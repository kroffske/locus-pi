import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunRequest, AgentRunResult } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  createWorkflowAgentRunner,
  WORKFLOW_NO_OPERATOR_ASK_MESSAGE,
} from "../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import { WORKFLOW_ASK_TOOL_NAME } from "../../../extensions/workflows/runtime/workflow-ask-tool.js";
import { createWorkflowRuntime } from "../../../extensions/workflows/runtime/workflow-runtime.js";
import type { WorkflowReplayController } from "../../../extensions/workflows/runtime/workflow-replay.js";
import { createHarness } from "../../test-harness.js";

/**
 * T-167 — the live ask bridge, wiring level.
 *
 * What must be true of the BRIDGE (the tool itself is unit-tested next door):
 * the stock `ask` is excluded from every child, `workflow_ask` is injected only
 * when the stage declared `ask: true`, the wall-clock fuse pauses while the
 * operator is thinking (a 200 ms human wait must not kill a 50 ms-fuse call),
 * the question+answer pair lands as a durable run artifact, and the replay key
 * forks on `ask` so a no-ask record is never served to an asking call.
 */

function completedResult(text: string): AgentRunResult {
  return {
    status: "completed",
    agentName: "sub-agent",
    reason: "done",
    text,
    diagnostics: [],
    lifecycleEntryIds: [],
  };
}

describe("workflow agent bridge — live ask wiring", () => {
  it("always excludes the stock ask; injects workflow_ask only when the stage declared it", async () => {
    const h = createHarness();
    const captured: AgentRunRequest[] = [];
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: () => ({
        async run(request) {
          captured.push(request);
          return completedResult("ok");
        },
      }),
    });
    await runner({ prompt: "plain stage", tools: ["*"] });
    await runner({ prompt: "asking stage", tools: ["*"], operatorAsk: true });
    expect(captured[0]?.additionalExcludeTools).toEqual(["ask"]);
    expect(captured[0]?.customTools).toBeUndefined();
    expect(captured[1]?.additionalExcludeTools).toEqual(["ask"]);
    expect(captured[1]?.customTools?.map((tool) => tool.name)).toEqual([WORKFLOW_ASK_TOOL_NAME]);
  });

  it("pauses the fuse while the operator thinks, and records the Q&A artifact", async () => {
    const h = createHarness();
    const artifactsRoot = mkdtempSync(path.join(tmpdir(), "workflow-ask-evidence-"));
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "ask-pause-run",
      evidenceDestinations: (callId) => ({
        transcriptDir: path.join(artifactsRoot, callId, "transcripts"),
        resultArtifactsDir: path.join(artifactsRoot, callId, "artifacts"),
      }),
      // A scripted operator that takes 200 ms to answer — four times the fuse.
      askRequestQuestion: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { status: "answered", kind: "option", answer: "sqlite", label: "sqlite" };
      },
      createExecutor: () => ({
        async run(request, signal) {
          const tool = request.customTools?.find((candidate) => candidate.name === WORKFLOW_ASK_TOOL_NAME);
          expect(tool).toBeDefined();
          const toolResult = await tool!.execute(
            "call-1",
            { questions: [{ id: "q1", question: "Which storage?", options: [{ label: "sqlite" }] }] },
            signal,
          );
          const text = toolResult.content[0]?.text ?? "";
          return completedResult(text);
        },
      }),
    });
    const result = await runner({
      prompt: "decide storage",
      tools: ["*"],
      operatorAsk: true,
      timeoutMs: 50,
      callId: "ask-call-1",
    });
    // 50 ms fuse, 200 ms human wait: without the pause this dies by call-timeout.
    expect(result.failureCause).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Answer: sqlite");
    expect(result.diagnostics.some((line) => line.includes("workflow_ask: operator answered 1/1"))).toBe(true);
    const artifactPath = path.join(artifactsRoot, "ask-call-1", "artifacts", "operator-ask-1.json");
    expect(existsSync(artifactPath)).toBe(true);
    const record = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      declined: boolean;
      entries: Array<{ id: string; status: string; answer?: string }>;
    };
    expect(record.declined).toBe(false);
    expect(record.entries[0]).toMatchObject({ id: "q1", status: "answered", answer: "sqlite" });
  });

  it("forks the replay key on ask, so a no-ask record is never served to an asking call", async () => {
    const h = createHarness();
    const keys: string[] = [];
    const replay = {
      beginAgentAttempt(canonicalRequest: string) {
        keys.push(canonicalRequest);
        return { replayed: false, reason: "no-recorded-calls" } as const;
      },
      recordAgentAttempt() {},
      resolveValue(_kind: unknown, produce: () => number) {
        return produce();
      },
      counts() {
        return { agentReplayed: 0, agentRecorded: 0, valueReplayed: 0, valueRecorded: 0 };
      },
    } as unknown as WorkflowReplayController;
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      askRequestQuestion: async () => ({ status: "answered", kind: "custom", answer: "yes" }),
      createExecutor: () => ({
        async run() {
          return completedResult("fine");
        },
      }),
    });
    const { dsl } = createWorkflowRuntime({ runId: "ask-key-run", agentRunner: runner, replay });
    await dsl.agent("same prompt");
    await dsl.agent("same prompt", { ask: true });
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toEqual(keys[1]);
    expect(keys[0]).toContain('"operatorAsk":null');
    expect(keys[1]).toContain('"operatorAsk":true');
  });

  it("refuses an ask stage under the run-level no-operator mode before any child exists (T-165)", async () => {
    const h = createHarness();
    let spawned = 0;
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      noOperator: true,
      createExecutor: () => ({
        async run() {
          spawned += 1;
          return completedResult("must never run");
        },
      }),
    });
    const refused = await runner({ prompt: "asking stage", tools: ["*"], operatorAsk: true });
    expect(refused.ok).toBe(false);
    expect(refused.failureCause).toBe("ask-unavailable");
    expect(refused.summary).toBe(WORKFLOW_NO_OPERATOR_ASK_MESSAGE);
    expect(spawned).toBe(0);
    // A stage that does not ask is untouched by the mode.
    const plain = await runner({ prompt: "plain stage", tools: ["*"] });
    expect(plain.ok).toBe(true);
    expect(spawned).toBe(1);
  });
});
