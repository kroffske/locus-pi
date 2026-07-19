import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runner.js";
import { createWorkflowAgentRunner } from "../../../extensions/_shared/workflow-agent-bridge.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentResult,
  type WorkflowJournalLine,
} from "../../../extensions/_shared/workflow-runtime.js";
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
  return root;
}

describe("workflow evidence threading", () => {
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
