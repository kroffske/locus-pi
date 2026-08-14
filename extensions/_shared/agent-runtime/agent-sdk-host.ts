import { EventEmitter } from "node:events";
import path from "node:path";
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type {
  AgentChildOutputStats,
  AgentChildTrace,
  AgentExecutor,
  AgentFailureCause,
  AgentRunRequest,
  AgentRunResult,
} from "./agent-runner.js";
import { EXECUTED_MODEL_UNAVAILABLE } from "./agent-runner.js";
import { modelSelectorFromModel } from "../model/live-model-display.js";
import {
  createAgentExecutionPromptCapsule,
  formatAgentKickoffPrompt,
  parseAgentText,
} from "./agent-execution-prompt.js";
import type { SessionRecord } from "../runtime/session-core.js";
import { runtimeStateDir } from "../host/files.js";
import { evaluateEvidence, type EvidenceEvaluationInput } from "./agent-evidence-evaluator.js";
import { PetnameRegistry } from "./agent-names.js";
import { AgentLiveTranscript, type AgentLiveTranscriptSnapshot } from "./agent-live-transcript.js";
import { createReadOnlyAgentSessionCapabilities, type ReadOnlyAgentCustomTool } from "./agent-read-only-policy.js";
import type { ThinkingLevel } from "../host/pi-api.js";

/**
 * The live agent executor: this is the one the product runs.
 *
 * Its superseded counterpart is the command-context executor in
 * `agent-executor-host.ts`, backed by `ctx.newSession`, which is structurally
 * unreachable from a tool `execute()` context and is retained only as provenance.
 * This executor instead spawns a real HEADLESS child agent session via the
 * top-level public SDK `createAgentSession`, so the programmatic `task` tool can
 * run a genuine sub-agent. It shares the capsule + text-result layer with that
 * historical path — both import `agent-execution-prompt.js` — and it does NOT
 * touch the boundary/runner.
 */

/** Diagnostic token stamped on blocked results when the SDK host is unavailable. */
export const AGENT_SDK_UNAVAILABLE_DIAGNOSTIC = "agent-sdk-host:unavailable";

/** Stable substring shared by AgentSdkUnavailableError messages. */
export const AGENT_SDK_UNAVAILABLE_HINT = "Pi SDK host";

const DEFAULT_AGENT_SDK_ABORT_TIMEOUT_MS = 5_000;

/** Raised when the installed Pi host cannot provide a usable `createAgentSession`. */
export class AgentSdkUnavailableError extends Error {
  constructor(message: string) {
    super(`${AGENT_SDK_UNAVAILABLE_HINT}: ${message}`);
    this.name = "AgentSdkUnavailableError";
  }
}

// Minimal structural shapes — we deliberately do NOT import the SDK types at module
// top level. The SDK is a peerDependency that may be missing or too old at import
// time; importing it eagerly would break the whole extension instead of degrading.
export interface SdkSessionStatsLike {
  sessionId: string;
  toolCalls: number;
  toolResults: number;
  /**
   * Cumulative token usage for the child session (T-190 GREEN). pi-ai `Usage`
   * shape: `input`/`output` are the in/out token sums; `total` additionally folds
   * in cacheRead/cacheWrite, so the row counter must use `input + output`, NOT
   * `total` (which over-counts). Optional because older hosts / mocks may omit it.
   */
  tokens?: { input: number; output: number; total?: number; cacheRead?: number; cacheWrite?: number };
}
export interface SdkAgentSessionEventLike {
  type?: unknown;
  willRetry?: boolean;
  [key: string]: unknown;
}
export interface SdkAgentSessionLike {
  readonly sessionId: string;
  /** True while Pi can accept a steering message into the active child turn. */
  readonly isStreaming?: boolean;
  /**
   * The model this session actually runs on, as the host reports it.
   *
   * The real peer declares `get model(): Model<any> | undefined`
   * (`@earendil-works/pi-coding-agent` `core/agent-session.d.ts`). Optional here
   * because an older peer or a structural mock may not have it — and an absent
   * readback is recorded as `unavailable`, never back-filled from what we asked
   * for. Structurally opaque: `modelSelectorFromModel` formats it.
   */
  readonly model?: unknown;
  /** Pi 0.83.0 conversation history; optional for structural mocks. */
  readonly messages?: readonly unknown[];
  subscribe(listener: (event: SdkAgentSessionEventLike) => void): () => void;
  prompt(text: string, options?: { source?: string; streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  getSessionStats(): SdkSessionStatsLike;
  getLastAssistantText(): string | undefined;
  /** Pi 0.83 host readback. Required for fresh tool-free Fusion sessions. */
  getActiveToolNames?(): string[];
  exportToJsonl(outputPath?: string): string; // SYNC
  /**
   * Full readable render of the same session (`AgentSession.exportToHtml`,
   * present in `@earendil-works/pi-coding-agent` 0.83.0). Optional here because
   * an older peer or a structural mock may not have it — and its absence is
   * RECORDED as a named warning beside the transcript, never skipped silently.
   * The package's export map blocks a deep import of the renderer, so this
   * method and the `pi --export in.jsonl out.html` CLI are the only two doors.
   *
   * ASYNC on the real peer (`Promise<string>`), unlike `exportToJsonl` right
   * above it. The call site awaits, so a peer that ever returns the path
   * directly is handled by the same code rather than by a second branch.
   */
  exportToHtml?(outputPath?: string): Promise<string> | string;
  dispose(): void;
  abort?(): Promise<void>;
}
export interface SdkCreateSessionResultLike {
  session: SdkAgentSessionLike;
}
export interface SdkCreateSessionOptionsLike {
  cwd?: string;
  tools?: string[];
  /** Host-level default suppression. Tool-free Fusion always requests `all`. */
  noTools?: "all" | "builtin";
  /** Tool names disabled after any allowlist is applied. */
  excludeTools?: string[];
  /** Custom tools registered for this child session. */
  customTools?: ReadOnlyAgentCustomTool[];
  /** A resolved Pi `Model` object (kept structurally opaque here). When set, the
   *  child session uses it instead of the host default — so the child inherits the
   *  caller's model rather than relying on settings (which may default to a weak or
   *  unauthenticated provider). */
  model?: unknown;
  /** Requested reasoning effort for the child session. */
  thinkingLevel?: ThinkingLevel;
  /** Additional child instructions generated from the selected catalog agent. The
   *  default host adapter appends this through DefaultResourceLoader so Pi keeps
   *  its normal base prompt, tool instructions, context files, and skills. */
  appendSystemPrompt?: string;
  /** Internal loader materialization contract; stripped before createAgentSession. */
  resourceLoaderOptions?: {
    noExtensions: true;
    noSkills: true;
    noPromptTemplates: true;
    noThemes: true;
    noContextFiles: true;
    systemPrompt: string;
    appendSystemPrompt: [];
  };
  resourceLoader?: unknown;
}

export type CreateAgentSessionFactory = (options: SdkCreateSessionOptionsLike) => Promise<SdkCreateSessionResultLike>;

/** Per-turn wall-clock budget for the child agent before the run is force-stopped. */
export const DEFAULT_AGENT_SDK_TURN_TIMEOUT_MS = 120_000;

export type AgentLiveStatus = "queued" | "working" | "done" | "cancelled" | "error";
export type AgentLiveActivityState = "waiting" | "active" | "completed" | "cancelled" | "failed";
export type AgentLiveGroupKind = "parallel" | "pipeline";

const MAX_AGENT_LIVE_EVENT_LINES = 200;
const MAX_AGENT_LIVE_EVENT_LINE_LENGTH = 300;
const MAX_AGENT_LIVE_REQUEST_LENGTH = 32_000;

export interface AgentLiveRow {
  id: string;
  parentRowId?: string;
  /** Durable owner provenance. Workflow-owned rows stop only through /workflows stop. */
  workflowRunId?: string;
  agentName?: string;
  /** Memorable, deterministic petname for this row (REQ-002); assigned in `begin`. */
  displayName?: string;
  label: string;
  /** Short work description shown in the live row (≤128 chars, REQ-003); falls back to the label. */
  title?: string;
  /** Bounded original task sent to the child, kept separate from the internal kickoff capsule. */
  request?: string;
  /**
   * Workflow loop slot descriptor `(phase, label)` (REQ-009, D-006). Present only for
   * workflow agents anchored to a repeatable slot; correlates the live row with the
   * per-round journal records the drill submenu reads. Interactive agents leave it unset.
   */
  slotKey?: string;
  /**
   * Loop round for a slot (≥1). Grows only when the SAME slot is re-invoked; the row is
   * reused (never re-created), so `round++` must not re-sort or move it (T-188 W4). The
   * `· r<N>` badge renders from r2 up (r1 implicit). Unset for non-slot rows.
   */
  round?: number;
  status: AgentLiveStatus;
  activityState?: AgentLiveActivityState;
  startedAt?: number;
  elapsedMs?: number;
  lastActivityAt?: number;
  model?: string;
  thinking?: string;
  currentPath?: string;
  currentTools: string[];
  currentToolArgs?: string | undefined;
  /**
   * Wall-clock ms stamped when the active tool started; cleared on tool end /
   * tool change (T-196). Gates the `> 5s` action-sub-line timer (REQ-004 kind (c)).
   * Explicit `| undefined` so a clearing `patch` can null it under
   * exactOptionalPropertyTypes (mirrors `currentToolArgs`).
   */
  currentToolStartMs?: number | undefined;
  stepCount: number;
  turnCount?: number;
  /** Cumulative agent tokens split in/out (REQ-006); the row shows `↓(input+output)`. */
  tokenCount?: { input: number; output: number };
  childSessionId?: string;
  resultArtifact?: string;
  finalAnswer?: string;
  isolated: boolean;
  noMcp: boolean;
  groupKind?: AgentLiveGroupKind;
  groupTotal?: number;
  groupCompleted?: number;
  groupFailed?: number;
  errors: string[];
  eventLines: string[];
  /** One bounded typed semantic timeline consumed by fleet and viewer. */
  transcript?: AgentLiveTranscriptSnapshot;
  /** Pure projection of `transcript.blocks`; never independently mutated. */
  latestMessage?: string | undefined;
}

interface AgentLiveBeginOptions {
  id?: string;
  parentRowId?: string;
  workflowRunId?: string;
  agentName?: string;
  label: string;
  title?: string;
  request?: string;
  slotKey?: string;
  round?: number;
  model?: string;
  thinking?: string;
  currentPath?: string;
  isolated?: boolean;
  noMcp?: boolean;
  groupKind?: AgentLiveGroupKind;
  groupTotal?: number;
  now?: number;
}

const AGENT_LIVE_EXECUTION_AUTHORITY = Symbol("agent-live-execution-authority");
const AGENT_LIVE_CANCELLATION_AUTHORITY = Symbol("agent-live-cancellation-authority");

export interface AgentLiveExecutionHandle {
  readonly [AGENT_LIVE_EXECUTION_AUTHORITY]: true;
}
interface AgentLiveCancellationAuthority {
  readonly [AGENT_LIVE_CANCELLATION_AUTHORITY]: true;
}

interface AgentLiveCancelRegistration {
  authority: AgentLiveCancellationAuthority;
  cancel: () => void;
  execution: AgentLiveExecutionHandle;
}

interface AgentLiveInputRegistration {
  execution: AgentLiveExecutionHandle;
  send: (text: string) => Promise<void>;
  available: () => boolean;
}

export type AgentLiveInputResult = { ok: true } | { ok: false; reason: string };

class AgentLiveStore {
  readonly rows = new Map<string, AgentLiveRow>();
  readonly emitter = new EventEmitter();
  readonly #agentNames = new Map<string, string>();
  readonly #petnames = new PetnameRegistry();
  readonly #executionAuthorities = new Map<string, AgentLiveExecutionHandle>();
  readonly #executionAuthorityRows = new WeakMap<AgentLiveExecutionHandle, string>();
  readonly #cancelRegistrations = new Map<string, AgentLiveCancelRegistration>();
  readonly #cancellationAuthorityRows = new WeakMap<AgentLiveCancellationAuthority, string>();
  readonly #inputRegistrations = new Map<string, AgentLiveInputRegistration>();
  readonly #transcripts = new Map<string, AgentLiveTranscript>();
  #nextId = 0;

  reset(): void {
    this.rows.clear();
    this.#agentNames.clear();
    this.#petnames.reset();
    this.#executionAuthorities.clear();
    this.#cancelRegistrations.clear();
    this.#inputRegistrations.clear();
    this.#transcripts.clear();
    this.#emit();
  }

  /** Remove retired rows and every private store owned by the same ids. */
  removeRows(ids: Iterable<string>): number {
    let removed = 0;
    for (const id of ids) {
      if (!this.rows.delete(id)) continue;
      this.#agentNames.delete(id);
      this.#petnames.release(id);
      this.#executionAuthorities.delete(id);
      this.#cancelRegistrations.delete(id);
      this.#inputRegistrations.delete(id);
      this.#transcripts.delete(id);
      removed += 1;
    }
    if (removed > 0) this.#emit();
    return removed;
  }

  /**
   * Attach the already-existing AbortSignal seam to a concrete live row. The
   * returned cleanup is identity-safe: a later run that reuses the same slot id
   * cannot be unregistered by an older run's finally block.
   */
  registerCancel(rowId: string, cancel: () => void): () => void {
    const execution = this.#executionAuthorities.get(rowId);
    if (execution === undefined) return () => {};
    return this.#registerCancel(rowId, execution, cancel);
  }

  registerCancelForExecution(execution: AgentLiveExecutionHandle, cancel: () => void): () => void {
    const rowId = this.#currentExecutionRowId(execution);
    if (rowId === undefined) return () => {};
    return this.#registerCancel(rowId, execution, cancel);
  }

  #registerCancel(rowId: string, execution: AgentLiveExecutionHandle, cancel: () => void): () => void {
    const authority = Object.freeze({}) as AgentLiveCancellationAuthority;
    const registration: AgentLiveCancelRegistration = { authority, cancel, execution };
    this.#cancellationAuthorityRows.set(authority, rowId);
    this.#cancelRegistrations.set(rowId, registration);
    return () => {
      if (this.#cancelRegistrations.get(rowId) === registration) this.#cancelRegistrations.delete(rowId);
    };
  }

  /** Attach the live child prompt seam while one SDK turn is accepting input. */
  registerInputForExecution(
    execution: AgentLiveExecutionHandle,
    send: (text: string) => Promise<void>,
    available: () => boolean = () => true,
  ): () => void {
    const rowId = this.#currentExecutionRowId(execution);
    if (rowId === undefined) return () => {};
    const registration: AgentLiveInputRegistration = { execution, send, available };
    this.#inputRegistrations.set(rowId, registration);
    this.#emit();
    return () => {
      if (this.#inputRegistrations.get(rowId) !== registration) return;
      this.#inputRegistrations.delete(rowId);
      this.#emit();
    };
  }

  canSendInputForExecution(execution: AgentLiveExecutionHandle): boolean {
    const rowId = this.#currentExecutionRowId(execution);
    const registration = rowId === undefined ? undefined : this.#inputRegistrations.get(rowId);
    return registration?.execution === execution && registration.available();
  }

  async sendInputForExecution(execution: AgentLiveExecutionHandle, text: string): Promise<AgentLiveInputResult> {
    if (text.trim() === "") return { ok: false, reason: "Enter a message before submitting." };
    const rowId = this.#currentExecutionRowId(execution);
    const registration = rowId === undefined ? undefined : this.#inputRegistrations.get(rowId);
    if (registration?.execution !== execution || !registration.available()) {
      return { ok: false, reason: "This agent is no longer accepting input." };
    }
    try {
      await registration.send(text);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `Agent input failed: ${errorMessage(error)}` };
    }
  }

  captureExecutionAuthority(rowId: string): AgentLiveExecutionHandle | undefined {
    return this.#executionAuthorities.get(rowId);
  }

  isExecutionAuthorityCurrent(authority: AgentLiveExecutionHandle): boolean {
    return this.#currentExecutionRowId(authority) !== undefined;
  }

  rowForExecution(execution: AgentLiveExecutionHandle): AgentLiveRow | undefined {
    const rowId = this.#currentExecutionRowId(execution);
    return rowId === undefined ? undefined : this.rows.get(rowId);
  }

  patchExecution(
    execution: AgentLiveExecutionHandle,
    patch: Partial<Omit<AgentLiveRow, "id">>,
    now = Date.now(),
  ): AgentLiveRow | undefined {
    const rowId = this.#currentExecutionRowId(execution);
    return rowId === undefined ? undefined : this.patch(rowId, patch, now);
  }

  /**
   * Terminal patch for a row whose child never ran: applies `patch` AND drops the
   * request-side `model`/`thinking` labels in the same update.
   *
   * A dedicated method rather than `patch({ model: undefined })` because
   * `exactOptionalPropertyTypes` makes that a type error, and because "this row must
   * show no model" is worth stating outright instead of leaving a reader to infer it
   * from a spread of `undefined`. The row is seeded with a requested selector before
   * the child exists; if nothing was ever built, that label is the request talking to
   * itself and an operator reading the panel cannot tell it from a model that ran.
   */
  patchExecutionWithoutModel(
    execution: AgentLiveExecutionHandle,
    patch: Partial<Omit<AgentLiveRow, "id" | "model" | "thinking">>,
    now = Date.now(),
  ): AgentLiveRow | undefined {
    const rowId = this.#currentExecutionRowId(execution);
    if (rowId === undefined) return undefined;
    const patched = this.patch(rowId, patch, now);
    if (patched === undefined) return undefined;
    // `patch()` emits, and a store listener may synchronously replace this row's
    // execution authority on that emit — the terminal-listener replacement case. The
    // second write must therefore re-check ownership and re-read the row rather than
    // writing back the pre-emit snapshot: without this, clearing the model clobbers a
    // replacement row that this execution no longer owns, and silently reverts
    // whatever the listener wrote.
    if (this.#currentExecutionRowId(execution) !== rowId) return undefined;
    const current = this.rows.get(rowId);
    if (current === undefined) return undefined;
    const cleared: AgentLiveRow = { ...current };
    delete cleared.model;
    delete cleared.thinking;
    this.rows.set(rowId, cleared);
    this.#emit();
    return cleared;
  }

  feedExecutionEvent(execution: AgentLiveExecutionHandle, event: unknown, now = Date.now()): AgentLiveRow | undefined {
    const rowId = this.#currentExecutionRowId(execution);
    return rowId === undefined ? undefined : this.feedSessionEvent(rowId, event, now);
  }

  applyExecutionStats(execution: AgentLiveExecutionHandle, stats: SdkSessionStatsLike): AgentLiveRow | undefined {
    const rowId = this.#currentExecutionRowId(execution);
    return rowId === undefined ? undefined : this.applySessionStats(rowId, stats);
  }

  replaceExecutionTranscript(
    execution: AgentLiveExecutionHandle,
    messages: readonly unknown[],
  ): AgentLiveRow | undefined {
    const rowId = this.#currentExecutionRowId(execution);
    return rowId === undefined ? undefined : this.replaceTranscriptFromMessages(rowId, messages);
  }

  #currentExecutionRowId(execution: AgentLiveExecutionHandle): string | undefined {
    const rowId = this.#executionAuthorityRows.get(execution);
    return rowId !== undefined && this.#executionAuthorities.get(rowId) === execution ? rowId : undefined;
  }

  captureCancellationAuthority(rowId: string): AgentLiveCancellationAuthority | undefined {
    const registration = this.#cancelRegistrations.get(rowId);
    if (registration === undefined || !this.isExecutionAuthorityCurrent(registration.execution)) return undefined;
    return registration.authority;
  }

  isCancellationAuthorityCurrent(authority: AgentLiveCancellationAuthority): boolean {
    const rowId = this.#cancellationAuthorityRows.get(authority);
    const registration = rowId === undefined ? undefined : this.#cancelRegistrations.get(rowId);
    return registration?.authority === authority && this.isExecutionAuthorityCurrent(registration.execution);
  }

  cancelWithAuthority(authority: AgentLiveCancellationAuthority): boolean {
    const rowId = this.#cancellationAuthorityRows.get(authority);
    const registration = rowId === undefined ? undefined : this.#cancelRegistrations.get(rowId);
    if (registration?.authority !== authority || !this.isExecutionAuthorityCurrent(registration.execution))
      return false;
    registration.cancel();
    return true;
  }

  /** Request cancellation of one selected child. False means no active child seam. */
  cancel(rowId: string): boolean {
    const authority = this.captureCancellationAuthority(rowId);
    return authority !== undefined && this.cancelWithAuthority(authority);
  }

  /**
   * Synchronous projection/compatibility API. It is intentionally row-id based
   * and must not be retained across an async boundary. Async producers must use
   * beginExecution() and the corresponding execution-handle methods.
   */
  begin(options: AgentLiveBeginOptions): AgentLiveRow {
    return this.#begin(options, false).row;
  }

  beginExecution(options: AgentLiveBeginOptions): AgentLiveExecutionHandle {
    return this.#begin(options, true).execution;
  }

  #begin(
    options: AgentLiveBeginOptions,
    freshExecution: boolean,
  ): { row: AgentLiveRow; execution: AgentLiveExecutionHandle } {
    const id = options.id ?? `agent-live-${Date.now()}-${++this.#nextId}`;
    const existing = this.rows.get(id);
    // Petname is stable per row: assigned once (never re-derived), and skipped for
    // group summary rows which render from their own label, not a petname.
    const isGroupRow = (options.groupKind ?? existing?.groupKind) !== undefined;
    const displayName =
      existing?.displayName ??
      (isGroupRow ? undefined : this.#displayNameFor(id, existing?.parentRowId ?? options.parentRowId));
    // Slot rounds (REQ-009): the SAME row is reused when a workflow slot is re-invoked.
    // A strictly higher round means a new iteration began — reset the per-round transient
    // fields (tools/args/tool-start/tokens/elapsed) so the row shows THIS round, not the
    // last. `round`/`slotKey` are options-win (the newer call carries the current value).
    const round = options.round ?? existing?.round;
    const slotKey = options.slotKey ?? existing?.slotKey;
    const isNewRound = existing !== undefined && options.round !== undefined && options.round > (existing.round ?? 0);
    const resetTransient = freshExecution || isNewRound;
    const lastActivityAt = freshExecution ? options.now : (existing?.lastActivityAt ?? options.now);
    const model = freshExecution ? (options.model ?? existing?.model) : (existing?.model ?? options.model);
    const thinking = freshExecution
      ? (options.thinking ?? existing?.thinking)
      : (existing?.thinking ?? options.thinking);
    const currentPath = freshExecution
      ? (options.currentPath ?? existing?.currentPath)
      : (existing?.currentPath ?? options.currentPath);
    const groupKind = freshExecution
      ? (options.groupKind ?? existing?.groupKind)
      : (existing?.groupKind ?? options.groupKind);
    const groupTotal = freshExecution
      ? (options.groupTotal ?? existing?.groupTotal)
      : (existing?.groupTotal ?? options.groupTotal);
    const request = options.request ?? (freshExecution ? undefined : existing?.request);
    if (resetTransient) this.#transcripts.delete(id);
    const row: AgentLiveRow = {
      id,
      ...(existing?.parentRowId !== undefined || options.parentRowId !== undefined
        ? { parentRowId: existing?.parentRowId ?? options.parentRowId }
        : {}),
      ...(existing?.workflowRunId !== undefined || options.workflowRunId !== undefined
        ? { workflowRunId: existing?.workflowRunId ?? options.workflowRunId }
        : {}),
      ...(existing?.agentName !== undefined || options.agentName !== undefined
        ? { agentName: existing?.agentName ?? options.agentName }
        : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      label: options.label,
      ...(existing?.title !== undefined || options.title !== undefined
        ? { title: existing?.title ?? options.title }
        : {}),
      ...(request !== undefined ? { request: boundedAgentLiveRequest(request) } : {}),
      ...(slotKey !== undefined ? { slotKey } : {}),
      ...(round !== undefined ? { round } : {}),
      status: freshExecution ? "queued" : (existing?.status ?? "queued"),
      activityState: freshExecution
        ? activityStateForStatus("queued")
        : (existing?.activityState ?? activityStateForStatus(existing?.status ?? "queued")),
      ...(!freshExecution && existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
      ...(!resetTransient && existing?.elapsedMs !== undefined ? { elapsedMs: existing.elapsedMs } : {}),
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(currentPath !== undefined ? { currentPath } : {}),
      currentTools: resetTransient ? [] : (existing?.currentTools ?? []),
      ...(!resetTransient && existing?.currentToolArgs !== undefined
        ? { currentToolArgs: existing.currentToolArgs }
        : {}),
      ...(!resetTransient && existing?.currentToolStartMs !== undefined
        ? { currentToolStartMs: existing.currentToolStartMs }
        : {}),
      stepCount: freshExecution ? 0 : (existing?.stepCount ?? 0),
      ...(!freshExecution && existing?.turnCount !== undefined ? { turnCount: existing.turnCount } : {}),
      ...(!resetTransient && existing?.tokenCount !== undefined ? { tokenCount: existing.tokenCount } : {}),
      ...(!freshExecution && existing?.childSessionId !== undefined ? { childSessionId: existing.childSessionId } : {}),
      ...(!freshExecution && existing?.resultArtifact !== undefined ? { resultArtifact: existing.resultArtifact } : {}),
      ...(!freshExecution && existing?.finalAnswer !== undefined ? { finalAnswer: existing.finalAnswer } : {}),
      isolated: options.isolated ?? existing?.isolated ?? false,
      noMcp: options.noMcp ?? existing?.noMcp ?? false,
      ...(groupKind !== undefined ? { groupKind } : {}),
      ...(groupTotal !== undefined ? { groupTotal } : {}),
      ...(!freshExecution && existing?.groupCompleted !== undefined ? { groupCompleted: existing.groupCompleted } : {}),
      ...(!freshExecution && existing?.groupFailed !== undefined ? { groupFailed: existing.groupFailed } : {}),
      errors: freshExecution ? [] : (existing?.errors ?? []),
      eventLines: freshExecution ? [] : (existing?.eventLines ?? []),
      ...(resetTransient || existing?.transcript === undefined ? {} : { transcript: existing.transcript }),
      ...(resetTransient || existing?.latestMessage === undefined ? {} : { latestMessage: existing.latestMessage }),
    };
    this.rows.set(id, row);
    const executionAuthority = Object.freeze({}) as AgentLiveExecutionHandle;
    this.#executionAuthorityRows.set(executionAuthority, id);
    this.#executionAuthorities.set(id, executionAuthority);
    this.#cancelRegistrations.delete(id);
    this.#inputRegistrations.delete(id);
    if (options.agentName !== undefined) this.#agentNames.set(id, options.agentName);
    this.#emit();
    return { row, execution: executionAuthority };
  }

  /**
   * One petname per LOGICAL agent, not per row. A row whose parent is a plain
   * (non-group) row is the same actor as its parent — the workflow anchor row and
   * the SDK executor row it spawns — so it adopts the parent's petname instead of
   * minting a second name for the same agent. Group summaries carry no petname
   * and never donate one; a parentless (or parent-unknown) row assigns fresh.
   */
  #displayNameFor(id: string, parentRowId: string | undefined): string {
    const parent = parentRowId === undefined ? undefined : this.rows.get(parentRowId);
    const inherited = parent !== undefined && parent.groupKind === undefined ? parent.displayName : undefined;
    return inherited === undefined ? this.#petnames.assign(id) : this.#petnames.adopt(id, inherited);
  }

  claimQueuedExecution(agentName: string, fallbackLabel: string): AgentLiveExecutionHandle {
    for (const [id, row] of this.rows) {
      if (row.status !== "queued" || this.#agentNames.get(id) !== agentName) continue;
      const execution = this.#executionAuthorities.get(id);
      if (execution !== undefined) return execution;
    }
    return this.beginExecution({ agentName, label: fallbackLabel });
  }

  /**
   * Synchronous projection/compatibility API. Async producers must retain an
   * AgentLiveExecutionHandle and call patchExecution() instead.
   */
  patch(id: string, patch: Partial<Omit<AgentLiveRow, "id">>, now = Date.now()): AgentLiveRow | undefined {
    const current = this.rows.get(id);
    if (current === undefined) return undefined;
    const activityState =
      patch.activityState ??
      (patch.status !== undefined ? activityStateForStatus(patch.status) : current.activityState);
    const row: AgentLiveRow = {
      ...current,
      ...patch,
      currentTools: patch.currentTools ?? current.currentTools,
      errors: patch.errors ?? current.errors,
      eventLines: patch.eventLines ?? current.eventLines,
    };
    if (patch.status !== undefined && isTerminalAgentLiveStatus(patch.status)) {
      row.currentTools = [];
      delete row.currentToolArgs;
      delete row.currentToolStartMs;
      if (patch.elapsedMs === undefined && current.elapsedMs === undefined && current.startedAt !== undefined) {
        row.elapsedMs = Math.max(0, now - current.startedAt);
      }
    }
    if (activityState !== undefined) row.activityState = activityState;
    this.rows.set(id, row);
    this.#emit();
    return row;
  }

  claimQueuedRow(agentName: string, fallbackLabel: string): AgentLiveRow {
    for (const [id, row] of this.rows) {
      if (row.status !== "queued") continue;
      if (this.#agentNames.get(id) === agentName) return row;
    }
    return this.begin({ agentName, label: fallbackLabel });
  }

  /** Synchronous compatibility API; async event sources must call feedExecutionEvent(). */
  feedSessionEvent(rowId: string, event: unknown, now = Date.now()): AgentLiveRow | undefined {
    const current = this.rows.get(rowId);
    if (current === undefined) return undefined;
    const patch: Partial<Omit<AgentLiveRow, "id">> = {
      lastActivityAt: now,
      eventLines: appendAgentLiveEventLine(current.eventLines, formatAgentLiveEventLine(event)),
      ...this.#projectTranscriptEvent(rowId, current, event),
    };
    const type = eventTypeName(event);
    const willRetry = isRecord(event) && event.willRetry === true;
    if (type === "agent_end" && !willRetry) {
      patch.status = "done";
      if (current.startedAt !== undefined) patch.elapsedMs = Math.max(0, now - current.startedAt);
    } else if (willRetry || type === "willRetry") {
      patch.status = "working";
      patch.errors = [...current.errors, eventErrorMessage(event) ?? "agent retry"];
    } else if (isToolOrStepEvent(event)) {
      patch.status = "working";
      patch.stepCount = current.stepCount + 1;
      const tool = eventToolName(event);
      if (tool !== undefined) {
        if (isToolResultEvent(event)) {
          patch.currentTools = current.currentTools.filter((item) => item !== tool);
          patch.currentToolArgs = undefined;
          patch.currentToolStartMs = undefined; // tool end → drop the elapsed anchor
        } else {
          patch.currentTools = unique([...current.currentTools, tool]);
          // Stamp the start only when a *new* tool becomes active (fresh call or a
          // tool change); a re-observed same tool keeps its original anchor so the
          // >5s timer measures the real run, not the latest event (T-196 W2).
          if (!current.currentTools.includes(tool)) patch.currentToolStartMs = now;
        }
      }
    } else if (type === "agent_start" || type === "turn_start") {
      patch.status = "working";
      patch.startedAt = current.startedAt ?? now;
    }
    if (type === "turn_start") patch.turnCount = (current.turnCount ?? 0) + 1;
    const turnUsage = eventTurnUsage(event);
    if (turnUsage !== undefined) {
      patch.tokenCount = {
        input: (current.tokenCount?.input ?? 0) + turnUsage.input,
        output: (current.tokenCount?.output ?? 0) + turnUsage.output,
      };
    }
    const pathValue = eventPath(event);
    if (pathValue !== undefined) patch.currentPath = pathValue;
    const toolArgs = eventToolArgs(event);
    if (toolArgs !== undefined) patch.currentToolArgs = toolArgs;
    const error = eventErrorMessage(event);
    if (error !== undefined && type !== "willRetry") patch.errors = [...current.errors, error];
    return this.patch(rowId, patch, now);
  }

  /** Synchronous compatibility API; async stats sources must call applyExecutionStats(). */
  applySessionStats(rowId: string, stats: SdkSessionStatsLike): AgentLiveRow | undefined {
    const current = this.rows.get(rowId);
    if (current === undefined) return undefined;
    return this.patch(rowId, {
      stepCount: Math.max(current.stepCount, stats.toolCalls + stats.toolResults),
      currentTools: [],
      currentToolArgs: undefined,
      currentToolStartMs: undefined,
      // Cumulative in+out from getSessionStats().tokens (T-190). No usage → leave
      // tokenCount untouched so the row omits `↓<tok>` rather than showing 0.
      ...(stats.tokens !== undefined ? { tokenCount: { input: stats.tokens.input, output: stats.tokens.output } } : {}),
      eventLines: appendAgentLiveEventLine(current.eventLines, formatAgentLiveStatsLine(stats)),
    });
  }

  /** Synchronous compatibility API; async transcript sources must call replaceExecutionTranscript(). */
  replaceTranscriptFromMessages(rowId: string, messages: readonly unknown[]): AgentLiveRow | undefined {
    const current = this.rows.get(rowId);
    if (current === undefined) return undefined;
    const transcript = this.#transcript(rowId, current);
    return this.patch(rowId, transcriptPatch(transcript.replaceMessages(messages, current.currentPath)));
  }

  #projectTranscriptEvent(
    rowId: string,
    current: AgentLiveRow,
    event: unknown,
  ): Pick<AgentLiveRow, "transcript" | "latestMessage"> {
    return transcriptPatch(this.#transcript(rowId, current).ingest(event, current.currentPath));
  }

  #transcript(rowId: string, current: AgentLiveRow): AgentLiveTranscript {
    const existing = this.#transcripts.get(rowId);
    if (existing !== undefined) return existing;
    const transcript = new AgentLiveTranscript(current.currentPath);
    this.#transcripts.set(rowId, transcript);
    return transcript;
  }

  #emit(): void {
    this.emitter.emit("change");
  }
}

function transcriptPatch(snapshot: AgentLiveTranscriptSnapshot): Pick<AgentLiveRow, "transcript" | "latestMessage"> {
  return {
    transcript: snapshot,
    latestMessage: snapshot.latestMessage,
  };
}

/**
 * Pi loads every package entrypoint through a fresh jiti instance with
 * `moduleCache:false`. A module-local singleton is therefore duplicated between
 * `extensions/agents` and `extensions/workflows`, even though both import this
 * file. Keep exactly one process-local store behind a versioned global symbol so
 * separately loaded entrypoints observe and control the same live rows.
 */
const AGENT_LIVE_STORE_GLOBAL_KEY = Symbol.for("locus-pi.agent-live-store.v5");
interface SharedAgentLiveStoreSlot {
  version: 5;
  store: AgentLiveStore;
}

function sharedAgentLiveStore(): AgentLiveStore {
  const runtimeGlobal = globalThis as unknown as Record<symbol, unknown>;
  const existing = runtimeGlobal[AGENT_LIVE_STORE_GLOBAL_KEY];
  if (existing !== undefined) {
    if (!isSharedAgentLiveStoreSlot(existing)) {
      throw new Error("locus-pi: incompatible global agent live-store slot");
    }
    // The object was created by another jiti module instance. Its methods keep
    // their original private-field brand; the structural cast only exposes the
    // shared contract to this separately evaluated copy of the class.
    return existing.store as AgentLiveStore;
  }
  const slot: SharedAgentLiveStoreSlot = { version: 5, store: new AgentLiveStore() };
  Object.defineProperty(runtimeGlobal, AGENT_LIVE_STORE_GLOBAL_KEY, {
    value: slot,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return slot.store;
}

function isSharedAgentLiveStoreSlot(value: unknown): value is SharedAgentLiveStoreSlot {
  if (!isRecord(value) || value.version !== 5 || !isRecord(value.store)) return false;
  return (
    value.store.rows instanceof Map &&
    typeof value.store.begin === "function" &&
    typeof value.store.beginExecution === "function" &&
    typeof value.store.rowForExecution === "function" &&
    typeof value.store.patchExecution === "function" &&
    typeof value.store.feedExecutionEvent === "function" &&
    typeof value.store.applyExecutionStats === "function" &&
    typeof value.store.replaceExecutionTranscript === "function" &&
    typeof value.store.registerCancelForExecution === "function" &&
    typeof value.store.registerInputForExecution === "function" &&
    typeof value.store.canSendInputForExecution === "function" &&
    typeof value.store.sendInputForExecution === "function" &&
    typeof value.store.cancelWithAuthority === "function" &&
    typeof value.store.captureExecutionAuthority === "function"
  );
}

export const agentLiveStore = sharedAgentLiveStore();

export interface AgentSdkSessionExecutorOptions {
  /** Inject a fake factory in unit tests; defaults to a guarded dynamic import. */
  createSession?: CreateAgentSessionFactory;
  /** Resolved parent `Model` to pass to the child session (e.g. `ctx.model`). When
   *  omitted, the child falls back to the host's default model resolution. */
  model?: unknown;
  /** Requested reasoning effort to pass to the child session. */
  thinkingLevel?: ThinkingLevel;
  /** Override the durable evidence directory (default .locus/runtime/reports). */
  reportsDir?: string;
  /** Deterministic timestamps in tests. */
  now?: () => string;
  /**
   * Override the wall-clock timeout (ms) applied to the whole child turn. The
   * effective budget is this value times the request's `maxTurns`. Set a small
   * value in tests to exercise the timeout fail-closed path deterministically.
   */
  turnTimeoutMs?: number;
  /** Maximum wait for the SDK abort acknowledgement before evidence persistence continues. */
  abortTimeoutMs?: number;
  /** Optional fail-closed tool-call budget for this child. */
  maxToolCalls?: number;
  /** Optional live-row identity supplied by callers that already created a UI row. */
  live?: {
    rowId?: string;
    parentRowId?: string;
    workflowRunId?: string;
    label?: string;
    title?: string;
    /** Workflow slot descriptor (phase,label); anchors the row across loop rounds (REQ-009). */
    slotKey?: string;
    /** Loop round for the slot (≥1); the workflow bridge increments it per re-invoke. */
    round?: number;
    isolated?: boolean;
    noMcp?: boolean;
    model?: string;
    thinking?: string;
  };
  /** Exact row execution created by an outer owner; prevents a second begin for the same genuine run. */
  liveExecution?: AgentLiveExecutionHandle;
  /** Reports the one exact execution used by this run to callers that need post-boundary attribution. */
  onLiveExecution?: (execution: AgentLiveExecutionHandle) => void;
  /** Optional explicit env for prompt-building; defaults to process.env. */
  promptEnv?: NodeJS.ProcessEnv;
}

export function createAgentSdkSessionExecutor(options: AgentSdkSessionExecutorOptions = {}): AgentExecutor {
  const createSession = options.createSession ?? defaultCreateAgentSession;
  const now = options.now ?? (() => new Date().toISOString());
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_AGENT_SDK_TURN_TIMEOUT_MS;
  const abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_AGENT_SDK_ABORT_TIMEOUT_MS;
  if (!Number.isFinite(abortTimeoutMs) || abortTimeoutMs < 0) {
    throw new Error("abortTimeoutMs must be a non-negative finite number when provided");
  }
  const maxToolCalls = options.maxToolCalls;
  if (maxToolCalls !== undefined && (!Number.isInteger(maxToolCalls) || maxToolCalls < 0)) {
    throw new Error("maxToolCalls must be a non-negative integer when provided");
  }
  const model = options.model;
  const thinkingLevel = options.thinkingLevel;
  return {
    async run(request, signal) {
      // A per-child controller lets the fleet menu stop exactly one selected row.
      // The caller's signal is still authoritative and is forwarded into the same
      // controller, so workflow/tool cancellation keeps its existing semantics.
      const childController = new AbortController();
      const forwardCallerAbort = () => childController.abort();
      if (signal.aborted) childController.abort();
      else signal.addEventListener("abort", forwardCallerAbort, { once: true });
      let unregisterCancel = () => {};
      try {
        const cwd = request.workingDirectory ?? request.projectRoot ?? process.cwd();
        const execution =
          options.liveExecution ??
          (options.live !== undefined
            ? agentLiveStore.beginExecution(
                liveBeginOptions(options.live.rowId, request.agent.name, options.live, cwd, request.task),
              )
            : agentLiveStore.claimQueuedExecution(request.agent.name, request.agent.name));
        const boundedRequest = boundedAgentLiveRequest(request.task);
        if (agentLiveStore.rowForExecution(execution)?.request !== boundedRequest) {
          agentLiveStore.patchExecution(execution, { request: boundedRequest });
        }
        unregisterCancel = agentLiveStore.registerCancelForExecution(execution, () => childController.abort());
        try {
          options.onLiveExecution?.(execution);
        } catch (observerError) {
          const reason = errorMessage(observerError);
          const current = agentLiveStore.rowForExecution(execution);
          if (current !== undefined) {
            try {
              agentLiveStore.patchExecution(execution, {
                status: "error",
                finalAnswer: reason,
                errors: unique([...current.errors, reason]),
              });
            } catch {
              // The terminal row is already stored before a synchronous change
              // listener can throw. Preserve the original observer failure.
            }
          }
          throw observerError;
        }
        return await runWithSdkSession(
          request,
          childController.signal,
          createSession,
          now,
          options.reportsDir,
          turnTimeoutMs,
          abortTimeoutMs,
          maxToolCalls,
          model,
          thinkingLevel,
          execution,
          options.promptEnv,
        );
      } finally {
        unregisterCancel();
        signal.removeEventListener("abort", forwardCallerAbort);
      }
    },
  };
}

/** Filled by the child-session run once a session exists; empty when none was created. */
interface ExecutedModelObservation {
  executedModel?: string;
  activeToolNames?: string[];
}

/**
 * Stamp the host's own readback onto every outcome of one child run.
 *
 * The readback is taken once, from the created session, and then travels out on
 * `AgentRunResult` regardless of how the run ended — a failed or cancelled child
 * still ran on a model, and its evidence should say which. Results returned before
 * `createSession` succeeded carry nothing, because nothing ran.
 */
async function runWithSdkSession(
  request: AgentRunRequest,
  signal: AbortSignal,
  createSession: CreateAgentSessionFactory,
  now: () => string,
  reportsDirOverride: string | undefined,
  turnTimeoutMs: number,
  abortTimeoutMs: number,
  maxToolCalls: number | undefined,
  model: unknown,
  thinkingLevel: ThinkingLevel | undefined,
  execution: AgentLiveExecutionHandle,
  promptEnv: NodeJS.ProcessEnv | undefined,
): Promise<AgentRunResult> {
  const observed: ExecutedModelObservation = {};
  const result = await runChildSession(
    request,
    signal,
    createSession,
    now,
    reportsDirOverride,
    turnTimeoutMs,
    abortTimeoutMs,
    maxToolCalls,
    model,
    thinkingLevel,
    execution,
    promptEnv,
    observed,
  );
  return {
    ...result,
    ...(observed.executedModel === undefined ? {} : { executedModel: observed.executedModel }),
    ...(observed.activeToolNames === undefined ? {} : { activeToolNames: observed.activeToolNames }),
  };
}

async function runChildSession(
  request: AgentRunRequest,
  signal: AbortSignal,
  createSession: CreateAgentSessionFactory,
  now: () => string,
  reportsDirOverride: string | undefined,
  turnTimeoutMs: number,
  abortTimeoutMs: number,
  maxToolCalls: number | undefined,
  model: unknown,
  thinkingLevel: ThinkingLevel | undefined,
  execution: AgentLiveExecutionHandle,
  promptEnv: NodeJS.ProcessEnv | undefined,
  observed: ExecutedModelObservation,
): Promise<AgentRunResult> {
  // T-119 PRE-CHECK: getBranch UNREACHABLE
  //
  // This SDK executor is created from tool-context `execute()` without a
  // sessionManager parameter. The only prompt input available here is the already
  // explicit AgentRunRequest, so parent transcript inheritance would require an
  // unsupported hidden channel. Keep ER-4 honest: pass a deliberate artifact path,
  // message payload, or task text through the request instead of injecting a
  // fabricated parent_context block.
  // Pre-flight cancel: never create a child if we were already aborted.
  if (signal.aborted) {
    const reason = "Agent run was cancelled before child session creation.";
    // Clear the request-side display model: no session was ever built, so leaving the
    // selector on the row shows an operator a model that never ran (see the note on
    // the `createSession` failure paths below).
    agentLiveStore.patchExecutionWithoutModel(execution, { status: "cancelled", finalAnswer: reason });
    return cancelledResult(request, reason);
  }

  const diagnostics: string[] = [];
  const capsule = createAgentExecutionPromptCapsule(request, diagnostics, promptEnv);
  const kickoff = formatAgentKickoffPrompt(capsule);

  const cwd = request.workingDirectory ?? request.projectRoot ?? process.cwd();
  const readOnlyCapabilities = request.agent.readOnly
    ? createReadOnlyAgentSessionCapabilities(cwd, request.allowedTools, {
        ...(request.repositoryCheckScripts !== undefined
          ? { repositoryCheckScripts: request.repositoryCheckScripts }
          : {}),
      })
    : undefined;
  const effectiveTools =
    readOnlyCapabilities?.tools ?? (request.allowedTools.includes("*") ? undefined : [...request.allowedTools]);
  const excludedTools = readOnlyCapabilities?.excludeTools ?? ["spawn_agent", "task"];
  const sessionOptions: SdkCreateSessionOptionsLike = {
    cwd,
    // Write-capable children may run `workflow`, but no child can recursively
    // call the two direct child-session entrypoints. Read-only children receive
    // the stricter allowlist above. Pi applies excludes after `tools`.
    excludeTools: excludedTools,
  };
  if (effectiveTools !== undefined) sessionOptions.tools = effectiveTools;
  if (readOnlyCapabilities?.customTools !== undefined) sessionOptions.customTools = readOnlyCapabilities.customTools;
  if (model !== undefined && model !== null) sessionOptions.model = model;
  if (thinkingLevel !== undefined) sessionOptions.thinkingLevel = thinkingLevel;
  const appendSystemPrompt = appendDirectSpawnBoundary(capsule.agentSystemPrompt);
  if (request.capabilityMode === "tool-free") {
    sessionOptions.noTools = "all";
    sessionOptions.tools = [];
    sessionOptions.customTools = [];
    sessionOptions.resourceLoaderOptions = {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: appendSystemPrompt,
      appendSystemPrompt: [],
    };
  } else if (appendSystemPrompt !== undefined) {
    sessionOptions.appendSystemPrompt = appendSystemPrompt;
  }
  let created: SdkCreateSessionResultLike;
  try {
    created = await createSession(sessionOptions);
  } catch (error) {
    if (error instanceof AgentSdkUnavailableError) {
      // Substrate genuinely unavailable -> blocked, with a detectable diagnostic
      // token the wiring keys its graceful fallback on. The reason is HONEST,
      // never the stale M11 replacement-session text.
      // The row was seeded with a REQUEST-side display selector before the child
      // existed, and no session was built, so there is nothing to replace it with.
      // Leaving it shows the operator a terminal row labelled with a model that never
      // ran — the live panel is the surface they actually watch, and a failed row
      // reading "test/fast" is indistinguishable from one that ran on test/fast and
      // errored. Clear it: absent is honest, invented is not.
      agentLiveStore.patchExecutionWithoutModel(execution, {
        status: "error",
        errors: [error.message],
        finalAnswer: error.message,
      });
      return blockedResult(request, error.message, "sdk-unavailable", [
        ...diagnostics,
        AGENT_SDK_UNAVAILABLE_DIAGNOSTIC,
        error.message,
      ]);
    }
    const reason = errorMessage(error);
    agentLiveStore.patchExecutionWithoutModel(execution, { status: "error", errors: [reason], finalAnswer: reason });
    // Catch-all: this branch also carries a bad model id, a rejected tool allowlist and any
    // option-assembly bug. None of those is transient, so none of them may be retried.
    return failedResult(request, reason, "unclassified", [...diagnostics, reason]);
  }

  const session = created.session;
  let childSession = createSdkSessionRecord(request, session.sessionId);
  let activeToolNames: string[] | undefined;
  if (request.capabilityMode !== undefined) {
    try {
      const readback = session.getActiveToolNames?.();
      if (readback !== undefined && (!Array.isArray(readback) || !readback.every((name) => typeof name === "string"))) {
        throw new Error("AgentSession.getActiveToolNames() returned an unexpected shape.");
      }
      activeToolNames = readback === undefined ? undefined : [...readback];
      if (activeToolNames !== undefined) observed.activeToolNames = activeToolNames;
    } catch (error) {
      const reason = `Active tool readback failed before child prompt: ${errorMessage(error)}`;
      agentLiveStore.patchExecutionWithoutModel(execution, { status: "error", errors: [reason], finalAnswer: reason });
      disposeQuietly(session);
      return failedResult(request, reason, "unclassified", [...diagnostics, reason], undefined, childSession);
    }
  }
  if (request.capabilityMode === "tool-free" && activeToolNames === undefined) {
    const reason = "Tool-free Fusion requires AgentSession.getActiveToolNames() before child prompt.";
    agentLiveStore.patchExecutionWithoutModel(execution, { status: "error", errors: [reason], finalAnswer: reason });
    disposeQuietly(session);
    return failedResult(request, reason, "unclassified", [...diagnostics, reason], undefined, childSession);
  }
  if (request.capabilityMode === "tool-free" && activeToolNames!.length > 0) {
    const reason = `Tool-free Fusion child exposed active tools before prompt: ${activeToolNames!.join(", ")}.`;
    agentLiveStore.patchExecutionWithoutModel(execution, { status: "error", errors: [reason], finalAnswer: reason });
    disposeQuietly(session);
    return failedResult(request, reason, "unclassified", [...diagnostics, reason], undefined, childSession);
  }
  // The one honest source for "which model WOULD run": the session itself, after the
  // host built it. Anything computed before this line is the request talking to
  // itself. It is deliberately NOT `observed.executedModel` yet — a built session is
  // not an executed one, and the two terminal paths below (kickoff cancellation and
  // model mismatch) return without ever prompting the child. Publishing here would
  // put "executedModel" on a call that spent no tokens, which is the same
  // requested-vs-executed conflation this task exists to remove, one step later.
  const sessionModelSelector = modelSelectorFromModel(session.model) ?? EXECUTED_MODEL_UNAVAILABLE;
  const requestedSelector = modelSelectorFromModel(model);
  let childOutputStats: AgentChildOutputStats | undefined;
  let childTrace: AgentChildTrace | undefined;
  let childTraceAttempted = false;
  const preserveChildTrace = async (): Promise<AgentChildTrace | undefined> => {
    if (!childTraceAttempted) {
      childTraceAttempted = true;
      childTrace = await exportEvidence(session, request, now, reportsDirOverride, diagnostics);
    }
    return childTrace;
  };
  /**
   * Terminal row patch that may only leave a model on the row once one executed.
   *
   * `observed.executedModel` is this file's single proof of execution, so the row and
   * the result are held to the same evidence: a run that ends before the child was
   * dispatched — a rejected `prompt()`, a subscription that threw, an abort landing
   * while the prompt was in flight — drops the label the row was seeded with instead
   * of leaving an operator a terminal row indistinguishable from one that ran.
   */
  const patchTerminalRow = (patch: Partial<Omit<AgentLiveRow, "id" | "model" | "thinking">>): void => {
    if (observed.executedModel === undefined) agentLiveStore.patchExecutionWithoutModel(execution, patch);
    else agentLiveStore.patchExecution(execution, patch);
  };
  try {
    agentLiveStore.patchExecution(execution, {
      status: "working",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      currentPath: cwd,
      // Make the full uuid available to an active drill immediately, rather than
      // only after the child has completed and its boundary result is parsed.
      childSessionId: session.sessionId,
      // The live row is where an operator actually watches a run, so it must show
      // what RAN as soon as that is knowable. The row was built before the child
      // existed and until this point carries a request-side display value; the
      // readback replaces it the moment the session reports one. When the peer
      // reports nothing the row keeps its display value rather than showing the
      // `unavailable` sentinel, which is evidence and not a model name (D6/D7).
      ...(sessionModelSelector !== EXECUTED_MODEL_UNAVAILABLE ? { model: sessionModelSelector } : {}),
    });

    // MUST guard the gap between session creation and prompting: an abort that
    // lands while createSession() was in flight must not kick off a real child.
    // It is still a real session, so preserve its identity and attempt evidence
    // export before returning the cancellation.
    if (signal.aborted) {
      const reason = "Agent run was cancelled before child session kickoff.";
      // Clear the label rather than leave the readback standing: the session was
      // BUILT on that model and never prompted, so a terminal row naming it claims an
      // execution that did not happen — the same conflation as echoing the request.
      agentLiveStore.patchExecutionWithoutModel(execution, { status: "cancelled", finalAnswer: reason });
      const preservedTrace = await preserveChildTrace();
      return withChildTrace(cancelledResult(request, reason, diagnostics, childSession), preservedTrace);
    }

    // A host that accepted a model and then built the session on a different one has
    // ignored the selection — precisely the failure this evidence exists to catch. Fail
    // before the first token is spent, and quote both values so the operator can see
    // which side moved. Unavailable readback is NOT a mismatch: it is the absence of
    // evidence, recorded as such, and it does not stop the run.
    if (
      requestedSelector !== undefined &&
      sessionModelSelector !== EXECUTED_MODEL_UNAVAILABLE &&
      sessionModelSelector !== requestedSelector
    ) {
      const reason =
        `Child session runs on ${sessionModelSelector} but the call resolved ${requestedSelector}; ` +
        "the host did not honour the selected model.";
      // Both values are in `reason`, which is where a mismatch belongs. The ROW gets
      // neither: the requested model did not run and the built-on model was never
      // prompted, so any label here names a model that executed nothing.
      agentLiveStore.patchExecutionWithoutModel(execution, {
        status: "error",
        errors: [reason],
        finalAnswer: reason,
      });
      await preserveChildTrace();
      // A host that ignored the resolved selector is a permanent configuration fault, not a
      // dropped channel: re-asking would land on the same wrong model. It stays `unclassified`
      // rather than earning its own member, because D1 promotes a cause out of `unclassified`
      // only on separate evidence that it is transient — and this one provably is not.
      return withChildTrace(
        failedResult(request, reason, "unclassified", [...diagnostics, reason], undefined, childSession),
        childTrace,
      );
    }

    // Budget scales with maxTurns so a legitimately long multi-turn child is not
    // killed prematurely, while a stuck child still has a hard ceiling.
    const turnBudgetMs = turnTimeoutMs * Math.max(1, request.maxTurns);
    const turn = await driveChildTurn(session, kickoff, signal, turnBudgetMs, maxToolCalls, execution);

    // THIS is the first point at which "executed" is a true word, so it is the first
    // point the evidence may say it. Everything above returns without it: a session
    // built and then cancelled, or built on the wrong model, executed nothing — and
    // neither does one whose `prompt()` was REJECTED by the transport (no credentials,
    // no route) or whose subscription threw, both of which leave `driveChildTurn` by
    // exception and skip this line entirely. `promptAccepted` is the narrower gate for
    // the case that still returns normally: an abort or a timeout that lands while the
    // prompt is still in flight and no child event has ever arrived. A turn that was
    // dispatched and then timed out DID execute, which is why promotion sits here
    // rather than after the settlement branches.
    if (turn.promptAccepted) observed.executedModel = sessionModelSelector;

    if (turn.settlement === "aborted" || turn.settlement === "timed_out" || turn.settlement === "tool_limit") {
      // Stop the child, then still export evidence and dispose (finally below).
      await abortChild(session, abortTimeoutMs);
      await preserveChildTrace();
      if (turn.settlement === "timed_out") {
        const reason = `Child agent turn exceeded the ${turnBudgetMs}ms budget and was aborted.`;
        patchTerminalRow({ status: "error", errors: [reason], finalAnswer: reason });
        return withChildTrace(
          failedResult(request, reason, "host-turn-timeout", [...diagnostics, reason], undefined, childSession),
          childTrace,
        );
      }
      if (turn.settlement === "tool_limit") {
        const reason = `Child agent exceeded the ${maxToolCalls ?? 0} tool-call budget and was aborted.`;
        patchTerminalRow({ status: "error", errors: [reason], finalAnswer: reason });
        return withChildTrace(
          failedResult(request, reason, "tool-call-budget", [...diagnostics, reason], undefined, childSession),
          childTrace,
        );
      }
      const reason = "Agent run was cancelled.";
      patchTerminalRow({ status: "cancelled", finalAnswer: reason });
      return withChildTrace(cancelledResult(request, reason, diagnostics, childSession), childTrace);
    }

    const stats = session.getSessionStats();
    if (childSession.id === "" && stats.sessionId !== "")
      childSession = createSdkSessionRecord(request, stats.sessionId);
    agentLiveStore.applyExecutionStats(execution, stats);
    if (session.messages !== undefined) agentLiveStore.replaceExecutionTranscript(execution, session.messages);
    const text = session.getLastAssistantText();
    await preserveChildTrace();

    childOutputStats = {
      // The SDK exposes aggregate counters, not an entry list, in this context.
      // entryCount is a defensible derived count from the genuine workload signals.
      entryCount: stats.toolCalls + stats.toolResults,
      assistantMessageCount: 0,
      assistantToolCallCount: stats.toolCalls,
      toolResultCount: stats.toolResults,
      recordedToolNames: turn.recordedToolNames,
      hasWorkloadProof: stats.toolCalls > 0 || stats.toolResults > 0,
    };

    const providerFailure = assistantProviderFailure(session.messages);
    if (providerFailure !== undefined) {
      const currentErrors = agentLiveStore.rowForExecution(execution)?.errors ?? [];
      agentLiveStore.patchExecution(execution, {
        status: "error",
        childSessionId: childSession.id,
        errors: unique([...currentErrors, providerFailure]),
        finalAnswer: providerFailure,
      });
      return withChildTrace(
        failedResult(
          request,
          providerFailure,
          "provider-error",
          [...diagnostics, providerFailure],
          childOutputStats,
          childSession,
        ),
        childTrace,
      );
    }
    const parsed = parseAgentText(text ?? "");
    if (!parsed.ok) {
      agentLiveStore.patchExecution(execution, {
        status: "error",
        childSessionId: childSession.id,
        finalAnswer: parsed.reason,
      });
      return withChildTrace(
        failedResult(
          request,
          parsed.reason,
          "unparseable-answer",
          [...diagnostics, parsed.reason],
          childOutputStats,
          childSession,
        ),
        childTrace,
      );
    }
    const evidenceInput: EvidenceEvaluationInput = {
      agentName: request.agent.name,
      policy: request.agent.evidence ?? { mode: "none" },
      toolCallCount: stats.toolCalls,
      toolResultCount: stats.toolResults,
      observedToolNames: childOutputStats.recordedToolNames ?? [],
      outputText: text ?? "",
      status: "completed",
    };
    const evidence = evaluateEvidence(evidenceInput);
    agentLiveStore.patchExecution(execution, {
      status: "done",
      childSessionId: childSession.id,
      finalAnswer: parsed.text,
    });
    return {
      status: "completed",
      agentName: request.agent.name,
      reason: parsed.text,
      text: parsed.text,
      evidence,
      diagnostics,
      lifecycleEntryIds: [],
      childOutputStats,
      childSession,
      ...(childTrace !== undefined ? { childTrace } : {}),
    };
  } catch (error) {
    const reason = errorMessage(error);
    const currentErrors = agentLiveStore.rowForExecution(execution)?.errors ?? [];
    // This catch takes both a transport rejection from `prompt()` (nothing ran) and a
    // failure after the child answered (something did), so the model label follows the
    // execution evidence rather than the code path.
    patchTerminalRow({
      status: "error",
      errors: unique([...currentErrors, reason]),
      finalAnswer: reason,
    });
    const preservedTrace = await preserveChildTrace();
    return withChildTrace(
      // Catch-all around the whole turn — parseAgentText, evidence evaluation, trace export
      // included. Nothing here proves the throw was transient, so it never retries.
      failedResult(request, reason, "unclassified", [...diagnostics, reason], childOutputStats, childSession),
      preservedTrace,
    );
  } finally {
    disposeQuietly(session);
  }
}

type ChildTurnSettlement = "completed" | "aborted" | "timed_out" | "tool_limit";
const SDK_TOOL_EVIDENCE_EVENT_TYPES = new Set(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);

interface ChildTurnObservation {
  settlement: ChildTurnSettlement;
  recordedToolNames: string[];
  /**
   * Whether the child was actually dispatched: `prompt()` resolved (the SDK settles it
   * once the turn is QUEUED, not when it finishes) or the child emitted its first
   * event. Either one is proof the transport took the turn.
   *
   * A `prompt()` that REJECTS — no credentials, no route to the provider — leaves this
   * function by exception and never returns an observation at all, which is the
   * stronger half of the same rule. This flag covers what still returns normally: an
   * abort or a timeout that wins the race while the prompt is in flight and no child
   * event has ever arrived. Nothing ran then, and the caller must not record a model
   * as executed.
   */
  promptAccepted: boolean;
}

/**
 * Prompt the child and wait for its `agent_end`, racing against the abort signal
 * and a wall-clock timeout so neither a hung `prompt()` nor a missing `agent_end`
 * can pin the tool forever. The `prompt()` promise is part of the race because it
 * only resolves once the turn is queued, not when the turn finishes — completion
 * is signalled exclusively by the `agent_end` event.
 */
async function driveChildTurn(
  session: SdkAgentSessionLike,
  kickoff: string,
  signal: AbortSignal,
  turnBudgetMs: number,
  maxToolCalls: number | undefined,
  execution: AgentLiveExecutionHandle,
): Promise<ChildTurnObservation> {
  // Subscribe BEFORE prompting so a fast agent_end is never missed.
  let resolveEnd: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  // The SDK invokes this listener on its OWN synchronous, detached emit path
  // (agent loop -> _handleAgentEvent -> _emit), NOT on a promise we await. A throw
  // here would escape every try/catch below and surface as an uncaught exception
  // that kills the host process. So the whole body is guarded: a malformed or late
  // event degrades to a recorded diagnostic, never a crash.
  const recordedToolNames = new Set<string>();
  let toolCallCount = 0;
  // Set the moment the transport takes the turn — see ChildTurnObservation.
  let promptAccepted = false;
  let resolveToolLimit: () => void = () => {};
  const toolLimited = new Promise<"tool_limit">((resolve) => {
    resolveToolLimit = () => resolve("tool_limit");
  });
  const unsubscribe = session.subscribe((event) => {
    try {
      // An event from the child is proof it is live, even if `prompt()` has not
      // settled yet: a host whose prompt promise only resolves at turn end would
      // otherwise look like a turn that never started.
      promptAccepted = true;
      const toolName = sdkToolEventName(event);
      if (toolName !== undefined) recordedToolNames.add(toolName);
      if (eventTypeName(event) === "tool_execution_start") {
        toolCallCount += 1;
        if (maxToolCalls !== undefined && toolCallCount > maxToolCalls) resolveToolLimit();
      }
      agentLiveStore.feedExecutionEvent(execution, event);
      // Pi emits `agent_end` after each model cycle, including a cycle followed
      // by queued steering input. The SDK prompt still owns the live run until
      // it settles, so keep the row active here; the terminal result path below
      // applies the genuine final status after prompt() returns.
      if (eventTypeName(event) === "agent_end" && session.isStreaming === true) {
        agentLiveStore.patchExecution(execution, { status: "working" });
      }
      if (isRecord(event) && event.type === "agent_end" && event.willRetry !== true) resolveEnd();
    } catch {
      // A malformed/late event must not crash the host from the SDK's emit path.
      // The genuine failure is still surfaced through the turn's timeout/abort and
      // the failedResult mapping; this guard only prevents an out-of-band throw.
    }
  });
  const unregisterInput =
    "isStreaming" in session
      ? agentLiveStore.registerInputForExecution(
          execution,
          async (text) => {
            if (session.isStreaming !== true) throw new Error("Agent turn is no longer accepting input.");
            await session.prompt(text, {
              source: "locus-pi-agent-viewer",
              streamingBehavior: "steer",
            });
          },
          () => session.isStreaming === true,
        )
      : () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const timedOut = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), turnBudgetMs);
    });
    // A turn is "complete" only when agent_end fires; prompt() racing here means a
    // hung prompt() cannot block the abort/timeout branches from winning.
    const completed = (async (): Promise<"completed"> => {
      await session.prompt(kickoff, { source: "locus-pi-agent-sdk-host" });
      promptAccepted = true;
      await ended;
      return "completed";
    })();
    const settlement = await Promise.race([completed, aborted, timedOut, toolLimited]);
    return { settlement, recordedToolNames: [...recordedToolNames].sort(), promptAccepted };
  } finally {
    unregisterInput();
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function sdkToolEventName(event: unknown): string | undefined {
  if (!SDK_TOOL_EVIDENCE_EVENT_TYPES.has(eventTypeName(event))) return undefined;
  return eventToolName(event)?.trim() || undefined;
}

/** Best-effort child abort with a bounded acknowledgement wait. */
async function abortChild(session: SdkAgentSessionLike, timeoutMs: number): Promise<void> {
  const abort = session.abort;
  if (abort === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const attempted = Promise.resolve()
      .then(() => abort.call(session))
      .catch(() => undefined);
    const bounded = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([attempted, bounded]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function disposeQuietly(session: SdkAgentSessionLike): void {
  try {
    session.dispose();
  } catch {
    /* best effort */
  }
}

async function defaultCreateAgentSession(opts: SdkCreateSessionOptionsLike): Promise<SdkCreateSessionResultLike> {
  let mod: unknown;
  try {
    mod = await import("@earendil-works/pi-coding-agent");
  } catch (error) {
    throw new AgentSdkUnavailableError(`Pi SDK module could not be imported: ${errorMessage(error)}`);
  }
  let create: unknown;
  try {
    create = (mod as { createAgentSession?: unknown }).createAgentSession;
  } catch (error) {
    // Some module shapes (e.g. strict ESM namespaces or test mocks) throw on a
    // missing-export access. Treat that as substrate-unavailable, not a run failure.
    throw new AgentSdkUnavailableError(`Installed Pi host does not expose createAgentSession: ${errorMessage(error)}`);
  }
  if (typeof create !== "function") {
    throw new AgentSdkUnavailableError("Installed Pi host does not export createAgentSession (host too old).");
  }
  const sessionOptions = await materializeSdkSessionOptions(mod, opts);
  const result = await (create as (o: unknown) => Promise<unknown>)(sessionOptions);
  if (!isRecord(result) || !isRecord(result.session)) {
    throw new AgentSdkUnavailableError("createAgentSession returned an unexpected shape.");
  }
  return result as unknown as SdkCreateSessionResultLike;
}

async function materializeSdkSessionOptions(
  mod: unknown,
  opts: SdkCreateSessionOptionsLike,
): Promise<Record<string, unknown>> {
  const { appendSystemPrompt, resourceLoaderOptions, ...sessionOptions } = opts;
  if (appendSystemPrompt === undefined && resourceLoaderOptions === undefined) return sessionOptions;
  if (!isRecord(mod) || typeof mod.DefaultResourceLoader !== "function") {
    throw new AgentSdkUnavailableError(
      "Installed Pi host does not expose DefaultResourceLoader for package-owned prompt resources.",
    );
  }
  const DefaultResourceLoader = mod.DefaultResourceLoader as new (options: Record<string, unknown>) => {
    reload?: () => Promise<void> | void;
  };
  const loaderOptions: Record<string, unknown> =
    resourceLoaderOptions === undefined
      ? {
          cwd: opts.cwd,
          appendSystemPromptOverride: (base: string[]) => [...base, appendSystemPrompt!],
        }
      : {
          cwd: opts.cwd,
          ...resourceLoaderOptions,
          systemPromptOverride: () => resourceLoaderOptions.systemPrompt,
          appendSystemPromptOverride: () => [],
        };
  if (typeof mod.getAgentDir === "function") loaderOptions.agentDir = (mod.getAgentDir as () => string)();
  const loader = new DefaultResourceLoader(loaderOptions);
  await loader.reload?.();
  return { ...sessionOptions, resourceLoader: loader };
}

async function exportEvidence(
  session: SdkAgentSessionLike,
  request: AgentRunRequest,
  now: () => string,
  reportsDirOverride: string | undefined,
  diagnostics: string[],
): Promise<AgentChildTrace | undefined> {
  const reportsDir = reportsDirOverride ?? path.join(runtimeStateDir(request.projectRoot ?? process.cwd()), "reports");
  const stamp = sanitizeStamp(now());
  try {
    if (session.sessionId.trim() === "") throw new Error("child session id is missing");
    mkdirSync(reportsDir, { recursive: true });
    const exportedPath = session.exportToJsonl(path.join(reportsDir, `agent-sdk-${request.agent.name}-${stamp}.jsonl`));
    const realReportsDir = realpathSync(reportsDir);
    const realExportedPath = realpathSync(exportedPath);
    const relativePath = path.relative(realReportsDir, realExportedPath);
    if (relativePath === "" || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error(`exported path escaped reports root: ${realExportedPath}`);
    }
    if (path.extname(realExportedPath) !== ".jsonl") {
      throw new Error(`exported path is not JSONL: ${realExportedPath}`);
    }
    const firstLine = readFileSync(realExportedPath, "utf8").split("\n", 1)[0]?.trim() ?? "";
    if (firstLine === "") throw new Error("exported JSONL session header is missing");
    const header = JSON.parse(firstLine) as unknown;
    if (!isRecord(header) || header.type !== "session" || header.id !== session.sessionId) {
      throw new Error(`exported JSONL session header does not match child ${session.sessionId}`);
    }
    diagnostics.push(`JSONL evidence exported: ${realExportedPath}`);
    const htmlPath = await exportHtmlRender(session, realReportsDir, realExportedPath, diagnostics);
    return {
      path: realExportedPath,
      format: "pi-session-jsonl",
      childSessionId: session.sessionId,
      ...(htmlPath === undefined ? {} : { htmlPath }),
    };
  } catch (error) {
    diagnostics.push(`JSONL export failed: ${errorMessage(error)}`);
    return undefined;
  }
}

/** Named warning prefix for every reason a session has no readable render. */
const HTML_RENDER_WARNING = "HTML transcript render";

/**
 * The readable half of one child's evidence, beside its JSONL and named after it.
 *
 * Additive: the TUI reader stays the required surface and a missing render never
 * fails a run. It is not, however, allowed to be quiet — every reason lands in
 * `diagnostics`, which the per-call result envelope persists, and the path is
 * returned only after the file has been verified on disk. A host with no
 * `exportToHtml` is one of those reasons; `pi --export <transcript>.jsonl
 * <out>.html` re-renders any saved transcript afterwards.
 */
async function exportHtmlRender(
  session: SdkAgentSessionLike,
  realReportsDir: string,
  realExportedPath: string,
  diagnostics: string[],
): Promise<string | undefined> {
  if (typeof session.exportToHtml !== "function") {
    diagnostics.push(`${HTML_RENDER_WARNING} unavailable: the installed Pi host exposes no AgentSession.exportToHtml`);
    return undefined;
  }
  const target = `${realExportedPath.slice(0, -path.extname(realExportedPath).length)}.html`;
  try {
    // Awaited, not fired and forgotten: the run may finish the instant this
    // returns, and a render still in flight would leave the evidence claiming a
    // file that is not there yet.
    const written = await session.exportToHtml(target);
    if (typeof written !== "string" || written.trim() === "") {
      throw new Error("exportToHtml returned no path");
    }
    const realWritten = realpathSync(written);
    const relativePath = path.relative(realReportsDir, realWritten);
    if (relativePath === "" || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error(`rendered path escaped reports root: ${realWritten}`);
    }
    if (path.extname(realWritten) !== ".html") throw new Error(`rendered path is not HTML: ${realWritten}`);
    if (statSync(realWritten).size === 0) throw new Error(`rendered file is empty: ${realWritten}`);
    diagnostics.push(`${HTML_RENDER_WARNING} exported: ${realWritten}`);
    return realWritten;
  } catch (error) {
    diagnostics.push(`${HTML_RENDER_WARNING} failed: ${errorMessage(error)}`);
    return undefined;
  }
}

function withChildTrace(result: AgentRunResult, childTrace: AgentChildTrace | undefined): AgentRunResult {
  return childTrace === undefined ? result : { ...result, childTrace };
}

function createSdkSessionRecord(request: AgentRunRequest, childSessionId: string): SessionRecord {
  const session: SessionRecord = {
    id: childSessionId,
    createdAt: "agent-sdk-session",
    metadata: {
      source: "agent-sdk-session-host",
      agentName: request.agent.name,
      maxTurns: request.maxTurns,
      depth: request.depth,
      maxDepth: request.maxDepth,
    },
  };
  if (request.parentSessionId !== undefined) session.parentSessionId = request.parentSessionId;
  if (request.projectRoot !== undefined) session.projectRoot = request.projectRoot;
  if (request.workingDirectory !== undefined) session.workingDirectory = request.workingDirectory;
  return session;
}

function blockedResult(
  request: AgentRunRequest,
  reason: string,
  failureCause: AgentFailureCause,
  diagnostics: string[],
): AgentRunResult {
  return {
    status: "blocked",
    agentName: request.agent.name,
    reason,
    failureCause,
    diagnostics,
    lifecycleEntryIds: [],
  };
}

function failedResult(
  request: AgentRunRequest,
  reason: string,
  failureCause: AgentFailureCause,
  diagnostics: string[] = [reason],
  childOutputStats?: AgentChildOutputStats,
  childSession?: SessionRecord,
): AgentRunResult {
  const result: AgentRunResult = {
    status: "failed",
    agentName: request.agent.name,
    reason,
    failureCause,
    diagnostics,
    lifecycleEntryIds: [],
  };
  if (childOutputStats !== undefined) result.childOutputStats = childOutputStats;
  if (childSession !== undefined) result.childSession = childSession;
  return result;
}

function cancelledResult(
  request: AgentRunRequest,
  reason: string,
  diagnostics: string[] = [reason],
  childSession?: SessionRecord,
): AgentRunResult {
  const result: AgentRunResult = {
    status: "cancelled",
    agentName: request.agent.name,
    reason,
    // Cancellation has exactly one origin, so the cause is a constant rather than a parameter.
    failureCause: "cancelled",
    diagnostics: diagnostics.length === 0 ? [reason] : diagnostics,
    lifecycleEntryIds: [],
  };
  if (childSession !== undefined) result.childSession = childSession;
  return result;
}

function sanitizeStamp(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolOrStepEvent(event: unknown): boolean {
  const type = eventTypeName(event).toLowerCase();
  return type.includes("tool") || type.includes("step");
}

function isToolResultEvent(event: unknown): boolean {
  const type = eventTypeName(event).toLowerCase();
  return type.includes("result") || type.includes("end") || type.includes("finish");
}

function eventToolName(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const key of ["toolName", "tool", "name"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  const toolCall = event["toolCall"];
  if (isRecord(toolCall)) {
    const name = toolCall["name"] ?? toolCall["toolName"];
    if (typeof name === "string" && name.trim() !== "") return name;
  }
  return undefined;
}

function eventPath(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const key of ["currentPath", "cwd", "workingDirectory", "path"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim() !== "") return compactAgentLiveValue(value);
  }
  return undefined;
}

function eventToolArgs(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const key of ["args", "arguments", "input"]) {
    const value = event[key];
    const formatted = eventFieldValue(value);
    if (formatted !== undefined) return formatted;
  }
  const toolCall = event["toolCall"];
  if (isRecord(toolCall)) {
    for (const key of ["args", "arguments", "input"]) {
      const formatted = eventFieldValue(toolCall[key]);
      if (formatted !== undefined) return formatted;
    }
  }
  return undefined;
}

function eventErrorMessage(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  for (const nested of [event.message, event.error]) {
    if (!isRecord(nested)) continue;
    const message = eventFieldMessage(nested.errorMessage);
    if (message !== undefined) return message;
  }
  for (const key of ["error", "message", "reason"]) {
    const value = event[key];
    const message = eventFieldMessage(value);
    if (message !== undefined) return message;
  }
  return undefined;
}

function assistantProviderFailure(messages: readonly unknown[] | undefined): string | undefined {
  if (messages === undefined) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      return eventFieldMessage(message.errorMessage) ?? "Child assistant failed with stopReason=error.";
    }
    if (message.stopReason === "length") {
      return "Child assistant reached the provider output-token limit (stopReason=length); refusing the truncated answer.";
    }
    return undefined;
  }
  return undefined;
}

/** Count one completed model turn. message_end carries the same message, so it is ignored. */
function eventTurnUsage(event: unknown): { input: number; output: number } | undefined {
  if (!isRecord(event) || eventTypeName(event) !== "turn_end") return undefined;
  const message = event.message;
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  const usage = message.usage;
  if (!isRecord(usage)) return undefined;
  const input = finiteNonNegativeNumber(usage.input);
  const output = finiteNonNegativeNumber(usage.output);
  return input === undefined || output === undefined ? undefined : { input, output };
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function appendDirectSpawnBoundary(systemPrompt: string | undefined): string {
  const boundary = [
    "# Delegation boundary",
    "Do not call `spawn_agent` or `task` directly; direct sub-agent nesting is disabled by the host.",
    "If multi-agent orchestration is necessary, you may author and run a workflow through `workflow` when that tool is available.",
  ].join("\n");
  return systemPrompt === undefined || systemPrompt.trim() === "" ? boundary : `${systemPrompt}\n\n${boundary}`;
}

function eventTypeName(event: unknown): string {
  if (!isRecord(event)) return "unknown";
  const value = event.type;
  return typeof value === "string" && value.trim() !== "" ? value : "unknown";
}

function formatAgentLiveEventLine(event: unknown): string {
  const parts = [`event type=${eventTypeName(event)}`];
  const tool = eventToolName(event);
  if (tool !== undefined) parts.push(`tool=${tool}`);
  if (isRecord(event)) {
    for (const key of ["error", "message", "reason"]) {
      const message = eventFieldMessage(event[key]);
      if (message !== undefined) parts.push(`${key}=${message}`);
    }
  }
  return boundedAgentLiveLine(parts.join(" "));
}

function formatAgentLiveStatsLine(stats: SdkSessionStatsLike): string {
  return boundedAgentLiveLine(
    `stats sessionId=${stats.sessionId} toolCalls=${stats.toolCalls} toolResults=${stats.toolResults}`,
  );
}

function appendAgentLiveEventLine(lines: string[], line: string): string[] {
  return [...lines, line].slice(-MAX_AGENT_LIVE_EVENT_LINES);
}

function eventFieldMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return compactAgentLiveValue(value);
  if (value instanceof Error && value.message.trim() !== "") return compactAgentLiveValue(value.message);
  return undefined;
}

function eventFieldValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() === "" ? undefined : boundedAgentLiveLine(value);
  try {
    return boundedAgentLiveLine(JSON.stringify(value));
  } catch {
    return boundedAgentLiveLine(String(value));
  }
}

function boundedAgentLiveLine(value: string): string {
  const compacted = compactAgentLiveValue(value);
  if (compacted.length <= MAX_AGENT_LIVE_EVENT_LINE_LENGTH) return compacted;
  return `${compacted.slice(0, MAX_AGENT_LIVE_EVENT_LINE_LENGTH - 1)}…`;
}

function compactAgentLiveValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function boundedAgentLiveRequest(value: string): string {
  if (value.length <= MAX_AGENT_LIVE_REQUEST_LENGTH) return value;
  const omitted = value.length - MAX_AGENT_LIVE_REQUEST_LENGTH;
  return `${value.slice(0, MAX_AGENT_LIVE_REQUEST_LENGTH)}\n\n… ${omitted} additional request character(s) omitted`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function liveBeginOptions(
  rowId: string | undefined,
  agentName: string,
  live: NonNullable<AgentSdkSessionExecutorOptions["live"]>,
  cwd: string,
  request: string,
): AgentLiveBeginOptions {
  const options: AgentLiveBeginOptions = {
    agentName,
    label: live.label ?? agentName,
    currentPath: cwd,
    request,
  };
  if (rowId !== undefined) options.id = rowId;
  if (live.title !== undefined) options.title = live.title;
  if (live.slotKey !== undefined) options.slotKey = live.slotKey;
  if (live.round !== undefined) options.round = live.round;
  if (live.parentRowId !== undefined) options.parentRowId = live.parentRowId;
  if (live.workflowRunId !== undefined) options.workflowRunId = live.workflowRunId;
  if (live.model !== undefined) options.model = live.model;
  if (live.thinking !== undefined) options.thinking = live.thinking;
  if (live.isolated !== undefined) options.isolated = live.isolated;
  if (live.noMcp !== undefined) options.noMcp = live.noMcp;
  return options;
}

function activityStateForStatus(status: AgentLiveStatus): AgentLiveActivityState {
  switch (status) {
    case "queued":
      return "waiting";
    case "working":
      return "active";
    case "done":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "error":
      return "failed";
  }
}

function isTerminalAgentLiveStatus(status: AgentLiveStatus): boolean {
  return status === "done" || status === "cancelled" || status === "error";
}
