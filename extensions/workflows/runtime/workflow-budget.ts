/**
 * workflow-budget.ts — ONE package-level answer to "how much is a workflow run
 * allowed to spend", on every axis the host can actually enforce.
 *
 * Before this module the two defaults that existed lived 580 lines apart in
 * `workflow-runtime.ts` with no cross-reference, and the axes that mattered most
 * (global concurrency, run wall clock) had no default at all. A contract a reader
 * cannot see in one place is not a contract, so every axis is one field of one
 * frozen object here and every other module reads it from here.
 *
 * Pure data and pure functions. No fs / process / network; no import of the
 * runtime, so the runtime can import this without a cycle.
 *
 * What this module is NOT: an enforcement point. It declares the numbers and the
 * override arithmetic; `workflow-runner.ts` applies them to a run and
 * `workflow-runtime.ts` enforces them per call.
 */

/**
 * The seven axes a workflow run is bounded on.
 *
 * Three are run-level (`concurrency`, `totalAgents`, `runtimeMs`) and four are
 * per-call (`timeoutMs`, `toolCalls`, `turns`, `answerChars`). Tokens and cost are
 * deliberately absent: `costTotal` is a hardcoded `0`
 * (`workflow-agent-bridge.ts`), and a limit over a stub is a gate that reports
 * "under budget" forever. They are reported, not enforced.
 */
export interface WorkflowBudget {
  /** Global simultaneous leaf-agent executions across the whole run. */
  concurrency: number;
  /** Total `agent()` invocations one run may make, counting nested and retried ones. */
  totalAgents: number;
  /** Wall clock over the agent chain, in milliseconds. Checked when a child starts. */
  runtimeMs: number;
  /** Wall-clock fuse for ONE child attempt, in milliseconds. */
  timeoutMs: number;
  /** Tool calls one child attempt may start. */
  toolCalls: number;
  /** Assistant turns one child attempt may take. */
  turns: number;
  /** Characters one child answer may return. */
  answerChars: number;
}

/**
 * The package defaults. Every number is a spend policy with a named failure mode,
 * not a guess; the one-line rationale on each field is the whole point of the
 * module, because the next reader has to be able to move one of them knowingly.
 */
export const DEFAULT_WORKFLOW_BUDGET: Readonly<WorkflowBudget> = Object.freeze({
  // Equal to today's per-call SCHEDULER_WIDTH, so every existing shape behaves
  // identically and only NESTED fan-out is newly bounded. There is no correctness
  // failure on this axis — too low only makes a run slow — which is why it can be tight.
  concurrency: 4,
  // A runaway loop is the failure this axis exists for. Fine-grained decomposition
  // can legitimately reach 10 scripts x 10 questions x 2 stages before discovery,
  // review, or retries, so 200 is ordinary-workload territory. 10,000 leaves that
  // work unconstrained while retaining a named finite stop for a genuine loop.
  totalAgents: 10_000,
  // Emergency host fuse, not an authoring deadline. Progressing weak-model and
  // fine-grained runs must not inherit the former two-hour ordinary stop.
  runtimeMs: 86_400_000,
  // Emergency per-child host fuse. Explicit tighter operator/call limits remain
  // supported and journaled; ordinary work gets a full day before time is a stop.
  timeoutMs: 86_400_000,
  // Unchanged from DEFAULT_WORKFLOW_AGENT_MAX_TOOL_CALLS. A different value would
  // invalidate every replay record for no observed benefit: no stage approaches it,
  // and stages that need less already narrow to 40 or 0.
  toolCalls: 1_000,
  // Host maximum. Turn count no longer ends ordinary long reasoning at the old
  // hidden five-turn default; explicit tighter limits remain available.
  turns: 20,
  // Above the largest curated per-stage bound (256_000) or the shipped examples
  // would break on their first run. This is a fuse against a pathological answer,
  // not a work target; per-stage narrowing stays the script's job.
  answerChars: 500_000,
});

/** Every axis name, in the order the journal and the run report print them. */
export const WORKFLOW_BUDGET_AXES: readonly (keyof WorkflowBudget)[] = Object.freeze([
  "concurrency",
  "totalAgents",
  "runtimeMs",
  "timeoutMs",
  "toolCalls",
  "turns",
  "answerChars",
] as const);

/**
 * The SDK host kills a child at `turnTimeoutMs * maxTurns`
 * (`agent-sdk-host.ts`), independently of the bridge's own fuse. Two deadlines at
 * the same instant make the failure an operator reads nondeterministic, so the
 * declared `timeoutMs` is the authority and the SDK budget is DERIVED from it —
 * strictly above it, by this margin per turn, so the workflow-level named failure
 * always wins and the SDK budget stays a backstop that cannot fire first.
 */
export const WORKFLOW_SDK_BACKSTOP_MARGIN_MS = 5_000;

/** Node's timer implementation clamps a larger delay to 1 ms. */
export const NODE_TIMER_MAX_DELAY_MS = 2_147_483_647;

/** The host accepts 1..20 assistant turns for one child. */
export const WORKFLOW_AGENT_MIN_TURNS = 1;
export const WORKFLOW_AGENT_MAX_TURNS = 20;

/**
 * Largest workflow fuse that remains a real timer even after the SDK backstop is
 * derived at the host's maximum turn count.
 *
 * `n * ceil(timeoutMs / n)` can exceed `timeoutMs` by at most `n - 1`; the SDK
 * then adds `n * WORKFLOW_SDK_BACKSTOP_MARGIN_MS`. Reserving both terms at
 * `n = 20` keeps the workflow timer and the multiplied SDK timer at or below
 * Node's maximum delay. Without this cap Node warns and schedules the supposed
 * long timeout after roughly one millisecond.
 */
export const WORKFLOW_MAX_TIMEOUT_MS =
  NODE_TIMER_MAX_DELAY_MS - WORKFLOW_AGENT_MAX_TURNS * WORKFLOW_SDK_BACKSTOP_MARGIN_MS - (WORKFLOW_AGENT_MAX_TURNS - 1);

/**
 * The SDK per-turn timeout derived from one call's declared fuse.
 *
 * `turnBudgetMs = workflowSdkTurnTimeoutMs(t, n) * n >= t + n * MARGIN > t` for
 * every `n >= 1`, so the workflow fuse is always the first deadline to expire.
 * With the package defaults this is a host backstop strictly later than the
 * workflow's 24-hour emergency fuse.
 */
export function workflowSdkTurnTimeoutMs(timeoutMs: number, maxTurns: number): number {
  assertWorkflowBudgetValue("timeoutMs", timeoutMs);
  assertWorkflowBudgetValue("turns", maxTurns);
  const turns = maxTurns;
  return Math.ceil(timeoutMs / turns) + WORKFLOW_SDK_BACKSTOP_MARGIN_MS;
}

/** One axis a caller asked to raise above the value that would otherwise apply. */
export interface WorkflowBudgetRaise {
  axis: keyof WorkflowBudget;
  /** The value that would have applied — the package default for a run-level
   *  override, the run's applied default for a per-call one. */
  applied: number;
  /** What the caller asked for. */
  requested: number;
}

export interface ResolvedWorkflowBudget {
  budget: WorkflowBudget;
  /** Empty when every supplied value narrowed or matched. Never silent otherwise. */
  raises: WorkflowBudgetRaise[];
}

/**
 * Apply a partial override to the package contract.
 *
 * Narrowing is free and silent. Raising is allowed — a down-only rule would make
 * a legitimately long workflow unauthorable and the operator would answer by
 * raising the package default for everyone, which is the worse outcome — but it
 * is never silent: every raise comes back as a record the caller journals.
 *
 * `undefined` on an axis means "unstated", which is not the same as "default":
 * an explicit value equal to the default is still not a raise, and an explicit
 * invalid value is refused rather than ignored. The same rule reaches the key
 * set: the object is closed over the axes, so a typo or a removed option is
 * named rather than quietly replaced by the package default.
 */
export function resolveWorkflowBudget(override?: Partial<WorkflowBudget>): ResolvedWorkflowBudget {
  const budget: WorkflowBudget = { ...DEFAULT_WORKFLOW_BUDGET };
  const raises: WorkflowBudgetRaise[] = [];
  if (override === undefined) return { budget, raises };
  assertClosedWorkflowBudgetKeys(override);
  for (const axis of WORKFLOW_BUDGET_AXES) {
    const requested = override[axis];
    if (requested === undefined) continue;
    assertWorkflowBudgetValue(axis, requested);
    const applied = DEFAULT_WORKFLOW_BUDGET[axis];
    if (requested > applied) raises.push({ axis, applied, requested });
    budget[axis] = requested;
  }
  return { budget, raises };
}

/**
 * Options this object REPLACED, mapped to the axis that now carries them.
 *
 * `RunWorkflowScriptOptions.maxTotalAgentInvocations` became `budget.totalAgents`.
 * TypeScript catches the old spelling on an object literal, but an embedder in
 * plain JS — or one whose value passed through a widened variable — would have
 * had its explicit bound dropped on the floor and silently replaced by the
 * package default. A removed option that still reads as configuration is worse
 * than a missing one, so it is named at the boundary instead.
 */
const REMOVED_WORKFLOW_BUDGET_KEYS: Readonly<Record<string, keyof WorkflowBudget>> = Object.freeze({
  maxTotalAgentInvocations: "totalAgents",
});

/**
 * The override is a CLOSED seven-key object. An unrecognised key with a real
 * value is a bound its author believed was applied; ignoring it is the silent
 * fallback `resolveWorkflowBudget` exists to refuse, and it would be invisible
 * in the journal because a raise that was never read cannot be reported.
 *
 * An unknown key whose value is `undefined` asks for nothing, so it is allowed —
 * the same "unstated is not default" rule the axes themselves follow, and it
 * keeps a spread-built override from failing over a key nobody set.
 */
function assertClosedWorkflowBudgetKeys(override: Partial<WorkflowBudget>): void {
  const axes = new Set<string>(WORKFLOW_BUDGET_AXES);
  for (const [key, value] of Object.entries(override)) {
    if (axes.has(key) || value === undefined) continue;
    const replacement = REMOVED_WORKFLOW_BUDGET_KEYS[key];
    throw new Error(
      replacement === undefined
        ? `workflow budget has no axis ${key}; the axes are ${WORKFLOW_BUDGET_AXES.join(", ")}`
        : `workflow budget option ${key} was removed; use budget.${replacement} instead`,
    );
  }
}

/**
 * Fail closed on a value that could never bound a real run. A zero or negative
 * axis is not a tight budget, it is a bug that would refuse the first child; a
 * fractional one would compare unpredictably against integer counters.
 */
export function assertWorkflowBudgetValue(axis: keyof WorkflowBudget, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`workflow budget ${axis} must be a positive safe integer`);
  }
  if (axis === "turns" && value > WORKFLOW_AGENT_MAX_TURNS) {
    throw new Error(
      `workflow budget turns must be an integer between ${WORKFLOW_AGENT_MIN_TURNS} and ${WORKFLOW_AGENT_MAX_TURNS}`,
    );
  }
  if (axis === "timeoutMs" && value > WORKFLOW_MAX_TIMEOUT_MS) {
    throw new Error(
      `workflow budget timeoutMs must not exceed ${WORKFLOW_MAX_TIMEOUT_MS}; larger values cannot be represented by Node timers with the SDK backstop`,
    );
  }
}

/**
 * The one prelude line a run emits before any workflow code runs. It is a `log`
 * line rather than a new journal kind on purpose: a new kind would touch every
 * journal reader for a string.
 */
export function formatWorkflowBudgetPrelude(budget: WorkflowBudget): string {
  const fields = WORKFLOW_BUDGET_AXES.map((axis) => `${axis}=${String(budget[axis])}`).join(" ");
  return `[workflow:budget] applied ${fields}`;
}

/** The line one raise emits. Names the axis, the value that would have applied,
 *  and what was asked for, so the raise is auditable from the journal alone. */
export function formatWorkflowBudgetRaise(raise: WorkflowBudgetRaise, scope: "run" | "call"): string {
  return (
    `[workflow:budget] ${scope} raised ${raise.axis} above the applied default: ` +
    `default=${String(raise.applied)} requested=${String(raise.requested)}`
  );
}
