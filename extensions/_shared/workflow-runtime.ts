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

import type { WorkflowRunSummary } from "./workflow-journal.js";
import type { WorkflowReplayController } from "./workflow-replay.js";
import type { WorkflowResourceLoader } from "./workflow-resources.js";
import type { WorkflowSourceState, WorkflowSourceStateReader, WorkflowWorkspaceManager } from "./workflow-worktree.js";
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
import type { EvidenceEvaluation, PermissionMode, WorkspaceMode } from "./types.js";
export type { PermissionMode, WorkspaceMode } from "./types.js";
export type {
  WorkflowAwaitOperatorDeclaration,
  WorkflowOperatorHandoffDeclaration,
  WorkflowOperatorQuestion,
} from "./workflow-handoff.js";

/** The single agent-execution callback the runtime depends on. The bridge supplies
 *  the real implementation; tests supply a fake. The runtime never imports the SDK. */
export type WorkflowAgentRunner = (req: WorkflowAgentRequest) => Promise<WorkflowAgentResult>;

export const DEFAULT_WORKFLOW_AGENT = "default";
export const WORKFLOW_INPUT_MAX_CHARS = 16_000;
/** High per-child safety fuse. Ordinary agent work should finish far below this value. */
export const DEFAULT_WORKFLOW_AGENT_MAX_TOOL_CALLS = 1_000;
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
  /** Per-call model selector, e.g. "provider/id" or "provider/id:thinking". */
  model?: string;
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
  model?: string;
  thinking?: string;
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
  /** Number of fresh child/model completions actually executed for this DSL call. */
  attempts: number;
  /** Final validator/parser errors on mismatch; empty after a valid attempt. */
  errors: string[];
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
  /** Capture and persist one deterministic host-owned source-state fingerprint. */
  captureSourceState(label: string): WorkflowSourceState;
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
  /** Per-call model selector, e.g. "provider/id" or "provider/id:thinking". */
  model?: string;
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
}

/** Options for the shaped overload. The schema property cannot be smuggled through
 *  WorkflowAgentOptions, so a shaped call can never be typed as Promise<string>. */
export interface WorkflowAgentSchemaOptions extends Omit<WorkflowAgentOptions, "schema"> {
  schema: Record<string, unknown>;
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
  /** Resolved model selector for agent live-row display. */
  model?: string;
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
  // default DEFAULT_MAX_TOTAL_AGENT_INVOCATIONS (1000); global per-run cap across agent() calls;
  // cyclic workflows allowed up to the cap, exceeding it throws WorkflowInvocationCapError and exits the run.
  maxTotalAgentInvocations?: number;
  journal?: WorkflowJournalSink; // default: no-op sink
  /** Recorded-call store for `--resume`. Absent means neither record nor replay. */
  replay?: WorkflowReplayController;
  artifactPorts?: WorkflowArtifactPorts;
  sourceState?: WorkflowSourceStateReader;
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
}

class UnlimitedAgentConcurrencyGate implements AgentConcurrencyGate {
  acquire(): Promise<void> {
    return Promise.resolve();
  }

  release(): void {
    // no-op
  }
}

class CountingAgentConcurrencyGate implements AgentConcurrencyGate {
  private inUse = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrentAgents: number) {}

  acquire(): Promise<void> {
    if (this.inUse < this.maxConcurrentAgents) {
      this.inUse += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.inUse += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.inUse -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) next();
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

/** Default global per-run cap on total dsl.agent() invocations. Cyclic workflows are
 *  allowed up to this cap; exceeding it throws WorkflowInvocationCapError and exits the run. */
export const DEFAULT_MAX_TOTAL_AGENT_INVOCATIONS = 1000;

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
 *   - `type`: "object" | "array" | "string" | "number" | "boolean"
 *   - `required`: string[]  (for objects — lists required property names)
 *   - `properties`: Record<string, schema>  (recursive)
 *   - `additionalProperties`: false  (for objects — reject keys not in `properties`)
 *   - `items`: schema  (for arrays — validates every element, recursive)
 *   - `enum`: JSON primitive[]  (value must be strictly equal to one listed member)
 *
 * `schema === undefined` is a no-op — callers must guard before calling.
 * No ajv, no fs, no network. Host-agnostic.
 */
const SUPPORTED_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "boolean"]);
const SUPPORTED_SCHEMA_KEYWORDS = new Set(["type", "enum", "required", "properties", "additionalProperties", "items"]);

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
        const items = schema["items"];
        if (items !== null && typeof items === "object" && !Array.isArray(items)) {
          value.forEach((el, i) => {
            const sub = validateAgainstSchema(el, items as Record<string, unknown>, `${path || "root"}[${i}]`);
            if (!sub.ok) errors.push(...sub.errors);
          });
        }
      }
    } else if (type === "string") {
      if (typeof value !== "string") {
        errors.push(`${path || "root"}: expected string, got ${typeof value}`);
      }
    } else if (type === "number") {
      if (typeof value !== "number") {
        errors.push(`${path || "root"}: expected number, got ${typeof value}`);
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

/**
 * Validate one child answer against a declared schema with the DSL's single JSON extractor and
 * subset validator. `attempt` is the 1-based child run this verdict describes.
 */
function checkAgentSchema(text: string, schema: Record<string, unknown>, attempt: number): AgentSchemaCheck {
  const parsed = parseJsonFromText(text);
  if (!parsed.ok) {
    return {
      validation: { status: "mismatch", attempts: attempt, errors: [`response is not valid JSON: ${parsed.error}`] },
    };
  }
  const validation = validateAgainstSchema(parsed.value, schema);
  if (!validation.ok) {
    return { validation: { status: "mismatch", attempts: attempt, errors: [...validation.errors] } };
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
): string {
  const repair =
    attempt > 1 && previousErrors.length > 0
      ? [
          "",
          `The previous answer (attempt ${attempt - 1} of ${SCHEMA_MAX_ATTEMPTS}) was REJECTED for:`,
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
  const maxTotalAgentInvocations = resolveMaxTotalAgentInvocations(options.maxTotalAgentInvocations);
  let totalAgentInvocations = 0;
  const journal = options.journal;
  const nowFn = options.now ?? (() => new Date().toISOString());
  const onEvent = options.onEvent;

  const journalMirror: WorkflowJournalLine[] = [];
  let _currentPhase: string | undefined;
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

  /** ONE child execution: invocation-cap accounting, journal start/end, fail-closed status
   *  mapping. `checkSchema` is supplied only by the shaped path; it runs on the final child text
   *  BEFORE agent_end is emitted so the journal records whether the answer was shape-checked. */
  async function runAgentAttempt(
    prompt: string,
    opts: WorkflowAgentAnyOptions | undefined,
    checkSchema?: (text: string) => AgentSchemaCheck,
  ): Promise<AgentAttemptOutcome> {
    // Global per-run cap across all agent() calls (including those nested in
    // parallel()/pipeline()). Count BEFORE doing any work so the call that breaches
    // the cap is itself counted, and throw a typed error that bubbles past grouped
    // contexts to exit the run. Cyclic workflows are allowed up to the cap.
    totalAgentInvocations += 1;
    if (totalAgentInvocations > maxTotalAgentInvocations) {
      throw new WorkflowInvocationCapError(maxTotalAgentInvocations);
    }
    const callId = `call-${String(totalAgentInvocations).padStart(4, "0")}`;
    if (prompt.trim() === "") throw new Error("agent prompt must be non-empty");
    if (opts?.workspaceHandle !== undefined && options.workspaceManager === undefined) {
      throw new Error("workflow workspace manager is not configured");
    }
    const effectivePhase = opts?.phase ?? _currentPhase;
    const maxToolCalls = normalizeMaxToolCalls(opts?.maxToolCalls ?? defaultMaxToolCalls, "agent maxToolCalls");
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
      ...(opts?.tools !== undefined ? { tools: [...opts.tools] } : {}),
      maxToolCalls,
      callId,
      ...(opts?.label !== undefined ? { label: opts.label } : {}),
    };
    // Replay eligibility is decided from the RESOLVED request, so defaults and
    // aliases cannot make two different executions share a key. A worktree call
    // is never served from a record: its recorded text would claim a filesystem
    // mutation this run did not perform.
    const replayable = req.workspaceMode === "project" && req.workspaceHandle === undefined;
    const canonicalRequest = canonicalAgentRequest(req);
    const lookup = options.replay?.beginAgentAttempt(canonicalRequest, replayable);
    const replayed = lookup?.replayed === true;

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
      ...(requestedLiveModel?.model !== undefined ? { model: requestedLiveModel.model } : {}),
      ...(requestedLiveModel?.thinking !== undefined ? { thinking: requestedLiveModel.thinking } : {}),
      ...(req.label !== undefined ? { label: req.label } : {}),
      callId,
      ...(req.phase !== undefined ? { phase: req.phase } : {}),
      // Slot descriptor for round correlation (REQ-009); only labelled agents anchor a slot.
      ...(req.label !== undefined ? { slotKey: workflowSlotKey({ phase: req.phase, label: req.label }) } : {}),
    });
    const start = Date.now();
    let finalResult: WorkflowAgentResult;
    if (lookup?.replayed === true) {
      // No child runs. The recorded answer is projected into the same result
      // shape a fresh child would produce, minus `usage` — a replayed call cost
      // nothing, and claiming otherwise would inflate the run budget.
      finalResult = {
        ok: true,
        status: "completed",
        summary: "Replayed from a recorded run.",
        text: lookup.text,
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
        const durationMs = Date.now() - start;
        // Record the failure so the recorded sequence keeps the same ordinals as
        // the live one: a later resume then replays the prefix and re-runs the
        // call that failed, which is the whole point of resuming.
        options.replay?.recordAgentAttempt(canonicalRequest, { ok: false });
        emit({
          ts: nowFn(),
          runId,
          kind: "error",
          agent: req.agent,
          callId,
          ...(req.label !== undefined ? { label: req.label } : {}),
          ...(req.phase !== undefined ? { phase: req.phase } : {}),
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
        summary: "Agent result text is empty.",
        diagnostics: [...finalResult.diagnostics, "Agent result text is empty."],
      };
    }
    // Shape check runs before agent_end so the run journal carries the verdict for THIS attempt.
    // A child that failed or returned no text has nothing to validate; that stays a run failure.
    const schemaCheck =
      checkSchema !== undefined && finalResult.ok && finalResult.status === "completed"
        ? checkSchema(finalResult.text ?? "")
        : undefined;
    const durationMs = Date.now() - start;
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
      emit({
        ts: nowFn(),
        runId,
        kind: "error",
        source: "runtime",
        agent: req.agent,
        callId,
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(req.phase !== undefined ? { phase: req.phase } : {}),
        message: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      throw err;
    }
    // This run writes its OWN complete record, replayed entries included, so a
    // resume of a resume still has an unbroken prefix to work from.
    options.replay?.recordAgentAttempt(
      canonicalRequest,
      finalResult.ok && finalResult.status === "completed" && finalResult.text !== undefined
        ? { ok: true, text: finalResult.text }
        : { ok: false },
    );
    emit({
      ts: nowFn(),
      runId,
      kind: "agent_end",
      agent: req.agent,
      callId,
      ...(replayed ? { replayed: true } : {}),
      ...((finalResult.readOnly ?? req.readOnly) !== undefined
        ? { readOnly: finalResult.readOnly ?? req.readOnly }
        : {}),
      status: finalResult.status,
      // Shape verdict for THIS attempt; absent on every call that declared no schema.
      ...(schemaCheck !== undefined ? { schemaValidation: schemaCheck.validation } : {}),
      permissionMode: finalResult.permissionMode ?? permissionMode,
      workspaceMode: finalResult.workspaceMode ?? workspaceMode,
      ...activeGroupFields(),
      ...(finalResult.model !== undefined ? { model: finalResult.model } : {}),
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
    if (!finalResult.ok || finalResult.status !== "completed") {
      throw new WorkflowAgentExecutionError(finalResult);
    }
    return { text: finalResult.text!, ...(schemaCheck !== undefined ? { schemaCheck } : {}) };
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
   */
  function agentDsl(prompt: string, opts: WorkflowAgentSchemaOptions): Promise<unknown>;
  function agentDsl(prompt: string, opts?: WorkflowAgentOptions): Promise<string>;
  async function agentDsl(prompt: string, opts?: WorkflowAgentAnyOptions): Promise<unknown> {
    const schema = opts?.schema;
    if (schema === undefined) return (await runAgentAttempt(prompt, opts)).text;
    if (!isRecord(schema)) throw new Error("agent schema must be a JSON-schema object");
    assertSupportedAgentSchema(schema);

    let lastErrors: string[] = [];
    for (let attempt = 1; attempt <= SCHEMA_MAX_ATTEMPTS; attempt++) {
      const attemptPrompt = withSchemaContract(prompt, schema, attempt, lastErrors);
      const outcome = await runAgentAttempt(attemptPrompt, opts, (text) => checkAgentSchema(text, schema, attempt));
      const check = outcome.schemaCheck;
      if (check?.validation.status === "valid") return check.value;
      lastErrors = check?.validation.errors ?? ["agent returned no text to validate"];
    }
    throw new SchemaValidationError(lastErrors, SCHEMA_MAX_ATTEMPTS);
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
            if (err instanceof WorkflowInvocationCapError || err instanceof CapturedWorkflowBranchFailure) throw err;
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
        // The invocation cap is a hard run-level failure and remains its own
        // public error type instead of being converted into a partial group.
        if (err instanceof WorkflowInvocationCapError) throw err;
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

  function captureSourceState(label: string): WorkflowSourceState {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(label)) {
      throw new Error("workflow source-state label must be a safe 1-96 character identifier");
    }
    if (options.sourceState === undefined) throw new Error("workflow source-state reader is not configured");
    if (options.artifactPorts === undefined) throw new Error("workflow artifact store is not configured");
    const state = options.sourceState.capture();
    options.artifactPorts.publishText(
      `source-state-${label}.json`,
      `${JSON.stringify({ label, ...state }, null, 2)}\n`,
      _currentPhase,
    );
    return state;
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
    captureSourceState,
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
