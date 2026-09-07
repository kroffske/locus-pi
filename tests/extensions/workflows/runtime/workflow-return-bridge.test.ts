/** Requires installed Pi imports; fake session integration, not a live provider run. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it as test } from "vitest";
import {
  createWorkflowRuntime,
  type WorkflowRuntime,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import { createWorkflowAgentRunner } from "../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import { createWorkflowArtifactStore } from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import {
  createAgentSdkSessionExecutor,
  agentLiveStore,
  type SdkAgentSessionEventLike,
} from "../../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import { createHarness } from "../../../test-harness.js";
function tempRun(root: string, id: string): string {
  const dir = path.join(root, ".locus-pi", "runs", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  // realpath: the host records the real exported path, and the artifact root must match it.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "locus-bridge-return-")));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
/** One real runtime -> bridge -> SDK stack whose only fake part is the Pi session.
 *  `submit` returns the value this child proposes on the given 1-based prompt. */
function bridgeHarness(
  root: string,
  id: string,
  submit: (prompt: number) => unknown,
): { runtime: WorkflowRuntime; counters: { sessions: number; prompts: number; disposals: number } } {
  const h = createHarness(root);
  const runDir = tempRun(root, id);
  const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir });
  const counters = { sessions: 0, prompts: 0, disposals: 0 };
  const runner = createWorkflowAgentRunner({
    pi: h.pi,
    ctx: h.ctx,
    signal: new AbortController().signal,
    workflowRunId: id,
    workflowRunDir: runDir,
    evidenceDestinations: (callId) => store.childEvidenceDestinations(callId),
    createExecutor: (opts) =>
      createAgentSdkSessionExecutor({
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.thinkingLevel === undefined ? {} : { thinkingLevel: opts.thinkingLevel }),
        ...(opts.live === undefined ? {} : { live: opts.live }),
        ...(opts.maxToolCalls === undefined ? {} : { maxToolCalls: opts.maxToolCalls }),
        ...(opts.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: opts.turnTimeoutMs }),
        ...(opts.reportsDir === undefined ? {} : { reportsDir: opts.reportsDir }),
        ...(opts.onLiveExecution === undefined ? {} : { onLiveExecution: opts.onLiveExecution }),
        createSession: async (sessionOptions) => {
          counters.sessions += 1;
          let active = ["read", "write", "workflow_return"];
          let emit: (event: SdkAgentSessionEventLike) => void = () => {};
          const tool = sessionOptions.customTools?.find((item) => item.name === "workflow_return");
          assert.ok(tool);
          return {
            session: {
              sessionId: "bridge-child",
              subscribe(listener) {
                emit = listener;
                return () => {};
              },
              async prompt() {
                counters.prompts += 1;
                emit({ type: "turn_start" });
                emit({
                  type: "tool_execution_start",
                  toolName: "workflow_return",
                  toolCallId: `t${counters.prompts}`,
                });
                await tool.execute(
                  `t${counters.prompts}`,
                  { value: submit(counters.prompts) },
                  new AbortController().signal,
                );
                emit({ type: "agent_end", willRetry: false });
              },
              getActiveToolNames: () => active,
              setActiveToolsByName(names) {
                active = [...names];
              },
              getSessionStats: () => ({
                sessionId: "bridge-child",
                toolCalls: counters.prompts,
                toolResults: counters.prompts,
              }),
              getLastAssistantText: () => "DO NOT USE THIS NARRATIVE",
              exportToJsonl(target) {
                const file = target ?? path.join(root, "trace.jsonl");
                mkdirSync(path.dirname(file), { recursive: true });
                // The host verifies the session header before adopting the trace.
                writeFileSync(file, `${JSON.stringify({ type: "session", id: "bridge-child" })}\n`, "utf8");
                return file;
              },
              dispose() {
                counters.disposals += 1;
              },
              async abort() {},
            },
          };
        },
      }),
  });
  return { runtime: createWorkflowRuntime({ runId: id, agentRunner: runner, artifactPorts: store }), counters };
}

test("runtime -> bridge -> SDK returns the validated tool value and preserves one session during repair", async () =>
  temporary(async (root) => {
    const id = "bridge-return";
    const { runtime, counters } = bridgeHarness(root, id, (prompt) => (prompt === 1 ? "bad\nline" : "orders"));
    const value = await runtime.dsl.agent("Extract an ID", {
      label: "extract",
      title: "Orders · ID",
      returnVia: "tool",
      output: { type: "string", singleLine: true },
    });
    assert.equal(value, "orders");
    assert.equal(counters.sessions, 1);
    assert.equal(counters.prompts, 2);
    assert.equal(counters.disposals, 1);
    const end = runtime.getJournal().find((line) => line.kind === "agent_end");
    assert.equal(end?.outputAcceptance?.attempts, 2);
    assert.ok(
      [...agentLiveStore.rows.values()].some(
        (row) => row.title === "Orders · ID" && row.childSessionId === "bridge-child",
      ),
    );
  }));

const RESULT = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "summary"],
  properties: {
    decision: { type: "string", enum: ["complete", "needs-work", "unknown"] },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
  },
};

test("runtime -> bridge -> SDK returns the validated record after same-session shape repair", async () =>
  temporary(async (root) => {
    const id = "bridge-shaped";
    const { runtime, counters } = bridgeHarness(root, id, (prompt) =>
      prompt === 1 ? { decision: "complete" } : { decision: "complete", summary: "ok" },
    );
    const value = await runtime.dsl.agent("Verify", {
      label: "verify",
      title: "Orders · verify",
      schema: RESULT,
      returnVia: "tool",
    });
    assert.deepEqual(value, { decision: "complete", summary: "ok" });
    assert.equal(counters.sessions, 1);
    assert.equal(counters.prompts, 2);
    assert.equal(counters.disposals, 1);
    assert.equal(runtime.getJournal().find((line) => line.kind === "agent_end")?.outputAcceptance?.attempts, 2);
  }));
