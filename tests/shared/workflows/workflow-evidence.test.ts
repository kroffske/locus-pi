import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runner.js";
import { createWorkflowAgentRunner } from "../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import {
  createWorkflowRuntime,
  DEFAULT_WORKFLOW_AGENT_MAX_TOOL_CALLS,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowJournalLine,
} from "../../../extensions/workflows/runtime/workflow-runtime.js";
import type { EvidenceEvaluation } from "../../../extensions/_shared/types.js";
import { WorkflowProgressComponent } from "../../../extensions/workflows/progress-widget.js";
import { createHarness } from "../../test-harness.js";

const evidence: EvidenceEvaluation = {
  evidence: "missing_expected_evidence",
  warnings: [
    "reviewer is missing expected runtime evidence (read, grep); mode=warn allows the run status to remain completed.",
  ],
  missingRequiredTools: ["read", "grep"],
  observedTools: [],
};

function tempProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-workflow-evidence-"));
  const dir = path.join(root, ".agents", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "reviewer.md"),
    "---\nname: reviewer\ndescription: Project reviewer\ntools: read, grep\n---\nReview carefully.\n",
    "utf8",
  );
  // The `default` agent has to belong to this project too. Discovery is
  // project → user → bundled, so a root that declares only `reviewer` borrows
  // `default` from whatever catalog the developer installed under `$HOME` — and
  // now that agent frontmatter `model:` selects the child's model, a stale home
  // catalog can fail these calls for reasons that have nothing to do with evidence.
  writeFileSync(
    path.join(dir, "default.md"),
    "---\nname: default\ndescription: General purpose agent\nmodel: task\n---\nDo the work.\n",
    "utf8",
  );
  return root;
}

describe("workflow evidence threading", () => {
  it("uses a high configurable tool-call fuse instead of the former 100-call ceiling", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const resultFor = (request: WorkflowAgentRequest): WorkflowAgentResult => ({
      ok: true,
      status: "completed",
      summary: "done",
      text: "done",
      diagnostics: [],
      agent: request.agent,
    });
    const defaultRuntime = createWorkflowRuntime({
      runId: "wf-default-tool-fuse",
      agentRunner: async (request) => {
        requests.push(request);
        return resultFor(request);
      },
    });

    await defaultRuntime.dsl.agent("default fuse");
    await defaultRuntime.dsl.agent("large explicit fuse", { maxToolCalls: 5_000 });

    assert.deepEqual(
      requests.map((request) => request.maxToolCalls),
      [DEFAULT_WORKFLOW_AGENT_MAX_TOOL_CALLS, 5_000],
    );

    const configuredRequests: WorkflowAgentRequest[] = [];
    const configuredRuntime = createWorkflowRuntime({
      runId: "wf-configured-tool-fuse",
      defaultMaxToolCalls: 2_000,
      agentRunner: async (request) => {
        configuredRequests.push(request);
        return resultFor(request);
      },
    });
    await configuredRuntime.dsl.agent("configured fuse");
    assert.equal(configuredRequests[0]?.maxToolCalls, 2_000);
  });

  it("rejects invalid tool-call fuse values before child execution", async () => {
    assert.throws(
      () =>
        createWorkflowRuntime({
          runId: "wf-invalid-default-tool-fuse",
          defaultMaxToolCalls: -1,
          agentRunner: async () => {
            throw new Error("must not run");
          },
        }),
      /defaultMaxToolCalls must be a non-negative safe integer/u,
    );

    let calls = 0;
    const runtime = createWorkflowRuntime({
      runId: "wf-invalid-call-tool-fuse",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });
    await assert.rejects(
      runtime.dsl.agent("invalid explicit fuse", { maxToolCalls: 1.5 }),
      /agent maxToolCalls must be a non-negative safe integer/u,
    );
    assert.equal(calls, 0);
  });

  it("carries evidence from the agent boundary into WorkflowAgentResult", async () => {
    const root = tempProject();
    const h = createHarness(root, { sessionId: "wf-parent" });
    const createExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        return {
          status: "completed",
          agentName: request.agent.name,
          reason: "reviewed",
          text: "reviewed",
          diagnostics: [],
          lifecycleEntryIds: [],
          evidence,
        };
      },
    });
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor,
    });

    const result = await runner({ prompt: "review", agent: "reviewer" });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.evidence, evidence);
  });

  it("applies per-call read-only narrowing without broadening catalog policy", async () => {
    const root = tempProject();
    const h = createHarness(root, { sessionId: "wf-parent-read-only" });
    let observed: AgentRunRequest | undefined;
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: () => ({
        async run(request: AgentRunRequest) {
          observed = request;
          return {
            status: "completed",
            agentName: request.agent.name,
            reason: "read",
            text: "read",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    const result = await runner({
      prompt: "inspect",
      agent: "default",
      readOnly: true,
      tools: ["read", "git_read", "grep", "find"],
    });

    assert.equal(observed?.agent.readOnly, true);
    assert.deepEqual(observed?.allowedTools, ["read", "git_read", "grep", "find"]);
    assert.equal(result.readOnly, true);

    const attemptedBroadening = await runner({
      prompt: "inspect",
      agent: "reviewer",
      readOnly: false,
      tools: ["read"],
    } as unknown as WorkflowAgentRequest);

    assert.equal(observed?.agent.readOnly, true);
    assert.equal(attemptedBroadening.readOnly, true);
  });

  it("freezes repository_check package scripts when the workflow runner is created", async () => {
    const root = tempProject();
    writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ scripts: { verify: "node verify.mjs" } })}\n`);
    const h = createHarness(root, { sessionId: "wf-parent-frozen-checks" });
    let observed: AgentRunRequest | undefined;
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: () => ({
        async run(request: AgentRunRequest) {
          observed = request;
          return {
            status: "completed",
            agentName: request.agent.name,
            reason: "read",
            text: "read",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({ scripts: { verify: "node changed.mjs", injected: "node injected.mjs" } })}\n`,
    );
    await runner({ prompt: "inspect", agent: "default", readOnly: true, tools: ["repository_check"] });

    assert.deepEqual(observed?.repositoryCheckScripts, { verify: "node verify.mjs" });
  });

  it("writes evidence onto agent_end journal lines from WorkflowAgentResult", async () => {
    const result: WorkflowAgentResult = {
      ok: true,
      status: "completed",
      summary: "done",
      text: "done",
      diagnostics: [],
      agent: "reviewer",
      evidence,
      childSessionId: "child-session-1",
      childTrace: {
        path: "/tmp/run/child-session-1.jsonl",
        format: "pi-session-jsonl",
        childSessionId: "child-session-1",
      },
      resultArtifact: "/tmp/run/agent-result.json",
    };
    const runtime = createWorkflowRuntime({
      runId: "wf-evidence",
      now: () => "2026-01-01T00:00:00.000Z",
      agentRunner: async () => result,
    });

    await runtime.dsl.agent("review", { agent: "reviewer" });
    const endLine = runtime.getJournal().find((line) => line.kind === "agent_end");

    assert.ok(endLine !== undefined);
    assert.deepEqual(endLine.evidence, evidence);
    assert.deepEqual(endLine.evidenceWarnings, evidence.warnings);
    assert.equal(endLine.childSessionId, "child-session-1");
    assert.deepEqual(endLine.childTrace, {
      path: "/tmp/run/child-session-1.jsonl",
      format: "pi-session-jsonl",
      childSessionId: "child-session-1",
    });
    assert.equal(endLine.resultArtifact, "/tmp/run/agent-result.json");
  });

  it("renders agent_end evidence warnings in the progress widget tail", () => {
    const component = new WorkflowProgressComponent({ requestRender() {} }, {}, "script", "wf-evidence");
    const line: WorkflowJournalLine = {
      ts: "2026-01-01T00:00:00.000Z",
      runId: "wf-evidence",
      kind: "agent_end",
      agent: "reviewer",
      status: "completed",
      evidence,
      evidenceWarnings: evidence.warnings,
    };

    component.push(line);
    const rendered = component.render(200).join("\n");
    component.dispose();

    assert.match(rendered, /agent_end: reviewer completed/);
    assert.match(rendered, /missing expected runtime evidence/);
  });
});
