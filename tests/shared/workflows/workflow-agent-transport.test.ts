import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_FAILURE_CAUSES,
  executeAgentRunBoundary,
  type AgentExecutor,
  type AgentFailureCause,
  type AgentRunRequest,
} from "../../../extensions/_shared/agent-runner.js";
import {
  AGENT_SDK_UNAVAILABLE_DIAGNOSTIC,
  AgentSdkUnavailableError,
  agentLiveStore,
  createAgentSdkSessionExecutor,
  type CreateAgentSessionFactory,
  type SdkAgentSessionEventLike,
  type SdkAgentSessionLike,
} from "../../../extensions/_shared/agent-sdk-host.js";
import {
  createWorkflowAgentRunner,
  WorkflowAgentUnavailableError,
} from "../../../extensions/_shared/workflow-agent-bridge.js";
import {
  createWorkflowJournalSink,
  readWorkflowRunJournalState,
} from "../../../extensions/_shared/workflow-journal.js";
import { createWorkflowRuntime, type WorkflowAgentResult } from "../../../extensions/_shared/workflow-runtime.js";
import { runWorkflowScript } from "../../../extensions/_shared/workflow-runner.js";
import type { WorkflowReplayController } from "../../../extensions/_shared/workflow-replay.js";
import type { AgentDefinition } from "../../../extensions/_shared/types.js";
import { createHarness } from "../../test-harness.js";

/**
 * T-130 W1 — the machine-readable failure cause.
 *
 * `status` tells a reader "failed" and nothing else: a turn timeout, a tool-call
 * budget breach, a provider error and a mid-turn throw all arrive as one status plus
 * an English sentence. Everything downstream that must tell those apart — the retry
 * of W2 first — would otherwise have to match on that sentence.
 *
 * So each case here drives ONE real failure through the layer that knows its cause
 * and asserts the declared member, never the prose. Coverage is enforced, not
 * eyeballed: `observed` accumulates every member these tests actually produced, and
 * the last case fails if any member of the closed list was never exercised.
 */

const observed = new Set<AgentFailureCause>();

function record<T extends { failureCause?: AgentFailureCause }>(result: T): T {
  if (result.failureCause !== undefined) observed.add(result.failureCause);
  return result;
}

// ---------------------------------------------------------------------------
// Host-level fakes (the same insurance-not-proof shape as agent-sdk-host.test.ts)
// ---------------------------------------------------------------------------

const reviewer: AgentDefinition = {
  name: "reviewer",
  description: "Review code",
  allowedTools: ["read", "search", "yield"],
  tools: ["read", "search", "yield"],
  risk: "medium",
  readOnly: true,
  source: "project",
  filePath: "/repo/.agents/agents/reviewer.md",
};

function hostRequest(): AgentRunRequest {
  return {
    agent: reviewer,
    task: "Review this change",
    parentSessionId: "parent-session",
    projectRoot: "/repo",
    workingDirectory: "/repo",
    maxTurns: 5,
    depth: 0,
    maxDepth: 1,
    allowedTools: ["read", "search", "yield"],
    approvalTier: "allow",
  };
}

interface FakeSessionConfig {
  lastAssistantText: string | undefined;
  toolCalls?: number;
  toolResults?: number;
  /** prompt() resolves but the terminal turn event never fires: only the fuse ends the turn. */
  neverEnds?: boolean;
  /** prompt() rejects, which lands in the catch around the whole turn. */
  promptError?: string;
  messages?: readonly unknown[];
  events?: SdkAgentSessionEventLike[];
}

function fakeSession(config: FakeSessionConfig): SdkAgentSessionLike {
  const exportDir = mkdtempSync(path.join(tmpdir(), "locus-transport-export-"));
  let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
  return {
    sessionId: "sdk-child",
    ...(config.messages !== undefined ? { messages: config.messages } : {}),
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      if (config.promptError !== undefined) throw new Error(config.promptError);
      for (const event of config.events ?? []) listener?.(event);
      if (config.neverEnds !== true) listener?.({ type: "agent_end", willRetry: false });
    },
    getSessionStats() {
      return { sessionId: "sdk-child", toolCalls: config.toolCalls ?? 0, toolResults: config.toolResults ?? 0 };
    },
    getLastAssistantText() {
      return config.lastAssistantText;
    },
    exportToJsonl(outputPath) {
      const target = outputPath ?? path.join(exportDir, "session.jsonl");
      writeFileSync(target, "{}\n", "utf8");
      return target;
    },
    dispose: vi.fn(),
    abort: vi.fn(async () => {}),
  };
}

function tmpReportsDir(): string {
  return mkdtempSync(path.join(tmpdir(), "locus-transport-reports-"));
}

async function runHost(
  config: FakeSessionConfig,
  options: { turnTimeoutMs?: number; maxToolCalls?: number; aborted?: boolean } = {},
) {
  const session = fakeSession(config);
  const createSession: CreateAgentSessionFactory = async () => ({ session });
  const executor = createAgentSdkSessionExecutor({
    createSession,
    reportsDir: tmpReportsDir(),
    now: () => "fixed",
    ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(options.maxToolCalls !== undefined ? { maxToolCalls: options.maxToolCalls } : {}),
  });
  const controller = new AbortController();
  if (options.aborted === true) controller.abort();
  return record(await executor.run(hostRequest(), controller.signal));
}

// ---------------------------------------------------------------------------
// Bridge-level project (a real catalog, a fake child)
// ---------------------------------------------------------------------------

function bridgeProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-transport-bridge-"));
  const agents = path.join(root, ".agents", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, "default.md"),
    "---\nname: default\ndescription: Transport test agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
    "utf8",
  );
  return root;
}

/** One runtime over a scripted agent runner; every result is recorded for the coverage gate. */
function runtimeOver(runId: string, results: WorkflowAgentResult[]) {
  const seen: WorkflowAgentResult[] = [];
  let index = 0;
  const runtime = createWorkflowRuntime({
    runId,
    agentRunner: async (): Promise<WorkflowAgentResult> => {
      const next = results[Math.min(index, results.length - 1)]!;
      index += 1;
      seen.push(next);
      return next;
    },
  });
  return { ...runtime, seen };
}

function completed(text: string): WorkflowAgentResult {
  return { ok: true, status: "completed", summary: "done", text, diagnostics: [], agent: "default" };
}

let retryProbes = 0;

/**
 * Does the RUNTIME re-ask on this cause?
 *
 * Asked through the public DSL, never through a classifier helper: the retry policy is a
 * BEHAVIOUR of the package, and an exported predicate a test can pin is not the same thing —
 * it can keep answering correctly while the loop that was supposed to consult it stops
 * doing so. Two children means the cause is in the transport class; one means it is not.
 */
async function retriesOn(cause: AgentFailureCause | undefined): Promise<boolean> {
  retryProbes += 1;
  const failure: WorkflowAgentResult = {
    ok: false,
    status: "failed",
    summary: "scripted failure for the retry probe",
    diagnostics: [],
    agent: "default",
    ...(cause === undefined ? {} : { failureCause: cause }),
  };
  const { dsl, requests } = scriptedRuntime(`retry-probe-${String(retryProbes)}`, [failure, completed("second")]);
  await dsl.agent("work", { readOnly: true, attempts: 2 }).catch(() => undefined);
  return requests.length > 1;
}

describe("agent failure cause — host", () => {
  it("names the host turn budget as a transport failure", async () => {
    const result = await runHost({ lastAssistantText: undefined, neverEnds: true }, { turnTimeoutMs: 5 });

    expect(result.status).toBe("failed");
    expect(result.failureCause).toBe("host-turn-timeout");
    expect(await retriesOn(result.failureCause)).toBe(true);
  });

  it("names the tool-call budget, and it is not transport", async () => {
    const result = await runHost(
      {
        lastAssistantText: undefined,
        toolCalls: 4,
        toolResults: 3,
        neverEnds: true,
        events: [
          { type: "tool_execution_start", toolName: "bash" },
          { type: "tool_execution_start", toolName: "bash" },
          { type: "tool_execution_start", toolName: "bash" },
          { type: "tool_execution_start", toolName: "bash" },
        ],
      },
      { turnTimeoutMs: 60_000, maxToolCalls: 3 },
    );

    expect(result.reason).toContain("tool-call budget");
    expect(result.failureCause).toBe("tool-call-budget");
    expect(await retriesOn(result.failureCause)).toBe(false);
  });

  it("names a provider-side assistant failure", async () => {
    agentLiveStore.reset();
    try {
      const result = await runHost({
        lastAssistantText: undefined,
        messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "provider exploded" }],
      });

      expect(result.reason).toBe("provider exploded");
      expect(result.failureCause).toBe("provider-error");
      expect(await retriesOn(result.failureCause)).toBe(false);
    } finally {
      agentLiveStore.reset();
    }
  });

  it("names an unreadable final answer", async () => {
    const result = await runHost({ lastAssistantText: undefined });

    expect(result.status).toBe("failed");
    expect(result.failureCause).toBe("unparseable-answer");
    expect(await retriesOn(result.failureCause)).toBe(false);
  });

  it("names operator cancellation, and never treats it as a dropped channel", async () => {
    const result = await runHost({ lastAssistantText: "unused" }, { aborted: true });

    expect(result.status).toBe("cancelled");
    expect(result.failureCause).toBe("cancelled");
    expect(await retriesOn(result.failureCause)).toBe(false);
  });

  it("names a missing SDK substrate", async () => {
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => {
        throw new AgentSdkUnavailableError("no substrate here");
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = record(await executor.run(hostRequest(), new AbortController().signal));

    expect(result.status).toBe("blocked");
    expect(result.failureCause).toBe("sdk-unavailable");
  });

  it("leaves an unproven createSession throw unclassified rather than guessing transport", async () => {
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => {
        // A bad model id and an option-assembly bug land in this same branch.
        throw new Error("model 'nope/nope' is not registered");
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = record(await executor.run(hostRequest(), new AbortController().signal));

    expect(result.status).toBe("failed");
    expect(result.failureCause).toBe("unclassified");
    expect(await retriesOn(result.failureCause)).toBe(false);
  });

  it("leaves an unproven mid-turn throw unclassified", async () => {
    const result = await runHost({ lastAssistantText: undefined, promptError: "kaboom inside the turn" });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("kaboom inside the turn");
    expect(result.failureCause).toBe("unclassified");
    expect(await retriesOn(result.failureCause)).toBe(false);
  });
});

describe("agent failure cause — run boundary", () => {
  it("names a request the run policy refused before any child existed", async () => {
    const harness = createHarness(bridgeProject(), { sessionId: "transport-policy" });
    let childRuns = 0;
    const executor: AgentExecutor = {
      async run() {
        childRuns += 1;
        throw new Error("must not run");
      },
    };

    const result = record(
      await executeAgentRunBoundary({
        pi: harness.pi,
        ctx: harness.ctx,
        // maxTurns 0 is refused by validateRunPolicy, so no executor is ever reached.
        request: { ...hostRequest(), maxTurns: 0 },
        executor,
        signal: new AbortController().signal,
      }),
    );

    expect(childRuns).toBe(0);
    expect(result.status).toBe("blocked");
    expect(result.failureCause).toBe("run-policy-blocked");
  });
});

describe("agent failure cause — bridge", () => {
  it("names an unknown catalog agent as an author error", async () => {
    const harness = createHarness(bridgeProject(), { sessionId: "transport-unknown-agent" });
    const runner = createWorkflowAgentRunner({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      createExecutor: (): AgentExecutor => ({
        async run() {
          throw new Error("must not run");
        },
      }),
    });

    const result = record(await runner({ prompt: "work", agent: "nowhere-agent" }));

    expect(result.summary).toContain("Unknown agent");
    expect(result.failureCause).toBe("unknown-agent");
    expect(await retriesOn(result.failureCause)).toBe(false);
  });

  it("names a workspace that could not be resolved", async () => {
    const harness = createHarness(bridgeProject(), { sessionId: "transport-workspace" });
    const runner = createWorkflowAgentRunner({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      createExecutor: (): AgentExecutor => ({
        async run() {
          throw new Error("must not run");
        },
      }),
    });

    // A workspace handle with no workspace manager configured: allocation, not transport.
    const result = record(await runner({ prompt: "work", agent: "default", workspaceHandle: "ws-1" }));

    expect(result.summary).toContain("workspace manager");
    expect(result.failureCause).toBe("workspace-allocation");
    expect(await retriesOn(result.failureCause)).toBe(false);
  });

  it("names its own per-call fuse as a transport failure", async () => {
    const harness = createHarness(bridgeProject(), { sessionId: "transport-fuse" });
    const runner = createWorkflowAgentRunner({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      createExecutor: (): AgentExecutor => ({
        // Never finishes on its own: only the call fuse can end it.
        async run(_request, signal) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            status: "cancelled" as const,
            agentName: "default",
            reason: "aborted",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    const result = record(await runner({ prompt: "hang", agent: "default", timeoutMs: 25 }));

    expect(result.summary).toContain("timeout and was aborted");
    expect(result.failureCause).toBe("call-timeout");
    expect(await retriesOn(result.failureCause)).toBe(true);
  });

  it("carries sdk-unavailable from the real host through the bridge into the run journal", async () => {
    // The one cause that never becomes a result. The bridge fails the whole run closed —
    // a run whose children cannot be spawned must end, not be re-asked — so it THROWS
    // before the result mapping, and there is no `agent_end` to carry a class. Without the
    // cause on the throw, the only terminal record of the call is an English sentence, and
    // "the cause travels end to end" would be true of thirteen members and false of this
    // one. Every layer here is real: the host executor, the bridge, the runtime, and the
    // journal validator a reader loads the file back through.
    const root = mkdtempSync(path.join(tmpdir(), "locus-transport-unavailable-"));
    const runId = "20260729-130000-abcd";
    const harness = createHarness(bridgeProject(), { sessionId: "transport-unavailable" });
    const runner = createWorkflowAgentRunner({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      createExecutor: () =>
        createAgentSdkSessionExecutor({
          createSession: async () => {
            throw new AgentSdkUnavailableError("no substrate here");
          },
          reportsDir: tmpReportsDir(),
          now: () => "fixed",
        }),
    });
    const { dsl } = createWorkflowRuntime({
      runId,
      projectRoot: root,
      journal: createWorkflowJournalSink(root, runId),
      agentRunner: runner,
    });

    // Fail-closed behaviour preserved: the call throws, it is not downgraded to a result.
    await expect(dsl.agent("work", { readOnly: true })).rejects.toThrow(/Pi SDK host/u);

    const read = readWorkflowRunJournalState(root, runId);
    expect(read.diagnostics).toEqual([]);
    const errors = read.lines.filter((line) => line.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.failureCause).toBe("sdk-unavailable");
    expect(errors[0]?.callId).toBe("call-0001");
    // No agent_end: the call never produced a result to end with, which is exactly why the
    // error line has to carry the class.
    expect(read.lines.filter((line) => line.kind === "agent_end")).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("fails the run closed on the typed sdk-unavailable cause with no diagnostic prose at all", async () => {
    // The real host always happens to append its English token beside the cause, so a
    // bridge that branched on that substring passed every end-to-end test while the typed
    // channel sat unread. Here the cause arrives ALONE: re-wording or dropping the
    // diagnostic must not change whether the run ends.
    const harness = createHarness(bridgeProject(), { sessionId: "transport-unavailable-typed" });
    const runner = createWorkflowAgentRunner({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      createExecutor: (): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          return {
            status: "blocked",
            agentName: request.agent.name,
            reason: "no substrate here",
            failureCause: "sdk-unavailable",
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    const thrown = await runner({ prompt: "work", agent: "default" }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(WorkflowAgentUnavailableError);
    expect((thrown as WorkflowAgentUnavailableError).failureCause).toBe("sdk-unavailable");
    expect((thrown as Error).message).toContain("no substrate here");
  });

  it("does not read the diagnostic token as a cause, and the run still fails closed", async () => {
    // The converse pin: prose alone no longer decides. A blocked result that carries the
    // token but no typed cause is `unclassified` — so it is never re-asked, and it is
    // never `ok`, which is what keeps the run failing closed rather than reading a blocked
    // call as an answer.
    const harness = createHarness(bridgeProject(), { sessionId: "transport-unavailable-prose" });
    const runner = createWorkflowAgentRunner({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      createExecutor: (): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          return {
            status: "blocked",
            agentName: request.agent.name,
            reason: "no substrate here",
            diagnostics: [AGENT_SDK_UNAVAILABLE_DIAGNOSTIC],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    const result = record(await runner({ prompt: "work", agent: "default" }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    // No declared cause at all: absence is what makes it unclassified, and unclassified
    // never retries.
    expect(result.failureCause).toBeUndefined();
    expect(await retriesOn(result.failureCause)).toBe(false);
  });

  it("puts no cause on an ordinary throw, rather than guessing one", async () => {
    // The gate on the cause carried by a throw is the closed list, not "any error with a
    // failureCause property": an unrelated error must never write a journal line the
    // reader refuses.
    const root = mkdtempSync(path.join(tmpdir(), "locus-transport-thrown-"));
    const runId = "20260729-131000-abcd";
    const { dsl } = createWorkflowRuntime({
      runId,
      projectRoot: root,
      journal: createWorkflowJournalSink(root, runId),
      agentRunner: async () => {
        throw Object.assign(new Error("host substrate is gone"), { failureCause: "made-up-cause" });
      },
    });

    await expect(dsl.agent("work", { readOnly: true })).rejects.toThrow(/host substrate is gone/u);

    const read = readWorkflowRunJournalState(root, runId);
    expect(read.diagnostics).toEqual([]);
    expect(read.lines.filter((line) => line.kind === "error").at(0)?.failureCause).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("agent failure cause — runtime", () => {
  it("names an empty answer, and keeps it out of the transport class", async () => {
    const { dsl, getJournal } = runtimeOver("transport-empty", [
      { ok: true, status: "completed", summary: "done", text: "   ", diagnostics: [], agent: "default" },
    ]);

    await expect(dsl.agent("summarize")).rejects.toThrow(/Agent result text is empty\./u);
    const end = getJournal().find((line) => line.kind === "agent_end");
    expect(end?.failureCause).toBe("empty-answer");
    observed.add("empty-answer");
  });

  it("names an over-long answer against the call's own bound", async () => {
    const { dsl, getJournal } = runtimeOver("transport-too-long", [completed("0123456789")]);

    await expect(dsl.agent("summarize", { maxAnswerChars: 4 })).rejects.toThrow(/Agent answer is 10 characters/u);
    const end = getJournal().find((line) => line.kind === "agent_end");
    expect(end?.failureCause).toBe("answer-too-long");
    observed.add("answer-too-long");
  });

  it("names a replayed answer the current script validator rejects", async () => {
    // A recorded answer that the CURRENT validator refuses: the runtime fails the run
    // closed rather than re-asking, because a second prompt would miss at this ordinal.
    const replay: WorkflowReplayController = {
      beginAgentAttempt: () => ({ replayed: true, text: '```json\n{"count":1}\n```' }),
      recordAgentAttempt: () => {},
      resolveValue: (_kind, produce) => produce(),
      counts: () => ({ replayedCalls: 1, freshCalls: 0 }),
    };
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "transport-script-rejected",
      agentRunner: async () => {
        throw new Error("a replayed call must not reach a child");
      },
      replay,
    });

    await expect(
      dsl.agent("count", {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["count"],
          properties: { count: { type: "integer" } },
        },
        validate: (value) => ((value as { count: number }).count === 3 ? [] : ["count: expected 3"]),
      }),
    ).rejects.toThrow(/rejected by the workflow script/u);
    const end = getJournal().find((line) => line.kind === "agent_end");
    expect(end?.failureCause).toBe("script-rejected");
    observed.add("script-rejected");
  });

  it("reads a result written before the field existed as unclassified, never as retryable", async () => {
    // Exactly the shape an older bridge produced: a failed result and no cause at all.
    const legacy: WorkflowAgentResult = {
      ok: false,
      status: "failed",
      summary: "Child agent turn exceeded the 5000ms budget and was aborted.",
      diagnostics: [],
      agent: "default",
    };

    expect(legacy.failureCause).toBeUndefined();
    // The prose says "timeout"; with no declared cause the runtime still refuses to retry.
    expect(await retriesOn(legacy.failureCause)).toBe(false);

    const { dsl, getJournal } = runtimeOver("transport-legacy", [legacy]);
    await expect(dsl.agent("work")).rejects.toThrow(/budget and was aborted/u);
    const end = getJournal().find((line) => line.kind === "agent_end");
    expect(end?.status).toBe("failed");
    expect(end?.failureCause).toBe("unclassified");
    observed.add("unclassified");
  });

  it("puts no cause on a completed call", async () => {
    const { dsl, getJournal } = runtimeOver("transport-completed", [completed("fine")]);

    await expect(dsl.agent("work")).resolves.toBe("fine");
    const end = getJournal().find((line) => line.kind === "agent_end");
    expect(end?.status).toBe("completed");
    expect(end?.failureCause).toBeUndefined();
  });
});

describe("agent failure cause — the list is closed and covered", () => {
  it("exercised every member of AGENT_FAILURE_CAUSES", () => {
    // A member nobody produced is a member nobody can trust: either the site that
    // sets it is unreachable, or the enum grew without a case proving where it comes from.
    const missing = AGENT_FAILURE_CAUSES.filter((cause) => !observed.has(cause));
    expect(missing).toEqual([]);
  });

  it("keeps the transport allowlist to the two causes the child never answered on", async () => {
    const transport: AgentFailureCause[] = [];
    for (const cause of AGENT_FAILURE_CAUSES) if (await retriesOn(cause)) transport.push(cause);
    expect(transport).toEqual(["host-turn-timeout", "call-timeout"]);
    // And the absent-cause case, which is not a member of the list at all.
    expect(await retriesOn(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W2 — the bounded transport retry
// ---------------------------------------------------------------------------

/** A transport failure the runtime is allowed to re-ask. */
function transportFailure(cause: "host-turn-timeout" | "call-timeout" = "host-turn-timeout"): WorkflowAgentResult {
  return {
    ok: false,
    status: "failed",
    failureCause: cause,
    summary: "Child agent turn exceeded the 5000ms budget and was aborted.",
    diagnostics: [],
    agent: "default",
  };
}

/** The only shape the retry may repeat: read-only, project workspace, no handle. */
const RETRYABLE_CALL = { readOnly: true, attempts: 2 } as const;

/** Drive a runtime over a scripted sequence of results and count the child calls. */
function scriptedRuntime(runId: string, results: WorkflowAgentResult[], extra: Record<string, unknown> = {}) {
  const requests: Array<{ prompt: string; callId?: string }> = [];
  let index = 0;
  const runtime = createWorkflowRuntime({
    runId,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push({ prompt: request.prompt, ...(request.callId !== undefined ? { callId: request.callId } : {}) });
      const next = results[Math.min(index, results.length - 1)]!;
      index += 1;
      return next;
    },
    ...extra,
  });
  return { ...runtime, requests };
}

describe("agent attempts — declaration", () => {
  it.each([0, 1.5, -1, 4])("refuses attempts=%s before any child starts", async (attempts) => {
    let children = 0;
    const { dsl } = createWorkflowRuntime({
      runId: `attempts-invalid-${String(attempts)}`,
      agentRunner: async () => {
        children += 1;
        throw new Error("must not run");
      },
    });

    await expect(dsl.agent("work", { ...RETRYABLE_CALL, attempts })).rejects.toThrow(
      /agent attempts must be a safe integer between 1 and 3/u,
    );
    // Refused, not clamped, and nothing was spawned to find that out.
    expect(children).toBe(0);
  });

  it("accepts the ceiling exactly", async () => {
    const { dsl, requests } = scriptedRuntime("attempts-ceiling", [completed("fine")]);

    await expect(dsl.agent("work", { readOnly: true, attempts: 3 })).resolves.toBe("fine");
    expect(requests).toHaveLength(1);
  });

  it("refuses a worktree call, spawning nothing", async () => {
    let children = 0;
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "attempts-worktree",
      agentRunner: async () => {
        children += 1;
        throw new Error("must not run");
      },
    });

    await expect(dsl.agent("edit", { readOnly: true, attempts: 2, workspaceMode: "worktree" })).rejects.toThrow(
      /refused for a worktree workspace call/u,
    );
    expect(children).toBe(0);
    expect(getJournal().filter((line) => line.kind === "agent_start")).toHaveLength(0);
  });

  it("refuses a workspace-handle call, spawning nothing", async () => {
    const workspaceEvidence = {
      handle: "ws-1",
      id: "ws",
      path: "/tmp/ws",
      head: "abc",
      sourceRef: "HEAD",
      originalRepoRoot: "/repo",
      originalHead: "abc",
    };
    let children = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "attempts-handle",
      agentRunner: async () => {
        children += 1;
        throw new Error("must not run");
      },
      workspaceManager: {
        allocate: () => "ws-1",
        resolve: () => workspaceEvidence,
        evidence: () => [workspaceEvidence],
      },
    });

    await expect(dsl.agent("edit", { readOnly: true, attempts: 2, workspaceHandle: "ws-1" })).rejects.toThrow(
      /refused for a call bound to a workspace handle/u,
    );
    expect(children).toBe(0);
  });

  it("refuses a project-workspace call that could still write, spawning nothing", async () => {
    let children = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "attempts-project-writer",
      agentRunner: async () => {
        children += 1;
        throw new Error("must not run");
      },
    });

    // Default options: workspaceMode falls back to "project" and the agent keeps its
    // catalog write capability, so this call is replay-eligible AND able to edit the repo.
    await expect(dsl.agent("fix the bug", { attempts: 2 })).rejects.toThrow(/provably cannot write/u);
    expect(children).toBe(0);

    // A tools allow-list with a writer in it is refused for the same reason.
    await expect(dsl.agent("fix the bug", { attempts: 2, tools: ["read", "edit"] })).rejects.toThrow(
      /provably cannot write/u,
    );
    expect(children).toBe(0);
  });

  it("accepts a no-write tools allow-list as proof, without readOnly", async () => {
    const { dsl, requests } = scriptedRuntime("attempts-tools-proof", [transportFailure(), completed("second")]);

    await expect(dsl.agent("read the file", { attempts: 2, tools: ["read", "grep"] })).resolves.toBe("second");
    expect(requests).toHaveLength(2);
  });

  it("keeps its no-write tool list a subset of the host's read-only allow-list", () => {
    // The runtime cannot import the host policy module (fs + child_process) and keeps a copy.
    // This is the assertion that stops the copy from drifting into permitting a writer — and
    // it is read from SOURCE rather than from two exported constants, because publishing an
    // internal allow-list on the packaged surface for a test's convenience is a worse trade
    // than reading the literal each list is actually written as.
    const literal = (file: string, declaration: string): string[] => {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      const start = source.indexOf(declaration);
      expect(start, `${declaration} not found in ${file}`).toBeGreaterThanOrEqual(0);
      const open = source.indexOf("[", start);
      const close = source.indexOf("]", open);
      expect(close, `${declaration} is not a literal array in ${file}`).toBeGreaterThan(open);
      const tools = [...source.slice(open, close).matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
      expect(tools.length, `${declaration} parsed as empty in ${file}`).toBeGreaterThan(0);
      return tools;
    };
    const hostSafe = new Set(literal("extensions/_shared/agent-read-only-policy.ts", "const READ_ONLY_SAFE_TOOLS"));
    const runtimeNoWrite = literal("extensions/_shared/workflow-runtime.ts", "const AGENT_NO_WRITE_TOOLS");

    expect(runtimeNoWrite.filter((tool) => !hostSafe.has(tool))).toEqual([]);
  });
});

describe("agent attempts — retry behaviour", () => {
  it("re-runs the identical request after a transport failure and returns the second answer", async () => {
    const { dsl, requests, getJournal } = scriptedRuntime("attempts-retry-then-succeed", [
      transportFailure(),
      completed("second answer"),
    ]);

    await expect(dsl.agent("summarize", RETRYABLE_CALL)).resolves.toBe("second answer");
    expect(requests).toHaveLength(2);
    // Identical prompt: a transport retry re-sends the request, it does not repair it.
    expect(requests[0]?.prompt).toBe(requests[1]?.prompt);
    // D5: each physical attempt is a real agent call with its own identity.
    expect(requests.map((request) => request.callId)).toEqual(["call-0001", "call-0002"]);
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends.map((line) => [line.callId, line.status, line.failureCause])).toEqual([
      ["call-0001", "failed", "host-turn-timeout"],
      ["call-0002", "completed", undefined],
    ]);
  });

  it("gives two interleaved parallel calls their own logical identity", async () => {
    // `parallel()` may run two calls that agree on agent, label, phase and group, and their
    // physical attempts then interleave. Nothing descriptive tells them apart, so each
    // logical call carries its own identity and every attempt of it repeats that identity.
    // Without it a reader grouping the journal by the descriptive fields attributes one
    // call's discarded attempt to the other.
    let started = 0;
    let releaseFirstRound: (() => void) | undefined;
    const bothFirstAttemptsStarted = new Promise<void>((resolve) => {
      releaseFirstRound = resolve;
    });
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "attempts-parallel-interleaved",
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        started += 1;
        if (started <= 2) {
          // Hold both first attempts open until each has begun, so the two calls provably
          // interleave rather than running one after the other.
          if (started === 2) releaseFirstRound?.();
          await bothFirstAttemptsStarted;
          return transportFailure();
        }
        return completed(`answer for ${request.callId ?? "?"}`);
      },
    });

    await dsl.parallel([
      () => dsl.agent("advise A", { ...RETRYABLE_CALL, label: "advise", phase: "advise" }),
      () => dsl.agent("advise B", { ...RETRYABLE_CALL, label: "advise", phase: "advise" }),
    ]);

    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends).toHaveLength(4);
    // The first two ends are the two DIFFERENT calls' first attempts — the interleaving.
    expect(ends[0]?.attempt).toBe(1);
    expect(ends[1]?.attempt).toBe(1);
    expect(ends[0]?.logicalCallId).not.toBe(ends[1]?.logicalCallId);
    const byLogicalCall = new Map<string, string[]>();
    for (const line of ends) {
      const key = line.logicalCallId ?? "none";
      byLogicalCall.set(key, [...(byLogicalCall.get(key) ?? []), line.callId ?? "none"]);
    }
    // Two logical calls, two physical attempts each, four distinct children in total.
    expect([...byLogicalCall.values()].map((callIds) => callIds.length)).toEqual([2, 2]);
    expect(new Set([...byLogicalCall.values()].flat()).size).toBe(4);
  });

  it("writes a journal a reader accepts, retry line included", async () => {
    // Every line the retry path emits is persisted and read back by the same validator the
    // run viewer uses. A field the journal does not allow for its kind would surface here as
    // a structural diagnostic rather than in a live run three weeks later.
    const root = mkdtempSync(path.join(tmpdir(), "locus-transport-journal-"));
    const runId = "20260729-120000-abcd";
    let index = 0;
    const results: WorkflowAgentResult[] = [transportFailure(), completed("second answer")];
    const { dsl } = createWorkflowRuntime({
      runId,
      projectRoot: root,
      journal: createWorkflowJournalSink(root, runId),
      agentRunner: async (): Promise<WorkflowAgentResult> => results[Math.min(index++, results.length - 1)]!,
    });

    await expect(dsl.agent("summarize", { ...RETRYABLE_CALL, label: "summary" })).resolves.toBe("second answer");

    const read = readWorkflowRunJournalState(root, runId);
    expect(read.diagnostics).toEqual([]);
    const retryLines = read.lines.filter((line) => line.message?.startsWith("[workflow:retry]") === true);
    expect(retryLines).toHaveLength(1);
    expect(retryLines[0]?.message).toContain("host-turn-timeout");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed on exhaustion, naming the LAST cause", async () => {
    const { dsl, requests, getJournal } = scriptedRuntime("attempts-exhausted", [
      transportFailure("host-turn-timeout"),
      transportFailure("call-timeout"),
    ]);

    await expect(dsl.agent("summarize", { readOnly: true, attempts: 2 })).rejects.toThrow(/budget and was aborted/u);
    expect(requests).toHaveLength(2);
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends.at(-1)?.failureCause).toBe("call-timeout");
  });

  it.each([
    ["sdk-unavailable"],
    ["cancelled"],
    ["tool-call-budget"],
    ["provider-error"],
    ["unparseable-answer"],
    ["run-policy-blocked"],
    ["unknown-agent"],
    ["workspace-allocation"],
    ["empty-answer"],
    ["answer-too-long"],
    ["script-rejected"],
    ["unclassified"],
  ] as const)("spends no attempt on a %s failure", async (cause) => {
    const { dsl, requests } = scriptedRuntime(`attempts-never-retry-${cause}`, [
      {
        ok: false,
        status: "failed",
        failureCause: cause,
        summary: `failed: ${cause}`,
        diagnostics: [],
        agent: "default",
      },
      completed("must not be reached"),
    ]);

    await expect(dsl.agent("summarize", { readOnly: true, attempts: 3 })).rejects.toThrow(new RegExp(cause, "u"));
    expect(requests).toHaveLength(1);
  });

  it("spends no attempt on a result written before the cause field existed", async () => {
    const { dsl, requests } = scriptedRuntime("attempts-legacy", [
      {
        ok: false,
        status: "failed",
        summary: "Child agent turn exceeded its budget.",
        diagnostics: [],
        agent: "default",
      },
      completed("must not be reached"),
    ]);

    await expect(dsl.agent("summarize", { readOnly: true, attempts: 3 })).rejects.toThrow(/exceeded its budget/u);
    expect(requests).toHaveLength(1);
  });

  it("never retries a THROWN failure — a throw carries no classified cause", async () => {
    let children = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "attempts-thrown",
      agentRunner: async () => {
        children += 1;
        throw new Error("host substrate is gone");
      },
    });

    await expect(dsl.agent("summarize", RETRYABLE_CALL)).rejects.toThrow(/host substrate is gone/u);
    expect(children).toBe(1);
  });

  it("charges every discarded attempt to the run invocation cap", async () => {
    const { dsl, requests } = scriptedRuntime(
      "attempts-cap",
      [transportFailure(), transportFailure(), completed("never reached")],
      { maxTotalAgentInvocations: 2 },
    );

    await expect(dsl.agent("summarize", { readOnly: true, attempts: 3 })).rejects.toThrow(
      /exceeded maxTotalAgentInvocations cap of 2/u,
    );
    // Two children ran and both were counted; the third breached the cap before running.
    expect(requests).toHaveLength(2);
  });
});

describe("agent attempts — replay", () => {
  /** A replay controller that records real ordinals so the count can be asserted. */
  function recordingReplay() {
    const begun: string[] = [];
    const recorded: Array<{ ok: boolean }> = [];
    const controller: WorkflowReplayController = {
      beginAgentAttempt: (canonicalRequest) => {
        begun.push(canonicalRequest);
        return { replayed: false, reason: "no-record" };
      },
      recordAgentAttempt: (_canonicalRequest, outcome) => {
        recorded.push({ ok: outcome.ok });
      },
      resolveValue: (_kind, produce) => produce(),
      counts: () => ({ replayedCalls: 0, freshCalls: begun.length }),
    };
    return { controller, begun, recorded };
  }

  it("opens ONE replay ordinal per logical call, however many children it took", async () => {
    const { controller, begun, recorded } = recordingReplay();
    const { dsl, requests } = scriptedRuntime(
      "attempts-one-ordinal",
      [transportFailure(), completed("first"), transportFailure(), completed("second")],
      { replay: controller },
    );

    await expect(dsl.agent("stage-1", RETRYABLE_CALL)).resolves.toBe("first");
    await expect(dsl.agent("stage-2", RETRYABLE_CALL)).resolves.toBe("second");

    // Four physical children, two script-level calls, two ordinals. A per-attempt ordinal
    // would shift every later call on resume and trip the divergence latch.
    expect(requests).toHaveLength(4);
    expect(begun).toHaveLength(2);
    expect(recorded).toEqual([{ ok: true }, { ok: true }]);
  });

  it("keeps attempts out of the recorded request so an old recording still replays", async () => {
    const withoutAttempts = recordingReplay();
    const plain = scriptedRuntime("attempts-key-plain", [completed("x")], { replay: withoutAttempts.controller });
    await plain.dsl.agent("summarize", { readOnly: true });

    const withAttempts = recordingReplay();
    const retrying = scriptedRuntime("attempts-key-retry", [completed("x")], { replay: withAttempts.controller });
    await retrying.dsl.agent("summarize", { readOnly: true, attempts: 3 });

    expect(withAttempts.begun[0]).toBe(withoutAttempts.begun[0]);
  });
});

describe("agent attempts — the D13 product with the shape-repair loop", () => {
  const COUNT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["count"],
    properties: { count: { type: "integer" } },
  };

  it("multiplies the shape loop: transport-fail → off-shape → transport-fail → valid", async () => {
    const { controller, begun } = (() => {
      const begunKeys: string[] = [];
      const ctrl: WorkflowReplayController = {
        beginAgentAttempt: (key) => {
          begunKeys.push(key);
          return { replayed: false, reason: "no-record" };
        },
        recordAgentAttempt: () => {},
        resolveValue: (_kind, produce) => produce(),
        counts: () => ({ replayedCalls: 0, freshCalls: begunKeys.length }),
      };
      return { controller: ctrl, begun: begunKeys };
    })();

    const sequence: WorkflowAgentResult[] = [
      transportFailure(), // shape attempt 1, physical attempt 1 — discarded
      completed('```json\n{"count":"three"}\n```'), // shape attempt 1, physical 2 — off shape
      transportFailure(), // shape attempt 2, physical 1 — discarded
      completed('```json\n{"count":3}\n```'), // shape attempt 2, physical 2 — valid
    ];
    const { dsl, requests, getJournal } = scriptedRuntime("attempts-grid", sequence, { replay: controller });

    await expect(dsl.agent("count them", { readOnly: true, attempts: 2, schema: COUNT_SCHEMA })).resolves.toEqual({
      count: 3,
    });

    // Four physical children for one script-level call: attempts × shape attempts.
    expect(requests).toHaveLength(4);
    // Each is a distinct agent call with its own identity and its own cap charge.
    expect(requests.map((request) => request.callId)).toEqual(["call-0001", "call-0002", "call-0003", "call-0004"]);
    // One replay ordinal per SHAPED attempt: each shape attempt carries its own prompt,
    // so it is its own logical call; the transport retries inside it are not.
    expect(begun).toHaveLength(2);
    expect(new Set(begun).size).toBe(2);
    const ends = getJournal().filter((line) => line.kind === "agent_end");
    expect(ends.map((line) => line.status)).toEqual(["failed", "completed", "failed", "completed"]);
  });

  it("ends the run on transport exhaustion instead of spending the next shape attempt", async () => {
    const { dsl, requests } = scriptedRuntime("attempts-exhaustion-precedence", [
      transportFailure(),
      transportFailure(),
      completed('```json\n{"count":3}\n```'),
    ]);

    // The child never answered, so there is nothing for the shape loop to repair.
    await expect(dsl.agent("count them", { readOnly: true, attempts: 2, schema: COUNT_SCHEMA })).rejects.toThrow(
      /budget and was aborted/u,
    );
    expect(requests).toHaveLength(2);
  });

  it("reads the option only in the logical call, never inside the shape loop", () => {
    // A transport retry that leaked into the shape budget would re-ask a child that
    // ANSWERED, which is the one thing the retry must never do. This pins WHERE the
    // option is read, by function, rather than by how the file happens to be laid out.
    const source = readFileSync(path.join(process.cwd(), "extensions", "_shared", "workflow-runtime.ts"), "utf8");
    const lines = source.split("\n");
    const lineOf = (needle: string): number => {
      const index = lines.findIndex((line) => line.includes(needle));
      expect(index, `expected to find ${needle}`).toBeGreaterThanOrEqual(0);
      return index;
    };
    const logicalStart = lineOf("async function runAgentAttempt(");
    const physicalStart = lineOf("async function runPhysicalAgentAttempt(");
    const shapedStart = lineOf("async function agentDsl(prompt: string, opts?: WorkflowAgentAnyOptions)");
    const shapedEnd = lineOf("async function parallel<T>(");
    expect(logicalStart).toBeLessThan(physicalStart);
    expect(physicalStart).toBeLessThan(shapedStart);
    expect(shapedStart).toBeLessThan(shapedEnd);

    // The declared option is read exactly once, inside the logical call.
    const optionReads = lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => /\bopts\??\.attempts\b/u.test(entry.line));
    expect(optionReads).toHaveLength(1);
    expect(optionReads[0]!.index).toBeGreaterThan(logicalStart);
    expect(optionReads[0]!.index).toBeLessThan(physicalStart);

    // The shape loop never sees it, and the transport loop never sees the shape budget.
    const shapedBody = lines.slice(shapedStart, shapedEnd).join("\n");
    expect(shapedBody).not.toMatch(/\bopts\??\.attempts\b/u);
    const transportBody = lines.slice(logicalStart, physicalStart).join("\n");
    expect(transportBody).not.toContain("SCHEMA_MAX_ATTEMPTS");
    expect(transportBody).not.toContain("checkAgentSchema(");
  });
});

describe("agent attempts — a real call-timeout on an artifact-backed child", () => {
  /**
   * The retry loop only ever sees a RETURNED result. Anything that throws inside a physical
   * attempt bypasses it, and evidence adoption throws by design when a fresh child reports a
   * session id without a persisted result envelope.
   *
   * So the whole `attempts` option hung on one field survival: the bridge's per-call fuse
   * built its own failure literal and dropped `boundary.resultArtifact`, which made adoption
   * throw on exactly the failure class `attempts` exists to absorb. Every earlier test drove
   * the bridge alone, declared no retry and adopted no evidence, so all of them passed while
   * the real path could not retry once.
   *
   * This case is deliberately end to end — real workflow script, real bridge, real evidence
   * adoption, real journal, real report — because every layer in that list is where the
   * regression hid.
   */
  it("retries, keeps the discarded attempt's evidence, and persists call-timeout in the envelope", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-transport-timeout-e2e-"));
    mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
    writeFileSync(
      path.join(root, ".agents", "agents", "default.md"),
      "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
      "utf8",
    );
    mkdirSync(path.join(root, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "workflows", "fused.workflow.mjs"),
      [
        "export default async function runWorkflow(dsl) {",
        '  return await dsl.agent("answer", {',
        '    artifact: "review.md",',
        '    label: "scout",',
        '    phase: "review",',
        "    readOnly: true,",
        "    attempts: 2,",
        "    timeoutMs: 30,",
        "  });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const harness = createHarness(root, { sessionId: "transport-timeout-e2e" });
    let child = 0;
    const createExecutor = (options: { reportsDir?: string }): AgentExecutor => ({
      async run(request: AgentRunRequest, signal: AbortSignal) {
        child += 1;
        const childId = `child-${String(child)}`;
        expect(options.reportsDir).toBeDefined();
        mkdirSync(options.reportsDir!, { recursive: true });
        const tracePath = path.join(options.reportsDir!, `${childId}.jsonl`);
        writeFileSync(tracePath, `${JSON.stringify({ type: "session", id: childId })}\n`, "utf8");
        const childEvidence = {
          childSession: { id: childId, createdAt: "now", metadata: {} },
          childTrace: { path: tracePath, format: "pi-session-jsonl" as const, childSessionId: childId },
        };
        // First child hangs until the CALL fuse aborts it — a real timeout, not a
        // hand-written `failureCause`. It still exported a transcript and still had its
        // envelope written, exactly like a real aborted child.
        if (child === 1) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            status: "cancelled" as const,
            agentName: request.agent.name,
            reason: "aborted",
            diagnostics: [],
            lifecycleEntryIds: [],
            ...childEvidence,
          };
        }
        return {
          status: "completed" as const,
          agentName: request.agent.name,
          reason: "exact answer",
          text: "exact answer",
          diagnostics: [],
          lifecycleEntryIds: [],
          ...childEvidence,
        };
      },
    });

    const result = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "fused",
      createExecutor,
    });

    // The run reached its answer, which it cannot do if adoption threw past the retry loop.
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(child).toBe(2);

    // The discarded attempt's evidence was ADOPTED, not lost: transcript and result envelope
    // for call-0001 are both in the run's own artifact index.
    const index = JSON.parse(readFileSync(path.join(result.runDir, "artifacts", "index.json"), "utf8")) as {
      artifacts: { kind: string; callId?: string; relativePath: string }[];
    };
    const firstAttempt = index.artifacts.filter((entry) => entry.callId === "call-0001");
    expect(firstAttempt.map((entry) => entry.kind).sort()).toEqual(["result", "transcript"]);

    // The DURABLE per-call record carries the machine-readable cause, and it is the FINAL
    // one: the host saw a cancellation, the bridge's own fuse owns the classification.
    const readEnvelope = (callId: string): { version: string; status: string; failureCause?: string } => {
      const record = index.artifacts.find((entry) => entry.callId === callId && entry.kind === "result");
      expect(record, `no result envelope adopted for ${callId}`).toBeDefined();
      const wrapper = JSON.parse(readFileSync(path.join(result.runDir, "artifacts", record!.relativePath), "utf8")) as {
        content: string;
      };
      return JSON.parse(wrapper.content) as { version: string; status: string; failureCause?: string };
    };
    const persisted = readEnvelope("call-0001");
    expect(persisted.version).toBe("locus.agent.run-result.v1");
    expect(persisted.failureCause).toBe("call-timeout");
    // A completed attempt has no cause to persist, and must not invent one.
    expect(readEnvelope("call-0002").failureCause).toBeUndefined();

    // The journal agrees with the envelope, rather than the two disagreeing about one call.
    const journal = readWorkflowRunJournalState(root, result.runId);
    expect(journal.diagnostics).toEqual([]);
    expect(
      journal.lines
        .filter((line) => line.kind === "agent_end")
        .map((line) => [line.callId, line.attempt, line.attempts, line.status, line.failureCause]),
    ).toEqual([
      ["call-0001", 1, 2, "failed", "call-timeout"],
      ["call-0002", 2, 2, "completed", undefined],
    ]);

    rmSync(root, { recursive: true, force: true });
  });
});
