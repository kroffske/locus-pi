/** Requires installed Pi imports; fake session integration, not a live provider run. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it as test } from "vitest";
import { createWorkflowRuntime } from "../../../../extensions/workflows/runtime/workflow-runtime.js";
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

test("runtime -> bridge -> SDK returns the validated tool value and preserves one session during repair", async () =>
  temporary(async (root) => {
    const h = createHarness(root);
    const id = "bridge-return";
    const runDir = tempRun(root, id);
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir });
    let sessions = 0,
      prompts = 0,
      disposals = 0;
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
            sessions += 1;
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
                  prompts += 1;
                  emit({ type: "turn_start" });
                  emit({ type: "tool_execution_start", toolName: "workflow_return", toolCallId: `t${prompts}` });
                  await tool.execute(
                    `t${prompts}`,
                    { value: prompts === 1 ? "bad\nline" : "orders" },
                    new AbortController().signal,
                  );
                  emit({ type: "agent_end", willRetry: false });
                },
                getActiveToolNames: () => active,
                setActiveToolsByName(names) {
                  active = [...names];
                },
                getSessionStats: () => ({ sessionId: "bridge-child", toolCalls: prompts, toolResults: prompts }),
                getLastAssistantText: () => "DO NOT USE THIS NARRATIVE",
                exportToJsonl(target) {
                  const file = target ?? path.join(root, "trace.jsonl");
                  mkdirSync(path.dirname(file), { recursive: true });
                  // The host verifies the session header before adopting the trace.
                  writeFileSync(file, `${JSON.stringify({ type: "session", id: "bridge-child" })}\n`, "utf8");
                  return file;
                },
                dispose() {
                  disposals += 1;
                },
                async abort() {},
              },
            };
          },
        }),
    });
    const runtime = createWorkflowRuntime({ runId: id, agentRunner: runner, artifactPorts: store });
    const value = await runtime.dsl.agent("Extract an ID", {
      label: "extract",
      title: "Orders · ID",
      returnVia: "tool",
      output: { type: "string", singleLine: true },
    });
    assert.equal(value, "orders");
    assert.equal(sessions, 1);
    assert.equal(prompts, 2);
    assert.equal(disposals, 1);
    const end = runtime.getJournal().find((line) => line.kind === "agent_end");
    assert.equal(end?.outputAcceptance?.attempts, 2);
    assert.ok(
      [...agentLiveStore.rows.values()].some(
        (row) => row.title === "Orders · ID" && row.childSessionId === "bridge-child",
      ),
    );
  }));
