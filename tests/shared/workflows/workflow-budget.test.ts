import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runner.js";
import {
  DEFAULT_WORKFLOW_BUDGET,
  NODE_TIMER_MAX_DELAY_MS,
  WORKFLOW_AGENT_MAX_TURNS,
  WORKFLOW_BUDGET_AXES,
  WORKFLOW_MAX_TIMEOUT_MS,
  formatWorkflowBudgetPrelude,
  formatWorkflowBudgetRaise,
  resolveWorkflowBudget,
  workflowSdkTurnTimeoutMs,
  type WorkflowBudget,
} from "../../../extensions/_shared/workflow-budget.js";
import { runWorkflowScript } from "../../../extensions/_shared/workflow-runner.js";
import {
  DEFAULT_MAX_TOTAL_AGENT_INVOCATIONS,
  DEFAULT_WORKFLOW_AGENT_MAX_TOOL_CALLS,
  WorkflowRunDeadlineError,
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowJournalLine,
} from "../../../extensions/_shared/workflow-runtime.js";
import { createHarness } from "../../test-harness.js";

/**
 * T-131 — the package budget contract, and the run wall clock that had no
 * default at all before it.
 *
 * The values are asserted verbatim on purpose. They are an owner-approved spend
 * policy, so a change to one of them must break a test and be re-decided, not
 * ride along in a refactor.
 */

describe("DEFAULT_WORKFLOW_BUDGET", () => {
  it("carries the seven owner-approved values", () => {
    expect(DEFAULT_WORKFLOW_BUDGET).toEqual({
      concurrency: 4,
      totalAgents: 200,
      runtimeMs: 7_200_000,
      timeoutMs: 600_000,
      toolCalls: 1_000,
      turns: 5,
      answerChars: 500_000,
    });
  });

  it("is frozen, so no consumer can mutate the package promise at runtime", () => {
    expect(Object.isFrozen(DEFAULT_WORKFLOW_BUDGET)).toBe(true);
    expect(() => {
      (DEFAULT_WORKFLOW_BUDGET as WorkflowBudget).concurrency = 99;
    }).toThrow(TypeError);
    expect(DEFAULT_WORKFLOW_BUDGET.concurrency).toBe(4);
  });

  it("names every axis exactly once in WORKFLOW_BUDGET_AXES", () => {
    expect([...WORKFLOW_BUDGET_AXES].sort()).toEqual(Object.keys(DEFAULT_WORKFLOW_BUDGET).sort());
    expect(new Set(WORKFLOW_BUDGET_AXES).size).toBe(WORKFLOW_BUDGET_AXES.length);
  });

  it("is the single source of the two constants that used to live 580 lines apart", () => {
    expect(DEFAULT_WORKFLOW_AGENT_MAX_TOOL_CALLS).toBe(DEFAULT_WORKFLOW_BUDGET.toolCalls);
    expect(DEFAULT_MAX_TOTAL_AGENT_INVOCATIONS).toBe(DEFAULT_WORKFLOW_BUDGET.totalAgents);
  });
});

describe("resolveWorkflowBudget", () => {
  it("returns the package contract when nothing is overridden", () => {
    const resolved = resolveWorkflowBudget();
    expect(resolved.budget).toEqual(DEFAULT_WORKFLOW_BUDGET);
    expect(resolved.raises).toEqual([]);
  });

  it("lets a narrowing override apply silently", () => {
    const resolved = resolveWorkflowBudget({ concurrency: 1, totalAgents: 3 });
    expect(resolved.budget.concurrency).toBe(1);
    expect(resolved.budget.totalAgents).toBe(3);
    expect(resolved.raises).toEqual([]);
  });

  it("treats a value equal to the default as no raise at all", () => {
    const resolved = resolveWorkflowBudget({ turns: DEFAULT_WORKFLOW_BUDGET.turns });
    expect(resolved.raises).toEqual([]);
  });

  it("records a raise instead of refusing it or hiding it", () => {
    const resolved = resolveWorkflowBudget({ runtimeMs: 14_400_000 });
    expect(resolved.budget.runtimeMs).toBe(14_400_000);
    expect(resolved.raises).toEqual([{ axis: "runtimeMs", applied: 7_200_000, requested: 14_400_000 }]);
  });

  it("refuses a run-level turns override outside the host clamp before calling it applied", () => {
    expect(() => resolveWorkflowBudget({ turns: 25 })).toThrow(
      /workflow budget turns must be an integer between 1 and 20/u,
    );
  });

  it("refuses a timeout that Node would clamp to a one-millisecond timer", () => {
    expect(() => resolveWorkflowBudget({ timeoutMs: WORKFLOW_MAX_TIMEOUT_MS + 1 })).toThrow(
      /cannot be represented by Node timers with the SDK backstop/u,
    );
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses a value that could never bound a run (%s)", (value) => {
    expect(() => resolveWorkflowBudget({ concurrency: value })).toThrow(
      /workflow budget concurrency must be a positive safe integer/u,
    );
  });

  it("never mutates the frozen package contract", () => {
    resolveWorkflowBudget({ toolCalls: 5 });
    expect(DEFAULT_WORKFLOW_BUDGET.toolCalls).toBe(1_000);
  });

  it("names the option it replaced instead of silently applying the package default", () => {
    // `RunWorkflowScriptOptions.maxTotalAgentInvocations` became `budget.totalAgents`.
    // TypeScript catches the old spelling on a literal; a JS embedder would have had
    // its explicit cap dropped and replaced by 200 with nothing said.
    expect(() => resolveWorkflowBudget({ maxTotalAgentInvocations: 5 } as unknown as Partial<WorkflowBudget>)).toThrow(
      /workflow budget option maxTotalAgentInvocations was removed; use budget\.totalAgents instead/u,
    );
  });

  it("refuses a key that is not an axis rather than ignoring the bound it carries", () => {
    expect(() => resolveWorkflowBudget({ tolCalls: 40 } as unknown as Partial<WorkflowBudget>)).toThrow(
      /workflow budget has no axis tolCalls/u,
    );
  });

  it("still accepts an unknown key that states nothing, so a spread-built override survives", () => {
    // `undefined` asks for no bound at all — the same rule the axes follow — so it
    // cannot be a silently dropped limit and must not fail a legitimate spread.
    const resolved = resolveWorkflowBudget({
      turns: 2,
      somethingElse: undefined,
    } as unknown as Partial<WorkflowBudget>);
    expect(resolved.budget.turns).toBe(2);
    expect(resolved.raises).toEqual([]);
  });
});

describe("budget journal text", () => {
  it("prints every axis in the prelude line", () => {
    const line = formatWorkflowBudgetPrelude(DEFAULT_WORKFLOW_BUDGET);
    for (const axis of WORKFLOW_BUDGET_AXES) {
      expect(line).toContain(`${axis}=${String(DEFAULT_WORKFLOW_BUDGET[axis])}`);
    }
  });

  it("names axis, applied default and requested value on a raise", () => {
    const line = formatWorkflowBudgetRaise({ axis: "timeoutMs", applied: 600_000, requested: 900_000 }, "call");
    expect(line).toContain("timeoutMs");
    expect(line).toContain("default=600000");
    expect(line).toContain("requested=900000");
    expect(line).toContain("call");
  });
});

describe("workflowSdkTurnTimeoutMs", () => {
  it("keeps the SDK budget strictly above the declared fuse at every legal turn count", () => {
    // The host clamp is 1..20 (`agent-runner.ts`). A tie at ANY of those counts
    // would make the operator's failure text a race, which is the defect D4 removes.
    for (let maxTurns = 1; maxTurns <= 20; maxTurns += 1) {
      for (const timeoutMs of [1, 999, 60_000, 600_000, 7_200_000]) {
        const turnTimeoutMs = workflowSdkTurnTimeoutMs(timeoutMs, maxTurns);
        const sdkBudgetMs = turnTimeoutMs * maxTurns;
        expect(sdkBudgetMs).toBeGreaterThan(timeoutMs);
      }
    }
  });

  it("keeps both real timers within Node's maximum delay at the largest accepted fuse", () => {
    for (let maxTurns = 1; maxTurns <= WORKFLOW_AGENT_MAX_TURNS; maxTurns += 1) {
      const turnTimeoutMs = workflowSdkTurnTimeoutMs(WORKFLOW_MAX_TIMEOUT_MS, maxTurns);
      expect(WORKFLOW_MAX_TIMEOUT_MS).toBeLessThanOrEqual(NODE_TIMER_MAX_DELAY_MS);
      expect(turnTimeoutMs * maxTurns).toBeLessThanOrEqual(NODE_TIMER_MAX_DELAY_MS);
      expect(turnTimeoutMs * maxTurns).toBeGreaterThan(WORKFLOW_MAX_TIMEOUT_MS);
    }
  });

  it("lands five seconds above the 120_000 the host used before the contract existed", () => {
    expect(workflowSdkTurnTimeoutMs(DEFAULT_WORKFLOW_BUDGET.timeoutMs, DEFAULT_WORKFLOW_BUDGET.turns)).toBe(125_000);
  });
});

// ---------------------------------------------------------------------------
// W2 — the runner applies the contract to a run that declares nothing
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-budget-run-"));
  roots.push(root);
  const agents = path.join(root, ".agents", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, "default.md"),
    "---\nname: default\ndescription: Budget test agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
    "utf8",
  );
  return root;
}

function saveWorkflow(root: string, name: string, body: string): void {
  const dir = path.join(root, ".pi", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.workflow.mjs`), body, "utf8");
}

interface ChildObservation {
  /** What the executor factory was handed for this child — the resolved fuses. */
  factory: { maxToolCalls?: number; turnTimeoutMs?: number };
  request: AgentRunRequest;
}

/**
 * Run a saved workflow with a scripted child, capturing what each child was
 * actually bounded by. `onEnter`/`onExit` let a case observe overlap.
 */
async function runSaved(
  root: string,
  name: string,
  options: {
    budget?: Partial<WorkflowBudget>;
    input?: string;
    answer?: (request: AgentRunRequest) => string;
    onEnter?: () => void;
    onExit?: () => void;
    hold?: () => Promise<void>;
  } = {},
) {
  const harness = createHarness(root, { sessionId: `budget-${name}` });
  const children: ChildObservation[] = [];
  const createExecutor = (factory: { maxToolCalls?: number; turnTimeoutMs?: number }): AgentExecutor => ({
    async run(request: AgentRunRequest) {
      children.push({ factory: { ...factory }, request });
      options.onEnter?.();
      if (options.hold !== undefined) await options.hold();
      options.onExit?.();
      return {
        status: "completed" as const,
        agentName: request.agent.name,
        reason: "answered",
        text: options.answer?.(request) ?? `answer(${request.task})`,
        diagnostics: [],
        lifecycleEntryIds: [],
      };
    },
  });
  const result = await runWorkflowScript({
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    name,
    createExecutor,
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  return { result, children };
}

/**
 * The run's append-only journal FILE, not the in-memory mirror `result.journal`
 * returns.
 *
 * An audit record that exists only in the object handed back to the caller is not
 * an audit record: the operator who reads a raise weeks later opens
 * `journal.ndjson`. Every raise assertion below is made against this, so a
 * regression that emitted the line into the mirror alone would fail.
 */
function persistedJournal(runDir: string): WorkflowJournalLine[] {
  return readFileSync(path.join(runDir, "journal.ndjson"), "utf8")
    .split("\n")
    .filter((row) => row.trim() !== "")
    .map((row) => JSON.parse(row) as WorkflowJournalLine);
}

const NO_LIMITS_WORKFLOW = `export const meta = { name: "no-limits", description: "declares no limit of any kind" };
export default async function runWorkflow(dsl) {
  return { answer: await dsl.agent("say something") };
}
`;

/** Four branches, each running its OWN parallel() of three: twelve leaf children.
 *  A FLAT parallel() of twelve is already held to four by SCHEDULER_WIDTH, so it
 *  would go green with the global gate switched off and prove nothing. */
const NESTED_FANOUT_WORKFLOW = `export const meta = { name: "nested-fanout", description: "four branches of three" };
export default async function runWorkflow(dsl) {
  const branch = (n) => () => dsl.parallel([
    () => dsl.agent("leaf " + n + "-1"),
    () => dsl.agent("leaf " + n + "-2"),
    () => dsl.agent("leaf " + n + "-3"),
  ]);
  const out = await dsl.parallel([branch(1), branch(2), branch(3), branch(4)]);
  return { branches: out.length };
}
`;

const LOOP_WORKFLOW = `export const meta = { name: "loop", description: "calls agent() until something stops it" };
export default async function runWorkflow(dsl) {
  let calls = 0;
  for (let i = 0; i < 50; i += 1) {
    await dsl.agent("call " + String(i));
    calls += 1;
  }
  return { calls };
}
`;

describe("the runner applies the budget contract", () => {
  it("bounds a script that declares nothing with the contract tool-call fuse", async () => {
    const root = scratchProject();
    saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);

    const { result, children } = await runSaved(root, "no-limits");

    expect(result.ok, result.error).toBe(true);
    expect(children).toHaveLength(1);
    // The script said nothing; the package contract is what reached the child.
    expect(children[0]?.factory.maxToolCalls).toBe(DEFAULT_WORKFLOW_BUDGET.toolCalls);
  });

  it("holds nested fan-out to the contract concurrency, which SCHEDULER_WIDTH alone does not", async () => {
    const root = scratchProject();
    saveWorkflow(root, "nested-fanout", NESTED_FANOUT_WORKFLOW);
    let active = 0;
    let peak = 0;

    const { result, children } = await runSaved(root, "nested-fanout", {
      onEnter: () => {
        active += 1;
        peak = Math.max(peak, active);
      },
      onExit: () => {
        active -= 1;
      },
      // Long enough that every child the scheduler is willing to start has started.
      hold: () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
    });

    expect(result.ok, result.error).toBe(true);
    expect(children).toHaveLength(12);
    // Without the global gate these twelve overlap: four branch pools of three.
    expect(peak).toBeLessThanOrEqual(DEFAULT_WORKFLOW_BUDGET.concurrency);
  });

  it("fails a call that declared NO maxAnswerChars but overran the contract bound, naming the axis", async () => {
    const root = scratchProject();
    saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);

    const { result } = await runSaved(root, "no-limits", {
      answer: () => "x".repeat(DEFAULT_WORKFLOW_BUDGET.answerChars + 1),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("answerChars");
    expect(result.error).toContain(String(DEFAULT_WORKFLOW_BUDGET.answerChars));
  });

  it("accepts an answer exactly at the contract bound, so the fuse is not off by one", async () => {
    const root = scratchProject();
    saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);

    const { result } = await runSaved(root, "no-limits", {
      answer: () => "x".repeat(DEFAULT_WORKFLOW_BUDGET.answerChars),
    });

    expect(result.ok, result.error).toBe(true);
  });

  it("routes a per-run narrowing through to the invocation cap", async () => {
    const root = scratchProject();
    saveWorkflow(root, "loop", LOOP_WORKFLOW);

    const { result, children } = await runSaved(root, "loop", { budget: { totalAgents: 3 } });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("maxTotalAgentInvocations cap of 3");
    // The call that breached the cap is counted and never reaches a child.
    expect(children).toHaveLength(3);
  });

  it("routes a per-run narrowing through to the run wall clock", async () => {
    const root = scratchProject();
    saveWorkflow(root, "loop", LOOP_WORKFLOW);

    // Each child holds for 30 ms against a 1 ms run budget, so the run cannot reach
    // the script's fiftieth call. No injected clock reaches the runner, so this is
    // the wiring proof the unit cases above cannot give. WHICH call is refused
    // first is deliberately not asserted: on a loaded machine the module import
    // alone can outlast a 1 ms budget, and pinning the ordinal would make the
    // wiring proof a timing bet.
    const { result, children } = await runSaved(root, "loop", {
      budget: { runtimeMs: 1 },
      hold: () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("runtimeMs");
    expect(children.length).toBeLessThan(50);
  });

  it("opens the journal of a run that sets nothing with the applied budget", async () => {
    const root = scratchProject();
    saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);

    const { result } = await runSaved(root, "no-limits");

    const prelude = result.journal[0];
    expect(prelude).toMatchObject({ kind: "log", source: "runtime" });
    for (const axis of WORKFLOW_BUDGET_AXES) {
      expect(prelude?.message).toContain(`${axis}=${String(DEFAULT_WORKFLOW_BUDGET[axis])}`);
    }
    // A run that declares nothing raises nothing.
    expect(result.journal.filter((line) => line.message?.includes("raised"))).toEqual([]);
    // And the same line is on disk, first, where an operator would look for it.
    expect(persistedJournal(result.runDir)[0]?.message).toBe(prelude?.message);
  });

  it("journals a per-run raise naming the axis, the default and the requested value", async () => {
    const root = scratchProject();
    saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);

    const { result } = await runSaved(root, "no-limits", {
      budget: { runtimeMs: DEFAULT_WORKFLOW_BUDGET.runtimeMs * 2, concurrency: 1 },
    });

    const raises = result.journal.filter((line) => line.message?.includes("raised"));
    expect(raises).toHaveLength(1);
    expect(raises[0]).toMatchObject({ kind: "log", source: "runtime" });
    expect(raises[0]?.message).toContain("run raised runtimeMs");
    expect(raises[0]?.message).toContain(`default=${String(DEFAULT_WORKFLOW_BUDGET.runtimeMs)}`);
    expect(raises[0]?.message).toContain(`requested=${String(DEFAULT_WORKFLOW_BUDGET.runtimeMs * 2)}`);
    // The narrowing on the same call stays silent.
    expect(
      result.journal.some((line) => line.message?.includes("concurrency") && line.message.includes("raised")),
    ).toBe(false);
    // The durable record, not the mirror: this is what makes the raise auditable.
    const persisted = persistedJournal(result.runDir).filter((line) => line.message?.includes("raised"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ kind: "log", source: "runtime", message: raises[0]?.message });
  });

  it("journals a per-call raise, which is the surface a workflow script can actually reach", async () => {
    const root = scratchProject();
    saveWorkflow(
      root,
      "raising",
      `export const meta = { name: "raising", description: "asks for more than the package default" };
export default async function runWorkflow(dsl) {
  const narrowed = await dsl.agent("narrow", { maxToolCalls: 10 });
  const raised = await dsl.agent("raise", { timeoutMs: ${DEFAULT_WORKFLOW_BUDGET.timeoutMs * 3} });
  return { narrowed, raised };
}
`,
    );

    const { result } = await runSaved(root, "raising");

    expect(result.ok, result.error).toBe(true);
    const raises = result.journal.filter((line) => line.message?.includes("raised"));
    expect(raises).toHaveLength(1);
    expect(raises[0]?.message).toContain("call raised timeoutMs");
    expect(raises[0]?.message).toContain(`default=${String(DEFAULT_WORKFLOW_BUDGET.timeoutMs)}`);
    expect(raises[0]?.message).toContain(`requested=${String(DEFAULT_WORKFLOW_BUDGET.timeoutMs * 3)}`);
    // A per-call raise travels the runtime's own emit() rather than the runner's
    // prelude, so its durability is a separate claim and gets its own assertion.
    const persisted = persistedJournal(result.runDir).filter((line) => line.message?.includes("raised"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ kind: "log", source: "runtime", message: raises[0]?.message });
  });

  it("refuses a per-run override that could never bound a run", async () => {
    const root = scratchProject();
    saveWorkflow(root, "no-limits", NO_LIMITS_WORKFLOW);

    await expect(runSaved(root, "no-limits", { budget: { concurrency: 0 } })).rejects.toThrow(
      /workflow budget concurrency must be a positive safe integer/u,
    );
  });
});
// ---------------------------------------------------------------------------
// W6 — the run wall clock
// ---------------------------------------------------------------------------

function clockFrom(start: number): { nowMs: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    nowMs: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function answeringRuntime(options: {
  runId: string;
  runtimeMs: number;
  nowMs: () => number;
  onRequest?: (request: WorkflowAgentRequest) => void;
}) {
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId: options.runId,
    runtimeMs: options.runtimeMs,
    nowMs: options.nowMs,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push(request);
      options.onRequest?.(request);
      return {
        ok: true,
        status: "completed",
        summary: "done",
        text: "answer",
        diagnostics: [],
        agent: request.agent,
      };
    },
  });
  return { ...runtime, requests };
}

describe("run wall clock (runtimeMs)", () => {
  it("refuses an already-expired attempt before it occupies a concurrency slot", async () => {
    const clock = clockFrom(0);
    const { dsl, requests, peakAgentConcurrency } = answeringRuntime({
      runId: "deadline-before-admission",
      runtimeMs: 10,
      nowMs: clock.nowMs,
    });

    clock.advance(11);
    await expect(dsl.agent("already late")).rejects.toThrow(WorkflowRunDeadlineError);
    expect(requests).toHaveLength(0);
    expect(peakAgentConcurrency()).toBe(0);
  });

  it("refuses the next child once the deadline has passed, naming the axis", async () => {
    const clock = clockFrom(1_000);
    const { dsl, requests } = answeringRuntime({ runId: "deadline-between", runtimeMs: 60_000, nowMs: clock.nowMs });

    await expect(dsl.agent("first")).resolves.toBe("answer");
    clock.advance(60_001);
    await expect(dsl.agent("second")).rejects.toThrow(WorkflowRunDeadlineError);
    await expect(dsl.agent("third")).rejects.toThrow(/runtimeMs/u);
    // Only the first call ever reached a child.
    expect(requests).toHaveLength(1);
  });

  it("refuses a child nested two groups deep on the same clock, and exits the run rather than failing one branch", async () => {
    const clock = clockFrom(0);
    let started = 0;
    const { dsl } = answeringRuntime({
      runId: "deadline-nested",
      runtimeMs: 10_000,
      nowMs: clock.nowMs,
      onRequest: () => {
        started += 1;
      },
    });

    // One ordinary child burns the whole run budget.
    await expect(dsl.agent("first")).resolves.toBe("answer");
    clock.advance(10_001);

    // A nested group does NOT get a fresh clock, and the refusal is not converted
    // into a per-branch group failure: it leaves the whole run.
    const nested = dsl.parallel([
      () => dsl.parallel([() => dsl.agent("a"), () => dsl.agent("b")]),
      () => dsl.parallel([() => dsl.agent("c"), () => dsl.agent("d")]),
    ]);
    await expect(nested).rejects.toThrow(WorkflowRunDeadlineError);
    await expect(nested).rejects.toThrow(/runtimeMs/u);
    expect(started).toBe(1);
  });

  it("rechecks the deadline after a queued child acquires the global concurrency slot", async () => {
    const clock = clockFrom(0);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const runtime = createWorkflowRuntime({
      runId: "deadline-after-queue",
      runtimeMs: 10,
      nowMs: clock.nowMs,
      maxConcurrentAgents: 1,
      agentRunner: async (request): Promise<WorkflowAgentResult> => {
        started.push(request.prompt);
        if (request.prompt === "first") await firstBlocked;
        return {
          ok: true,
          status: "completed",
          summary: "done",
          text: "answer",
          diagnostics: [],
          agent: request.agent,
        };
      },
    });

    const grouped = runtime.dsl.parallel([() => runtime.dsl.agent("first"), () => runtime.dsl.agent("queued")]);
    // Both calls have entered the runtime; only the first owns the one execution slot.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.getJournal().filter((line) => line.kind === "agent_start")).toHaveLength(2);
    expect(started).toEqual(["first"]);

    clock.advance(11);
    releaseFirst();
    await expect(grouped).rejects.toThrow(WorkflowRunDeadlineError);
    // The queued request is refused at admission and never reaches the child runner.
    expect(started).toEqual(["first"]);
  });

  it("arms the deadline once at construction, not per call", async () => {
    const clock = clockFrom(500);
    const { dsl } = answeringRuntime({ runId: "deadline-armed-once", runtimeMs: 5_000, nowMs: clock.nowMs });

    clock.advance(2_500);
    await expect(dsl.agent("still inside")).resolves.toBe("answer");
    clock.advance(2_500);
    // Exactly at the deadline the budget is spent but not exceeded.
    await expect(dsl.agent("exactly at the deadline")).resolves.toBe("answer");
    clock.advance(1);
    // 5_001 ms since CONSTRUCTION; a per-call clock would still allow this.
    await expect(dsl.agent("now outside")).rejects.toThrow(WorkflowRunDeadlineError);
  });

  it("does NOT bound a script that stops calling agent() — the accepted limit of this design", async () => {
    // Characterisation, not aspiration (D9 cases (a) and (b)). The deadline is a
    // check at agent-attempt start, so pure script work past it completes normally.
    // Asserted here so a later reader sees a chosen scope rather than an untested hole.
    const clock = clockFrom(0);
    const { dsl } = answeringRuntime({ runId: "deadline-script-only", runtimeMs: 1_000, nowMs: clock.nowMs });

    await expect(dsl.agent("one child")).resolves.toBe("answer");
    clock.advance(1_000_000);
    let loops = 0;
    for (let i = 0; i < 1_000; i += 1) {
      dsl.log(`script work ${String(i)}`);
      loops += 1;
    }
    expect(loops).toBe(1_000);
    // The run is still alive and can even finish successfully.
    await expect(dsl.workflow(async () => "done")).resolves.toBe("done");
  });

  it.each([0, -1, 1.5])("refuses a runtimeMs that could never bound a run (%s)", (runtimeMs) => {
    expect(() =>
      createWorkflowRuntime({
        runId: "deadline-invalid",
        runtimeMs,
        agentRunner: async () => {
          throw new Error("must not run");
        },
      }),
    ).toThrow(/workflow budget runtimeMs must be a positive safe integer/u);
  });

  it("leaves a runtime with no runtimeMs unbounded, so existing embedders are unchanged", async () => {
    const clock = clockFrom(0);
    const { dsl } = createWorkflowRuntime({
      runId: "deadline-absent",
      nowMs: clock.nowMs,
      agentRunner: async (request): Promise<WorkflowAgentResult> => ({
        ok: true,
        status: "completed",
        summary: "done",
        text: "answer",
        diagnostics: [],
        agent: request.agent,
      }),
    });

    clock.advance(Number.MAX_SAFE_INTEGER - 1);
    await expect(dsl.agent("late but unbounded")).resolves.toBe("answer");
  });
});
