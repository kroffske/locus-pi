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
import type { WorkflowResourceLoader } from "./workflow-resources.js";
import type { WorkflowWorkspaceManager } from "./workflow-worktree.js";
import type { EvidenceEvaluation, PermissionMode, WorkspaceMode } from "./types.js";
export type { PermissionMode, WorkspaceMode } from "./types.js";

/** The single agent-execution callback the runtime depends on. The bridge supplies
 *  the real implementation; tests supply a fake. The runtime never imports the SDK. */
export type WorkflowAgentRunner = (req: WorkflowAgentRequest) => Promise<WorkflowAgentResult>;

export const DEFAULT_WORKFLOW_AGENT = "default";
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
  usage?: WorkflowLlmUsage;
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

/** The single direct-model callback the runtime depends on for dsl.llm(). The llm-bridge
 *  supplies the real impl (pi-ai completeSimple); tests supply a fake. The runtime never
 *  imports the SDK or pi-ai — it reaches the model ONLY through this injected runner. */
export type WorkflowLlmRunner = (req: WorkflowLlmRequest) => Promise<WorkflowLlmResult>;

export interface WorkflowLlmRequest {
  prompt: string;
  /** Maps to Context.systemPrompt; optional. */
  system?: string;
  /** Per-call model selector, e.g. "provider/id[:thinking]"; else the session model. */
  model?: string;
  /** Provider thinking level pass-through (pi-ai SimpleStreamOptions.reasoning). */
  reasoning?: string;
  /** When true, the bridge uses streamSimple and forwards text chunks to onDelta. */
  stream?: boolean;
  /** Internal: set by the runtime when stream is true; the bridge calls it per text chunk
   *  so the runtime can journal an llm_delta line. Not part of the public DSL options. */
  onDelta?: (textDelta: string) => void;
  label?: string;
  phase?: string;
}

/** Token + cost projection of pi-ai AssistantMessage.usage. */
export interface WorkflowLlmUsage {
  input: number;
  output: number;
  totalTokens: number;
  costTotal: number;
}

export interface WorkflowLlmResult {
  ok: boolean; // true when the model returned normally (stopReason stop/length)
  text: string; // concatenated assistant text content
  stopReason: string; // raw provider stop reason ("stop" | "length" | "error" | ...)
  model?: string; // resolved model selector actually used
  thinking?: string;
  usage?: WorkflowLlmUsage;
  output?: unknown; // parsed JSON value when a schema was provided and validation passed
  diagnostics: string[];
  label?: string;
  /** Present only when the call requested schema validation. This is protocol
   *  accounting, not a domain-quality verdict. */
  schemaValidation?: WorkflowSchemaValidation;
}

export interface WorkflowDsl {
  /** Run one child agent. Success resolves to its exact non-empty final text. */
  agent(prompt: string, opts?: WorkflowAgentOptions): Promise<string>;
  /** Render one neighboring .prompt.md resource from the original workflow source. */
  promptFile(path: string, variables?: Record<string, string>): Promise<string>;
  /** Allocate one retained runtime-owned linked worktree at an exact Git ref. */
  workspace(label: string, ref: string): Promise<string>;
  /** Absolute project root captured by the workflow runner. */
  projectRoot(): string;
  /** Direct one-shot model completion node — a thin sibling of agent(). No child session,
   *  no tools. Returns ok:false (never throws) when no llmRunner is configured or the model
   *  errors; a group classifies that explicit result as a typed branch failure. */
  llm(prompt: string, opts?: WorkflowLlmOptions): Promise<WorkflowLlmResult>;
  /** Run independent branches behind one fail-closed barrier and preserve input order. */
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;
  /** Run ordered stages for every item; a failed item stops before its later stages. */
  pipeline<T>(items: T[], ...stages: Array<WorkflowStage<unknown>>): Promise<unknown[]>;
  /** Change the current reader-visible stage and append a phase line to the run journal. */
  phase(name: string): void;
  /** Append a script-owned journal message tagged with the current phase. */
  log(msg: string): void;
  /** Run a nested workflow function with the same typed DSL handle. */
  workflow<T = unknown>(subFn: (dsl: WorkflowDsl, input: unknown) => Promise<T>, input?: unknown): Promise<T>;
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
  phase?: string;
  /** @deprecated use permissionMode / workspaceMode (P2-2) — this field remains a compatible alias; worktree isolation only, not a security boundary */
  sandbox?: "read-only" | "workspace-write";
  /** Permission intent for the child run. This is trace metadata, not a security boundary. */
  permissionMode?: PermissionMode;
  /** Workspace isolation intent for the child run. Worktrees isolate file changes for review, not security. */
  workspaceMode?: WorkspaceMode;
  /** Reuse a runtime-owned workspace allocated by workspace(). */
  workspaceHandle?: string;
}

export interface WorkflowLlmOptions {
  /** Maps to Context.systemPrompt. */
  system?: string;
  /** Per-call model selector, e.g. "provider/id[:thinking]"; else the session model. */
  model?: string;
  /** Provider thinking level pass-through. */
  reasoning?: string;
  /** Stream the completion: emit llm_delta journal events per text chunk. Default false. */
  stream?: boolean;
  /** When set, the runtime parses result.text as JSON, validates it against this schema, and
   *  retries up to SCHEMA_MAX_ATTEMPTS; on final mismatch returns ok:false (or throws when
   *  throwOnSchemaMismatch). A valid value is returned in result.output. */
  schema?: unknown;
  /** When true AND schema is set, a final schema mismatch throws SchemaValidationError instead
   *  of returning ok:false. Default false. */
  throwOnSchemaMismatch?: boolean;
  label?: string;
  phase?: string;
}

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
  kind:
    | "phase"
    | "log"
    | "group_start"
    | "group_end"
    | "agent_start"
    | "agent_end"
    | "llm_start"
    | "llm_end"
    | "llm_delta"
    | "error";
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
  /** Token/cost usage for llm_end lines (present when the model reported usage). */
  usage?: WorkflowLlmUsage;
  /** Resolved model selector for agent and llm live-row display. */
  model?: string;
  /** Resolved thinking/reasoning level for agent and llm live-row display. */
  thinking?: string;
  /** Incremental text chunk for llm_delta lines (streaming). */
  textDelta?: string;
  resumeFromRunId?: string;
  resumeSourceRunSummary?: WorkflowRunSummary | null;
}

export interface WorkflowRuntimeOptions {
  runId: string;
  agentRunner: WorkflowAgentRunner;
  /** Optional direct-model runner for dsl.llm(). When omitted, llm() returns a
   *  fail-closed ok:false result (never throws, never fabricates text). */
  llmRunner?: WorkflowLlmRunner;
  args?: unknown;
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
  now?: () => string; // default () => new Date().toISOString()
  onEvent?: (line: WorkflowJournalLine) => void; // progress callback (UI streaming)
}

export interface WorkflowRuntime {
  dsl: WorkflowDsl;
  getJournal(): WorkflowJournalLine[]; // in-memory mirror (for tests / final render)
  getArgs(): unknown;
  currentPhase(): string | undefined;
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

function defaultWorkflowWorkspaceMode(opts: WorkflowAgentOptions | undefined): WorkspaceMode {
  if (opts?.workspaceMode !== undefined) return opts.workspaceMode;
  if (opts?.sandbox !== undefined) return workspaceModeFromSandbox(opts.sandbox);
  return "project";
}

// ---------------------------------------------------------------------------
// Schema enforcement (S2)
// ---------------------------------------------------------------------------

/** Maximum direct-model invocation attempts when a schema is provided. */
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

/** Thrown by llm({ schema, throwOnSchemaMismatch: true }) when the model output still
 *  violates the schema after SCHEMA_MAX_ATTEMPTS. Carries the validator errors + attempt count. */
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
 *   - `enum`: unknown[]  (value must be strictly equal to one listed member)
 *
 * `schema === undefined` is a no-op — callers must guard before calling.
 * No ajv, no fs, no network. Host-agnostic.
 */
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
 * Tolerant JSON extraction from llm() text for schema validation: try the whole
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

// ---------------------------------------------------------------------------
// createWorkflowRuntime
// ---------------------------------------------------------------------------

export function createWorkflowRuntime(options: WorkflowRuntimeOptions): WorkflowRuntime {
  const { runId, agentRunner } = options;
  const llmRunner = options.llmRunner;
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

  async function agentDsl(prompt: string, opts?: WorkflowAgentOptions): Promise<string> {
    // Global per-run cap across all agent() calls (including those nested in
    // parallel()/pipeline()). Count BEFORE doing any work so the call that breaches
    // the cap is itself counted, and throw a typed error that bubbles past grouped
    // contexts to exit the run. Cyclic workflows are allowed up to the cap.
    totalAgentInvocations += 1;
    if (totalAgentInvocations > maxTotalAgentInvocations) {
      throw new WorkflowInvocationCapError(maxTotalAgentInvocations);
    }
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
      ...(opts?.label !== undefined ? { label: opts.label } : {}),
    };
    const requestedLiveModel = liveModelFromSelector(req.model);
    emit({
      ts: nowFn(),
      runId,
      kind: "agent_start",
      agent: req.agent,
      ...(req.readOnly !== undefined ? { readOnly: req.readOnly } : {}),
      permissionMode,
      workspaceMode,
      ...(req.workspaceHandle !== undefined ? { workspaceHandle: req.workspaceHandle } : {}),
      ...activeGroupFields(),
      ...(requestedLiveModel?.model !== undefined ? { model: requestedLiveModel.model } : {}),
      ...(requestedLiveModel?.thinking !== undefined ? { thinking: requestedLiveModel.thinking } : {}),
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(req.phase !== undefined ? { phase: req.phase } : {}),
      // Slot descriptor for round correlation (REQ-009); only labelled agents anchor a slot.
      ...(req.label !== undefined ? { slotKey: workflowSlotKey({ phase: req.phase, label: req.label }) } : {}),
    });
    const start = Date.now();
    let finalResult: WorkflowAgentResult;
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
      emit({
        ts: nowFn(),
        runId,
        kind: "error",
        agent: req.agent,
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(req.phase !== undefined ? { phase: req.phase } : {}),
        message: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      throw err;
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
    const durationMs = Date.now() - start;
    emit({
      ts: nowFn(),
      runId,
      kind: "agent_end",
      agent: req.agent,
      ...((finalResult.readOnly ?? req.readOnly) !== undefined
        ? { readOnly: finalResult.readOnly ?? req.readOnly }
        : {}),
      status: finalResult.status,
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
    return finalResult.text!;
  }

  async function llmDsl(prompt: string, opts?: WorkflowLlmOptions): Promise<WorkflowLlmResult> {
    const effectivePhase = opts?.phase ?? _currentPhase;
    const schema = opts?.schema;
    const wantStream = opts?.stream === true;
    const req: WorkflowLlmRequest = {
      prompt,
      ...(opts?.system !== undefined ? { system: opts.system } : {}),
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(opts?.reasoning !== undefined ? { reasoning: opts.reasoning } : {}),
      ...(wantStream ? { stream: true } : {}),
      ...(effectivePhase !== undefined ? { phase: effectivePhase } : {}),
      ...(opts?.label !== undefined ? { label: opts.label } : {}),
    };
    // Streaming: the bridge forwards each text chunk here so the runtime owns journaling.
    if (wantStream) {
      req.onDelta = (textDelta: string) => {
        emit({
          ts: nowFn(),
          runId,
          kind: "llm_delta",
          textDelta,
          ...activeGroupFields(),
          ...(req.label !== undefined ? { label: req.label } : {}),
          ...(req.phase !== undefined ? { phase: req.phase } : {}),
        });
      };
    }
    const requestedLiveModel = liveModelFromSelector(req.model);
    emit({
      ts: nowFn(),
      runId,
      kind: "llm_start",
      ...activeGroupFields(),
      ...(requestedLiveModel?.model !== undefined ? { model: requestedLiveModel.model } : {}),
      ...(req.reasoning !== undefined
        ? { thinking: req.reasoning }
        : requestedLiveModel?.thinking !== undefined
          ? { thinking: requestedLiveModel.thinking }
          : {}),
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(req.phase !== undefined ? { phase: req.phase } : {}),
    });
    const start = Date.now();

    function emitLlmEnd(status: string, r?: WorkflowLlmResult): void {
      const diagnostic = firstWorkflowDiagnostic(r);
      emit({
        ts: nowFn(),
        runId,
        kind: "llm_end",
        status,
        ...activeGroupFields(),
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(req.phase !== undefined ? { phase: req.phase } : {}),
        ...(r?.model !== undefined ? { model: r.model } : {}),
        ...(r?.thinking !== undefined
          ? { thinking: r.thinking }
          : req.reasoning !== undefined
            ? { thinking: req.reasoning }
            : {}),
        ...(r?.usage !== undefined ? { usage: r.usage } : {}),
        ...(r?.schemaValidation !== undefined ? { schemaValidation: r.schemaValidation } : {}),
        ...(status !== "completed" && diagnostic !== undefined ? { message: diagnostic } : {}),
        durationMs: Date.now() - start,
      });
    }

    // No runner configured: fail closed (honest ok:false), never throw, never fabricate text.
    if (llmRunner === undefined) {
      const unavailableResult: WorkflowLlmResult = {
        ok: false,
        text: "",
        stopReason: "error",
        diagnostics: ["llm runner not configured"],
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
      emitLlmEnd("failed", unavailableResult);
      return unavailableResult;
    }

    // Route through the single scheduler seam + concurrency gate, exactly like agent().
    // With schema: parse result.text as JSON, validate, and retry up to SCHEMA_MAX_ATTEMPTS.
    const throwOnMismatch = opts?.throwOnSchemaMismatch === true;
    const maxAttempts = schema !== undefined ? SCHEMA_MAX_ATTEMPTS : 1;
    let result: WorkflowLlmResult | undefined;
    let lastResult: WorkflowLlmResult | undefined;
    let lastSchemaErrors: string[] | undefined;
    let schemaAttempts = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      schemaAttempts += 1;
      let r: WorkflowLlmResult;
      try {
        const [scheduled] = await runScheduled<WorkflowLlmResult>([
          async () => {
            await agentConcurrencyGate.acquire();
            try {
              return await llmRunner(req);
            } finally {
              agentConcurrencyGate.release();
            }
          },
        ]);
        if (scheduled === undefined) {
          throw new Error("scheduler returned empty array for single-llm call");
        }
        r = scheduled;
      } catch (err) {
        emit({
          ts: nowFn(),
          runId,
          kind: "error",
          ...(req.label !== undefined ? { label: req.label } : {}),
          ...(req.phase !== undefined ? { phase: req.phase } : {}),
          message: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        });
        throw err; // bare llm() rejects; groups retain it in typed failure evidence
      }

      lastResult = r;
      // No schema, or model-level failure: nothing to validate.
      if (schema === undefined || !r.ok) {
        result = r;
        break;
      }
      // Validate: parse text as JSON, then check against the schema subset validator.
      const parsed = parseJsonFromText(r.text);
      if (parsed.ok) {
        const validation = validateAgainstSchema(parsed.value, schema as Record<string, unknown>);
        if (validation.ok) {
          result = { ...r, output: parsed.value };
          lastSchemaErrors = undefined;
          break;
        }
        lastSchemaErrors = validation.errors;
      } else {
        lastSchemaErrors = [`response is not valid JSON: ${parsed.error}`];
      }
      result = undefined; // not valid yet; retry (fresh completion) or fail below
    }

    // Schema enforcement produced a final mismatch after all attempts.
    if (schema !== undefined && result === undefined && lastSchemaErrors !== undefined) {
      const schemaValidation: WorkflowSchemaValidation = {
        status: "mismatch",
        attempts: schemaAttempts,
        errors: [...lastSchemaErrors],
      };
      const mismatchResult: WorkflowLlmResult = {
        ok: false,
        text: lastResult?.text ?? "",
        stopReason: lastResult?.stopReason ?? "error",
        ...(lastResult?.model !== undefined ? { model: lastResult.model } : {}),
        ...(lastResult?.usage !== undefined ? { usage: lastResult.usage } : {}),
        diagnostics: [...(lastResult?.diagnostics ?? []), `schema mismatch: ${lastSchemaErrors.join("; ")}`],
        schemaValidation,
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
      emitLlmEnd("failed", mismatchResult);
      if (throwOnMismatch) {
        throw new SchemaValidationError(lastSchemaErrors, maxAttempts);
      }
      return mismatchResult;
    }

    const baseResult = result!;
    const finalResult: WorkflowLlmResult =
      schema !== undefined && baseResult.ok
        ? {
            ...baseResult,
            schemaValidation: { status: "valid", attempts: schemaAttempts, errors: [] },
          }
        : baseResult;
    emitLlmEnd(finalResult.ok ? "completed" : "failed", finalResult);
    return finalResult;
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

  async function workflowDsl<T = unknown>(
    subFn: (dsl: WorkflowDsl, input: unknown) => Promise<T>,
    input?: unknown,
  ): Promise<T> {
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

  const dsl: WorkflowDsl = {
    agent: agentDsl,
    promptFile,
    workspace,
    projectRoot,
    llm: llmDsl,
    parallel,
    pipeline,
    phase,
    log,
    workflow: workflowDsl,
  };

  return {
    dsl,
    getJournal: () => [...journalMirror],
    getArgs: () => args,
    currentPhase: () => _currentPhase,
  };
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

function firstWorkflowDiagnostic(result: WorkflowLlmResult | undefined): string | undefined {
  const diagnostic = result?.diagnostics.find((entry) => typeof entry === "string" && entry.trim() !== "");
  return diagnostic === undefined ? undefined : workflowErrorMessage(diagnostic);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
