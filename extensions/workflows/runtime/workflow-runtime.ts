/**
 * workflow-runtime.ts — DSL core (agent/parallel/pipeline/phase/log) + THE single
 * scheduler seam (runScheduled, bounded-concurrency width SCHEDULER_WIDTH) + journal mirror.
 *
 * Pure host-agnostic core. Talks to agents ONLY through an injected WorkflowAgentRunner.
 * No fs / process / require / shell / network anywhere. Unit-testable in isolation.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

import {
  DEFAULT_WORKFLOW_BUDGET,
  WORKFLOW_AGENT_MAX_TURNS,
  WORKFLOW_AGENT_MIN_TURNS,
  WORKFLOW_MAX_TIMEOUT_MS,
  assertWorkflowBudgetValue,
  formatWorkflowBudgetRaise,
  type WorkflowBudget,
} from "./workflow-budget.js";
import type { WorkflowRunSummary } from "./workflow-journal.js";
import type { WorkflowReplayController } from "./workflow-replay.js";
import type { WorkflowResourceLoader } from "./workflow-resources.js";
import type { WorkflowWorkspaceManager } from "./workflow-worktree.js";
import type {
  WorkflowArtifactPorts,
  WorkflowArtifactRef,
  WorkflowBoundContinuation,
  WorkflowConsumedTextArtifact,
  WorkflowContinuationArtifact,
  WorkflowContinuationJournal,
} from "./workflow-artifacts.js";
import {
  normalizeWorkflowAwaitOperatorDeclaration,
  type WorkflowAwaitOperatorDeclaration,
  type WorkflowOperatorHandoffDeclaration,
  type WorkflowOperatorQuestion,
} from "./workflow-handoff.js";
import type { EvidenceEvaluation } from "../../_shared/agent-runtime/agent-evidence-evaluator.js";
import type { PermissionMode } from "../../_shared/agent-runtime/agents.js";
// The closed cause list is owned by the agent envelope that carries it and DEFINED in
// `agent-failure-cause.ts`, a module with no imports at all. Reading it as a value here keeps
// this core host-agnostic — nothing that touches `node:fs` or `node:child_process` enters the
// runtime — while still validating against one list rather than a second copy of it.
import { AGENT_FAILURE_CAUSES, type AgentFailureCause } from "../../_shared/agent-runtime/agent-failure-cause.js";
export type { PermissionMode } from "../../_shared/agent-runtime/agents.js";

/**
 * Workspace intent for one agent call. Declared here rather than shared with the host because
 * the DSL is its only author and the bridge below is its only reader: the host request carries
 * the resolved mode as journal metadata, never as a typed field.
 */
export type WorkspaceMode = "project" | "worktree" | "temporary-worktree";
export type {
  WorkflowAwaitOperatorDeclaration,
  WorkflowOperatorHandoffDeclaration,
  WorkflowOperatorQuestion,
} from "./workflow-handoff.js";

/** The single agent-execution callback the runtime depends on. The bridge supplies
 *  the real implementation; tests supply a fake. The runtime never imports the SDK. */
export type WorkflowAgentRunner = (req: WorkflowAgentRequest) => Promise<WorkflowAgentResult>;

/** The machine-readable cause carried from the host through the bridge. Re-exported so a
 *  workflow-side caller never has to reach into the agent envelope for the same closed list. */
export type WorkflowAgentFailureCause = AgentFailureCause;

/** The ONLY causes `attempts` re-asks: the child never got to answer, or lost the channel
 *  while answering. It is an allowlist, not "everything the never-retry list forgot" — an
 *  unnamed cause reads as `unclassified` and fails closed. */
const TRANSPORT_RETRYABLE_FAILURE_CAUSES: ReadonlySet<WorkflowAgentFailureCause> = new Set([
  "host-turn-timeout",
  "call-timeout",
]);

/** A result written before the cause field existed is `unclassified`, never retryable.
 *  Absence is read here, once, instead of being inferred at each call site. */
function workflowAgentFailureCause(result: Pick<WorkflowAgentResult, "failureCause">): WorkflowAgentFailureCause {
  return result.failureCause ?? "unclassified";
}

/** True only for a named transport cause. */
function isTransportRetryableFailure(result: Pick<WorkflowAgentResult, "failureCause">): boolean {
  return TRANSPORT_RETRYABLE_FAILURE_CAUSES.has(workflowAgentFailureCause(result));
}

const AGENT_FAILURE_CAUSE_NAMES: ReadonlySet<string> = new Set(AGENT_FAILURE_CAUSES);

/**
 * The declared cause on a THROWN transport failure, or `undefined` when the throw carries
 * none.
 *
 * Some failures never reach a result at all: the bridge throws
 * `WorkflowAgentUnavailableError` when the SDK substrate is gone, because a run whose
 * children cannot be spawned must end rather than be re-asked. That throw still knows its
 * cause, and without this the journal's terminal record of the call is an English sentence
 * — exactly the prose-matching the closed list exists to remove.
 *
 * Read structurally rather than by `instanceof`, because the thrower is host-side and this
 * module may not import it, and validated against the closed list so an unrelated error
 * that happens to carry a `failureCause` property can never write an unreadable journal
 * line.
 */
function thrownAgentFailureCause(err: unknown): WorkflowAgentFailureCause | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const declared = (err as { failureCause?: unknown }).failureCause;
  return typeof declared === "string" && AGENT_FAILURE_CAUSE_NAMES.has(declared)
    ? (declared as WorkflowAgentFailureCause)
    : undefined;
}

export const DEFAULT_WORKFLOW_AGENT = "default";
export const WORKFLOW_INPUT_MAX_CHARS = 16_000;
/** High per-child safety fuse. Ordinary agent work should finish far below this value.
 *  Single-sourced from the package budget contract: this name is kept because callers
 *  and tests use it, but the number lives in exactly one place. */
export const DEFAULT_WORKFLOW_AGENT_MAX_TOOL_CALLS = DEFAULT_WORKFLOW_BUDGET.toolCalls;
export const WORKFLOW_GROUP_FAILURE = "WORKFLOW_GROUP_FAILURE" as const;

export interface WorkflowAgentRequest {
  prompt: string;
  agent: string; // catalog name; defaults to DEFAULT_WORKFLOW_AGENT
  /** Per-call host-enforced read-only capability boundary. */
  readOnly?: true;
  /** Optional per-call subset of the selected catalog agent's allowed tools. */
  tools?: string[];
  /** Fail-closed per-child tool-call safety fuse. The first over-budget start aborts the child. */
  maxToolCalls?: number;
  /** Per-call concrete model selector, e.g. "provider/id" or "provider/id:high". */
  model?: string;
  /** Per-call tier: a name in the roles table, never a provider selector. */
  modelRole?: string;
  /** Wall-clock fuse for this attempt; the bridge aborts the child when it expires. */
  timeoutMs?: number;
  /** Assistant turns this child attempt may take. Also the multiplier the SDK host
   *  uses for its own child deadline, which is why it is a budget axis and not a detail. */
  maxTurns?: number;
  label?: string;
  phase?: string;
  /** @deprecated use permissionMode / workspaceMode (P2-2) — this field remains a compatible alias; worktree isolation only, not a security boundary */
  sandbox?: "read-only" | "workspace-write";
  /** Permission intent for the child run. This is trace metadata, not a security boundary. */
  permissionMode?: PermissionMode;
  /** Workspace isolation intent for the child run. Worktrees isolate file changes for review, not security. */
  workspaceMode?: WorkspaceMode;
  /** Opaque runtime-owned workspace identity. The bridge resolves it to cwd. */
  workspaceHandle?: string;
  /** Runtime-owned stable identity allocated before this attempt is scheduled. */
  callId?: string;
}

export interface WorkflowAgentResult {
  ok: boolean; // true when status === "completed"
  status: "completed" | "failed" | "cancelled" | "blocked";
  summary: string;
  /** Machine-readable origin of a non-completed call. Absent means the cause was never
   *  declared, which reads as `unclassified` — see `workflowAgentFailureCause`. */
  failureCause?: WorkflowAgentFailureCause;
  /** Exact final child text when status is completed. */
  text?: string;
  diagnostics: string[];
  evidence?: EvidenceEvaluation;
  agent: string;
  label?: string;
  childSessionId?: string;
  childTrace?: WorkflowAgentChildTrace;
  resultArtifact?: string;
  worktreePath?: string;
  /** Display selector for the live row; see WorkflowJournalLine.model. */
  model?: string;
  thinking?: string;
  /**
   * What the CHILD SESSION reported it ran on, read back from the host after the
   * session was created — not the selector this bridge asked for. `"unavailable"`
   * when the peer exposes no model on its session; never back-filled from the
   * request, because repeating a request back proves only that we remember it.
   */
  executedModel?: string;
  /**
   * Set when a declared tier had no assignment in any layer and the child therefore
   * inherited the parent session model. One sentence naming the role and the layers
   * that were read. Quiet fallback, loud record.
   */
  modelRoleFallback?: string;
  /** Workflow loop slot descriptor (phase,label); set by the bridge for slotted agents (REQ-009). */
  slotKey?: string;
  /** Loop round for the slot (≥1); the bridge increments it per slot re-invoke (REQ-009). */
  round?: number;
  /** Token usage for this run, projected from the child session stats for the round journal (D-004/D-006). */
  usage?: WorkflowUsage;
  permissionMode?: PermissionMode;
  workspaceMode?: WorkspaceMode;
  /** Resolved host-enforced read-only capability boundary. */
  readOnly?: boolean;
}

export interface WorkflowAgentChildTrace {
  path: string;
  format: "pi-session-jsonl";
  childSessionId: string;
}

export interface WorkflowSchemaValidation {
  status: "valid" | "mismatch";
  /** 1-based loop position of the attempt this verdict describes. A replayed attempt
   *  occupies an ordinal and increments it, and contributes no `usage`. */
  attempts: number;
  /** Final validator/parser errors on mismatch; empty after a valid attempt. */
  errors: string[];
  /** Which authority rejected the answer. Present only on a mismatch, and only on a
   *  call that declared `validate` — a schema-only call has one possible authority,
   *  so naming it would change every existing journal line for no added information. */
  source?: "schema" | "script";
}

/** Token + cost projection for one model-backed child run, summed per run for the budget view. */
export interface WorkflowUsage {
  input: number;
  output: number;
  totalTokens: number;
  costTotal: number;
}

export interface WorkflowDsl {
  /** Run one child agent under a declared answer shape. Success resolves to the
   *  VALIDATED value (not text); exhausting the retry budget throws SchemaValidationError. */
  agent(prompt: string, opts: WorkflowAgentSchemaOptions): Promise<unknown>;
  /** Run one child agent. Success resolves to its exact non-empty final text. */
  agent(prompt: string, opts?: WorkflowAgentOptions): Promise<string>;
  /** Render one neighboring .prompt.md resource from the original workflow source. */
  promptFile(path: string, variables?: Record<string, string>): Promise<string>;
  /** Allocate one retained runtime-owned linked worktree at an exact Git ref. */
  workspace(label: string, ref: string): Promise<string>;
  /** Absolute project root captured by the workflow runner. */
  projectRoot(): string;
  /** Persist deterministic workflow-authored text and return its complete digest-bound reference. */
  publishArtifact(name: string, text: string): WorkflowArtifactRef;
  /** Verify and copy one complete prior-run text reference into this run. */
  consumeTextArtifact(ref: WorkflowArtifactRef): WorkflowConsumedTextArtifact;
  /** Host-verified continuation artifacts bound before trusted workflow code starts. */
  continuationArtifacts(): readonly WorkflowContinuationArtifact[];
  /** Run independent branches behind one fail-closed barrier and preserve input order. */
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;
  /** Run ordered stages for every item; a failed item stops before its later stages. */
  pipeline<T>(items: T[], ...stages: Array<WorkflowStage<unknown>>): Promise<unknown[]>;
  /** Change the current reader-visible stage and append a phase line to the run journal. */
  phase(name: string): void;
  /** Append a script-owned journal message tagged with the current phase. */
  log(msg: string): void;
  /** Declare that a successful run is waiting for bounded operator input.
   *  This is runtime control state; it never changes the script's returned value. */
  awaitOperator(input: WorkflowAwaitOperatorDeclaration): void;
  /** Replay-safe wall clock. Records its value on the first run and returns the
   *  recorded one on `--resume`; a direct `Date.now()` is neither banned nor replayable. */
  now(): number;
  /** Replay-safe randomness with the same record/replay contract as `now()`. */
  random(): number;
  /** Run a nested workflow function with the same typed DSL handle. */
  workflow<T = unknown>(subFn: (dsl: WorkflowDsl, input?: string) => Promise<T>, input?: string): Promise<T>;
}

export interface WorkflowAgentOptions {
  agent?: string; // catalog name; default DEFAULT_WORKFLOW_AGENT
  /** Narrow the selected catalog agent with a host-enforced read-only capability boundary. */
  readOnly?: true;
  /** Narrow this child to a subset of its catalog allow-list; [] creates a no-tool child. */
  tools?: string[];
  /** Maximum tool calls per child attempt; defaults to the runtime safety fuse. 0 requires no tools. */
  maxToolCalls?: number;
  /**
   * Concrete model for this call, always `provider/id` with an optional display-only
   * `:off|minimal|low|medium|high|xhigh` suffix. A selector no configured provider
   * can serve fails the call by name; it never silently runs on the session model.
   */
  model?: string;
  /**
   * Tier for this call: a name in the roles table (`smol`, `slow`, `task`, …), never
   * a provider selector. The package ships no assignments, so an operator layer
   * (session / project `.pi/model-roles/config.json` / user config) has to say what
   * the name means; a role nothing assigns degrades to the parent session model and
   * the degradation is recorded on `agent_end`, in the run-result artifact and in the
   * run report. `model` and `modelRole` each have exactly one meaning — the option
   * chosen at the call site says which one the author meant.
   */
  modelRole?: string;
  /**
   * Wall-clock fuse for one child attempt, in milliseconds. `maxToolCalls` bounds
   * tool usage and cannot end a stalled child. On expiry the child is aborted and
   * the call fails closed; it never resolves to a partial answer.
   */
  timeoutMs?: number;
  /**
   * Assistant turns for one child attempt, within the host clamp of 1..20. It was
   * a hardcoded `5` in the bridge and invisible to authors, while the child's whole
   * wall clock is computed from it — a budget the package was making in silence.
   * A value outside the clamp is refused before any child starts.
   */
  maxTurns?: number;
  /**
   * Upper bound on the child's answer, in characters. An oversized handoff breaks
   * the next stage's prompt, so the runtime fails the call here instead of letting
   * a script re-implement the check. Enforced on replayed answers too.
   */
  maxAnswerChars?: number;
  /**
   * Physical child attempts for this ONE logical call when the TRANSPORT failed — the child
   * never got to answer, or lost the channel while answering. Default 1; ceiling 3; refused,
   * never clamped, outside that range.
   *
   * It never re-asks because an answer was weak: that is a critic agent's job, and an answer
   * whose SHAPE is wrong already has its own bounded repair (`schema` + `validate`). Refused
   * at declaration time unless the call is both replay-eligible and provably unable to write,
   * because a child that timed out mid-edit may already have changed the repository.
   */
  attempts?: number;
  label?: string;
  /** Logical name for the exact returned answer in the run artifact index. */
  artifact?: string;
  phase?: string;
  /** @deprecated use permissionMode / workspaceMode (P2-2) — this field remains a compatible alias; worktree isolation only, not a security boundary */
  sandbox?: "read-only" | "workspace-write";
  /** Permission intent for the child run. This is trace metadata, not a security boundary. */
  permissionMode?: PermissionMode;
  /** Workspace isolation intent for the child run. Worktrees isolate file changes for review, not security. */
  workspaceMode?: WorkspaceMode;
  /** Reuse a runtime-owned workspace allocated by workspace(). */
  workspaceHandle?: string;
  /** A schema selects WorkflowAgentSchemaOptions instead of the exact-text overload. */
  schema?: never;
  /** validate needs a parsed value, which only the shaped overload has. */
  validate?: never;
}

/**
 * Script-supplied cross-field validation for one shaped answer.
 *
 * Receives the parsed, schema-valid value; returns the violations it found, empty
 * for a pass. It must be pure, synchronous and deterministic, must not throw to
 * signal a violation, must not transform the value, and must not call back into
 * the DSL. Its strings are spliced into the retry prompt and therefore enter the
 * canonical replay key, so an unstable message is a replay defect.
 */
export type WorkflowAgentValidate = (value: unknown) => readonly string[];

/** Options for the shaped overload. The schema property cannot be smuggled through
 *  WorkflowAgentOptions, so a shaped call can never be typed as Promise<string>. */
export interface WorkflowAgentSchemaOptions extends Omit<WorkflowAgentOptions, "schema" | "validate"> {
  schema: Record<string, unknown>;
  /** Cross-field rules the schema subset cannot declare. Runs only after schema
   *  validation succeeds; a non-empty return re-asks the child in its own labelled
   *  repair block instead of ending the run. */
  validate?: WorkflowAgentValidate;
}

type WorkflowAgentAnyOptions = WorkflowAgentOptions | WorkflowAgentSchemaOptions;

export type WorkflowStage<T> = (item: T, index: number) => Promise<unknown>;

export type WorkflowGroupKind = "parallel" | "pipeline";

export interface WorkflowBranchFailure {
  index: number;
  kind: "thrown" | "returned-failure";
  message: string;
  stageIndex?: number;
  status?: string;
}

export type WorkflowGroupSlot<T> =
  | { index: number; status: "completed"; value: T }
  | { index: number; status: "failed"; failure: WorkflowBranchFailure; value?: T };

export type WorkflowGroupEnvelopeSlot =
  { index: number; status: "completed" } | { index: number; status: "failed"; failure: WorkflowBranchFailure };

/** JSON-safe run/result projection for an unhandled group failure. */
export interface WorkflowGroupFailureEnvelope {
  ok: false;
  kind: "workflow_group_failure";
  code: typeof WORKFLOW_GROUP_FAILURE;
  groupKind: WorkflowGroupKind;
  groupId: string;
  total: number;
  completed: number;
  failed: number;
  slots: WorkflowGroupEnvelopeSlot[];
  failures: WorkflowBranchFailure[];
}

/**
 * Fail-closed barrier result for thrown or explicitly failed branches.
 *
 * Successful siblings finish. `slots` is the unambiguous in-memory truth;
 * `partialResults` is a convenience view where thrown positions are null while
 * returned failed values remain inspectable. A script must catch this stable
 * typed error explicitly to accept a deliberate partial outcome.
 */
export class WorkflowGroupFailureError<T = unknown> extends Error {
  readonly code = WORKFLOW_GROUP_FAILURE;
  readonly groupKind: WorkflowGroupKind;
  readonly groupId: string;
  readonly slots: Array<WorkflowGroupSlot<T>>;
  readonly partialResults: Array<T | null>;
  readonly failures: WorkflowBranchFailure[];
  readonly total: number;
  readonly completed: number;
  readonly failed: number;

  constructor(groupKind: WorkflowGroupKind, groupId: string, slots: Array<WorkflowGroupSlot<T>>) {
    const failures = slots
      .filter((slot): slot is Extract<WorkflowGroupSlot<T>, { status: "failed" }> => slot.status === "failed")
      .map((slot) => slot.failure);
    const total = slots.length;
    const failed = failures.length;
    const preview = failures
      .slice(0, 3)
      .map(
        (failure) =>
          `branch ${failure.index}${failure.stageIndex === undefined ? "" : ` stage ${failure.stageIndex}`}: ${failure.message}`,
      )
      .join("; ");
    const suffix = failures.length > 3 ? `; +${failures.length - 3} more` : "";
    super(`${groupKind} failed in ${failed}/${total} branch(es): ${preview}${suffix}`);
    this.name = "WorkflowGroupFailureError";
    this.groupKind = groupKind;
    this.groupId = groupId;
    this.slots = slots.map((slot) =>
      slot.status === "completed" ? { ...slot } : { ...slot, failure: { ...slot.failure } },
    );
    this.partialResults = this.slots.map((slot) => {
      if (slot.status === "completed") return slot.value;
      return Object.prototype.hasOwnProperty.call(slot, "value") ? (slot.value ?? null) : null;
    });
    this.failures = failures.map((failure) => ({ ...failure }));
    this.total = total;
    this.completed = Math.max(0, total - failed);
    this.failed = failed;
  }

  toEnvelope(): WorkflowGroupFailureEnvelope {
    return {
      ok: false,
      kind: "workflow_group_failure",
      code: this.code,
      groupKind: this.groupKind,
      groupId: this.groupId,
      total: this.total,
      completed: this.completed,
      failed: this.failed,
      slots: this.slots.map((slot) =>
        slot.status === "completed"
          ? { index: slot.index, status: "completed" }
          : { index: slot.index, status: "failed", failure: { ...slot.failure } },
      ),
      failures: this.failures.map((failure) => ({ ...failure })),
    };
  }
}

export function workflowGroupFailureEnvelope(value: unknown): WorkflowGroupFailureEnvelope | undefined {
  return value instanceof WorkflowGroupFailureError ? value.toEnvelope() : undefined;
}

class CapturedWorkflowBranchFailure<T = unknown> extends Error {
  constructor(
    readonly value: T,
    readonly failure: WorkflowBranchFailure,
  ) {
    super(failure.message);
    this.name = "CapturedWorkflowBranchFailure";
  }
}

export interface WorkflowJournalSink {
  write(line: WorkflowJournalLine): void; // sync append; never throws into the DSL
}

export interface WorkflowJournalLine {
  ts: string;
  runId: string;
  kind: "phase" | "log" | "group_start" | "group_end" | "agent_start" | "agent_end" | "error";
  /** Provenance for log lines. Absent means legacy/unknown and must not be inferred. */
  source?: "script" | "runtime";
  phase?: string;
  message?: string;
  groupId?: string;
  groupKind?: "parallel" | "pipeline";
  groupLabel?: string;
  groupTotal?: number;
  groupCompleted?: number;
  groupFailed?: number;
  agent?: string;
  /** Host-enforced read-only capability boundary for this child. */
  readOnly?: boolean;
  label?: string;
  /** Runtime-owned stable identity for this concrete child attempt. */
  callId?: string;
  answerArtifact?: WorkflowArtifactRef;
  transcriptArtifact?: WorkflowArtifactRef;
  resultEnvelopeArtifact?: WorkflowArtifactRef;
  /** Workflow loop slot descriptor (phase,label) on agent lines (REQ-009); absent = no-rounds journal. */
  slotKey?: string;
  /** Loop round (≥1) on agent_end lines (REQ-009); the drill reads past rounds by (slotKey,round). */
  round?: number;
  status?: string;
  /** Machine-readable cause on a non-completed `agent_end`. Absent on old journals and on
   *  every completed call; a reader treats absence as `unclassified`. */
  failureCause?: WorkflowAgentFailureCause;
  /** 1-based PHYSICAL transport attempt within one logical agent() call. Present only on a
   *  call that declared `attempts > 1`, so every journal written before the option is
   *  byte-identical and absence still means "one attempt". */
  attempt?: number;
  /** The declared transport-attempt bound this attempt belongs to. */
  attempts?: number;
  /** Stable identity of the ONE logical `agent()` call this physical attempt belongs to.
   *  Travels with `attempt`/`attempts` and is the only field a reader may group attempts by:
   *  `callId` is per-attempt, and `parallel()` can run two calls that agree on agent, label,
   *  phase and group. */
  logicalCallId?: string;
  evidence?: EvidenceEvaluation;
  evidenceWarnings?: string[];
  /** Runtime-owned child session identity; never parsed from agent text. */
  childSessionId?: string;
  /** Persisted child transcript evidence; never exposed as the DSL return value. */
  childTrace?: WorkflowAgentChildTrace;
  /** Persisted child result artifact path; never exposed as the DSL return value. */
  resultArtifact?: string;
  schemaValidation?: WorkflowSchemaValidation;
  durationMs?: number;
  worktreePath?: string;
  workspaceHandle?: string;
  /** Resolved permission intent for agent_start/agent_end lines. Not a security boundary. */
  permissionMode?: PermissionMode;
  /** Resolved workspace intent for agent_start/agent_end lines. Not a security boundary. */
  workspaceMode?: WorkspaceMode;
  /** Token/cost usage for agent_end lines (present when the child reported usage). */
  usage?: WorkflowUsage;
  /**
   * Resolved model selector for agent live-row display. On `agent_start` this is
   * still an intent — the line is emitted before the bridge resolves anything — so
   * read `requestedModel` there for the honest name and `executedModel` on
   * `agent_end` for what actually ran.
   */
  model?: string;
  /**
   * The selector the call ASKED for, on `agent_start`. Named for what it is: this
   * line is written before any resolution happens, so it structurally cannot know
   * what executed and must not be read as if it did.
   */
  requestedModel?: string;
  /** The tier the call declared, on `agent_start`. A role name, never a provider selector. */
  modelRole?: string;
  /**
   * What the child session reported it ran on, read back from the host.
   * `"unavailable"` when the peer exposes no model. Absent on journals written before
   * this field existed — absence is never evidence that a model ran.
   *
   * Carried by `agent_end`, and by the `error` lines emitted AFTER a child returned (a
   * script `validate` that threw, an artifact writer that failed). Never by a line
   * written before dispatch: `agent_start` structurally cannot know it, and a failure
   * that never reached a child has nothing to report.
   */
  executedModel?: string;
  /** With `executedModel`: a declared tier had no assignment and the child inherited the session model. */
  modelRoleFallback?: string;
  /** Resolved thinking/reasoning level for agent live-row display. */
  thinking?: string;
  /** True on agent lines served from a recorded run instead of a fresh child.
   *  Absent means the call really executed; it is never inferred from anything else. */
  replayed?: boolean;
  resumeFromRunId?: string;
  resumeSourceRunSummary?: WorkflowRunSummary | null;
  continuation?: WorkflowContinuationJournal;
}

export interface WorkflowRuntimeOptions {
  runId: string;
  agentRunner: WorkflowAgentRunner;
  args?: string;
  /** Already consumed and digest-bound by the runner before workflow code starts. */
  continuation?: WorkflowBoundContinuation;
  projectRoot?: string;
  resourceLoader?: WorkflowResourceLoader;
  workspaceManager?: WorkflowWorkspaceManager;
  maxConcurrentAgents?: number; // default: unlimited global leaf-agent concurrency
  /** Default per-child tool-call safety fuse; defaults to DEFAULT_WORKFLOW_AGENT_MAX_TOOL_CALLS. */
  defaultMaxToolCalls?: number;
  /** Default upper bound on a child answer, applied to calls that declare none.
   *  Absent means the axis is enforced only where the call declared it — the
   *  state every embedder was in before the package budget contract existed. */
  defaultMaxAnswerChars?: number;
  /** Default wall-clock fuse for one child attempt. Absent means a call that
   *  declares none arms no workflow-level fuse and is bounded only by the SDK host. */
  defaultTimeoutMs?: number;
  /** Default assistant turns per child attempt, within the host clamp of 1..20.
   *  Absent leaves the bridge's own default in place. */
  defaultMaxTurns?: number;
  /**
   * Wall clock over the agent chain, in milliseconds, armed once at construction.
   * The deadline is checked when a child STARTS, so a run is bounded by this value
   * plus at most one child's own `timeoutMs`. Absent means no run deadline.
   */
  runtimeMs?: number;
  /** Injectable numeric clock for the run deadline; defaults to `Date.now`. Separate
   *  from `now()`, which produces ISO strings for journal lines. */
  nowMs?: () => number;
  // default DEFAULT_MAX_TOTAL_AGENT_INVOCATIONS; global per-run cap across agent() calls;
  // cyclic workflows allowed up to the cap, exceeding it throws WorkflowInvocationCapError and exits the run.
  maxTotalAgentInvocations?: number;
  journal?: WorkflowJournalSink; // default: no-op sink
  /** Recorded-call store for `--resume`. Absent means neither record nor replay. */
  replay?: WorkflowReplayController;
  artifactPorts?: WorkflowArtifactPorts;
  replaySourceRunId?: string;
  now?: () => string; // default () => new Date().toISOString()
  onEvent?: (line: WorkflowJournalLine) => void; // progress callback (UI streaming)
  /** Runner-owned sink for one out-of-band operator handoff declaration. */
  onAwaitOperator?: (declaration: WorkflowAwaitOperatorDeclaration) => void;
}

export interface WorkflowRuntime {
  dsl: WorkflowDsl;
  getJournal(): WorkflowJournalLine[]; // in-memory mirror (for tests / final render)
  getArgs(): string | undefined;
  currentPhase(): string | undefined;
  /** Gate-owned high-water mark of simultaneously executing leaf agents. The only
   *  honest source for this number; the journal cannot produce it (see AgentConcurrencyGate). */
  peakAgentConcurrency(): number;
}

export function assertWorkflowInput(value: unknown, field = "workflow input"): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${field} must be a string when provided`);
  }
  if (typeof value === "string" && value.length > WORKFLOW_INPUT_MAX_CHARS) {
    throw new Error(`${field} exceeds ${WORKFLOW_INPUT_MAX_CHARS} characters`);
  }
}

// ---------------------------------------------------------------------------
// THE single concurrency seam
// ---------------------------------------------------------------------------

/**
 * THE single concurrency seam for the whole runtime. Every agent execution —
 * agent(), parallel(), pipeline() — funnels through here.
 *
 * Bounded per-call concurrency seam. Real concurrency with git-worktree
 * isolation for parallel writes can be dropped in HERE without touching any
 * workflow script.
 *
 * // TODO(concurrency): add git-worktree isolation. Keep this signature stable.
 */
const SCHEDULER_WIDTH = 4;

async function runScheduled<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
  const out: T[] = new Array(thunks.length);
  let next = 0;
  const workerCount = Math.min(SCHEDULER_WIDTH, thunks.length);
  // SCHEDULER_WIDTH bounds width PER runScheduled call, not globally.
  // Nested orchestration wrappers create their OWN pool, so nested dsl.agent()
  // inside a parallel() wrapper does NOT deadlock against leaf agent slots.
  // Global leaf-agent concurrency is enforced separately by AgentConcurrencyGate.
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= thunks.length) return;
      out[i] = await thunks[i]!();
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}

interface AgentConcurrencyGate {
  acquire(): Promise<void>;
  release(): void;
  /**
   * High-water mark of simultaneously EXECUTING leaf agents.
   *
   * Gate-owned rather than derived from the journal, and that is the whole point:
   * `agent_start` is emitted before `acquire()`, so counting overlapping
   * start/end intervals counts children that are still queued. That number is
   * demand, not concurrency, and printing it beside a concurrency limit would
   * read as a limit breach that never happened.
   */
  peak(): number;
}

class UnlimitedAgentConcurrencyGate implements AgentConcurrencyGate {
  #inUse = 0;
  #peak = 0;

  acquire(): Promise<void> {
    this.#inUse += 1;
    if (this.#inUse > this.#peak) this.#peak = this.#inUse;
    return Promise.resolve();
  }

  release(): void {
    this.#inUse -= 1;
  }

  peak(): number {
    return this.#peak;
  }
}

class CountingAgentConcurrencyGate implements AgentConcurrencyGate {
  private inUse = 0;
  private peakInUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrentAgents: number) {}

  acquire(): Promise<void> {
    if (this.inUse < this.maxConcurrentAgents) {
      this.enter();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.enter();
        resolve();
      });
    });
  }

  release(): void {
    this.inUse -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }

  peak(): number {
    return this.peakInUse;
  }

  private enter(): void {
    this.inUse += 1;
    if (this.inUse > this.peakInUse) this.peakInUse = this.inUse;
  }
}

function createAgentConcurrencyGate(maxConcurrentAgents: number | undefined): AgentConcurrencyGate {
  if (maxConcurrentAgents === undefined) return new UnlimitedAgentConcurrencyGate();
  if (!Number.isInteger(maxConcurrentAgents) || maxConcurrentAgents < 1) {
    throw new Error("maxConcurrentAgents must be a positive integer when provided");
  }
  return new CountingAgentConcurrencyGate(maxConcurrentAgents);
}

function resolveMaxTotalAgentInvocations(maxTotalAgentInvocations: number | undefined): number {
  if (maxTotalAgentInvocations === undefined) return DEFAULT_MAX_TOTAL_AGENT_INVOCATIONS;
  if (!Number.isInteger(maxTotalAgentInvocations) || maxTotalAgentInvocations < 1) {
    throw new Error("maxTotalAgentInvocations must be a positive integer when provided");
  }
  return maxTotalAgentInvocations;
}

function normalizeMaxToolCalls(maxToolCalls: number, field: string): number {
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return maxToolCalls;
}

/** A fuse of zero would abort before the child starts; that is a bug, not a bound. */
function normalizeTimeoutMs(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("agent timeoutMs must be a positive safe integer");
  }
  if (timeoutMs > WORKFLOW_MAX_TIMEOUT_MS) {
    throw new Error(
      `agent timeoutMs must not exceed ${WORKFLOW_MAX_TIMEOUT_MS}; larger values cannot be represented by Node timers with the SDK backstop`,
    );
  }
  return timeoutMs;
}

/**
 * The execution evidence a post-child failure still owns.
 *
 * The two `error` lines that carry this are emitted AFTER the child ran and returned —
 * a script `validate`/parse callback that threw, an artifact writer that failed — so
 * the run holds a real host readback at that point. Omitting it is the mirror image of
 * naming a model that never ran: `executedModel` is the single proof of execution every
 * read side keys on (`workflow-journal.ts`, `workflow-run-report.ts`), so a terminal
 * line without it is read as "no child executed" and the live row's label is cleared.
 * The one case where a child provably DID execute would then be the case that loses the
 * evidence of it.
 *
 * `modelRoleFallback` rides along because the bridge already gates it on the same
 * readback (`workflow-agent-bridge.ts`), so it is never a claim this line invents.
 */
function executedModelEvidence(
  result: Pick<WorkflowAgentResult, "model" | "executedModel" | "modelRoleFallback" | "thinking">,
): Pick<WorkflowJournalLine, "model" | "executedModel" | "modelRoleFallback" | "thinking"> {
  return {
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.executedModel !== undefined ? { executedModel: result.executedModel } : {}),
    ...(result.modelRoleFallback !== undefined ? { modelRoleFallback: result.modelRoleFallback } : {}),
    ...(result.thinking !== undefined ? { thinking: result.thinking } : {}),
  };
}

/** The host clamps `maxTurns` to 1..20 (`agent-runner.ts`). The runtime refuses an
 *  out-of-range value here, BEFORE any child starts, so an author sees the rule
 *  instead of a request-validation failure after the run has begun spending. */
function normalizeMaxTurns(maxTurns: number): number {
  if (!Number.isSafeInteger(maxTurns) || maxTurns < WORKFLOW_AGENT_MIN_TURNS || maxTurns > WORKFLOW_AGENT_MAX_TURNS) {
    throw new Error(
      `agent maxTurns must be an integer between ${WORKFLOW_AGENT_MIN_TURNS} and ${WORKFLOW_AGENT_MAX_TURNS}`,
    );
  }
  return maxTurns;
}

function normalizeMaxAnswerChars(maxAnswerChars: number): number {
  if (!Number.isSafeInteger(maxAnswerChars) || maxAnswerChars <= 0) {
    throw new Error("agent maxAnswerChars must be a positive safe integer");
  }
  return maxAnswerChars;
}

/**
 * Ceiling on physical transport attempts for one logical `agent()` call.
 *
 * Three, because the shape-repair loop can already call the physical executor three times
 * when `validate` is declared (`SCHEMA_MAX_ATTEMPTS + 1`), so `attempts` MULTIPLIES that
 * budget rather than adding to it: the worst case for one shaped call is `attempts × 3`
 * children, each charged to the run's invocation cap.
 */
const MAX_AGENT_TRANSPORT_ATTEMPTS = 3;

/** Default 1: a package-wide retry default is a budget decision nobody has taken yet. */
function normalizeAgentAttempts(attempts: number | undefined): number {
  if (attempts === undefined) return 1;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_AGENT_TRANSPORT_ATTEMPTS) {
    throw new Error(`agent attempts must be a safe integer between 1 and ${MAX_AGENT_TRANSPORT_ATTEMPTS}`);
  }
  return attempts;
}

/**
 * Tools this runtime will accept as proof that a child cannot write.
 *
 * Copied deliberately rather than imported: the host's own read-only allowlist lives in
 * `agent-read-only-policy.ts`, which reaches for `node:fs` and `node:child_process`, and this
 * module is the host-agnostic core. `tests/shared/workflows/workflow-agent-transport.test.ts`
 * asserts this list stays a SUBSET of the host's, so the copy cannot drift into permitting
 * something the host does not consider read-only.
 */
const AGENT_NO_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "git_read",
  "ast_index",
  "repository_check",
  "yield",
]);

/**
 * Why this call may NOT repeat a dropped child, or `undefined` when it may.
 *
 * Two conditions, and replay eligibility alone is not enough. Replay asks "may a recorded
 * answer be SUBSTITUTED for this call" — a question about the record. A retry asks "may this
 * call be REPEATED" — a question about side effects. They coincide for a worktree call and
 * diverge for a project-workspace writer: `workspaceMode` defaults to `"project"` and the
 * bridge leaves a catalog agent write-capable unless the CALL asks for read-only, so a
 * default-options writer editing the repository in place is replay-eligible while a second
 * attempt could double-apply its edits or edit a half-finished tree.
 */
function transportRetryRefusal(req: WorkflowAgentRequest, replayable: boolean): string | undefined {
  if (!replayable) {
    return req.workspaceHandle !== undefined
      ? "agent attempts > 1 is refused for a call bound to a workspace handle: a repeated attempt could act on a tree the first attempt already changed"
      : `agent attempts > 1 is refused for a ${String(req.workspaceMode)} workspace call: a repeated attempt could act on a tree the first attempt already changed`;
  }
  const provablyNoWrite =
    req.readOnly === true || (req.tools !== undefined && req.tools.every((tool) => AGENT_NO_WRITE_TOOLS.has(tool)));
  if (!provablyNoWrite) {
    return "agent attempts > 1 requires a call that provably cannot write: declare readOnly: true, or a tools allow-list with no write, edit or shell member";
  }
  return undefined;
}

function defaultWorkflowPermissionMode(agentName: string, requestedMode: PermissionMode | undefined): PermissionMode {
  if (agentName === DEFAULT_WORKFLOW_AGENT && requestedMode === "restricted") return "inherit-parent";
  if (requestedMode !== undefined) return requestedMode;
  return agentName === DEFAULT_WORKFLOW_AGENT ? "inherit-parent" : "agent-defined";
}

function workspaceModeFromSandbox(sandbox: WorkflowAgentOptions["sandbox"]): WorkspaceMode {
  return sandbox === "workspace-write" ? "worktree" : "project";
}

function defaultWorkflowWorkspaceMode(opts: WorkflowAgentAnyOptions | undefined): WorkspaceMode {
  if (opts?.workspaceMode !== undefined) return opts.workspaceMode;
  if (opts?.sandbox !== undefined) return workspaceModeFromSandbox(opts.sandbox);
  return "project";
}

// ---------------------------------------------------------------------------
// Schema enforcement (S2)
// ---------------------------------------------------------------------------

/** Maximum child-run attempts when agent({schema}) declares an answer shape — one retry
 *  budget for the DSL. */
const SCHEMA_MAX_ATTEMPTS = 2;

/** Upper bounds on what a script validator may hand back. Its strings reach the next
 *  child's prompt, the journal verdict and — through the prompt — the replay key, and
 *  nothing else caps them. A breach is a run error, never a truncation: truncating
 *  would silently rewrite the replay key. */
const MAX_SCRIPT_VALIDATION_ERRORS = 32;
const MAX_SCRIPT_VALIDATION_ERROR_CHARS = 500;

/** A validate() return is author data crossing into runtime-owned surfaces, so it is
 *  checked like any other untrusted value. Every breach fails the run closed and
 *  consumes no retry — a bug in author code must not be laundered into a repair loop
 *  that blames the model for it. */
function assertScriptValidationErrors(returned: unknown): readonly string[] {
  if (isRecord(returned) && typeof returned.then === "function") {
    throw new Error("agent validate must return an array of strings, not a Promise");
  }
  if (!Array.isArray(returned)) throw new Error("agent validate must return an array of strings");
  if (returned.length > MAX_SCRIPT_VALIDATION_ERRORS) {
    throw new Error(
      `agent validate returned ${returned.length} error(s); at most ${MAX_SCRIPT_VALIDATION_ERRORS} are allowed`,
    );
  }
  for (const [index, error] of returned.entries()) {
    if (typeof error !== "string") throw new Error("agent validate must return an array of strings");
    if (error === "") throw new Error(`agent validate error at index ${index} must be a non-empty string`);
    if (error.length > MAX_SCRIPT_VALIDATION_ERROR_CHARS) {
      throw new Error(
        `agent validate error at index ${index} is ${error.length} character(s); at most ${MAX_SCRIPT_VALIDATION_ERROR_CHARS} are allowed`,
      );
    }
  }
  return returned as readonly string[];
}

/** Default global per-run cap on total dsl.agent() invocations. Cyclic workflows are
 *  allowed up to this cap; exceeding it throws WorkflowInvocationCapError and exits the run.
 *  Single-sourced from the package budget contract. */
export const DEFAULT_MAX_TOTAL_AGENT_INVOCATIONS = DEFAULT_WORKFLOW_BUDGET.totalAgents;

/** Thrown by agentDsl() when a run exceeds maxTotalAgentInvocations. Bubbles past
 *  grouped contexts (parallel/pipeline) so a cyclic/runaway workflow exits the run
 *  with a clear error instead of looping unbounded. */
export class WorkflowInvocationCapError extends Error {
  readonly cap: number;
  constructor(cap: number) {
    super(`workflow exceeded maxTotalAgentInvocations cap of ${cap}`);
    this.name = "WorkflowInvocationCapError";
    this.cap = cap;
  }
}

/** The two failures that bound the RUN, not one branch. Both are thrown before any
 *  child work and must exit grouped contexts unchanged. */
function isRunLevelWorkflowFailure(err: unknown): boolean {
  return err instanceof WorkflowInvocationCapError || err instanceof WorkflowRunDeadlineError;
}

/**
 * Thrown when a child would START after the run's wall clock expired. Mirrors
 * WorkflowInvocationCapError deliberately: same check site, same bubbling past
 * grouped contexts, same "refuse the next one rather than abort the current one"
 * discipline. Aborting a child mid-flight would need a second abort path racing
 * the per-child fuse, which is the defect the single-deadline rule removes.
 *
 * What it bounds, stated so a reader does not have to infer it: the AGENT CHAIN.
 * A run is bounded by `runtimeMs` plus at most one child's own `timeoutMs`. Script
 * code that calls no further agent is not bounded by this at all.
 */
export class WorkflowRunDeadlineError extends Error {
  readonly runtimeMs: number;
  readonly elapsedMs: number;
  constructor(runtimeMs: number, elapsedMs: number) {
    super(
      `workflow exceeded its runtimeMs budget of ${runtimeMs} ms (${elapsedMs} ms elapsed) before this agent call started`,
    );
    this.name = "WorkflowRunDeadlineError";
    this.runtimeMs = runtimeMs;
    this.elapsedMs = elapsedMs;
  }
}

/** Typed failure for one child execution. Public agent() callers receive text only;
 * runtime status and diagnostics remain available on this internal error and journal. */
export class WorkflowAgentExecutionError extends Error {
  readonly result: WorkflowAgentResult;

  constructor(result: WorkflowAgentResult) {
    super(result.summary);
    this.name = "WorkflowAgentExecutionError";
    this.result = result;
  }
}

/** The DSL's "declared shape not met" failure. Thrown by agent({ schema }) — that path always
 *  fails closed — when the child's answer still violates the schema after SCHEMA_MAX_ATTEMPTS.
 *  Carries the validator errors + attempt count. A child RUN failure stays
 *  WorkflowAgentExecutionError; this error means the child ran and answered off-shape. */
export class SchemaValidationError extends Error {
  readonly errors: string[];
  readonly attempts: number;
  constructor(errors: string[], attempts: number) {
    super(`schema mismatch after ${attempts} attempt(s): ${errors.join("; ")}`);
    this.name = "SchemaValidationError";
    this.errors = errors;
    this.attempts = attempts;
  }
}

/**
 * Minimal dependency-free JSON-schema subset validator.
 *
 * Supported keywords:
 *   - `type`: "object" | "array" | "string" | "number" | "integer" | "boolean"
 *   - `required`: string[]  (for objects — lists required property names)
 *   - `properties`: Record<string, schema>  (recursive)
 *   - `additionalProperties`: false  (for objects — reject keys not in `properties`)
 *   - `items`: schema  (for arrays — validates every element, recursive)
 *   - `enum`: JSON primitive[]  (value must be strictly equal to one listed member)
 *   - `minLength` / `maxLength` / `pattern`  (for strings)
 *   - `minItems` / `maxItems`  (for arrays)
 *   - `nonBlank: true`  (for strings — reject a value that is empty after trimming)
 *   - `uniqueItems: true`  (for arrays of string/number/integer/boolean items)
 *   - `uniqueTrimmedItems: true`  (for arrays of string items — unique after trimming)
 *   - `uniqueBy: "<property>"`  (for arrays of objects — that property is unique)
 *
 * Trimming is `String.prototype.trim`, the same canonicalization a consumer's
 * normalizer applies, so a value this validator accepts cannot collapse later.
 *
 * `schema === undefined` is a no-op — callers must guard before calling.
 * No ajv, no fs, no network. Host-agnostic.
 */
const SUPPORTED_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean"]);
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "type",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  // Size and shape bounds. Without these a script must re-check every string and
  // array by hand after validation succeeds, and a violation then throws and
  // kills the run — whereas a bound expressed here is fed back to the child by
  // the existing retry, which is the difference between a fatal answer and a
  // correctable one.
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  // Uniqueness and blankness, for the same reason. A repeated id or a
  // whitespace-only label is something the child can correct once told, but a
  // hand-written check after validation can only throw and end the run.
  // `uniqueItems` covers arrays of primitives, `uniqueBy` arrays of objects
  // keyed on one named property, `uniqueTrimmedItems` string arrays a consumer
  // trims anyway, and `nonBlank` a string that satisfies minLength 1 while
  // being nothing but whitespace.
  "nonBlank",
  "uniqueItems",
  "uniqueTrimmedItems",
  "uniqueBy",
]);

const STRING_ONLY_KEYWORDS = ["minLength", "maxLength", "pattern", "nonBlank"] as const;
const ARRAY_ONLY_KEYWORDS = ["minItems", "maxItems", "uniqueItems", "uniqueTrimmedItems", "uniqueBy"] as const;

/** Item types `uniqueItems` and `uniqueBy` can compare without inventing an equality. */
const PRIMITIVE_SCHEMA_TYPES = ["string", "number", "integer", "boolean"] as const;

/** Validate the declaration before the first child call. Runtime value validation
 *  is useful only when authors cannot accidentally declare an ignored contract. */
function assertSupportedAgentSchema(schema: Record<string, unknown>, path = "schema"): void {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(`${path}: unsupported keyword "${keyword}"`);
    }
  }

  const type = schema.type;
  if (type !== undefined && (typeof type !== "string" || !SUPPORTED_SCHEMA_TYPES.has(type))) {
    throw new Error(`${path}: unsupported type ${JSON.stringify(type)}`);
  }
  if (type === undefined && schema.enum === undefined) {
    throw new Error(`${path}: schema must declare type or enum`);
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new Error(`${path}: enum must be a non-empty array`);
    }
    for (const [index, member] of schema.enum.entries()) {
      const supportedPrimitive =
        member === null ||
        typeof member === "string" ||
        typeof member === "boolean" ||
        (typeof member === "number" && Number.isFinite(member));
      if (!supportedPrimitive) {
        throw new Error(`${path}: enum value at index ${index} must be a JSON primitive`);
      }
      const matchesDeclaredType =
        type === undefined ||
        (type === "string" && typeof member === "string") ||
        (type === "number" && typeof member === "number") ||
        (type === "integer" && typeof member === "number" && Number.isInteger(member)) ||
        (type === "boolean" && typeof member === "boolean");
      if (!matchesDeclaredType) {
        throw new Error(`${path}: enum value at index ${index} does not match declared type ${String(type)}`);
      }
    }
  }

  const objectKeywords = ["required", "properties", "additionalProperties"].filter(
    (keyword) => schema[keyword] !== undefined,
  );
  if (objectKeywords.length > 0 && type !== "object") {
    throw new Error(`${path}: ${objectKeywords[0]} is only valid for an object schema`);
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error(`${path}: additionalProperties supports only false`);
  }

  let properties: Record<string, unknown> | undefined;
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new Error(`${path}: properties must be an object`);
    properties = schema.properties;
    for (const [name, child] of Object.entries(properties)) {
      if (!isRecord(child)) throw new Error(`${path}.properties.${name} must be a schema object`);
      assertSupportedAgentSchema(child, `${path}.properties.${name}`);
    }
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string")) {
      throw new Error(`${path}: required must be an array of strings`);
    }
    const required = schema.required as string[];
    if (new Set(required).size !== required.length) {
      throw new Error(`${path}: required contains duplicate property names`);
    }
    for (const key of required) {
      if (properties === undefined || !(key in properties)) {
        throw new Error(`${path}: required property "${key}" is not declared in properties`);
      }
    }
  }

  if (type === "array") {
    if (!isRecord(schema.items)) throw new Error(`${path}: array schema must declare items as a schema object`);
    assertSupportedAgentSchema(schema.items, `${path}.items`);
  } else if (schema.items !== undefined) {
    throw new Error(`${path}: items is only valid for an array schema`);
  }

  assertBoundKeywords(schema, path, type);
}

/**
 * A bound that can never be satisfied would burn every schema retry before
 * failing, so an impossible or misplaced declaration is refused here — before
 * the first child call — rather than discovered as an unexplained exhaustion.
 */
function assertBoundKeywords(schema: Record<string, unknown>, path: string, type: unknown): void {
  for (const keyword of STRING_ONLY_KEYWORDS) {
    if (schema[keyword] !== undefined && type !== "string") {
      throw new Error(`${path}: ${keyword} is only valid for a string schema`);
    }
  }
  for (const keyword of ARRAY_ONLY_KEYWORDS) {
    if (schema[keyword] !== undefined && type !== "array") {
      throw new Error(`${path}: ${keyword} is only valid for an array schema`);
    }
  }

  for (const keyword of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    const bound = schema[keyword];
    if (bound === undefined) continue;
    if (typeof bound !== "number" || !Number.isSafeInteger(bound) || bound < 0) {
      throw new Error(`${path}: ${keyword} must be a non-negative safe integer`);
    }
  }

  const impossible = (min: unknown, max: unknown): boolean =>
    typeof min === "number" && typeof max === "number" && min > max;
  if (impossible(schema.minLength, schema.maxLength)) {
    throw new Error(`${path}: minLength ${String(schema.minLength)} exceeds maxLength ${String(schema.maxLength)}`);
  }
  if (impossible(schema.minItems, schema.maxItems)) {
    throw new Error(`${path}: minItems ${String(schema.minItems)} exceeds maxItems ${String(schema.maxItems)}`);
  }

  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") throw new Error(`${path}: pattern must be a string`);
    try {
      compilePattern(schema.pattern);
    } catch (error) {
      throw new Error(
        `${path}: pattern is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  assertUniquenessKeywords(schema, path);
}

/**
 * The uniqueness and blankness keywords carry no numeric domain, so the ways to
 * get them wrong are all declarative: a value other than `true`, an item type
 * whose equality the runtime refuses to invent, or a `uniqueBy` property the
 * items do not actually promise. Each is refused before the first child call —
 * an ignored contract is worse than an absent one.
 */
function assertUniquenessKeywords(schema: Record<string, unknown>, path: string): void {
  for (const keyword of ["nonBlank", "uniqueItems", "uniqueTrimmedItems"] as const) {
    if (schema[keyword] !== undefined && schema[keyword] !== true) {
      throw new Error(`${path}: ${keyword} supports only true`);
    }
  }

  if (schema.uniqueItems === true && schema.uniqueTrimmedItems === true) {
    throw new Error(
      `${path}: uniqueItems and uniqueTrimmedItems cannot both be declared; uniqueTrimmedItems already rejects raw duplicates`,
    );
  }

  // Reached only for an array schema (ARRAY_ONLY_KEYWORDS above), whose `items`
  // is already proven to be a schema object by the caller.
  const items = isRecord(schema.items) ? schema.items : undefined;
  const itemType = items?.type;

  if (schema.uniqueItems === true && !isPrimitiveSchemaType(itemType)) {
    throw new Error(
      `${path}: uniqueItems requires items to declare a string, number, integer, or boolean type; use uniqueBy for objects`,
    );
  }
  if (schema.uniqueTrimmedItems === true && itemType !== "string") {
    throw new Error(`${path}: uniqueTrimmedItems requires items to declare a string type`);
  }

  if (schema.uniqueBy === undefined) return;
  if (typeof schema.uniqueBy !== "string" || schema.uniqueBy === "") {
    throw new Error(`${path}: uniqueBy must be a non-empty string`);
  }
  const property = schema.uniqueBy;
  if (itemType !== "object") {
    throw new Error(`${path}: uniqueBy requires items to declare an object type`);
  }
  const properties = isRecord(items?.properties) ? items.properties : undefined;
  if (properties === undefined || !(property in properties)) {
    throw new Error(`${path}: uniqueBy property ${JSON.stringify(property)} is not declared in items.properties`);
  }
  // Without `required`, an element missing the property is neither unique nor a
  // duplicate, and the runtime would have to invent that semantic. Requiring it
  // instead means the child gets `missing required property` — a better error.
  const required = Array.isArray(items?.required) ? items.required : [];
  if (!required.includes(property)) {
    throw new Error(`${path}: uniqueBy property ${JSON.stringify(property)} is not listed in items.required`);
  }
  const propertySchema = properties[property];
  if (!isRecord(propertySchema) || !isPrimitiveSchemaType(propertySchema.type)) {
    throw new Error(
      `${path}: uniqueBy property ${JSON.stringify(property)} must declare a string, number, integer, or boolean type`,
    );
  }
}

function isPrimitiveSchemaType(type: unknown): type is (typeof PRIMITIVE_SCHEMA_TYPES)[number] {
  return typeof type === "string" && (PRIMITIVE_SCHEMA_TYPES as readonly string[]).includes(type);
}

/**
 * JSON Schema `pattern` is an unanchored ECMA-262 search with no flags, so an
 * author who means "the whole value" writes the anchors themselves. Compiled
 * results are cached because validation re-runs on every retry.
 */
const patternCache = new Map<string, RegExp>();

function compilePattern(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached !== undefined) return cached;
  const compiled = new RegExp(pattern);
  patternCache.set(pattern, compiled);
  return compiled;
}

function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = "",
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const type = schema["type"];
  if (type !== undefined) {
    const loc = path || "root";
    if (type === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(
          `${loc}: expected object, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`,
        );
      } else {
        const obj = value as Record<string, unknown>;
        const required = schema["required"];
        if (Array.isArray(required)) {
          for (const key of required) {
            if (!(key in obj)) {
              errors.push(`${loc}: missing required property "${String(key)}"`);
            }
          }
        }
        const properties = schema["properties"];
        const propsObj =
          properties !== null && typeof properties === "object" && !Array.isArray(properties)
            ? (properties as Record<string, unknown>)
            : undefined;
        if (propsObj) {
          for (const [key, propSchema] of Object.entries(propsObj)) {
            if (key in obj && propSchema !== null && typeof propSchema === "object") {
              const sub = validateAgainstSchema(
                obj[key],
                propSchema as Record<string, unknown>,
                path ? `${path}.${key}` : key,
              );
              if (!sub.ok) errors.push(...sub.errors);
            }
          }
        }
        if (schema["additionalProperties"] === false) {
          for (const key of Object.keys(obj)) {
            if (propsObj === undefined || !(key in propsObj)) {
              errors.push(`${loc}: unexpected additional property "${key}"`);
            }
          }
        }
      }
    } else if (type === "array") {
      if (!Array.isArray(value)) {
        errors.push(`${path || "root"}: expected array, got ${typeof value}`);
      } else {
        const loc2 = path || "root";
        const minItems = schema["minItems"];
        const maxItems = schema["maxItems"];
        // Counts are reported by value: "at most 6" alone does not tell the child
        // how far over it went, and it has to decide what to drop.
        if (typeof minItems === "number" && value.length < minItems) {
          errors.push(`${loc2}: expected at least ${minItems} item(s), got ${value.length}`);
        }
        if (typeof maxItems === "number" && value.length > maxItems) {
          errors.push(`${loc2}: expected at most ${maxItems} item(s), got ${value.length}`);
        }
        const items = schema["items"];
        if (items !== null && typeof items === "object" && !Array.isArray(items)) {
          value.forEach((el, i) => {
            const sub = validateAgainstSchema(el, items as Record<string, unknown>, `${loc2}[${i}]`);
            if (!sub.ok) errors.push(...sub.errors);
          });
          errors.push(...arrayUniquenessErrors(value, schema, items as Record<string, unknown>, loc2));
        }
      }
    } else if (type === "string") {
      if (typeof value !== "string") {
        errors.push(`${path || "root"}: expected string, got ${typeof value}`);
      } else {
        errors.push(...stringBoundErrors(value, schema, path || "root"));
      }
    } else if (type === "number") {
      if (typeof value !== "number") {
        errors.push(`${path || "root"}: expected number, got ${typeof value}`);
      }
    } else if (type === "integer") {
      // A fractional number is the failure the child must be told about by value:
      // "got number" would read as a type mismatch it cannot act on.
      if (typeof value !== "number") {
        errors.push(`${path || "root"}: expected integer, got ${typeof value}`);
      } else if (!Number.isInteger(value)) {
        errors.push(`${path || "root"}: expected integer, got ${JSON.stringify(value)}`);
      }
    } else if (type === "boolean") {
      if (typeof value !== "boolean") {
        errors.push(`${path || "root"}: expected boolean, got ${typeof value}`);
      }
    }
  }

  // `enum` is independent of `type`: the value must strictly equal one listed member.
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && !enumValues.some((member) => member === value)) {
    errors.push(`${path || "root"}: value ${JSON.stringify(value)} not in enum`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function stringBoundErrors(value: string, schema: Record<string, unknown>, loc: string): string[] {
  const errors: string[] = [];
  const minLength = schema["minLength"];
  const maxLength = schema["maxLength"];
  // Lengths are reported by value so the child knows how much to cut, and the
  // pattern is echoed because "invalid id" gives it nothing to correct toward.
  if (typeof minLength === "number" && value.length < minLength) {
    errors.push(`${loc}: expected at least ${minLength} character(s), got ${value.length}`);
  }
  if (typeof maxLength === "number" && value.length > maxLength) {
    errors.push(`${loc}: expected at most ${maxLength} character(s), got ${value.length}`);
  }
  const pattern = schema["pattern"];
  if (typeof pattern === "string" && !compilePattern(pattern).test(value)) {
    errors.push(`${loc}: value ${JSON.stringify(value)} does not match pattern ${pattern}`);
  }
  // The count, not the value: a blank string can be hundreds of whitespace
  // characters, and echoing them would splice junk into the retry prompt — and
  // therefore into the replay key.
  if (schema["nonBlank"] === true && value.trim() === "") {
    errors.push(`${loc}: expected a non-blank string, got ${value.length} whitespace character(s)`);
  }
  return errors;
}

/**
 * Uniqueness runs after the per-element `items` pass and only over elements
 * whose runtime type matches the declared one, so a wrong-typed element reports
 * its type error and nothing else — the error set stays a pure function of the
 * value, which matters because these strings enter the retry prompt and the
 * replay key. Every later duplicate is reported at its own index and names the
 * first occurrence, which is the only form that says which one to edit.
 */
function arrayUniquenessErrors(
  value: readonly unknown[],
  schema: Record<string, unknown>,
  items: Record<string, unknown>,
  loc: string,
): string[] {
  const errors: string[] = [];
  const itemType = items["type"];

  const trimmed = schema["uniqueTrimmedItems"] === true;
  if (schema["uniqueItems"] === true || trimmed) {
    const firstIndex = new Map<unknown, number>();
    value.forEach((element, index) => {
      if (!matchesPrimitiveType(element, itemType)) return;
      const key = trimmed ? (element as string).trim() : element;
      const seen = firstIndex.get(key);
      if (seen === undefined) {
        firstIndex.set(key, index);
        return;
      }
      errors.push(
        trimmed
          ? `${loc}[${index}]: trimmed value ${JSON.stringify(key)} duplicates item ${seen}`
          : `${loc}[${index}]: value ${JSON.stringify(element)} duplicates item ${seen}`,
      );
    });
  }

  const uniqueBy = schema["uniqueBy"];
  if (typeof uniqueBy === "string" && uniqueBy !== "") {
    const firstIndex = new Map<unknown, number>();
    value.forEach((element, index) => {
      if (!isRecord(element) || !(uniqueBy in element)) return;
      const key = element[uniqueBy];
      const seen = firstIndex.get(key);
      if (seen === undefined) {
        firstIndex.set(key, index);
        return;
      }
      errors.push(`${loc}[${index}].${uniqueBy}: value ${JSON.stringify(key)} duplicates item ${seen}`);
    });
  }

  return errors;
}

function matchesPrimitiveType(value: unknown, type: unknown): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  return false;
}

/** Strip a ```json … ``` (or bare ``` … ```) fence if the model wrapped its JSON. */
function stripJsonFences(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return fence !== null ? fence[1]! : text;
}

/**
 * Tolerant JSON extraction from a child's final text for schema validation: try the whole
 * (fence-stripped) string, then fall back to the first {...}/[...] block. Used only
 * when a schema is provided; never throws.
 */
function parseJsonFromText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = stripJsonFences(text).trim();
  if (trimmed === "") return { ok: false, error: "empty response" };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    const block = /[{[][\s\S]*[\]}]/.exec(trimmed);
    if (block !== null) {
      try {
        return { ok: true, value: JSON.parse(block[0]) };
      } catch {
        // fall through to the error below
      }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Shape verdict for ONE child attempt of agent({schema}). */
interface AgentSchemaCheck {
  validation: WorkflowSchemaValidation;
  /** Present only when `validation.status === "valid"`. */
  value?: unknown;
}

/** Result of ONE child execution: the exact child text plus, for a shaped call, its verdict. */
interface AgentAttemptOutcome {
  text: string;
  schemaCheck?: AgentSchemaCheck;
}

/** What one PHYSICAL child execution hands back to its logical call. A failure is returned,
 *  not thrown, so the logical call can read its cause and decide whether it may repeat. */
type PhysicalAgentAttempt =
  { ok: true; text: string; outcome: AgentAttemptOutcome } | { ok: false; result: WorkflowAgentResult };

interface PhysicalAgentAttemptInput {
  /** The fully resolved request, minus the per-attempt `callId`. */
  req: WorkflowAgentRequest;
  permissionMode: PermissionMode;
  workspaceMode: WorkspaceMode;
  opts: WorkflowAgentAnyOptions | undefined;
  /** Resolved answer bound, including the run default. Kept outside the request and
   *  replay key so a tighter current bound rejects an older recorded answer. */
  maxAnswerChars?: number;
  checkSchema?: (text: string) => AgentSchemaCheck;
  /** Present only when the logical call was served from a record; no child then runs. */
  replayedText?: string;
  /** 1-based position of this physical attempt, and the bound it was drawn from. */
  attempt: number;
  attempts: number;
  /** Stable identity of the ONE logical call every attempt here belongs to. */
  logicalCallId: string;
}

/**
 * Validate one child answer against a declared schema with the DSL's single JSON extractor and
 * subset validator, then — only on a value that already validated — against the script's own
 * `validate` callback. `attempt` is the 1-based child run this verdict describes.
 *
 * The order is the contract: a cross-field rule presupposes the shape holds, so an off-shape
 * answer never reaches author code. `source` names the rejecting authority, and is recorded only
 * when two authorities could have rejected — a schema-only call has exactly one.
 */
function checkAgentSchema(
  text: string,
  schema: Record<string, unknown>,
  attempt: number,
  validate?: WorkflowAgentValidate,
): AgentSchemaCheck {
  const authority = validate === undefined ? {} : { source: "schema" as const };
  const parsed = parseJsonFromText(text);
  if (!parsed.ok) {
    return {
      validation: {
        status: "mismatch",
        attempts: attempt,
        errors: [`response is not valid JSON: ${parsed.error}`],
        ...authority,
      },
    };
  }
  const validation = validateAgainstSchema(parsed.value, schema);
  if (!validation.ok) {
    return { validation: { status: "mismatch", attempts: attempt, errors: [...validation.errors], ...authority } };
  }
  if (validate !== undefined) {
    const scriptErrors = assertScriptValidationErrors(validate(parsed.value));
    if (scriptErrors.length > 0) {
      return { validation: { status: "mismatch", attempts: attempt, errors: [...scriptErrors], source: "script" } };
    }
  }
  return { validation: { status: "valid", attempts: attempt, errors: [] }, value: parsed.value };
}

/**
 * Append the shape contract to a child prompt for agent({schema}).
 *
 * The host cannot force a tool call (Pi's agent-session surface exposes no tool choice), so the
 * prompt states the contract and the runtime ENFORCES it after the fact: parse, validate, retry,
 * fail closed. A retry repeats the request with the previous attempt's validator errors, which is
 * the only signal that makes a second try better than the first — a fresh child has no memory of it.
 */
function withSchemaContract(
  prompt: string,
  schema: Record<string, unknown>,
  attempt: number,
  previousErrors: readonly string[],
  previousSource: "schema" | "script",
  maxAttempts: number,
): string {
  // Exactly one repair block can appear, because the script validator only ever sees a
  // schema-valid value: an attempt has one rejecting authority. Script errors are never
  // merged into the schema list — schema errors carry 0-indexed JSON paths and observed
  // values, and one merged list would hand the child two index bases and frame a
  // cross-field violation as a shape violation.
  const repair =
    attempt > 1 && previousErrors.length > 0
      ? [
          "",
          previousSource === "script"
            ? `The previous answer (attempt ${attempt - 1} of ${maxAttempts}) matched the required shape but was REJECTED by the workflow script for:`
            : `The previous answer (attempt ${attempt - 1} of ${maxAttempts}) was REJECTED for:`,
          ...previousErrors.map((error) => `- ${error}`),
          "Return the corrected JSON value only.",
        ].join("\n")
      : "";
  return [
    prompt,
    "",
    "## Required answer shape",
    "",
    "Your final message must be ONE JSON value that validates against this JSON Schema.",
    "No prose before or after it, no explanation, no commentary.",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    repair,
  ]
    .join("\n")
    .trimEnd();
}

// ---------------------------------------------------------------------------
// createWorkflowRuntime
// ---------------------------------------------------------------------------

export function createWorkflowRuntime(options: WorkflowRuntimeOptions): WorkflowRuntime {
  const { runId, agentRunner } = options;
  assertWorkflowInput(options.args);
  assertBoundContinuation(options.continuation, runId);
  const args = options.args;
  const agentConcurrencyGate = createAgentConcurrencyGate(options.maxConcurrentAgents);
  const defaultMaxToolCalls = normalizeMaxToolCalls(
    options.defaultMaxToolCalls ?? DEFAULT_WORKFLOW_AGENT_MAX_TOOL_CALLS,
    "defaultMaxToolCalls",
  );
  // No package fallback here on purpose: the runner owns the contract, and an
  // embedder that supplies nothing keeps the pre-contract behaviour instead of
  // silently acquiring a bound it never asked for.
  const defaultMaxAnswerChars =
    options.defaultMaxAnswerChars === undefined ? undefined : normalizeMaxAnswerChars(options.defaultMaxAnswerChars);
  const defaultTimeoutMs =
    options.defaultTimeoutMs === undefined ? undefined : normalizeTimeoutMs(options.defaultTimeoutMs);
  const defaultMaxTurns =
    options.defaultMaxTurns === undefined ? undefined : normalizeMaxTurns(options.defaultMaxTurns);
  // Distinct from the DSL's own `nowMs()` below: that one is REPLAYED on a resume,
  // and a replayed clock would let a resumed run inherit the original run's elapsed
  // time. The budget deadline reads real time.
  const deadlineNowMs = options.nowMs ?? (() => Date.now());
  // Armed ONCE, here, so a nested parallel()/pipeline() child is checked on the same
  // clock as a top-level one instead of restarting the budget per group.
  let runtimeMs: number | undefined;
  let runDeadlineMs: number | undefined;
  let runStartedMs: number | undefined;
  if (options.runtimeMs !== undefined) {
    assertWorkflowBudgetValue("runtimeMs", options.runtimeMs);
    runtimeMs = options.runtimeMs;
    runStartedMs = deadlineNowMs();
    runDeadlineMs = runStartedMs + runtimeMs;
  }
  const maxTotalAgentInvocations = resolveMaxTotalAgentInvocations(options.maxTotalAgentInvocations);
  let totalAgentInvocations = 0;
  /**
   * Logical `agent()` calls, so every physical attempt of one call can name the call it
   * belongs to.
   *
   * `callId` cannot do that job: it is per-attempt by design (D5 — a discarded attempt is a
   * real agent call with its own transcript). And (agent, label, phase, group) cannot either:
   * `parallel()` may run two calls that agree on all four, and a reader grouping by those
   * fields would attribute one call's discarded attempt to the other.
   */
  let totalLogicalAgentCalls = 0;
  const journal = options.journal;
  const nowFn = options.now ?? (() => new Date().toISOString());
  const onEvent = options.onEvent;

  const journalMirror: WorkflowJournalLine[] = [];
  let _currentPhase: string | undefined;
  /** Set while a script `validate` callback is running. The callback sits between the
   *  child answer and agent_end, before artifact recording and replay journaling, so a
   *  nested child call there has no defined position in either sequence. */
  let insideValidate = false;
  let groupCounter = 0;
  const groupStack: Array<{ id: string; kind: "parallel" | "pipeline"; label: string }> = [];

  function emit(line: WorkflowJournalLine): void {
    journalMirror.push(line);
    try {
      journal?.write(line);
    } catch {
      // never throw into the DSL
    }
    try {
      onEvent?.(line);
    } catch {
      // never throw into the DSL
    }
  }

  function assertRunDeadline(): void {
    if (runDeadlineMs === undefined) return;
    const currentMs = deadlineNowMs();
    if (currentMs > runDeadlineMs) {
      throw new WorkflowRunDeadlineError(runtimeMs!, currentMs - runStartedMs!);
    }
  }

  /**
   * One runtime-source journal line per per-call axis raised above the value the run
   * would otherwise have applied. An axis the run never bounded (no default configured)
   * cannot be "raised", so it is skipped rather than reported against nothing.
   */
  function journalPerCallRaises(
    axes: Partial<Record<keyof WorkflowBudget, { requested: number | undefined; applied: number | undefined }>>,
  ): void {
    for (const [axis, values] of Object.entries(axes) as Array<
      [keyof WorkflowBudget, { requested: number | undefined; applied: number | undefined }]
    >) {
      const { requested, applied } = values;
      if (requested === undefined || applied === undefined || requested <= applied) continue;
      emit({
        ts: nowFn(),
        runId,
        kind: "log",
        source: "runtime",
        message: formatWorkflowBudgetRaise({ axis, applied, requested }, "call"),
        ...(_currentPhase !== undefined ? { phase: _currentPhase } : {}),
      });
    }
  }

  /**
   * ONE logical `agent()` call: the resolved request, the transport-retry bound, and the
   * replay envelope — opened once and closed once, whatever the physical executor below had
   * to do to get an answer.
   *
   * The replay record is POSITIONAL (`workflow-replay.ts` advances a read cursor per
   * `beginAgentAttempt` and latches divergence on a key mismatch), and a transport retry
   * re-sends the identical prompt. So a discarded attempt recorded at its own ordinal would
   * write two entries with the same key at consecutive positions; on resume the first
   * re-executes, succeeds, and every later call reads an ordinal off by one — a key
   * mismatch, the one-way divergence latch, and the recorded suffix discarded and re-run
   * live. One script-level call, one ordinal, is the invariant the record already assumes.
   *
   * `checkSchema` is supplied only by the shaped path; it runs on the final child text
   * BEFORE agent_end is emitted so the journal records whether the answer was shape-checked.
   */
  async function runAgentAttempt(
    prompt: string,
    opts: WorkflowAgentAnyOptions | undefined,
    checkSchema?: (text: string) => AgentSchemaCheck,
  ): Promise<AgentAttemptOutcome> {
    if (insideValidate) throw new Error("agent() must not be called from inside a validate callback");
    if (prompt.trim() === "") throw new Error("agent prompt must be non-empty");
    if (opts?.workspaceHandle !== undefined && options.workspaceManager === undefined) {
      throw new Error("workflow workspace manager is not configured");
    }
    const effectivePhase = opts?.phase ?? _currentPhase;
    const maxToolCalls = normalizeMaxToolCalls(opts?.maxToolCalls ?? defaultMaxToolCalls, "agent maxToolCalls");
    // Resolved here rather than at the check site below, so a call that declares
    // NOTHING is held to the run's bound. Gating the check on `opts.maxAnswerChars`
    // enforced the axis on exactly the calls that had already declared it, which is
    // an axis in name only. The value is validated before a child starts; the bound
    // itself is still applied to whatever answer arrives, fresh or replayed.
    const maxAnswerChars =
      opts?.maxAnswerChars !== undefined ? normalizeMaxAnswerChars(opts.maxAnswerChars) : defaultMaxAnswerChars;
    const timeoutMs = opts?.timeoutMs !== undefined ? normalizeTimeoutMs(opts.timeoutMs) : defaultTimeoutMs;
    // Refused here — before the invocation is spent on a child — so an out-of-clamp
    // value is an authoring error the operator reads immediately, not a host
    // request-validation failure discovered after the run started spending.
    const maxTurns = opts?.maxTurns !== undefined ? normalizeMaxTurns(opts.maxTurns) : defaultMaxTurns;
    // A stage that asks for MORE than the run's applied default gets it — a down-only
    // rule would make a legitimately long stage unauthorable and the operator would
    // answer by raising the package default for everyone. What it does not get is
    // silence: the raise is journalled where the rest of the run's evidence lives.
    journalPerCallRaises({
      toolCalls: { requested: opts?.maxToolCalls, applied: defaultMaxToolCalls },
      answerChars: { requested: opts?.maxAnswerChars, applied: defaultMaxAnswerChars },
      timeoutMs: { requested: opts?.timeoutMs, applied: defaultTimeoutMs },
      turns: { requested: opts?.maxTurns, applied: defaultMaxTurns },
    });
    const agentName = opts?.agent ?? DEFAULT_WORKFLOW_AGENT;
    const permissionMode = defaultWorkflowPermissionMode(agentName, opts?.permissionMode);
    const workspaceMode = opts?.workspaceHandle !== undefined ? "worktree" : defaultWorkflowWorkspaceMode(opts);
    const req: WorkflowAgentRequest = {
      prompt,
      agent: agentName,
      ...(opts?.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
      permissionMode,
      workspaceMode,
      ...(opts?.workspaceHandle !== undefined ? { workspaceHandle: opts.workspaceHandle } : {}),
      ...(opts?.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      ...(effectivePhase !== undefined ? { phase: effectivePhase } : {}),
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(opts?.modelRole !== undefined ? { modelRole: opts.modelRole } : {}),
      // The declared fuse is the AUTHORITY over this child's wall clock (D4). It is
      // resolved here — default included — so the request the bridge receives always
      // carries the number the SDK turn budget is then derived from, and the two
      // deadlines can never expire at the same instant.
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(opts?.tools !== undefined ? { tools: [...opts.tools] } : {}),
      maxToolCalls,
      ...(opts?.label !== undefined ? { label: opts.label } : {}),
    };
    // Replay eligibility is decided from the RESOLVED request, so defaults and
    // aliases cannot make two different executions share a key. A worktree call
    // is never served from a record: its recorded text would claim a filesystem
    // mutation this run did not perform.
    const replayable = req.workspaceMode === "project" && req.workspaceHandle === undefined;
    // Bounded and gated BEFORE the replay envelope opens and before any child exists, so a
    // refused declaration costs neither an ordinal nor an invocation. Never clamped: a
    // script that declares `attempts: 50` must hear "no", not silently receive 3.
    const attempts = normalizeAgentAttempts(opts?.attempts);
    if (attempts > 1) {
      const refusal = transportRetryRefusal(req, replayable);
      if (refusal !== undefined) throw new Error(refusal);
    }
    const canonicalRequest = canonicalAgentRequest(req);
    // Allocated once per logical call, and only where one ordinal is opened: it is the name
    // the physical attempts below share, and the only field a report can group them by.
    totalLogicalAgentCalls += 1;
    const logicalCallId = `logical-${String(totalLogicalAgentCalls).padStart(4, "0")}`;
    const lookup = options.replay?.beginAgentAttempt(canonicalRequest, replayable);
    const replayedText = lookup?.replayed === true ? lookup.text : undefined;

    let lastFailure: WorkflowAgentResult | undefined;
    for (let attempt = 1; ; attempt++) {
      let physical: PhysicalAgentAttempt;
      try {
        physical = await runPhysicalAgentAttempt({
          req,
          permissionMode,
          workspaceMode,
          opts,
          ...(maxAnswerChars !== undefined ? { maxAnswerChars } : {}),
          attempt,
          attempts,
          logicalCallId,
          ...(checkSchema !== undefined ? { checkSchema } : {}),
          ...(replayedText !== undefined ? { replayedText } : {}),
        });
      } catch (err) {
        // A THROWN failure carries no classified cause, so it is never retried. Record it so
        // the recorded sequence keeps the same ordinals as the live one: a later resume then
        // replays the prefix and re-runs the call that failed, which is the point of resuming.
        options.replay?.recordAgentAttempt(canonicalRequest, { ok: false });
        throw err;
      }
      if (physical.ok) {
        // This run writes its OWN complete record, replayed entries included, so a
        // resume of a resume still has an unbroken prefix to work from.
        options.replay?.recordAgentAttempt(canonicalRequest, { ok: true, text: physical.text });
        return physical.outcome;
      }
      lastFailure = physical.result;
      if (attempt >= attempts || !isTransportRetryableFailure(physical.result)) break;
      // `log` carries no agent identity of its own (`workflow-journal.ts` rejects one), so the
      // agent is named in the message; the attempt's own agent_end already holds the rest.
      emit({
        ts: nowFn(),
        runId,
        kind: "log",
        source: "runtime",
        ...(req.phase !== undefined ? { phase: req.phase } : {}),
        message: `[workflow:retry] ${req.agent}${req.label === undefined ? "" : ` (${req.label})`}: transport attempt ${attempt} of ${attempts} failed with ${workflowAgentFailureCause(physical.result)}; re-running the identical request`,
      });
    }
    options.replay?.recordAgentAttempt(canonicalRequest, { ok: false });
    throw new WorkflowAgentExecutionError(lastFailure!);
  }

  /**
   * ONE physical child execution inside a logical call: its own invocation-cap charge, its
   * own `callId` and therefore its own transcript and result directories, its own
   * `agent_start`/`agent_end` pair, and the fail-closed status mapping.
   *
   * A discarded transport attempt is a real agent call and pays for all of it. A cap that
   * ignores retries is the same defect class as a cost counter hardcoded to zero: a gate
   * that does not count what it gates. The discarded attempt's transcript is also the only
   * evidence an operator has that the stage was paid for twice.
   */
  async function runPhysicalAgentAttempt(input: PhysicalAgentAttemptInput): Promise<PhysicalAgentAttempt> {
    const { permissionMode, workspaceMode, opts, maxAnswerChars, checkSchema, replayedText, attempt, attempts } = input;
    // Emitted only when a retry budget was actually declared, so every journal written
    // before `attempts` existed stays byte-identical and absence still means "one attempt".
    // The three travel together: an ordinal with no logical call to belong to cannot be
    // grouped, and a reader falling back to (agent, label, phase, group) would mis-attribute
    // two `parallel()` calls that agree on all four.
    const attemptFields = attempts > 1 ? { attempt, attempts, logicalCallId: input.logicalCallId } : {};
    // Global per-run cap across all agent() calls (including those nested in
    // parallel()/pipeline()). Count BEFORE doing any work so the attempt that breaches
    // the cap is itself counted, and throw a typed error that bubbles past grouped
    // contexts to exit the run. Cyclic workflows are allowed up to the cap.
    totalAgentInvocations += 1;
    if (totalAgentInvocations > maxTotalAgentInvocations) {
      throw new WorkflowInvocationCapError(maxTotalAgentInvocations);
    }
    // Refuse an already-expired attempt before it occupies a concurrency slot or
    // inflates the gate-owned peak. Fresh work checks again after any queue wait,
    // immediately before execution; a replay has no gate and this is its only check.
    assertRunDeadline();
    const callId = `call-${String(totalAgentInvocations).padStart(4, "0")}`;
    // `callId` is deliberately absent from `canonicalAgentRequest`, so giving each physical
    // attempt its own identity leaves the logical call's replay key untouched.
    const req: WorkflowAgentRequest = { ...input.req, callId };
    const replayed = replayedText !== undefined;
    const requestedLiveModel = liveModelFromSelector(req.model);
    emit({
      ts: nowFn(),
      runId,
      kind: "agent_start",
      agent: req.agent,
      ...(replayed ? { replayed: true } : {}),
      ...(req.readOnly !== undefined ? { readOnly: req.readOnly } : {}),
      permissionMode,
      workspaceMode,
      ...(req.workspaceHandle !== undefined ? { workspaceHandle: req.workspaceHandle } : {}),
      ...activeGroupFields(),
      // Both facts, neither fabricated: `model` keeps its documented live-row display
      // meaning for existing readers, `requestedModel` says out loud that at this point
      // in the run the value is a request and nothing has executed yet.
      ...(requestedLiveModel?.model !== undefined ? { model: requestedLiveModel.model } : {}),
      ...(requestedLiveModel?.model !== undefined ? { requestedModel: requestedLiveModel.model } : {}),
      ...(req.modelRole !== undefined ? { modelRole: req.modelRole } : {}),
      ...(requestedLiveModel?.thinking !== undefined ? { thinking: requestedLiveModel.thinking } : {}),
      ...(req.label !== undefined ? { label: req.label } : {}),
      callId,
      ...attemptFields,
      ...(req.phase !== undefined ? { phase: req.phase } : {}),
      // Slot descriptor for round correlation (REQ-009); only labelled agents anchor a slot.
      ...(req.label !== undefined ? { slotKey: workflowSlotKey({ phase: req.phase, label: req.label }) } : {}),
    });
    let executionStartedAtMs = Date.now();
    let finalResult: WorkflowAgentResult;
    if (replayedText !== undefined) {
      // No child runs. The recorded answer is projected into the same result
      // shape a fresh child would produce, minus `usage` — a replayed call cost
      // nothing, and claiming otherwise would inflate the run budget.
      finalResult = {
        ok: true,
        status: "completed",
        summary: "Replayed from a recorded run.",
        text: replayedText,
        diagnostics: [],
        agent: req.agent,
        permissionMode,
        workspaceMode,
        ...(req.readOnly !== undefined ? { readOnly: req.readOnly } : {}),
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
    } else {
      try {
        const [result] = await runScheduled<WorkflowAgentResult>([
          async () => {
            await agentConcurrencyGate.acquire();
            try {
              executionStartedAtMs = Date.now();
              assertRunDeadline();
              return await agentRunner(req);
            } finally {
              agentConcurrencyGate.release();
            }
          },
        ]);
        if (result === undefined) {
          throw new Error("scheduler returned empty array for single-agent call");
        }
        finalResult = result;
      } catch (err) {
        const durationMs = Date.now() - executionStartedAtMs;
        // A thrown transport failure never reaches an `agent_end`, so this IS the terminal
        // journal record of the call. Carrying the declared cause here is what makes
        // `sdk-unavailable` readable end to end without matching on the message.
        //
        // The attempt trio travels with it for the same reason: a call that timed out, was
        // re-run and then THREW leaves exactly one agent_end behind, so a reader that only
        // consumed agent_end would render a stage that ran twice as if it never retried.
        const thrownCause = thrownAgentFailureCause(err);
        emit({
          ts: nowFn(),
          runId,
          kind: "error",
          agent: req.agent,
          callId,
          ...attemptFields,
          ...(req.label !== undefined ? { label: req.label } : {}),
          ...(req.phase !== undefined ? { phase: req.phase } : {}),
          ...(thrownCause !== undefined ? { failureCause: thrownCause } : {}),
          message: err instanceof Error ? err.message : String(err),
          durationMs,
        });
        throw err;
      }
    }
    if (opts?.sandbox !== undefined) {
      finalResult.diagnostics = finalResult.diagnostics ?? [];
      finalResult.diagnostics.push(
        "`sandbox` is deprecated; it remains a compatible alias — file isolation only, not a security boundary",
      );
    }
    if (
      finalResult.ok &&
      finalResult.status === "completed" &&
      (finalResult.text === undefined || finalResult.text.trim() === "")
    ) {
      finalResult = {
        ...finalResult,
        ok: false,
        status: "failed",
        // An empty answer is the clearest signal a stage is under-decomposed. Naming the
        // cause keeps it OUT of the transport class rather than leaving it unclassified.
        failureCause: "empty-answer",
        summary: "Agent result text is empty.",
        diagnostics: [...finalResult.diagnostics, "Agent result text is empty."],
      };
    }
    // The answer bound is a runtime gate, not part of the request: it is checked
    // here so a replayed answer is held to the caller's CURRENT bound. Tightening
    // it therefore fails an old recording loudly instead of passing text the next
    // stage's prompt cannot hold.
    if (maxAnswerChars !== undefined && finalResult.ok && finalResult.status === "completed") {
      const length = finalResult.text?.length ?? 0;
      if (length > maxAnswerChars) {
        // Keep the established first sentence stable for callers that surface it
        // verbatim; append the budget classification instead of inserting it before
        // the sentence-ending period.
        const message = `Agent answer is ${length} characters; the call allows ${maxAnswerChars}. Budget axis: answerChars.`;
        finalResult = {
          ...finalResult,
          ok: false,
          status: "failed",
          // The child answered; the author's bound was wrong. Never a transport failure.
          failureCause: "answer-too-long",
          summary: message,
          diagnostics: [...finalResult.diagnostics, message],
        };
      }
    }
    // Shape check runs before agent_end so the run journal carries the verdict for THIS attempt.
    // A child that failed or returned no text has nothing to validate; that stays a run failure.
    let schemaCheck: AgentSchemaCheck | undefined;
    if (checkSchema !== undefined && finalResult.ok && finalResult.status === "completed") {
      try {
        schemaCheck = checkSchema(finalResult.text ?? "");
      } catch (err) {
        // A script validator that throws — or hands back something that is not an error
        // list — ends the run unchanged and spends no retry. The line is emitted because
        // this attempt really ran: without it the journal holds an agent_start with no
        // agent_end and no record of why the run stopped. It carries the attempt trio for
        // the same reason the transport catch does — this is the attempt's terminal record —
        // and the readback for the same reason: the child answered before the validator ran.
        emit({
          ts: nowFn(),
          runId,
          kind: "error",
          source: "script",
          agent: req.agent,
          callId,
          ...attemptFields,
          ...(req.label !== undefined ? { label: req.label } : {}),
          ...(req.phase !== undefined ? { phase: req.phase } : {}),
          ...executedModelEvidence(finalResult),
          message: err instanceof Error ? err.message : String(err),
          ...(finalResult.usage !== undefined ? { usage: finalResult.usage } : {}),
          durationMs: Date.now() - executionStartedAtMs,
        });
        throw err;
      }
    }
    // A replayed answer the CURRENT validator rejects fails the run closed, exactly as an
    // over-long replayed answer does above. Re-asking would form an attempt-2 prompt whose
    // key misses at that ordinal, trip the one-way divergence latch and silently turn the
    // operator's resume into a full live run. A SCHEMA mismatch on a replayed answer keeps
    // re-asking as before — that path predates this rule and is unchanged.
    if (replayed && schemaCheck?.validation.status === "mismatch" && schemaCheck.validation.source === "script") {
      const message = `Replayed agent answer was rejected by the workflow script: ${schemaCheck.validation.errors.join("; ")}`;
      finalResult = {
        ...finalResult,
        ok: false,
        status: "failed",
        failureCause: "script-rejected",
        summary: message,
        diagnostics: [...finalResult.diagnostics, message],
      };
    }
    const durationMs = Date.now() - executionStartedAtMs;
    let artifactEvidence;
    try {
      artifactEvidence = options.artifactPorts?.recordAgentEvidence({
        callId,
        name: opts?.artifact ?? defaultArtifactName(req.label ?? req.agent, callId),
        ...(req.phase !== undefined ? { stage: req.phase } : {}),
        ...(finalResult.text !== undefined ? { text: finalResult.text } : {}),
        replayed,
        ...(replayed && options.replaySourceRunId !== undefined
          ? { replaySourceRunId: options.replaySourceRunId }
          : {}),
        ...(finalResult.childSessionId !== undefined ? { childSessionId: finalResult.childSessionId } : {}),
        ...(finalResult.childTrace?.path !== undefined ? { childTracePath: finalResult.childTrace.path } : {}),
        ...(finalResult.resultArtifact !== undefined ? { resultArtifactPath: finalResult.resultArtifact } : {}),
      });
    } catch (err) {
      // The other terminal-by-throw record of a physical attempt: evidence writing failed,
      // so no agent_end follows. It carries the attempt trio for the same reason the
      // transport catch above does. The artifact writer runs after the child returned, so
      // this failure is the store's and not the call's — the readback rides along too.
      emit({
        ts: nowFn(),
        runId,
        kind: "error",
        source: "runtime",
        agent: req.agent,
        callId,
        ...attemptFields,
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(req.phase !== undefined ? { phase: req.phase } : {}),
        // The call already HAD a classification when adoption failed — this record is the
        // only terminal line it gets, so dropping the cause here would turn a classified
        // timeout into an unclassified store error and leave the operator matching prose.
        ...(finalResult.status !== "completed" ? { failureCause: workflowAgentFailureCause(finalResult) } : {}),
        ...executedModelEvidence(finalResult),
        ...(finalResult.usage !== undefined ? { usage: finalResult.usage } : {}),
        message: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      throw err;
    }
    emit({
      ts: nowFn(),
      runId,
      kind: "agent_end",
      agent: req.agent,
      callId,
      ...attemptFields,
      ...(replayed ? { replayed: true } : {}),
      ...((finalResult.readOnly ?? req.readOnly) !== undefined
        ? { readOnly: finalResult.readOnly ?? req.readOnly }
        : {}),
      status: finalResult.status,
      // Machine-readable cause on every non-completed call, so a reader never has to
      // match on `summary` prose to tell a timeout from a cancellation.
      ...(finalResult.status !== "completed" ? { failureCause: workflowAgentFailureCause(finalResult) } : {}),
      // Shape verdict for THIS attempt; absent on every call that declared no schema.
      ...(schemaCheck !== undefined ? { schemaValidation: schemaCheck.validation } : {}),
      permissionMode: finalResult.permissionMode ?? permissionMode,
      workspaceMode: finalResult.workspaceMode ?? workspaceMode,
      ...activeGroupFields(),
      ...(finalResult.model !== undefined ? { model: finalResult.model } : {}),
      // The two model facts this line can honestly carry: what the host said the child
      // ran on, and — when a declared tier had nothing assigned — that it degraded.
      ...(finalResult.executedModel !== undefined ? { executedModel: finalResult.executedModel } : {}),
      ...(finalResult.modelRoleFallback !== undefined ? { modelRoleFallback: finalResult.modelRoleFallback } : {}),
      ...(finalResult.thinking !== undefined ? { thinking: finalResult.thinking } : {}),
      ...(finalResult.evidence !== undefined ? { evidence: finalResult.evidence } : {}),
      ...(finalResult.evidence?.warnings !== undefined && finalResult.evidence.warnings.length > 0
        ? { evidenceWarnings: finalResult.evidence.warnings }
        : {}),
      ...(finalResult.childSessionId !== undefined ? { childSessionId: finalResult.childSessionId } : {}),
      ...(finalResult.childTrace !== undefined ? { childTrace: finalResult.childTrace } : {}),
      ...(finalResult.resultArtifact !== undefined ? { resultArtifact: finalResult.resultArtifact } : {}),
      ...(artifactEvidence?.answer !== undefined ? { answerArtifact: artifactEvidence.answer } : {}),
      ...(artifactEvidence?.transcript !== undefined ? { transcriptArtifact: artifactEvidence.transcript } : {}),
      ...(artifactEvidence?.result !== undefined ? { resultEnvelopeArtifact: artifactEvidence.result } : {}),
      ...(req.workspaceHandle !== undefined ? { workspaceHandle: req.workspaceHandle } : {}),
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(req.phase !== undefined ? { phase: req.phase } : {}),
      // Round record for the drill submenu (REQ-009): (slotKey,round,usage) from the bridge.
      // Absent on old journals ⇒ read side treats the run as no-rounds (submenu hidden).
      ...(finalResult.slotKey !== undefined ? { slotKey: finalResult.slotKey } : {}),
      ...(finalResult.round !== undefined ? { round: finalResult.round } : {}),
      ...(finalResult.usage !== undefined ? { usage: finalResult.usage } : {}),
      ...(finalResult.worktreePath !== undefined ? { worktreePath: finalResult.worktreePath } : {}),
      durationMs,
    });
    if (!finalResult.ok || finalResult.status !== "completed" || finalResult.text === undefined) {
      return { ok: false, result: finalResult };
    }
    return {
      ok: true,
      text: finalResult.text,
      outcome: { text: finalResult.text, ...(schemaCheck !== undefined ? { schemaCheck } : {}) },
    };
  }

  /**
   * `agent()` — the exact-text default, plus the opt-in shaped answer.
   *
   * Without `schema` this is one child run resolving to the child's exact final text: no prompt
   * augmentation, no parsing, unchanged journal. With `schema` the runtime owns the contract at
   * the boundary: it appends a deterministic shape block to the prompt, runs the child, parses
   * and validates its text, retries up to SCHEMA_MAX_ATTEMPTS with the previous validator errors
   * fed back, and resolves to the validated value. Every attempt is a real child run and is
   * journaled as one. Exhaustion throws SchemaValidationError — never a partial or untyped value.
   *
   * `validate` extends that loop to the rules a declared schema cannot say — referential
   * integrity, cross-field agreement, summed budgets, graph shape. It runs after schema
   * validation succeeds, its errors reach the child in their own labelled repair block, and a
   * call that declares it gets one dedicated extra attempt.
   */
  function agentDsl(prompt: string, opts: WorkflowAgentSchemaOptions): Promise<unknown>;
  function agentDsl(prompt: string, opts?: WorkflowAgentOptions): Promise<string>;
  async function agentDsl(prompt: string, opts?: WorkflowAgentAnyOptions): Promise<unknown> {
    const schema = opts?.schema;
    const declaredValidate = opts?.validate;
    // Refused before the text overload returns: the text path runs one attempt and has no
    // parsed value, so a validator there would silently never run and report success.
    if (declaredValidate !== undefined) {
      if (schema === undefined) throw new Error("agent validate requires a schema");
      if (typeof declaredValidate !== "function") throw new Error("agent validate must be a function");
    }
    if (schema === undefined) return (await runAgentAttempt(prompt, opts)).text;
    if (!isRecord(schema)) throw new Error("agent schema must be a JSON-schema object");
    assertSupportedAgentSchema(schema);

    const validate: WorkflowAgentValidate | undefined =
      declaredValidate === undefined
        ? undefined
        : (value) => {
            insideValidate = true;
            try {
              return declaredValidate(value);
            } finally {
              insideValidate = false;
            }
          };
    // A dedicated, unconditional extra attempt when a validator is declared. It is not
    // conditioned on which authority rejected which attempt, because the repair block must
    // state a TRUE budget ("attempt 1 of M") in text that enters the replay key, and at
    // render time nobody knows who will reject the next answer. A schema-only call keeps
    // the old constant, so every existing recording's attempt-2 prompt is byte-identical.
    const maxAttempts = validate === undefined ? SCHEMA_MAX_ATTEMPTS : SCHEMA_MAX_ATTEMPTS + 1;

    let lastErrors: string[] = [];
    let lastSource: "schema" | "script" = "schema";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptPrompt = withSchemaContract(prompt, schema, attempt, lastErrors, lastSource, maxAttempts);
      const outcome = await runAgentAttempt(attemptPrompt, opts, (text) =>
        checkAgentSchema(text, schema, attempt, validate),
      );
      const check = outcome.schemaCheck;
      if (check?.validation.status === "valid") return check.value;
      lastErrors = check?.validation.errors ?? ["agent returned no text to validate"];
      lastSource = check?.validation.source === "script" ? "script" : "schema";
    }
    throw new SchemaValidationError(lastErrors, maxAttempts);
  }

  async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
    return runGrouped("parallel", thunks.length, () => runGroupBranches("parallel", thunks));
  }

  async function pipeline<T>(items: T[], ...stages: Array<WorkflowStage<unknown>>): Promise<unknown[]> {
    const itemThunks: Array<() => Promise<unknown>> = items.map((_item, itemIndex) => {
      const item = _item;
      return async () => {
        let acc: unknown = item;
        for (const [_si, stage] of stages.entries()) {
          const si = _si;
          try {
            const next = await stage(acc, itemIndex * stages.length + si);
            const returnedFailure = classifyReturnedGroupFailure(next, itemIndex, si);
            if (returnedFailure !== undefined) {
              throw new CapturedWorkflowBranchFailure(next, returnedFailure);
            }
            acc = next;
          } catch (err) {
            if (isRunLevelWorkflowFailure(err) || err instanceof CapturedWorkflowBranchFailure) throw err;
            throw new CapturedWorkflowBranchFailure(undefined, {
              index: itemIndex,
              stageIndex: si,
              kind: "thrown",
              message: workflowErrorMessage(err),
            });
          }
        }
        return acc;
      };
    });
    return runGrouped("pipeline", itemThunks.length, () => runGroupBranches("pipeline", itemThunks));
  }

  async function runGroupBranches<T>(kind: WorkflowGroupKind, thunks: Array<() => Promise<T>>): Promise<T[]> {
    const groupId = activeGroupFields().groupId ?? `${kind}-unknown`;
    const wrapped: Array<() => Promise<WorkflowGroupSlot<T>>> = thunks.map((thunk, index) => async () => {
      try {
        const value = await thunk();
        const returnedFailure = classifyReturnedGroupFailure(value, index);
        if (returnedFailure === undefined) return { index, status: "completed", value };
        emitGroupBranchFailure(returnedFailure);
        return { index, status: "failed", value, failure: returnedFailure };
      } catch (err) {
        // The invocation cap and the run deadline are hard RUN-level failures and
        // keep their own public error types instead of being converted into a
        // partial group: a bound on the whole run is not one branch's problem.
        if (isRunLevelWorkflowFailure(err)) throw err;
        const failure =
          err instanceof CapturedWorkflowBranchFailure
            ? err.failure
            : { index, kind: "thrown" as const, message: workflowErrorMessage(err) };
        emitGroupBranchFailure(failure);
        return {
          index,
          status: "failed",
          ...(err instanceof CapturedWorkflowBranchFailure && err.failure.kind === "returned-failure"
            ? { value: err.value as T }
            : {}),
          failure,
        };
      }
    });
    const slots = await runScheduled(wrapped);
    if (slots.some((slot) => slot.status === "failed")) {
      throw new WorkflowGroupFailureError(kind, groupId, slots);
    }
    return slots.map((slot) => (slot as Extract<WorkflowGroupSlot<T>, { status: "completed" }>).value);
  }

  function emitGroupBranchFailure(failure: WorkflowBranchFailure): void {
    emit({
      ts: nowFn(),
      runId,
      kind: "error",
      message: failure.message,
      ...(_currentPhase !== undefined ? { phase: _currentPhase } : {}),
      ...activeGroupFields(),
    });
  }

  function phase(name: string): void {
    _currentPhase = name;
    emit({ ts: nowFn(), runId, kind: "phase", phase: name });
  }

  function log(msg: string): void {
    emit({
      ts: nowFn(),
      runId,
      kind: "log",
      source: "script",
      message: msg,
      ...(_currentPhase !== undefined ? { phase: _currentPhase } : {}),
    });
  }

  function awaitOperator(input: WorkflowAwaitOperatorDeclaration): void {
    const declaration = normalizeWorkflowAwaitOperatorDeclaration(input);
    if (options.onAwaitOperator === undefined) {
      throw new Error("awaitOperator is not configured by the workflow runner");
    }
    options.onAwaitOperator(declaration);
  }

  async function workflowDsl<T = unknown>(
    subFn: (dsl: WorkflowDsl, input?: string) => Promise<T>,
    input?: string,
  ): Promise<T> {
    assertWorkflowInput(input, "nested workflow input");
    emit({
      ts: nowFn(),
      runId,
      kind: "log",
      source: "runtime",
      message: "[workflow:enter]",
      ...(_currentPhase !== undefined ? { phase: _currentPhase } : {}),
    });
    const result = await subFn(dsl, input);
    emit({
      ts: nowFn(),
      runId,
      kind: "log",
      source: "runtime",
      message: "[workflow:exit]",
      ...(_currentPhase !== undefined ? { phase: _currentPhase } : {}),
    });
    return result;
  }

  async function runGrouped<T extends unknown[]>(
    kind: "parallel" | "pipeline",
    total: number,
    run: () => Promise<T>,
  ): Promise<T> {
    const id = `${kind}-${++groupCounter}`;
    const label = `${kind} ${total}`;
    emit({
      ts: nowFn(),
      runId,
      kind: "group_start",
      groupId: id,
      groupKind: kind,
      groupLabel: label,
      groupTotal: total,
      ...(_currentPhase !== undefined ? { phase: _currentPhase } : {}),
    });
    groupStack.push({ id, kind, label });
    const start = Date.now();
    try {
      const results = await run();
      emit({
        ts: nowFn(),
        runId,
        kind: "group_end",
        status: "completed",
        groupId: id,
        groupKind: kind,
        groupLabel: label,
        groupTotal: total,
        groupCompleted: total,
        groupFailed: 0,
        ...(_currentPhase !== undefined ? { phase: _currentPhase } : {}),
        durationMs: Date.now() - start,
      });
      return results;
    } catch (err) {
      const groupFailure = err instanceof WorkflowGroupFailureError ? err : undefined;
      emit({
        ts: nowFn(),
        runId,
        kind: "group_end",
        status: "failed",
        groupId: id,
        groupKind: kind,
        groupLabel: label,
        groupTotal: total,
        groupCompleted: groupFailure?.completed ?? 0,
        groupFailed: groupFailure?.failed ?? total,
        ...(_currentPhase !== undefined ? { phase: _currentPhase } : {}),
        message: workflowErrorMessage(err),
        durationMs: Date.now() - start,
      });
      throw err;
    } finally {
      const top = groupStack.at(-1);
      if (top?.id === id) groupStack.pop();
      else {
        const index = groupStack.findIndex((entry) => entry.id === id);
        if (index >= 0) groupStack.splice(index, 1);
      }
    }
  }

  function activeGroupFields(): Pick<WorkflowJournalLine, "groupId" | "groupKind" | "groupLabel"> {
    const group = groupStack.at(-1);
    if (group === undefined) return {};
    return { groupId: group.id, groupKind: group.kind, groupLabel: group.label };
  }

  async function promptFile(path: string, variables?: Record<string, string>): Promise<string> {
    if (options.resourceLoader === undefined) {
      throw new Error("workflow resource loader is not configured");
    }
    return options.resourceLoader.renderPrompt(path, variables);
  }

  async function workspace(label: string, ref: string): Promise<string> {
    if (options.workspaceManager === undefined) {
      throw new Error("workflow workspace manager is not configured");
    }
    return options.workspaceManager.allocate(label, ref);
  }

  function projectRoot(): string {
    if (options.projectRoot === undefined || options.projectRoot.trim() === "") {
      throw new Error("workflow project root is not configured");
    }
    return options.projectRoot;
  }

  function publishArtifact(name: string, text: string): WorkflowArtifactRef {
    if (options.artifactPorts === undefined) throw new Error("workflow artifact store is not configured");
    return options.artifactPorts.publishText(name, text, _currentPhase);
  }

  function consumeTextArtifact(ref: WorkflowArtifactRef): WorkflowConsumedTextArtifact {
    if (options.artifactPorts === undefined) throw new Error("workflow artifact store is not configured");
    return options.artifactPorts.consumeText(ref, _currentPhase);
  }

  function continuationArtifacts(): readonly WorkflowContinuationArtifact[] {
    return options.continuation?.artifacts ?? [];
  }

  /**
   * The DSL's answer to replay determinism: supply the nondeterministic value
   * instead of banning the call. Without a replay store these are exactly
   * `Date.now()` / `Math.random()`; with one they are recorded on the first run
   * and returned from the record on a resumed run, until the prefix diverges.
   */
  function nowMs(): number {
    return options.replay === undefined ? Date.now() : options.replay.resolveValue("clock", () => Date.now());
  }

  function random(): number {
    return options.replay === undefined ? Math.random() : options.replay.resolveValue("random", () => Math.random());
  }

  const dsl: WorkflowDsl = {
    agent: agentDsl,
    promptFile,
    workspace,
    projectRoot,
    publishArtifact,
    consumeTextArtifact,
    continuationArtifacts,
    parallel,
    pipeline,
    phase,
    log,
    awaitOperator,
    now: nowMs,
    random,
    workflow: workflowDsl,
  };

  return {
    dsl,
    getJournal: () => [...journalMirror],
    getArgs: () => args,
    currentPhase: () => _currentPhase,
    peakAgentConcurrency: () => agentConcurrencyGate.peak(),
  };
}

function assertBoundContinuation(binding: WorkflowBoundContinuation | undefined, runId: string): void {
  if (binding === undefined) return;
  if (typeof binding.originRunId !== "string" || binding.originRunId.trim() === "") {
    throw new Error("workflow continuation binding has an invalid originRunId");
  }
  if (!Array.isArray(binding.artifacts) || binding.artifacts.length < 1 || binding.artifacts.length > 8) {
    throw new Error("workflow continuation binding must contain 1-8 artifacts");
  }
  const identities = new Set<string>();
  for (const pair of binding.artifacts) {
    if (!isRecord(pair) || !isRecord(pair.sourceRef) || !isRecord(pair.consumedArtifact)) {
      throw new Error("workflow continuation binding has an invalid artifact pair");
    }
    const sourceRef = pair.sourceRef as unknown as WorkflowArtifactRef;
    const consumed = pair.consumedArtifact as unknown as WorkflowConsumedTextArtifact;
    if (sourceRef.runId !== binding.originRunId || consumed.source?.runId !== binding.originRunId) {
      throw new Error("workflow continuation binding does not match its origin run");
    }
    if (!isRecord(consumed.ref) || consumed.ref.runId !== runId) {
      throw new Error("workflow continuation consumed artifact does not belong to the current run");
    }
    const identity = `${sourceRef.runId}\u001f${sourceRef.artifactId}`;
    if (identities.has(identity)) throw new Error("workflow continuation binding has a duplicate artifact identity");
    identities.add(identity);
  }
}

/**
 * Stable slot descriptor `(phase, label)` for a workflow agent (REQ-009, D-006). A loop
 * that re-invokes `agent()` with the same (phase,label) resolves to the same slot, so its
 * rounds anchor to one live row / one journal correlation key. Pure and host-agnostic; the
 * bridge (live row) and the runtime (agent_start journal line) both derive it from here so
 * they never drift. The `` unit separator keeps phase/label unambiguous.
 */
export function workflowSlotKey(input: { phase?: string | undefined; label?: string | undefined }): string {
  return `${input.phase ?? ""}${input.label ?? ""}`;
}

/**
 * Canonical identity of one child request for the replay record (T-109).
 *
 * Built from the RESOLVED request rather than the author's `opts`, so a default
 * that later changes value cannot silently reuse a record made under the old
 * default. Every field is listed explicitly: a field added to
 * `WorkflowAgentRequest` without being added here would widen what counts as
 * "the same call", so the omission has to be a deliberate edit rather than an
 * accident of spreading the object. A declared `schema` needs no field of its
 * own — it is already baked into `prompt` by `withSchemaContract`.
 */
function canonicalAgentRequest(req: WorkflowAgentRequest): string {
  return JSON.stringify({
    prompt: req.prompt,
    agent: req.agent,
    readOnly: req.readOnly ?? null,
    tools: req.tools ?? null,
    maxToolCalls: req.maxToolCalls ?? null,
    model: req.model ?? null,
    // The tier a stage DECLARED. Two stages on two tiers are two different calls and
    // must not share one record. Known residual, tested in workflow-replay.test.ts:
    // the key is built here, before the bridge consults the roles table, so it
    // identifies the declared NAME and not the model that produced the answer —
    // remapping `smol` in a roles config, or editing an agent's frontmatter, reuses
    // the record. Recorded runs must be invalidated by hand after such a change.
    modelRole: req.modelRole ?? null,
    // Same class as `maxToolCalls`: a fuse that shapes execution, so changing it
    // is a different call and must not reuse the earlier record.
    timeoutMs: req.timeoutMs ?? null,
    // Same class again: two turn budgets produce different child behaviour, so a
    // record made under one must not be served to the other.
    maxTurns: req.maxTurns ?? null,
    label: req.label ?? null,
    phase: req.phase ?? null,
    sandbox: req.sandbox ?? null,
    permissionMode: req.permissionMode ?? null,
    workspaceMode: req.workspaceMode ?? null,
    workspaceHandle: req.workspaceHandle ?? null,
  });
}

function defaultArtifactName(label: string, callId: string): string {
  const safe = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return safe === "" ? `${callId}-answer` : safe;
}

function liveModelFromSelector(selector: string | undefined): { model: string; thinking?: string } | undefined {
  if (selector === undefined) return undefined;
  const trimmed = selector.trim();
  if (!trimmed.includes("/")) return undefined;
  const colon = trimmed.lastIndexOf(":");
  if (colon > -1) {
    const suffix = trimmed.slice(colon + 1);
    if (isThinkingSuffix(suffix)) return { model: trimmed.slice(0, colon), thinking: suffix };
  }
  return { model: trimmed };
}

function isThinkingSuffix(value: string): boolean {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "thinking"
  );
}

function classifyReturnedGroupFailure(
  value: unknown,
  index: number,
  stageIndex?: number,
): WorkflowBranchFailure | undefined {
  if (!isRecord(value)) return undefined;
  const status = typeof value.status === "string" ? value.status : undefined;
  const failedStatus = status === "failed" || status === "blocked" || status === "cancelled";
  if (value.ok !== false && !failedStatus) return undefined;
  const summary = typeof value.summary === "string" && value.summary.trim() !== "" ? value.summary : undefined;
  const firstDiagnostic = Array.isArray(value.diagnostics)
    ? value.diagnostics.find((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : undefined;
  const message = workflowErrorMessage(
    summary ??
      firstDiagnostic ??
      (status === undefined ? "branch returned ok:false" : `branch returned status=${status}`),
  );
  return {
    index,
    kind: "returned-failure",
    message,
    ...(stageIndex !== undefined ? { stageIndex } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function workflowErrorMessage(value: unknown): string {
  try {
    const raw = value instanceof Error ? value.message : String(value);
    const compact = raw.replace(/\s+/gu, " ").trim();
    return compact === "" ? "unknown branch failure" : compact.slice(0, 240);
  } catch {
    return "unknown branch failure";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
