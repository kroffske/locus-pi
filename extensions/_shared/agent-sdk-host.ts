import { EventEmitter } from "node:events";
import path from "node:path";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import type {
  AgentChildOutputStats,
  AgentChildTrace,
  AgentExecutor,
  AgentRunRequest,
  AgentRunResult,
} from "./agent-runner.js";
import { createAgentExecutionPromptCapsule, formatAgentKickoffPrompt, parseAgentText } from "./agent-executor-host.js";
import type { SessionRecord } from "./session-core.js";
import { runtimeStateDir } from "./files.js";
import { evaluateEvidence } from "./agent-evidence-evaluator.js";
import type { EvidenceEvaluationInput } from "./types.js";
import { PetnameRegistry } from "./agent-names.js";
import { AgentLiveTranscript, type AgentLiveTranscriptSnapshot } from "./agent-live-transcript.js";
import { createReadOnlyAgentSessionCapabilities, type ReadOnlyAgentCustomTool } from "./agent-read-only-policy.js";

/**
 * Tool-context sibling of `createAgentReplacementSessionExecutor`.
 *
 * The command-context executor (agent-executor-host.ts) is backed by
 * `ctx.newSession`, which is structurally unreachable from a tool `execute()`
 * context. This executor instead spawns a real HEADLESS child agent session via
 * the top-level public SDK `createAgentSession`, so the programmatic `task` tool
 * can run a genuine sub-agent. It reuses the same capsule + text-result layer as
 * the command path, and it does NOT touch the boundary/runner.
 */

/** Diagnostic token stamped on blocked results when the SDK host is unavailable. */
export const AGENT_SDK_UNAVAILABLE_DIAGNOSTIC = "agent-sdk-host:unavailable";

/** Stable substring shared by AgentSdkUnavailableError messages. */
export const AGENT_SDK_UNAVAILABLE_HINT = "Pi SDK host";

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
  /** Pi 0.80.3 conversation history; optional for older hosts and structural mocks. */
  readonly messages?: readonly unknown[];
  subscribe(listener: (event: SdkAgentSessionEventLike) => void): () => void;
  prompt(text: string, options?: { source?: string }): Promise<void>;
  getSessionStats(): SdkSessionStatsLike;
  getLastAssistantText(): string | undefined;
  exportToJsonl(outputPath?: string): string; // SYNC
  dispose(): void;
  abort?(): Promise<void>;
}
export interface SdkCreateSessionResultLike {
  session: SdkAgentSessionLike;
}
export interface SdkCreateSessionOptionsLike {
  cwd?: string;
  tools?: string[];
  /** Tool names disabled after any allowlist is applied. */
  excludeTools?: string[];
  /** Custom tools registered for this child session. */
  customTools?: ReadOnlyAgentCustomTool[];
  /** A resolved Pi `Model` object (kept structurally opaque here). When set, the
   *  child session uses it instead of the host default — so the child inherits the
   *  caller's model rather than relying on settings (which may default to a weak or
   *  unauthenticated provider). */
  model?: unknown;
  /** Additional child instructions generated from the selected catalog agent. The
   *  default host adapter appends this through DefaultResourceLoader so Pi keeps
   *  its normal base prompt, tool instructions, context files, and skills. */
  appendSystemPrompt?: string;
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

export interface AgentLiveRow {
  id: string;
  parentRowId?: string;
  agentName?: string;
  /** Memorable, deterministic petname for this row (REQ-002); assigned in `begin`. */
  displayName?: string;
  label: string;
  /** Short work description shown in the live row (≤48 cols, REQ-003); falls back to the label. */
  title?: string;
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
  agentName?: string;
  label: string;
  title?: string;
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

class AgentLiveStore {
  readonly rows = new Map<string, AgentLiveRow>();
  readonly emitter = new EventEmitter();
  readonly #agentNames = new Map<string, string>();
  readonly #petnames = new PetnameRegistry();
  readonly #cancelHandlers = new Map<string, () => void>();
  readonly #transcripts = new Map<string, AgentLiveTranscript>();
  #nextId = 0;

  reset(): void {
    this.rows.clear();
    this.#agentNames.clear();
    this.#petnames.reset();
    this.#cancelHandlers.clear();
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
      this.#cancelHandlers.delete(id);
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
    this.#cancelHandlers.set(rowId, cancel);
    return () => {
      if (this.#cancelHandlers.get(rowId) === cancel) this.#cancelHandlers.delete(rowId);
    };
  }

  /** Request cancellation of one selected child. False means no active child seam. */
  cancel(rowId: string): boolean {
    const cancel = this.#cancelHandlers.get(rowId);
    if (cancel === undefined) return false;
    cancel();
    return true;
  }

  begin(options: AgentLiveBeginOptions): AgentLiveRow {
    const id = options.id ?? `agent-live-${Date.now()}-${++this.#nextId}`;
    const existing = this.rows.get(id);
    // Petname is stable per row: assigned once (never re-derived), and skipped for
    // group summary rows which render from their own label, not a petname.
    const isGroupRow = (options.groupKind ?? existing?.groupKind) !== undefined;
    const displayName = existing?.displayName ?? (isGroupRow ? undefined : this.#petnames.assign(id));
    // Slot rounds (REQ-009): the SAME row is reused when a workflow slot is re-invoked.
    // A strictly higher round means a new iteration began — reset the per-round transient
    // fields (tools/args/tool-start/tokens/elapsed) so the row shows THIS round, not the
    // last. `round`/`slotKey` are options-win (the newer call carries the current value).
    const round = options.round ?? existing?.round;
    const slotKey = options.slotKey ?? existing?.slotKey;
    const isNewRound = existing !== undefined && options.round !== undefined && options.round > (existing.round ?? 0);
    if (isNewRound) this.#transcripts.delete(id);
    const row: AgentLiveRow = {
      id,
      ...(existing?.parentRowId !== undefined || options.parentRowId !== undefined
        ? { parentRowId: existing?.parentRowId ?? options.parentRowId }
        : {}),
      ...(existing?.agentName !== undefined || options.agentName !== undefined
        ? { agentName: existing?.agentName ?? options.agentName }
        : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      label: options.label,
      ...(existing?.title !== undefined || options.title !== undefined
        ? { title: existing?.title ?? options.title }
        : {}),
      ...(slotKey !== undefined ? { slotKey } : {}),
      ...(round !== undefined ? { round } : {}),
      status: existing?.status ?? "queued",
      activityState: existing?.activityState ?? activityStateForStatus(existing?.status ?? "queued"),
      ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
      ...(!isNewRound && existing?.elapsedMs !== undefined ? { elapsedMs: existing.elapsedMs } : {}),
      ...(existing?.lastActivityAt !== undefined || options.now !== undefined
        ? { lastActivityAt: existing?.lastActivityAt ?? options.now }
        : {}),
      ...(existing?.model !== undefined || options.model !== undefined
        ? { model: existing?.model ?? options.model }
        : {}),
      ...(existing?.thinking !== undefined || options.thinking !== undefined
        ? { thinking: existing?.thinking ?? options.thinking }
        : {}),
      ...(existing?.currentPath !== undefined || options.currentPath !== undefined
        ? { currentPath: existing?.currentPath ?? options.currentPath }
        : {}),
      currentTools: isNewRound ? [] : (existing?.currentTools ?? []),
      ...(!isNewRound && existing?.currentToolArgs !== undefined ? { currentToolArgs: existing.currentToolArgs } : {}),
      ...(!isNewRound && existing?.currentToolStartMs !== undefined
        ? { currentToolStartMs: existing.currentToolStartMs }
        : {}),
      stepCount: existing?.stepCount ?? 0,
      ...(existing?.turnCount !== undefined ? { turnCount: existing.turnCount } : {}),
      ...(!isNewRound && existing?.tokenCount !== undefined ? { tokenCount: existing.tokenCount } : {}),
      ...(existing?.childSessionId !== undefined ? { childSessionId: existing.childSessionId } : {}),
      ...(existing?.resultArtifact !== undefined ? { resultArtifact: existing.resultArtifact } : {}),
      ...(existing?.finalAnswer !== undefined ? { finalAnswer: existing.finalAnswer } : {}),
      isolated: options.isolated ?? existing?.isolated ?? false,
      noMcp: options.noMcp ?? existing?.noMcp ?? false,
      ...(existing?.groupKind !== undefined || options.groupKind !== undefined
        ? { groupKind: existing?.groupKind ?? options.groupKind }
        : {}),
      ...(existing?.groupTotal !== undefined || options.groupTotal !== undefined
        ? { groupTotal: existing?.groupTotal ?? options.groupTotal }
        : {}),
      ...(existing?.groupCompleted !== undefined ? { groupCompleted: existing.groupCompleted } : {}),
      ...(existing?.groupFailed !== undefined ? { groupFailed: existing.groupFailed } : {}),
      errors: existing?.errors ?? [],
      eventLines: existing?.eventLines ?? [],
      ...(isNewRound || existing?.transcript === undefined ? {} : { transcript: existing.transcript }),
      ...(isNewRound || existing?.latestMessage === undefined ? {} : { latestMessage: existing.latestMessage }),
    };
    this.rows.set(id, row);
    if (options.agentName !== undefined) this.#agentNames.set(id, options.agentName);
    this.#emit();
    return row;
  }

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
const AGENT_LIVE_STORE_GLOBAL_KEY = Symbol.for("locus-pi.agent-live-store.v3");
interface SharedAgentLiveStoreSlot {
  version: 3;
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
  const slot: SharedAgentLiveStoreSlot = { version: 3, store: new AgentLiveStore() };
  Object.defineProperty(runtimeGlobal, AGENT_LIVE_STORE_GLOBAL_KEY, {
    value: slot,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return slot.store;
}

function isSharedAgentLiveStoreSlot(value: unknown): value is SharedAgentLiveStoreSlot {
  if (!isRecord(value) || value.version !== 3 || !isRecord(value.store)) return false;
  return (
    value.store.rows instanceof Map &&
    typeof value.store.begin === "function" &&
    typeof value.store.cancel === "function"
  );
}

export const agentLiveStore = sharedAgentLiveStore();

export interface AgentSdkSessionExecutorOptions {
  /** Inject a fake factory in unit tests; defaults to a guarded dynamic import. */
  createSession?: CreateAgentSessionFactory;
  /** Resolved parent `Model` to pass to the child session (e.g. `ctx.model`). When
   *  omitted, the child falls back to the host's default model resolution. */
  model?: unknown;
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
  /** Optional fail-closed tool-call budget for this child. */
  maxToolCalls?: number;
  /** Optional live-row identity supplied by callers that already created a UI row. */
  live?: {
    rowId?: string;
    parentRowId?: string;
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
  /** Optional explicit env for prompt-building; defaults to process.env. */
  promptEnv?: NodeJS.ProcessEnv;
}

export function createAgentSdkSessionExecutor(options: AgentSdkSessionExecutorOptions = {}): AgentExecutor {
  const createSession = options.createSession ?? defaultCreateAgentSession;
  const now = options.now ?? (() => new Date().toISOString());
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_AGENT_SDK_TURN_TIMEOUT_MS;
  const maxToolCalls = options.maxToolCalls;
  if (maxToolCalls !== undefined && (!Number.isInteger(maxToolCalls) || maxToolCalls < 0)) {
    throw new Error("maxToolCalls must be a non-negative integer when provided");
  }
  const model = options.model;
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
        return await runWithSdkSession(
          request,
          childController.signal,
          createSession,
          now,
          options.reportsDir,
          turnTimeoutMs,
          maxToolCalls,
          model,
          options.live,
          options.promptEnv,
          (rowId) => {
            unregisterCancel();
            unregisterCancel = agentLiveStore.registerCancel(rowId, () => childController.abort());
          },
        );
      } finally {
        unregisterCancel();
        signal.removeEventListener("abort", forwardCallerAbort);
      }
    },
  };
}

async function runWithSdkSession(
  request: AgentRunRequest,
  signal: AbortSignal,
  createSession: CreateAgentSessionFactory,
  now: () => string,
  reportsDirOverride: string | undefined,
  turnTimeoutMs: number,
  maxToolCalls: number | undefined,
  model: unknown,
  live: AgentSdkSessionExecutorOptions["live"],
  promptEnv: NodeJS.ProcessEnv | undefined,
  onLiveRow?: (rowId: string) => void,
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
    return cancelledResult(request, "Agent run was cancelled before child session creation.");
  }

  const diagnostics: string[] = [];
  const capsule = createAgentExecutionPromptCapsule(request, diagnostics, promptEnv);
  const kickoff = formatAgentKickoffPrompt(capsule);

  const cwd = request.workingDirectory ?? request.projectRoot ?? process.cwd();
  const readOnlyCapabilities = request.agent.readOnly
    ? createReadOnlyAgentSessionCapabilities(cwd, request.allowedTools)
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
  const appendSystemPrompt = appendDirectSpawnBoundary(capsule.agentSystemPrompt);
  if (appendSystemPrompt !== undefined) sessionOptions.appendSystemPrompt = appendSystemPrompt;
  const liveRow =
    live !== undefined
      ? agentLiveStore.begin(liveBeginOptions(live.rowId, request.agent.name, live, cwd))
      : agentLiveStore.claimQueuedRow(request.agent.name, request.agent.name);
  onLiveRow?.(liveRow.id);

  let created: SdkCreateSessionResultLike;
  try {
    created = await createSession(sessionOptions);
  } catch (error) {
    if (error instanceof AgentSdkUnavailableError) {
      // Substrate genuinely unavailable -> blocked, with a detectable diagnostic
      // token the wiring keys its graceful fallback on. The reason is HONEST,
      // never the stale M11 replacement-session text.
      return blockedResult(request, error.message, [...diagnostics, AGENT_SDK_UNAVAILABLE_DIAGNOSTIC, error.message]);
    }
    return failedResult(request, errorMessage(error), [...diagnostics, errorMessage(error)]);
  }

  const session = created.session;
  agentLiveStore.patch(liveRow.id, {
    status: "working",
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    currentPath: cwd,
    // Make the full uuid available to an active drill immediately, rather than
    // only after the child has completed and its boundary result is parsed.
    childSessionId: session.sessionId,
  });

  // MUST guard the gap between session creation and prompting: an abort that
  // lands while createSession() was in flight would otherwise still kick off a
  // real child turn. Dispose-and-cancel immediately instead.
  if (signal.aborted) {
    disposeQuietly(session);
    const reason = "Agent run was cancelled before child session kickoff.";
    agentLiveStore.patch(liveRow.id, { status: "cancelled", finalAnswer: reason });
    return cancelledResult(request, reason);
  }

  // Budget scales with maxTurns so a legitimately long multi-turn child is not
  // killed prematurely, while a stuck child still has a hard ceiling.
  const turnBudgetMs = turnTimeoutMs * Math.max(1, request.maxTurns);
  try {
    const turn = await driveChildTurn(session, kickoff, signal, turnBudgetMs, maxToolCalls, liveRow.id);

    if (turn.settlement === "aborted" || turn.settlement === "timed_out" || turn.settlement === "tool_limit") {
      // Stop the child, then still export evidence and dispose (finally below).
      await abortChild(session);
      const childTrace = exportEvidence(session, request, now, reportsDirOverride, diagnostics);
      const childSession = createSdkSessionRecord(request, session.sessionId);
      if (turn.settlement === "timed_out") {
        const reason = `Child agent turn exceeded the ${turnBudgetMs}ms budget and was aborted.`;
        agentLiveStore.patch(liveRow.id, { status: "error", errors: [reason], finalAnswer: reason });
        return withChildTrace(
          failedResult(request, reason, [...diagnostics, reason], undefined, childSession),
          childTrace,
        );
      }
      if (turn.settlement === "tool_limit") {
        const reason = `Child agent exceeded the ${maxToolCalls ?? 0} tool-call budget and was aborted.`;
        agentLiveStore.patch(liveRow.id, { status: "error", errors: [reason], finalAnswer: reason });
        return withChildTrace(
          failedResult(request, reason, [...diagnostics, reason], undefined, childSession),
          childTrace,
        );
      }
      const reason = "Agent run was cancelled.";
      agentLiveStore.patch(liveRow.id, { status: "cancelled", finalAnswer: reason });
      return withChildTrace(cancelledResult(request, reason, diagnostics, childSession), childTrace);
    }

    const stats = session.getSessionStats();
    agentLiveStore.applySessionStats(liveRow.id, stats);
    if (session.messages !== undefined) agentLiveStore.replaceTranscriptFromMessages(liveRow.id, session.messages);
    const text = session.getLastAssistantText();
    const childTrace = exportEvidence(session, request, now, reportsDirOverride, diagnostics);

    const childOutputStats: AgentChildOutputStats = {
      // The SDK exposes aggregate counters, not an entry list, in this context.
      // entryCount is a defensible derived count from the genuine workload signals.
      entryCount: stats.toolCalls + stats.toolResults,
      assistantMessageCount: 0,
      assistantToolCallCount: stats.toolCalls,
      toolResultCount: stats.toolResults,
      recordedToolNames: turn.recordedToolNames,
      hasWorkloadProof: stats.toolCalls > 0 || stats.toolResults > 0,
    };

    const childSession = createSdkSessionRecord(request, session.sessionId || stats.sessionId);
    const providerFailure = assistantProviderFailure(session.messages);
    if (providerFailure !== undefined) {
      agentLiveStore.patch(liveRow.id, {
        status: "error",
        childSessionId: childSession.id,
        errors: unique([...agentLiveStore.rows.get(liveRow.id)!.errors, providerFailure]),
        finalAnswer: providerFailure,
      });
      return withChildTrace(
        failedResult(request, providerFailure, [...diagnostics, providerFailure], childOutputStats, childSession),
        childTrace,
      );
    }
    const parsed = parseAgentText(text ?? "");
    if (!parsed.ok) {
      agentLiveStore.patch(liveRow.id, {
        status: "error",
        childSessionId: childSession.id,
        finalAnswer: parsed.reason,
      });
      return withChildTrace(
        failedResult(request, parsed.reason, [...diagnostics, parsed.reason], childOutputStats, childSession),
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
    agentLiveStore.patch(liveRow.id, {
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
    return failedResult(request, errorMessage(error), [...diagnostics, errorMessage(error)]);
  } finally {
    disposeQuietly(session);
  }
}

type ChildTurnSettlement = "completed" | "aborted" | "timed_out" | "tool_limit";
const SDK_TOOL_EVIDENCE_EVENT_TYPES = new Set(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);

interface ChildTurnObservation {
  settlement: ChildTurnSettlement;
  recordedToolNames: string[];
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
  liveRowId: string,
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
  let resolveToolLimit: () => void = () => {};
  const toolLimited = new Promise<"tool_limit">((resolve) => {
    resolveToolLimit = () => resolve("tool_limit");
  });
  const unsubscribe = session.subscribe((event) => {
    try {
      const toolName = sdkToolEventName(event);
      if (toolName !== undefined) recordedToolNames.add(toolName);
      if (eventTypeName(event) === "tool_execution_start") {
        toolCallCount += 1;
        if (maxToolCalls !== undefined && toolCallCount > maxToolCalls) resolveToolLimit();
      }
      agentLiveStore.feedSessionEvent(liveRowId, event);
      if (isRecord(event) && event.type === "agent_end" && event.willRetry !== true) resolveEnd();
    } catch {
      // A malformed/late event must not crash the host from the SDK's emit path.
      // The genuine failure is still surfaced through the turn's timeout/abort and
      // the failedResult mapping; this guard only prevents an out-of-band throw.
    }
  });

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
      await ended;
      return "completed";
    })();
    const settlement = await Promise.race([completed, aborted, timedOut, toolLimited]);
    return { settlement, recordedToolNames: [...recordedToolNames].sort() };
  } finally {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function sdkToolEventName(event: unknown): string | undefined {
  if (!SDK_TOOL_EVIDENCE_EVENT_TYPES.has(eventTypeName(event))) return undefined;
  return eventToolName(event)?.trim() || undefined;
}

/** Best-effort child abort; the SDK's abort() resolves once the child is idle. */
async function abortChild(session: SdkAgentSessionLike): Promise<void> {
  try {
    await session.abort?.();
  } catch {
    /* best effort: we are already tearing the child down */
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
  const { appendSystemPrompt, ...sessionOptions } = opts;
  if (appendSystemPrompt === undefined) return sessionOptions;
  if (!isRecord(mod) || typeof mod.DefaultResourceLoader !== "function") {
    throw new AgentSdkUnavailableError(
      "Installed Pi host does not expose DefaultResourceLoader for appendSystemPrompt.",
    );
  }
  const DefaultResourceLoader = mod.DefaultResourceLoader as new (options: Record<string, unknown>) => {
    reload?: () => Promise<void> | void;
  };
  const loaderOptions: Record<string, unknown> = {
    cwd: opts.cwd,
    appendSystemPromptOverride: (base: string[]) => [...base, appendSystemPrompt],
  };
  if (typeof mod.getAgentDir === "function") loaderOptions.agentDir = (mod.getAgentDir as () => string)();
  const loader = new DefaultResourceLoader(loaderOptions);
  await loader.reload?.();
  return { ...sessionOptions, resourceLoader: loader };
}

function exportEvidence(
  session: SdkAgentSessionLike,
  request: AgentRunRequest,
  now: () => string,
  reportsDirOverride: string | undefined,
  diagnostics: string[],
): AgentChildTrace | undefined {
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
    const childTrace: AgentChildTrace = {
      path: realExportedPath,
      format: "pi-session-jsonl",
      childSessionId: session.sessionId,
    };
    diagnostics.push(`JSONL evidence exported: ${realExportedPath}`);
    return childTrace;
  } catch (error) {
    diagnostics.push(`JSONL export failed: ${errorMessage(error)}`);
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

function blockedResult(request: AgentRunRequest, reason: string, diagnostics: string[]): AgentRunResult {
  return {
    status: "blocked",
    agentName: request.agent.name,
    reason,
    diagnostics,
    lifecycleEntryIds: [],
  };
}

function failedResult(
  request: AgentRunRequest,
  reason: string,
  diagnostics: string[] = [reason],
  childOutputStats?: AgentChildOutputStats,
  childSession?: SessionRecord,
): AgentRunResult {
  const result: AgentRunResult = {
    status: "failed",
    agentName: request.agent.name,
    reason,
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
    return message.stopReason === "error"
      ? (eventFieldMessage(message.errorMessage) ?? "Child assistant failed with stopReason=error.")
      : undefined;
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function liveBeginOptions(
  rowId: string | undefined,
  agentName: string,
  live: NonNullable<AgentSdkSessionExecutorOptions["live"]>,
  cwd: string,
): AgentLiveBeginOptions {
  const options: AgentLiveBeginOptions = {
    agentName,
    label: live.label ?? agentName,
    currentPath: cwd,
  };
  if (rowId !== undefined) options.id = rowId;
  if (live.title !== undefined) options.title = live.title;
  if (live.slotKey !== undefined) options.slotKey = live.slotKey;
  if (live.round !== undefined) options.round = live.round;
  if (live.parentRowId !== undefined) options.parentRowId = live.parentRowId;
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
