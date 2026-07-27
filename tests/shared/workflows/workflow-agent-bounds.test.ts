import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentExecutor } from "../../../extensions/_shared/agent-runner.js";
import { createWorkflowAgentRunner } from "../../../extensions/_shared/workflow-agent-bridge.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";
import { createHarness } from "../../test-harness.js";

/**
 * `timeoutMs` and `maxAnswerChars` — the two per-call bounds the runtime owns so
 * a workflow script does not re-implement them. Both fail closed: neither ever
 * resolves to a partial or oversized answer.
 */

function runtimeWith(runId: string, answer: string) {
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push(request);
      return {
        ok: true,
        status: "completed",
        summary: "done",
        text: answer,
        diagnostics: [],
        agent: request.agent,
      };
    },
  });
  return { ...runtime, requests };
}

describe("per-call agent bounds", () => {
  it("passes timeoutMs to the child request so the bridge can arm the fuse", async () => {
    const { dsl, requests } = runtimeWith("agent-timeout-request", "fine");

    await expect(dsl.agent("work", { timeoutMs: 60_000 })).resolves.toBe("fine");
    expect(requests[0]?.timeoutMs).toBe(60_000);
  });

  it.each([
    [0, /timeoutMs must be a positive safe integer/u],
    [-1, /timeoutMs must be a positive safe integer/u],
    [1.5, /timeoutMs must be a positive safe integer/u],
  ])("rejects a timeoutMs that could never bound a real call (%s)", async (timeoutMs, message) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-timeout-invalid",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect(dsl.agent("work", { timeoutMs })).rejects.toThrow(message);
    expect(calls).toBe(0);
  });

  it("fails an oversized answer instead of handing it to the next stage", async () => {
    const { dsl, getJournal } = runtimeWith("agent-answer-too-long", "0123456789");

    await expect(dsl.agent("summarize", { maxAnswerChars: 4 })).rejects.toThrow(
      /Agent answer is 10 characters; the call allows 4\./u,
    );
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]?.status).toBe("failed");
  });

  it("accepts an answer exactly at the bound", async () => {
    const { dsl } = runtimeWith("agent-answer-at-bound", "0123");

    await expect(dsl.agent("summarize", { maxAnswerChars: 4 })).resolves.toBe("0123");
  });

  it.each([0, -1, 1.5])("rejects an invalid maxAnswerChars bound (%s)", async (maxAnswerChars) => {
    const { dsl } = runtimeWith("agent-answer-invalid-bound", "fine");

    await expect(dsl.agent("summarize", { maxAnswerChars })).rejects.toThrow(
      "agent maxAnswerChars must be a positive safe integer",
    );
  });

  it("aborts the child itself when the fuse expires, instead of abandoning it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-agent-bounds-"));
    const agents = path.join(root, ".agents", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      path.join(agents, "reviewer.md"),
      "---\nname: reviewer\ndescription: Project reviewer\ntools: read, grep\n---\nReview carefully.\n",
      "utf8",
    );
    const h = createHarness(root, { sessionId: "wf-timeout" });
    let childSawAbort = false;
    const createExecutor = (): AgentExecutor => ({
      // A child that never finishes on its own: only the fuse can end this call.
      async run(_request, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        childSawAbort = true;
        return {
          status: "cancelled" as const,
          agentName: "reviewer",
          reason: "aborted",
          text: "",
          diagnostics: [],
          lifecycleEntryIds: [],
        };
      },
    });
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "timeout-run",
      createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "timeout-run", agentRunner: runner });

    await expect(dsl.agent("hang forever", { agent: "reviewer", timeoutMs: 25, label: "hang" })).rejects.toThrow(
      /exceeded its 25 ms timeout/u,
    );
    // The child was aborted, not left running with nobody to read its answer.
    expect(childSawAbort).toBe(true);
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends[0]?.status).toBe("failed");
  });

  it("keeps the bound out of the recorded request so it stays a live gate", async () => {
    // Two calls that differ only by `maxAnswerChars` are the same request: the
    // bound is enforced on whatever answer arrives, fresh or replayed, so it must
    // not fork the replay key the way a child-visible option does.
    const first = runtimeWith("agent-answer-key-a", "0123456789");
    await first.dsl.agent("summarize", { maxAnswerChars: 100 });
    const second = runtimeWith("agent-answer-key-b", "0123456789");
    await expect(second.dsl.agent("summarize", { maxAnswerChars: 4 })).rejects.toThrow(/Agent answer is 10/u);

    expect(second.requests[0]).toEqual(first.requests[0]);
  });
});
