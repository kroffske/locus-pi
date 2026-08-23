import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentExecutor } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  DEFAULT_WORKFLOW_BUDGET,
  WORKFLOW_MAX_TIMEOUT_MS,
  workflowSdkTurnTimeoutMs,
} from "../../../extensions/workflows/runtime/workflow-budget.js";
import { createWorkflowAgentRunner } from "../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/workflows/runtime/workflow-runtime.js";
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

function runtimeWithTurns(runId: string, maxTurns: number) {
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId,
    defaultMaxTurns: maxTurns,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push(request);
      return { ok: true, status: "completed", summary: "done", text: "fine", diagnostics: [], agent: request.agent };
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

  it("rejects a timeoutMs above the largest real Node timer before a child starts", async () => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "agent-timeout-node-limit",
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect(dsl.agent("work", { timeoutMs: WORKFLOW_MAX_TIMEOUT_MS + 1 })).rejects.toThrow(
      /cannot be represented by Node timers with the SDK backstop/u,
    );
    expect(calls).toBe(0);
  });

  it("fails an oversized answer instead of handing it to the next stage", async () => {
    const { dsl, getJournal } = runtimeWith("agent-answer-too-long", "0123456789");

    await expect(dsl.agent("summarize", { maxAnswerChars: 4 })).rejects.toThrow(
      /Agent answer is 10 characters; the call allows 4\. Budget axis: answerChars\./u,
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

/**
 * T-131 W3/W5 — the per-child axes the package budget contract now defaults, and
 * the single deadline that replaced two racing ones.
 */
describe("contract-defaulted per-child bounds", () => {
  it("applies the default timeoutMs to a call that declares none", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "default-timeout",
      defaultTimeoutMs: DEFAULT_WORKFLOW_BUDGET.timeoutMs,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        return { ok: true, status: "completed", summary: "done", text: "fine", diagnostics: [], agent: request.agent };
      },
    });

    await expect(dsl.agent("work")).resolves.toBe("fine");
    expect(requests[0]?.timeoutMs).toBe(DEFAULT_WORKFLOW_BUDGET.timeoutMs);
  });

  it("lets an explicit per-call fuse narrow the default", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "narrowed-timeout",
      defaultTimeoutMs: DEFAULT_WORKFLOW_BUDGET.timeoutMs,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        return { ok: true, status: "completed", summary: "done", text: "fine", diagnostics: [], agent: request.agent };
      },
    });

    await expect(dsl.agent("work", { timeoutMs: 1_000 })).resolves.toBe("fine");
    expect(requests[0]?.timeoutMs).toBe(1_000);
  });

  it("arms no fuse at all when no default is configured, so old embedders are unchanged", async () => {
    const { dsl, requests } = runtimeWith("no-default-timeout", "fine");

    await expect(dsl.agent("work")).resolves.toBe("fine");
    expect(requests[0]?.timeoutMs).toBeUndefined();
  });

  it("derives the SDK turn budget from the declared fuse, so the workflow failure wins the race", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-turn-budget-"));
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: Turn budget agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
      "utf8",
    );
    const h = createHarness(root, { sessionId: "wf-turn-budget" });
    const factoryOptions: Array<{ turnTimeoutMs?: number }> = [];
    const createExecutor = (o: { turnTimeoutMs?: number }): AgentExecutor => {
      factoryOptions.push({ ...o });
      return {
        async run(request) {
          return {
            status: "completed" as const,
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: "fine",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      };
    };
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "turn-budget-run",
      createExecutor,
    });
    const { dsl } = createWorkflowRuntime({
      runId: "turn-budget-run",
      defaultTimeoutMs: DEFAULT_WORKFLOW_BUDGET.timeoutMs,
      agentRunner: runner,
    });

    await expect(dsl.agent("work")).resolves.toBe("fine");
    const turnTimeoutMs = factoryOptions[0]?.turnTimeoutMs;
    expect(turnTimeoutMs).toBe(workflowSdkTurnTimeoutMs(DEFAULT_WORKFLOW_BUDGET.timeoutMs, 20));
    // ORDERING, not only the value: the host kills a child at turnTimeoutMs * maxTurns
    // (`agent-sdk-host.ts`), and that moment must come strictly after the workflow fuse.
    expect(turnTimeoutMs! * 20).toBeGreaterThan(DEFAULT_WORKFLOW_BUDGET.timeoutMs);
    rmSync(root, { recursive: true, force: true });
  });

  it("threads no turn budget when the call has no fuse, leaving the host default in place", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-turn-budget-absent-"));
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: Turn budget agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
      "utf8",
    );
    const h = createHarness(root, { sessionId: "wf-turn-budget-absent" });
    const factoryOptions: Array<{ turnTimeoutMs?: number }> = [];
    const createExecutor = (o: { turnTimeoutMs?: number }): AgentExecutor => {
      factoryOptions.push({ ...o });
      return {
        async run(request) {
          return {
            status: "completed" as const,
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: "fine",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      };
    };
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "turn-budget-absent",
      createExecutor,
    });
    const { dsl } = createWorkflowRuntime({ runId: "turn-budget-absent", agentRunner: runner });

    await expect(dsl.agent("work")).resolves.toBe("fine");
    expect(factoryOptions[0]?.turnTimeoutMs).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("maxTurns as a budget axis", () => {
  it("carries the contract turn budget on a call that declares nothing", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "default-turns",
      defaultMaxTurns: DEFAULT_WORKFLOW_BUDGET.turns,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        return { ok: true, status: "completed", summary: "done", text: "fine", diagnostics: [], agent: request.agent };
      },
    });

    await expect(dsl.agent("work")).resolves.toBe("fine");
    expect(requests[0]?.maxTurns).toBe(DEFAULT_WORKFLOW_BUDGET.turns);
  });

  it("lets a call declare its own turn budget within the host clamp", async () => {
    const requests: WorkflowAgentRequest[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "declared-turns",
      defaultMaxTurns: DEFAULT_WORKFLOW_BUDGET.turns,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        requests.push(request);
        return { ok: true, status: "completed", summary: "done", text: "fine", diagnostics: [], agent: request.agent };
      },
    });

    await expect(dsl.agent("work", { maxTurns: 20 })).resolves.toBe("fine");
    await expect(dsl.agent("work", { maxTurns: 1 })).resolves.toBe("fine");
    expect(requests.map((request) => request.maxTurns)).toEqual([20, 1]);
  });

  it.each([25, 0, -1, 1.5])("refuses a maxTurns outside the host clamp with zero child calls (%s)", async (value) => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "clamped-turns",
      defaultMaxTurns: DEFAULT_WORKFLOW_BUDGET.turns,
      agentRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    });

    await expect(dsl.agent("work", { maxTurns: value })).rejects.toThrow(
      /agent maxTurns must be an integer between 1 and 20/u,
    );
    expect(calls).toBe(0);
  });

  it("reaches the child request, so the bridge stops choosing the turn budget", async () => {
    // The canonical-key consequence is proven in workflow-replay.test.ts, where a
    // recorded answer is or is not served; comparing request objects here would
    // pass whether or not `maxTurns` joined the key.
    const five = runtimeWithTurns("turns-five", 5);
    await five.dsl.agent("work");
    const two = runtimeWithTurns("turns-two", 2);
    await two.dsl.agent("work");

    expect(five.requests[0]?.maxTurns).toBe(5);
    expect(two.requests[0]?.maxTurns).toBe(2);
  });

  it("derives the SDK turn budget from the DECLARED turn count, not a constant", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-turns-sdk-"));
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: Turns agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
      "utf8",
    );
    const h = createHarness(root, { sessionId: "wf-turns-sdk" });
    const factoryOptions: Array<{ turnTimeoutMs?: number }> = [];
    const createExecutor = (o: { turnTimeoutMs?: number }): AgentExecutor => {
      factoryOptions.push({ ...o });
      return {
        async run(request) {
          return {
            status: "completed" as const,
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: "fine",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      };
    };
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      workflowRunId: "turns-sdk-run",
      createExecutor,
    });
    const { dsl } = createWorkflowRuntime({
      runId: "turns-sdk-run",
      defaultTimeoutMs: 60_000,
      defaultMaxTurns: DEFAULT_WORKFLOW_BUDGET.turns,
      agentRunner: runner,
    });

    await expect(dsl.agent("work", { maxTurns: 2 })).resolves.toBe("fine");
    expect(factoryOptions[0]?.turnTimeoutMs).toBe(workflowSdkTurnTimeoutMs(60_000, 2));
    expect(factoryOptions[0]!.turnTimeoutMs! * 2).toBeGreaterThan(60_000);
    rmSync(root, { recursive: true, force: true });
  });
});
