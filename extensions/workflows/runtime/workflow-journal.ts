/**
 * workflow-journal.ts — runId generation + .locus/runtime/workflows/<runId>/ layout
 * + file-backed journal sink (journal.ndjson) + read-side helpers for status views.
 *
 * This is the ONLY filesystem surface of the runtime; keeps workflow-runtime.ts pure.
 * Reuses runtimeStateDir from files.ts.
 */

import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  agentLiveStore,
  type AgentLiveExecutionHandle,
  type AgentLiveStatus,
} from "../../_shared/agent-runtime/agent-sdk-host.js";
import { runtimeStateDir } from "../../_shared/host/files.js";
import { AGENT_FAILURE_CAUSES } from "../../_shared/types.js";
import type {
  WorkflowAgentFailureCause,
  WorkflowJournalLine,
  WorkflowJournalSink,
  WorkflowUsage,
} from "./workflow-runtime.js";
import {
  readWorkflowArtifactRecord,
  WORKFLOW_ARTIFACT_COMPONENT_PATTERN,
  type WorkflowArtifactRef,
} from "./workflow-artifacts.js";
import { parseWorkflowFailureDiagnostic, type WorkflowFailureDiagnostic } from "./workflow-failure.js";
import type { WorkflowExecutionSource, WorkflowIdentityCoverage } from "./workflow-script-identity.js";
import { projectWorkflowDisposition } from "./workflow-result.js";

const RETAINED_COMPLETED_WORKFLOW_RUNS = 5;
const WORKFLOW_ARTIFACT_COMPONENT_REGEX = new RegExp(WORKFLOW_ARTIFACT_COMPONENT_PATTERN, "u");
const WORKFLOW_LIVE_EXECUTIONS_KEY = Symbol.for("locus-pi.workflow-live-executions.v1");

function workflowLiveExecutions(): Map<string, AgentLiveExecutionHandle> {
  const runtimeGlobal = globalThis as unknown as Record<symbol, unknown>;
  const existing = runtimeGlobal[WORKFLOW_LIVE_EXECUTIONS_KEY];
  if (existing instanceof Map) return existing as Map<string, AgentLiveExecutionHandle>;
  const executions = new Map<string, AgentLiveExecutionHandle>();
  Object.defineProperty(runtimeGlobal, WORKFLOW_LIVE_EXECUTIONS_KEY, {
    value: executions,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return executions;
}

/** Active journal writers only; independent from retained live rows. */
export function workflowLiveExecutionCount(): number {
  return workflowLiveExecutions().size;
}

/** Drop process-shared writer authority at a workflow session boundary. */
export function resetWorkflowLiveExecutions(): void {
  workflowLiveExecutions().clear();
}

// ---------------------------------------------------------------------------
// runId
// ---------------------------------------------------------------------------

/** e.g. "20260614-031200-ab12" — filesystem-safe timestamp + short random hex. */
export function newWorkflowRunId(now?: () => Date): string {
  const d = now !== undefined ? now() : new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const datePart = String(d.getUTCFullYear()) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
  const timePart = pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds());
  const rand = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `${datePart}-${timePart}-${rand}`;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function workflowsRootDir(projectRoot: string): string {
  return path.join(runtimeStateDir(projectRoot), "workflows");
}

export function workflowRunDir(projectRoot: string, runId: string): string {
  return path.join(workflowsRootDir(projectRoot), runId);
}

/** The run's append-only journal file — one name, one owner. */
export function workflowJournalFile(runDir: string): string {
  return path.join(runDir, "journal.ndjson");
}

// ---------------------------------------------------------------------------
// File-backed journal sink
// ---------------------------------------------------------------------------

export function createWorkflowJournalSink(projectRoot: string, runId: string): WorkflowJournalSink {
  const runDir = workflowRunDir(projectRoot, runId);
  const journalPath = workflowJournalFile(runDir);
  let dirEnsured = false;

  function ensureDir(): void {
    if (dirEnsured) return;
    try {
      mkdirSync(runDir, { recursive: true });
      dirEnsured = true;
    } catch {
      // If mkdir fails, writes will fail silently below — never throw into the DSL.
    }
  }

  return {
    write(line: WorkflowJournalLine): void {
      try {
        ensureDir();
        appendFileSync(journalPath, JSON.stringify(line) + "\n", "utf8");
      } catch {
        // Never throw into the DSL.
      }
    },
  };
}

/**
 * One synchronous journal-to-live adapter call owns projection, optional replay
 * hydration, and exact writer finalization. Production callers pass projectRoot;
 * callers that omit it cannot verify replay evidence and receive an explicit row diagnostic.
 */
export function applyWorkflowJournalLineToAgentLiveStore(line: WorkflowJournalLine, projectRoot?: string): void {
  if (line.kind === "group_start" || line.kind === "group_end") {
    applyGroupLineToAgentLiveStore(line);
    return;
  }
  if (line.agent === undefined) return;
  if (line.kind === "error" && !hasTerminalCallId(line.callId)) return;
  const id = workflowAgentLiveRowId(line);
  const executionKey = workflowJournalExecutionKey(line);
  if (line.kind === "agent_start") {
    const execution = agentLiveStore.beginExecution({
      id,
      ...(line.groupId !== undefined ? { parentRowId: workflowGroupLiveRowId(line) } : {}),
      workflowRunId: line.runId,
      agentName: line.agent,
      label: line.label !== undefined ? `${line.agent} (${line.label})` : line.agent,
      ...(line.model !== undefined ? { model: line.model } : {}),
      ...(line.thinking !== undefined ? { thinking: line.thinking } : {}),
      ...(line.slotKey !== undefined ? { slotKey: line.slotKey } : {}),
      isolated: false,
      noMcp: false,
    });
    workflowLiveExecutions().set(executionKey, execution);
    agentLiveStore.patchExecution(execution, { status: "working", startedAt: Date.now() });
    return;
  }
  const execution = workflowLiveExecutions().get(executionKey);
  const agentEndStatus =
    line.kind === "agent_end" && line.status !== undefined ? workflowStatusToAgentLiveStatus(line.status) : undefined;
  const terminal = line.kind === "error" || (agentEndStatus !== undefined && isTerminalStatus(agentEndStatus));
  try {
    if (execution === undefined) return;
    const current = agentLiveStore.rowForExecution(execution);
    if (current === undefined) return;
    if (line.kind === "error") {
      const message = line.message?.trim() || "Workflow agent failed without an error message.";
      const patch = {
        status: "error" as const,
        finalAnswer: message,
        errors: current.errors.includes(message) ? current.errors : [...current.errors, message],
        ...(line.durationMs !== undefined ? { elapsedMs: line.durationMs } : {}),
        currentTools: [],
      };
      // The row was opened from `agent_start`, which carries the REQUESTED selector by
      // documented design — the bridge has resolved nothing at that point. A call that
      // failed without ever reporting an `executedModel` never reached a child, so its
      // terminal row must drop that label instead of leaving the request standing where
      // an operator reads it as the model that ran (W7).
      //
      // The mirror case is just as wrong and is why this line carries the model at all:
      // a validator or artifact writer that throws AFTER the child returned is a failure
      // of a call that really executed, and the runtime forwards the readback onto the
      // `error` line for exactly that reason. Clearing there would erase the one piece of
      // evidence the run does own, so the executed value replaces the request instead.
      if (line.executedModel === undefined) agentLiveStore.patchExecutionWithoutModel(execution, patch);
      else
        agentLiveStore.patchExecution(execution, {
          ...patch,
          ...(line.model !== undefined ? { model: line.model } : {}),
          ...(line.thinking !== undefined ? { thinking: line.thinking } : {}),
        });
      return;
    }
    if (line.kind !== "agent_end") return;
    const status = agentEndStatus;
    if (status === undefined) return;
    const replayContextError =
      terminal && line.replayed === true && projectRoot === undefined
        ? "Replayed answer verification context is unavailable."
        : undefined;
    // A terminal call that never reported an executed model never reached a child — a
    // refused tier, a malformed role, a run that died in setup, or a REPLAYED answer for
    // which no child ran at all. Its row still carries the requested selector from
    // `agent_start`, and such an `agent_end` sends no `model` to replace it, so the label
    // has to be dropped rather than left to read as evidence of a run (W7). A call that
    // DID execute keeps its label, including the `unavailable` readback case where the
    // peer named nothing but the child ran.
    //
    // The gate is `executedModel` alone and NOT the status, because a completed call can
    // be just as modelless: a replay is served from a recorded answer with no child and
    // no readback (`workflow-runtime.ts` builds that result without either field), and
    // leaving `done` rows out of the rule let a request stand as a result on the one
    // status an operator is least likely to question.
    const neverExecuted = terminal && line.executedModel === undefined;
    const patch = {
      status,
      // Slot round on the anchor row (REQ-009): cosmetic while the executor row carries it, but
      // load-bearing in the degraded fallback where no executor row exists (host unavailable).
      ...(line.slotKey !== undefined ? { slotKey: line.slotKey } : {}),
      ...(line.round !== undefined ? { round: line.round } : {}),
      ...(line.worktreePath !== undefined ? { currentPath: line.worktreePath } : {}),
      ...(line.durationMs !== undefined ? { elapsedMs: line.durationMs } : {}),
      ...(status !== "working" ? { currentTools: [] } : {}),
      ...(replayContextError !== undefined
        ? {
            errors: current.errors.includes(replayContextError)
              ? current.errors
              : [...current.errors, replayContextError],
          }
        : {}),
    };
    if (neverExecuted) agentLiveStore.patchExecutionWithoutModel(execution, patch);
    else
      agentLiveStore.patchExecution(execution, {
        ...patch,
        ...(line.model !== undefined ? { model: line.model } : {}),
        ...(line.thinking !== undefined ? { thinking: line.thinking } : {}),
      });
    if (terminal && line.replayed === true && projectRoot !== undefined) {
      hydrateWorkflowAgentAnswerArtifact(projectRoot, line, execution);
    }
  } finally {
    if (terminal && execution !== undefined && workflowLiveExecutions().get(executionKey) === execution) {
      workflowLiveExecutions().delete(executionKey);
    }
  }
}

function hasTerminalCallId(callId: string | undefined): callId is string {
  return callId !== undefined && callId.trim() !== "";
}

/** Hydrate one replay while its exact writer is still active. */
function hydrateWorkflowAgentAnswerArtifact(
  projectRoot: string,
  line: WorkflowJournalLine,
  execution: AgentLiveExecutionHandle,
): void {
  const row = agentLiveStore.rowForExecution(execution);
  if (row === undefined) return;
  const ref = line.answerArtifact;
  if (ref === undefined) {
    patchWorkflowArtifactError(execution, row.errors, "Replayed answer artifact is missing from the workflow journal.");
    return;
  }
  if (ref.runId !== line.runId) {
    patchWorkflowArtifactError(execution, row.errors, "Replayed answer artifact belongs to a different workflow run.");
    return;
  }
  const read = readWorkflowArtifactRecord(projectRoot, ref.runId, ref.artifactId);
  if (read.status !== "ready") {
    patchWorkflowArtifactError(execution, row.errors, `Replayed answer artifact is ${read.status}: ${read.message}`);
    return;
  }
  const record = read.record;
  if (
    record.kind !== "answer" ||
    record.provenance !== "replay" ||
    record.name !== ref.name ||
    record.sha256 !== ref.sha256 ||
    (line.callId !== undefined && record.callId !== line.callId)
  ) {
    patchWorkflowArtifactError(
      execution,
      row.errors,
      "Replayed answer artifact metadata does not match the workflow journal.",
    );
    return;
  }
  const finalAnswer = read.bytes.toString("utf8");
  if (finalAnswer.trim() === "") {
    patchWorkflowArtifactError(execution, row.errors, "Replayed answer artifact is empty.");
    return;
  }
  agentLiveStore.patchExecution(execution, {
    finalAnswer,
    resultArtifact: `workflow-artifact:${ref.runId}/${ref.artifactId}#sha256=${ref.sha256}`,
  });
}

function patchWorkflowArtifactError(
  execution: AgentLiveExecutionHandle,
  existingErrors: string[],
  message: string,
): void {
  if (existingErrors.includes(message)) return;
  agentLiveStore.patchExecution(execution, { errors: [...existingErrors, message] });
}

function workflowJournalExecutionKey(
  line: Pick<WorkflowJournalLine, "runId" | "callId" | "agent" | "label" | "phase">,
): string {
  return `${line.runId}\u0000agent:${line.callId ?? workflowAgentLiveRowId(line)}`;
}

function workflowGroupExecutionKey(line: Pick<WorkflowJournalLine, "runId" | "groupId">): string {
  return `${line.runId}\u0000group:${line.groupId ?? ""}`;
}

export function workflowAgentLiveRowId(line: Pick<WorkflowJournalLine, "runId" | "agent" | "label" | "phase">): string {
  return `workflow:${line.runId}:${line.agent ?? ""}:${line.label ?? ""}:${line.phase ?? ""}`;
}

/**
 * Stable live-row id for the executor row of a slotted workflow agent (REQ-009). Distinct
 * from the `workflow:` slot/anchor row so the bridge can reuse THE SAME executor row across
 * loop rounds (round++) while the anchor still collapses via `compactWorkflowParentRows`. The
 * `workflow-agent:` prefix keeps it a leaf (not a `workflow:` parent) so it renders directly.
 */
export function workflowAgentLiveChildRowId(
  line: Pick<WorkflowJournalLine, "runId" | "agent" | "label" | "phase">,
): string {
  return `workflow-agent:${line.runId}:${line.agent ?? ""}:${line.label ?? ""}:${line.phase ?? ""}`;
}

/** Extract the runId from a `workflow:` / `workflow-agent:` live-row id (drill journal lookup); undefined otherwise. */
export function workflowRunIdFromRowId(rowId: string): string | undefined {
  const match = /^workflow(?:-agent)?:([^:]+):/.exec(rowId);
  return match?.[1];
}

/**
 * Keep the just-completed run drillable and retire only older terminal runs.
 * Active runs are never counted toward or removed by this retention bound.
 */
export function pruneCompletedWorkflowRunLiveRows(latestCompletedRunId: string): number {
  const terminalRunIds = workflowLiveRunIds().filter((runId) => {
    const rows = workflowRunLiveRows(runId);
    return rows.length > 0 && rows.every((row) => isTerminalStatus(row.status));
  });
  const newestFirst = terminalRunIds.sort((left, right) => right.localeCompare(left));
  const retained = new Set(
    (newestFirst.includes(latestCompletedRunId)
      ? [latestCompletedRunId, ...newestFirst.filter((runId) => runId !== latestCompletedRunId)]
      : newestFirst
    ).slice(0, RETAINED_COMPLETED_WORKFLOW_RUNS),
  );
  let removed = 0;
  for (const runId of terminalRunIds) {
    if (!retained.has(runId)) removed += clearWorkflowRunLiveRows(runId);
  }
  return removed;
}

/** Remove every parent/child/group row owned by one retired workflow run. */
export function clearWorkflowRunLiveRows(runId: string): number {
  const prefix = `${runId}\u0000`;
  for (const key of workflowLiveExecutions().keys()) {
    if (key.startsWith(prefix)) workflowLiveExecutions().delete(key);
  }
  return agentLiveStore.removeRows(workflowRunLiveRowIds(runId));
}

function workflowRunLiveRowIds(runId: string): Set<string> {
  const parentPrefix = `workflow:${runId}:`;
  const childPrefix = `workflow-agent:${runId}:`;
  const owned = new Set<string>();
  for (const id of agentLiveStore.rows.keys()) {
    if (id.startsWith(parentPrefix) || id.startsWith(childPrefix)) owned.add(id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of agentLiveStore.rows.values()) {
      if (owned.has(row.id) || row.parentRowId === undefined || !owned.has(row.parentRowId)) continue;
      owned.add(row.id);
      changed = true;
    }
  }
  return owned;
}

function workflowRunLiveRows(runId: string) {
  return [...workflowRunLiveRowIds(runId)].map((id) => agentLiveStore.rows.get(id)).filter((row) => row !== undefined);
}

function workflowLiveRunIds(): string[] {
  const runIds = new Set<string>();
  for (const id of agentLiveStore.rows.keys()) {
    const runId = workflowRunIdFromRowId(id);
    if (runId !== undefined) runIds.add(runId);
  }
  return [...runIds];
}

function isTerminalStatus(status: AgentLiveStatus): boolean {
  return status === "done" || status === "cancelled" || status === "error";
}

export function workflowGroupLiveRowId(line: Pick<WorkflowJournalLine, "runId" | "groupId">): string {
  return `workflow:${line.runId}:group:${line.groupId ?? ""}`;
}

function applyGroupLineToAgentLiveStore(line: WorkflowJournalLine): void {
  if (line.groupId === undefined || line.groupKind === undefined) return;
  const id = workflowGroupLiveRowId(line);
  const executionKey = workflowGroupExecutionKey(line);
  if (line.kind === "group_start") {
    const execution = agentLiveStore.beginExecution({
      id,
      workflowRunId: line.runId,
      agentName: "workflow-group",
      label: `${line.groupKind} (${line.groupTotal ?? 0})`,
      groupKind: line.groupKind,
      ...(line.groupTotal !== undefined ? { groupTotal: line.groupTotal } : {}),
      isolated: false,
      noMcp: false,
    });
    workflowLiveExecutions().set(executionKey, execution);
    agentLiveStore.patchExecution(execution, { status: "working", startedAt: Date.now() });
    return;
  }
  const status = workflowStatusToAgentLiveStatus(line.status ?? "");
  if (status === undefined) return;
  const execution = workflowLiveExecutions().get(executionKey);
  try {
    if (execution === undefined || agentLiveStore.rowForExecution(execution) === undefined) return;
    agentLiveStore.patchExecution(execution, {
      status,
      ...(line.durationMs !== undefined ? { elapsedMs: line.durationMs } : {}),
      ...(line.groupTotal !== undefined ? { groupTotal: line.groupTotal } : {}),
      ...(line.groupCompleted !== undefined ? { groupCompleted: line.groupCompleted } : {}),
      ...(line.groupFailed !== undefined ? { groupFailed: line.groupFailed } : {}),
    });
  } finally {
    if (
      execution !== undefined &&
      isTerminalStatus(status) &&
      workflowLiveExecutions().get(executionKey) === execution
    ) {
      workflowLiveExecutions().delete(executionKey);
    }
  }
}

function workflowStatusToAgentLiveStatus(status: string): AgentLiveStatus | undefined {
  switch (status) {
    case "running":
      return "working";
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "blocked":
      return "error";
    case "pending":
      return "queued";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Read side — status / progress views over persisted runs
// ---------------------------------------------------------------------------

export type WorkflowRunStatus = "running" | "completed" | "awaiting_operator" | "cancelled" | "failed" | "unknown";

export interface WorkflowRunSummary {
  runId: string;
  status: WorkflowRunStatus;
  phase: string | null; // last phase seen
  agentsStarted: number;
  agentsEnded: number;
  /** Agent calls served from a recorded run instead of a fresh child (T-109).
   *  A non-zero count means part of this run's evidence is not fresh. */
  agentsReplayed: number;
  /** Run-level token/cost budget summed from agent_end usage; null when no child reported usage. */
  usage: WorkflowUsage | null;
  errors: number;
  lastKind: string | null;
  lastTs: string | null; // ISO timestamp of the last journal line
  hasResult: boolean; // result.json present (run finished writing a result)
}

export interface WorkflowJournalDiagnostic {
  kind: "json" | "structure" | "io";
  lineNumber: number | null;
  message: string;
}

export interface WorkflowJournalRead {
  lines: WorkflowJournalLine[];
  diagnostics: WorkflowJournalDiagnostic[];
}

export interface WorkflowRunResultEnvelope {
  ok?: boolean;
  disposition?: unknown;
  result?: unknown;
  error?: string;
  failureDiagnostic?: WorkflowFailureDiagnostic;
  artifactRefs?: WorkflowArtifactRef[];
  artifactRefsOmitted?: number;
  target?: {
    kind: "name" | "scriptPath";
    ref: string;
    source: "project" | "personal" | "package";
  };
  scriptIdentity?: {
    schemaVersion: 1 | 2;
    identityPolicy: "legacy-unversioned" | "static-node-only-v1";
    sourcePath: string;
    snapshotPath: string;
    scriptSha256: string;
    identityCoverage: WorkflowIdentityCoverage;
    executionSource: WorkflowExecutionSource;
    nodeVersion: string;
    platform: string;
    arch: string;
    builtinImports: string[];
    unboundDependencies: string[];
  };
}

export type WorkflowRunScriptSnapshot =
  | {
      kind: "ready";
      runId: string;
      target: NonNullable<WorkflowRunResultEnvelope["target"]>;
      path: string;
      sha256: string;
      identityCoverage: WorkflowIdentityCoverage;
      source: string;
    }
  | {
      kind: "legacy" | "missing" | "unreadable" | "invalid" | "tampered";
      runId: string;
      target?: WorkflowRunResultEnvelope["target"];
      path?: string;
      sha256?: string;
      identityCoverage?: WorkflowIdentityCoverage;
      message: string;
    };

/** Run ids newest-first, ordered by a proven start timestamp. */
export function listWorkflowRunIds(projectRoot: string): string[] {
  try {
    return readdirSync(workflowsRootDir(projectRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ runId: entry.name, startedAt: workflowRunStartedAt(projectRoot, entry.name) }))
      .filter((entry): entry is { runId: string; startedAt: number } => entry.startedAt !== undefined)
      .sort((left, right) => right.startedAt - left.startedAt || right.runId.localeCompare(left.runId))
      .map((entry) => entry.runId);
  } catch {
    return [];
  }
}

function workflowRunStartedAt(projectRoot: string, runId: string): number | undefined {
  const runDir = workflowRunDir(projectRoot, runId);
  const journalPath = workflowJournalFile(runDir);
  const resultPath = path.join(runDir, "result.json");
  if (!existsSync(journalPath) && !existsSync(resultPath)) return undefined;

  const canonical = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-|$)/u.exec(runId);
  if (canonical !== null) {
    const parsed = Date.parse(
      `${canonical[1]}-${canonical[2]}-${canonical[3]}T${canonical[4]}:${canonical[5]}:${canonical[6]}Z`,
    );
    if (Number.isFinite(parsed)) return parsed;
  }

  for (const line of readWorkflowRunJournal(projectRoot, runId)) {
    const parsed = parseWorkflowTimestamp(line.ts);
    if (parsed !== undefined) return parsed;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(resultPath, "utf8"));
    const journal = (parsed as { journal?: unknown }).journal;
    if (Array.isArray(journal)) {
      for (const line of journal) {
        const timestamp = parseWorkflowTimestamp((line as { ts?: unknown } | null)?.ts);
        if (timestamp !== undefined) return timestamp;
      }
    }
  } catch {
    // A malformed result does not establish run chronology.
  }
  return undefined;
}

function parseWorkflowTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse a run's journal without letting corrupt rows masquerade as complete evidence.
 * Valid rows remain available to compatibility callers; diagnostics retain every
 * JSON, structural, or read failure for status/viewer surfaces.
 */
export function readWorkflowRunJournalState(projectRoot: string, runId: string): WorkflowJournalRead {
  let raw: string;
  try {
    raw = readFileSync(workflowJournalFile(workflowRunDir(projectRoot, runId)), "utf8");
  } catch (error) {
    return {
      lines: [],
      diagnostics: isMissingFileError(error)
        ? []
        : [{ kind: "io", lineNumber: null, message: `Journal could not be read: ${errorMessage(error)}.` }],
    };
  }
  const lines: WorkflowJournalLine[] = [];
  const diagnostics: WorkflowJournalDiagnostic[] = [];
  for (const [index, row] of raw.split("\n").entries()) {
    const trimmed = row.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      diagnostics.push({ kind: "json", lineNumber: index + 1, message: "Invalid JSON." });
      continue;
    }
    const problem = workflowJournalLineProblem(parsed, runId);
    if (problem !== undefined) {
      diagnostics.push({ kind: "structure", lineNumber: index + 1, message: problem });
      continue;
    }
    lines.push(parsed as WorkflowJournalLine);
  }
  return { lines, diagnostics };
}

/** Compatibility projection for callers that only process valid journal events. */
export function readWorkflowRunJournal(projectRoot: string, runId: string): WorkflowJournalLine[] {
  return readWorkflowRunJournalState(projectRoot, runId).lines;
}

function workflowJournalLineProblem(value: unknown, expectedRunId: string): string | undefined {
  if (!isRecord(value)) return "Expected a JSON object.";
  if (typeof value.ts !== "string") return "Field ts must be a string.";
  if (value.runId !== expectedRunId) return `Field runId must equal ${JSON.stringify(expectedRunId)}.`;
  if (!isOneOf(value.kind, ["phase", "log", "group_start", "group_end", "agent_start", "agent_end", "error"])) {
    return "Field kind is not a supported workflow journal event.";
  }

  const eventKind = value.kind;
  const allowedFields = new Set(["ts", "runId", "kind", ...WORKFLOW_JOURNAL_FIELDS_BY_KIND[eventKind]]);
  const unknownField = Object.keys(value).find((field) => !allowedFields.has(field));
  if (unknownField !== undefined) {
    return `Field ${unknownField} is not allowed for ${eventKind} events.`;
  }
  for (const requiredField of WORKFLOW_JOURNAL_REQUIRED_FIELDS_BY_KIND[eventKind]) {
    if (value[requiredField] === undefined) {
      return `Field ${requiredField} is required for ${eventKind} events.`;
    }
  }

  const stringProblem = optionalFieldsProblem(
    value,
    [
      "phase",
      "message",
      "groupId",
      "groupLabel",
      "agent",
      "label",
      "callId",
      "logicalCallId",
      "slotKey",
      "status",
      "childSessionId",
      "resultArtifact",
      "worktreePath",
      "workspaceHandle",
      "model",
      "requestedModel",
      "modelRole",
      "executedModel",
      "modelRoleFallback",
      "thinking",
      "resumeFromRunId",
    ],
    "string",
  );
  if (stringProblem !== undefined) return stringProblem;

  const numberProblem = optionalFieldsProblem(
    value,
    ["groupTotal", "groupCompleted", "groupFailed", "round", "attempt", "attempts", "durationMs"],
    "finite number",
  );
  if (numberProblem !== undefined) return numberProblem;
  if (value.round !== undefined) {
    const round = value.round as number;
    if (!Number.isSafeInteger(round) || round < 1) return "Field round must be a positive safe integer.";
  }
  for (const field of ["attempt", "attempts"] as const) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && (!Number.isSafeInteger(fieldValue) || (fieldValue as number) < 1)) {
      return `Field ${field} must be a positive safe integer.`;
    }
  }
  // The trio is only meaningful together: a lone ordinal has no bound to read it against,
  // an ordinal past its bound describes an attempt that could not have happened, and an
  // ordinal with no logical call named cannot be grouped with its siblings — a reader
  // falling back to (agent, label, phase, group) would merge two `parallel()` calls that
  // agree on all four and attribute one call's discarded attempt to the other.
  if ((value.attempt === undefined) !== (value.attempts === undefined)) {
    return "Fields attempt and attempts must be present together.";
  }
  if ((value.attempt === undefined) !== (value.logicalCallId === undefined)) {
    return "Fields attempt and logicalCallId must be present together.";
  }
  if (value.attempt !== undefined && (value.attempt as number) > (value.attempts as number)) {
    return "Field attempt must not exceed attempts.";
  }
  for (const field of ["groupTotal", "groupCompleted", "groupFailed", "durationMs"] as const) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && (fieldValue as number) < 0) return `Field ${field} must not be negative.`;
  }
  for (const field of ["groupTotal", "groupCompleted", "groupFailed"] as const) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !Number.isSafeInteger(fieldValue)) {
      return `Field ${field} must be a non-negative safe integer.`;
    }
  }

  const booleanProblem = optionalFieldsProblem(value, ["readOnly", "replayed"], "boolean");
  if (booleanProblem !== undefined) return booleanProblem;
  if (value.source !== undefined && !isOneOf(value.source, ["script", "runtime"])) {
    return "Field source must be script or runtime.";
  }
  if (value.groupKind !== undefined && !isOneOf(value.groupKind, ["parallel", "pipeline"])) {
    return "Field groupKind must be parallel or pipeline.";
  }
  if (eventKind === "group_end" && !isOneOf(value.status, ["completed", "failed"])) {
    return "Field status must be completed or failed for group_end events.";
  }
  if (eventKind === "agent_end" && !isOneOf(value.status, ["completed", "failed", "cancelled", "blocked"])) {
    return "Field status is invalid for agent_end events.";
  }
  if (value.failureCause !== undefined && !isOneOf(value.failureCause, AGENT_FAILURE_CAUSE_NAMES)) {
    return "Field failureCause is invalid.";
  }
  if (
    value.permissionMode !== undefined &&
    !isOneOf(value.permissionMode, ["inherit-parent", "agent-defined", "restricted"])
  ) {
    return "Field permissionMode is invalid.";
  }
  if (
    value.workspaceMode !== undefined &&
    !isOneOf(value.workspaceMode, ["project", "worktree", "temporary-worktree"])
  ) {
    return "Field workspaceMode is invalid.";
  }
  if (value.evidenceWarnings !== undefined && !isStringArray(value.evidenceWarnings)) {
    return "Field evidenceWarnings must be an array of strings.";
  }
  if (value.answerArtifact !== undefined && !isArtifactRef(value.answerArtifact))
    return "Field answerArtifact is invalid.";
  if (value.transcriptArtifact !== undefined && !isArtifactRef(value.transcriptArtifact)) {
    return "Field transcriptArtifact is invalid.";
  }
  if (value.resultEnvelopeArtifact !== undefined && !isArtifactRef(value.resultEnvelopeArtifact)) {
    return "Field resultEnvelopeArtifact is invalid.";
  }
  if (value.childTrace !== undefined && !isChildTrace(value.childTrace)) return "Field childTrace is invalid.";
  if (value.schemaValidation !== undefined && !isSchemaValidation(value.schemaValidation)) {
    return "Field schemaValidation is invalid.";
  }
  if (value.usage !== undefined && !isWorkflowUsage(value.usage)) return "Field usage is invalid.";
  if (value.evidence !== undefined && !isEvidenceEvaluation(value.evidence)) return "Field evidence is invalid.";
  if (
    value.resumeSourceRunSummary !== undefined &&
    value.resumeSourceRunSummary !== null &&
    !isWorkflowRunSummary(value.resumeSourceRunSummary)
  ) {
    return "Field resumeSourceRunSummary is invalid.";
  }
  if (value.continuation !== undefined) {
    if (eventKind !== "log" || value.source !== "runtime" || value.message !== "[workflow:continuation]") {
      return "Field continuation is only valid on the canonical runtime continuation log.";
    }
    const continuationProblem = workflowContinuationProblem(value.continuation, expectedRunId);
    if (continuationProblem !== undefined) return continuationProblem;
  } else if (eventKind === "log" && value.message === "[workflow:continuation]") {
    return "Canonical runtime continuation log requires field continuation.";
  }
  return undefined;
}

/**
 * The closed failure-cause list a persisted line is checked against.
 *
 * Read from the one declaration the runtime and the agent envelope also read, so the
 * reader cannot fall behind the writer: a cause added to the list is accepted here the
 * moment it exists, and a second hand-maintained copy can never reject a line the runtime
 * legitimately wrote.
 */
const AGENT_FAILURE_CAUSE_NAMES: readonly WorkflowAgentFailureCause[] = AGENT_FAILURE_CAUSES;

const WORKFLOW_JOURNAL_FIELDS_BY_KIND = {
  phase: ["phase"],
  log: ["source", "phase", "message", "resumeFromRunId", "resumeSourceRunSummary", "continuation"],
  group_start: ["phase", "groupId", "groupKind", "groupLabel", "groupTotal"],
  group_end: [
    "phase",
    "message",
    "status",
    "groupId",
    "groupKind",
    "groupLabel",
    "groupTotal",
    "groupCompleted",
    "groupFailed",
    "durationMs",
  ],
  agent_start: [
    "phase",
    "groupId",
    "groupKind",
    "groupLabel",
    "agent",
    "readOnly",
    "label",
    "callId",
    "attempt",
    "attempts",
    "logicalCallId",
    "slotKey",
    "workspaceHandle",
    "permissionMode",
    "workspaceMode",
    "model",
    "requestedModel",
    "modelRole",
    "thinking",
    "replayed",
  ],
  agent_end: [
    "phase",
    "groupId",
    "groupKind",
    "groupLabel",
    "agent",
    "readOnly",
    "label",
    "callId",
    "attempt",
    "attempts",
    "logicalCallId",
    "answerArtifact",
    "transcriptArtifact",
    "resultEnvelopeArtifact",
    "slotKey",
    "round",
    "status",
    "failureCause",
    "evidence",
    "evidenceWarnings",
    "childSessionId",
    "childTrace",
    "resultArtifact",
    "schemaValidation",
    "durationMs",
    "worktreePath",
    "workspaceHandle",
    "permissionMode",
    "workspaceMode",
    "usage",
    "model",
    "executedModel",
    "modelRoleFallback",
    "thinking",
    "replayed",
  ],
  error: [
    "source",
    "phase",
    "message",
    "groupId",
    "groupKind",
    "groupLabel",
    "agent",
    "label",
    "callId",
    // A failure that THREW never reaches an agent_end, so this line is the call's terminal
    // record and the only place its declared cause — and its place in a retry sequence —
    // can be read without parsing prose. The trio is validated as a trio for every kind,
    // so an ordinal here is still refused without its bound and its logical call.
    "failureCause",
    "attempt",
    "attempts",
    "logicalCallId",
    "durationMs",
    "model",
    "executedModel",
    "modelRoleFallback",
    "thinking",
    // Post-child script/artifact failures use `error` as the sole terminal line.
    // The child already ran, so its usage belongs here just as it does on agent_end.
    "usage",
    "resumeFromRunId",
    "resumeSourceRunSummary",
  ],
} as const satisfies Record<WorkflowJournalLine["kind"], readonly string[]>;

const WORKFLOW_JOURNAL_REQUIRED_FIELDS_BY_KIND = {
  phase: ["phase"],
  log: ["message"],
  group_start: ["groupId", "groupKind", "groupTotal"],
  group_end: ["groupId", "groupKind", "groupTotal", "groupCompleted", "groupFailed", "status"],
  // callId was added after the first persisted journals. Keep those explicit
  // legacy rows readable, while still requiring an agent identity.
  agent_start: ["agent"],
  agent_end: ["agent", "status"],
  error: ["message"],
} as const satisfies Record<WorkflowJournalLine["kind"], readonly string[]>;

function optionalFieldsProblem(
  value: Record<string, unknown>,
  fields: readonly string[],
  expected: "string" | "boolean" | "finite number",
): string | undefined {
  for (const field of fields) {
    const fieldValue = value[field];
    if (fieldValue === undefined) continue;
    const valid =
      expected === "string"
        ? typeof fieldValue === "string"
        : expected === "boolean"
          ? typeof fieldValue === "boolean"
          : typeof fieldValue === "number" && Number.isFinite(fieldValue);
    if (!valid) return `Field ${field} must be ${expected}.`;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isArtifactRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => ["runId", "artifactId", "name", "sha256"].includes(key)) &&
    Object.keys(value).length === 4 &&
    typeof value.runId === "string" &&
    typeof value.artifactId === "string" &&
    typeof value.name === "string" &&
    typeof value.sha256 === "string" &&
    WORKFLOW_ARTIFACT_COMPONENT_REGEX.test(value.runId) &&
    WORKFLOW_ARTIFACT_COMPONENT_REGEX.test(value.artifactId) &&
    WORKFLOW_ARTIFACT_COMPONENT_REGEX.test(value.name) &&
    /^[a-f0-9]{64}$/u.test(value.sha256)
  );
}

function workflowContinuationProblem(value: unknown, currentRunId: string): string | undefined {
  if (!isRecord(value)) return "Field continuation must be an object.";
  if (!hasExactFields(value, ["originRunId", "artifacts"])) {
    return "Field continuation must contain only originRunId and artifacts.";
  }
  if (typeof value.originRunId !== "string" || !WORKFLOW_ARTIFACT_COMPONENT_REGEX.test(value.originRunId)) {
    return "Field continuation.originRunId is invalid.";
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > 8) {
    return "Field continuation.artifacts must contain 1-8 pairs.";
  }
  const identities = new Set<string>();
  for (const pair of value.artifacts) {
    if (!isRecord(pair) || !hasExactFields(pair, ["sourceRef", "consumedRef"])) {
      return "Each continuation artifact must contain only sourceRef and consumedRef.";
    }
    if (!isArtifactRef(pair.sourceRef) || !isArtifactRef(pair.consumedRef)) {
      return "Continuation artifact refs are invalid.";
    }
    const sourceRef = pair.sourceRef as WorkflowArtifactRef;
    const consumedRef = pair.consumedRef as WorkflowArtifactRef;
    if (sourceRef.runId !== value.originRunId) {
      return "Continuation sourceRef does not belong to originRunId.";
    }
    if (consumedRef.runId !== currentRunId) {
      return "Continuation consumedRef does not belong to the current run.";
    }
    if (consumedRef.name !== sourceRef.name || consumedRef.sha256 !== sourceRef.sha256) {
      return "Continuation consumedRef must preserve the sourceRef name and sha256.";
    }
    const identity = `${sourceRef.runId}\u001f${sourceRef.artifactId}`;
    if (identities.has(identity)) return "Continuation contains a duplicate source artifact identity.";
    identities.add(identity);
  }
  return undefined;
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function isChildTrace(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.format === "pi-session-jsonl" &&
    typeof value.childSessionId === "string"
  );
}

function isSchemaValidation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.status, ["valid", "mismatch"]) &&
    typeof value.attempts === "number" &&
    Number.isSafeInteger(value.attempts) &&
    value.attempts >= 0 &&
    isStringArray(value.errors) &&
    // Which authority rejected the answer. Absent on every line written before the
    // script-validation callback existed, and on every schema-only call since.
    (value.source === undefined || isOneOf(value.source, ["schema", "script"]))
  );
}

function isWorkflowUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [value.input, value.output, value.totalTokens, value.costTotal].every(
    (item) => typeof item === "number" && Number.isFinite(item) && item >= 0,
  );
}

function isEvidenceEvaluation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.evidence, [
      "reasoning_only",
      "evidence_backed",
      "missing_expected_evidence",
      "claims_without_evidence",
    ]) &&
    isStringArray(value.warnings) &&
    isStringArray(value.missingRequiredTools) &&
    isStringArray(value.observedTools)
  );
}

function isWorkflowRunSummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.runId === "string" &&
    isOneOf(value.status, ["running", "completed", "awaiting_operator", "cancelled", "failed", "unknown"]) &&
    (value.phase === null || typeof value.phase === "string") &&
    [value.agentsStarted, value.agentsEnded, value.agentsReplayed, value.errors].every(
      (item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0,
    ) &&
    (value.usage === null || isWorkflowUsage(value.usage)) &&
    (value.lastKind === null || typeof value.lastKind === "string") &&
    (value.lastTs === null || typeof value.lastTs === "string") &&
    typeof value.hasResult === "boolean"
  );
}

/**
 * Turn whatever the operator typed into one persisted run id.
 *
 * The chat digest and the live panel head a run with its short suffix
 * (`run #98cc`), so that is usually what an operator has in front of them, while
 * the run list and detail widgets print full ids. Both resolve here, `last` is the
 * newest run, and a full id still resolves exactly. An ambiguous short suffix is refused rather than
 * guessed, because opening the wrong run's evidence is worse than being asked
 * for the full id.
 */
export type WorkflowRunIdResolution =
  | { status: "resolved"; runId: string }
  | { status: "not-found" }
  | { status: "ambiguous"; matched: number; candidates: string[] };

export function resolveWorkflowRunId(projectRoot: string, selector: string): WorkflowRunIdResolution {
  const runIds = listWorkflowRunIds(projectRoot);
  const wanted = selector.trim();
  if (wanted === "" || wanted === "last" || wanted === "latest") {
    const newest = runIds[0];
    return newest === undefined ? { status: "not-found" } : { status: "resolved", runId: newest };
  }
  if (runIds.includes(wanted)) return { status: "resolved", runId: wanted };
  const needle = wanted.replace(/[^a-zA-Z0-9]/gu, "").toLowerCase();
  if (needle === "") return { status: "not-found" };
  const matches = runIds.filter((runId) =>
    runId
      .replace(/[^a-zA-Z0-9]/gu, "")
      .toLowerCase()
      .endsWith(needle),
  );
  if (matches.length === 1) return { status: "resolved", runId: matches[0]! };
  if (matches.length > 1) {
    // The count is the real number of matches; the list is what fits in one
    // message. Reporting the truncated length as the count would read as
    // exhaustive while quietly dropping runs.
    return { status: "ambiguous", matched: matches.length, candidates: matches.slice(0, 5) };
  }
  return { status: "not-found" };
}

export type WorkflowRunResultText =
  { status: "ready"; runId: string; path: string; text: string } | { status: "none"; runId: string; message: string };

/**
 * The whole terminal output of one finished run, read from disk. `result.md` is
 * the verbatim copy a prose run writes; older runs and structured results are
 * recovered from result.json, so a run finished before that file existed still
 * opens. Nothing here is truncated — being readable is the entire point.
 */
export function readWorkflowRunResultText(projectRoot: string, runId: string): WorkflowRunResultText {
  const runDir = workflowRunDir(projectRoot, runId);
  const textPath = path.join(runDir, "result.md");
  try {
    const text = readFileSync(textPath, "utf8");
    if (text.trim() !== "") return { status: "ready", runId, path: textPath, text };
  } catch {
    // No verbatim copy: fall through to the JSON envelope.
  }
  const envelope = readWorkflowRunResult(projectRoot, runId);
  const jsonPath = path.join(runDir, "result.json");
  if (envelope === null) {
    return { status: "none", runId, message: `No persisted result was found for run ${runId}.` };
  }
  if (typeof envelope.result === "string" && envelope.result.trim() !== "") {
    return { status: "ready", runId, path: jsonPath, text: envelope.result };
  }
  if (envelope.result !== undefined) {
    try {
      const json = JSON.stringify(envelope.result, null, 2);
      if (json !== undefined) return { status: "ready", runId, path: jsonPath, text: json };
    } catch {
      // An unserializable persisted value falls through to the error/none paths.
    }
  }
  if (envelope.error !== undefined && envelope.error.trim() !== "") {
    return { status: "ready", runId, path: jsonPath, text: `Run failed: ${envelope.error}` };
  }
  return { status: "none", runId, message: `Run ${runId} persisted no readable result text.` };
}

/** Read persisted result detail for `/workflows status <runId>`. Best-effort; never throws. */
export function readWorkflowRunResult(projectRoot: string, runId: string): WorkflowRunResultEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(workflowRunDir(projectRoot, runId), "result.json"), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const target = parsePersistedWorkflowTarget(record.target);
    const scriptIdentity = parsePersistedWorkflowScriptIdentity(record.scriptIdentity);
    const failureDiagnostic = parseWorkflowFailureDiagnostic(record.failureDiagnostic);
    return {
      ...(typeof record.ok === "boolean" ? { ok: record.ok } : {}),
      ...(Object.prototype.hasOwnProperty.call(record, "disposition") ? { disposition: record.disposition } : {}),
      ...(Object.prototype.hasOwnProperty.call(record, "result") ? { result: record.result } : {}),
      ...(typeof record.error === "string" ? { error: record.error } : {}),
      ...(failureDiagnostic === undefined ? {} : { failureDiagnostic }),
      ...(isArtifactRefArray(record.artifactRefs) ? { artifactRefs: record.artifactRefs } : {}),
      ...(typeof record.artifactRefsOmitted === "number" &&
      Number.isSafeInteger(record.artifactRefsOmitted) &&
      record.artifactRefsOmitted >= 0
        ? { artifactRefsOmitted: record.artifactRefsOmitted }
        : {}),
      ...(target !== undefined ? { target } : {}),
      ...(scriptIdentity !== undefined ? { scriptIdentity } : {}),
    };
  } catch {
    return null;
  }
}

function isArtifactRefArray(value: unknown): value is WorkflowArtifactRef[] {
  return Array.isArray(value) && value.length <= 20 && value.every(isArtifactRef);
}

/**
 * Read only the immutable source snapshot recorded by one exact persisted run.
 * This boundary never consults the current workflow resolver or another file.
 */
export function readWorkflowRunScriptSnapshot(projectRoot: string, runId: string): WorkflowRunScriptSnapshot {
  if (!isSimpleWorkflowRunId(runId)) {
    return snapshotUnavailable("invalid", runId, `Invalid workflow run id: ${JSON.stringify(runId)}.`);
  }

  const result = readWorkflowRunResult(projectRoot, runId);
  if (result === null) {
    return snapshotUnavailable("legacy", runId, `Run ${runId} has no readable persisted result identity.`);
  }
  const identity = result.scriptIdentity;
  if (identity === undefined) {
    if (persistedResultHasScriptIdentity(projectRoot, runId)) {
      return snapshotUnavailable(
        "invalid",
        runId,
        `Run ${runId} has malformed persisted workflow snapshot identity.`,
        result.target,
      );
    }
    return snapshotUnavailable(
      "legacy",
      runId,
      `Run ${runId} predates retained workflow source snapshots.`,
      result.target,
    );
  }
  const details = {
    target: result.target,
    path: identity.snapshotPath,
    sha256: identity.scriptSha256,
    identityCoverage: identity.identityCoverage,
  };
  if (identity.schemaVersion !== 2) {
    return snapshotUnavailable(
      "legacy",
      runId,
      `Run ${runId} has legacy entry identity but no trusted executed snapshot.`,
      result.target,
      details,
    );
  }

  const lexicalProjectRoot = path.resolve(projectRoot);
  const lexicalWorkflowsRoot = path.resolve(workflowsRootDir(lexicalProjectRoot));
  const lexicalRunDir = path.resolve(lexicalWorkflowsRoot, runId);
  const expectedName = `script-${identity.scriptSha256}.workflow.mjs`;
  const lexicalSnapshot = path.resolve(identity.snapshotPath);
  if (
    path.dirname(lexicalRunDir) !== lexicalWorkflowsRoot ||
    path.dirname(lexicalSnapshot) !== lexicalRunDir ||
    path.basename(lexicalSnapshot) !== expectedName ||
    identity.snapshotPath !== path.join(lexicalRunDir, expectedName)
  ) {
    return snapshotUnavailable(
      "invalid",
      runId,
      `Run ${runId} records a snapshot outside its exact run directory or with the wrong hash-derived filename.`,
      result.target,
      details,
    );
  }

  try {
    assertNonSymlinkDirectoryChain(lexicalProjectRoot, lexicalRunDir);
  } catch (error) {
    return snapshotUnavailable(
      "invalid",
      runId,
      `Run ${runId} snapshot directory is not a regular non-symlink path: ${errorMessage(error)}.`,
      result.target,
      details,
    );
  }

  let snapshotStat;
  try {
    snapshotStat = lstatSync(lexicalSnapshot);
  } catch (error) {
    const kind = isMissingFileError(error) ? "missing" : "unreadable";
    return snapshotUnavailable(
      kind,
      runId,
      `Run ${runId} snapshot is ${kind}: ${errorMessage(error)}.`,
      result.target,
      details,
    );
  }
  if (snapshotStat.isSymbolicLink() || !snapshotStat.isFile()) {
    return snapshotUnavailable(
      "invalid",
      runId,
      `Run ${runId} snapshot is not a regular non-symlink file.`,
      result.target,
      details,
    );
  }

  try {
    const physicalProjectRoot = realpathSync(lexicalProjectRoot);
    const physicalRunDir = realpathSync(lexicalRunDir);
    const physicalSnapshot = realpathSync(lexicalSnapshot);
    if (
      !isContainedPath(physicalProjectRoot, physicalRunDir) ||
      path.dirname(physicalSnapshot) !== physicalRunDir ||
      path.basename(physicalSnapshot) !== expectedName
    ) {
      return snapshotUnavailable(
        "invalid",
        runId,
        `Run ${runId} snapshot escapes its canonical run directory.`,
        result.target,
        details,
      );
    }
    const sourceBytes = readFileSync(lexicalSnapshot);
    const actualSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    if (actualSha256 !== identity.scriptSha256) {
      return snapshotUnavailable(
        "tampered",
        runId,
        `Run ${runId} snapshot hash mismatch: expected ${identity.scriptSha256}, got ${actualSha256}.`,
        result.target,
        details,
      );
    }
    if (result.target === undefined) {
      return snapshotUnavailable(
        "invalid",
        runId,
        `Run ${runId} has snapshot identity but no valid persisted workflow target.`,
        undefined,
        details,
      );
    }
    return {
      kind: "ready",
      runId,
      target: result.target,
      path: lexicalSnapshot,
      sha256: identity.scriptSha256,
      identityCoverage: identity.identityCoverage,
      source: sourceBytes.toString("utf8"),
    };
  } catch (error) {
    return snapshotUnavailable(
      "unreadable",
      runId,
      `Run ${runId} snapshot could not be read: ${errorMessage(error)}.`,
      result.target,
      details,
    );
  }
}

function persistedResultHasScriptIdentity(projectRoot: string, runId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(workflowRunDir(projectRoot, runId), "result.json"), "utf8"),
    );
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.prototype.hasOwnProperty.call(parsed, "scriptIdentity")
    );
  } catch {
    return false;
  }
}

function snapshotUnavailable(
  kind: Exclude<WorkflowRunScriptSnapshot["kind"], "ready">,
  runId: string,
  message: string,
  target?: WorkflowRunResultEnvelope["target"],
  details: { path?: string; sha256?: string; identityCoverage?: WorkflowIdentityCoverage } = {},
): WorkflowRunScriptSnapshot {
  return {
    kind,
    runId,
    ...(target !== undefined ? { target } : {}),
    ...(details.path !== undefined ? { path: details.path } : {}),
    ...(details.sha256 !== undefined ? { sha256: details.sha256 } : {}),
    ...(details.identityCoverage !== undefined ? { identityCoverage: details.identityCoverage } : {}),
    message,
  };
}

function isSimpleWorkflowRunId(runId: string): boolean {
  return runId !== "." && runId !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId);
}

function assertNonSymlinkDirectoryChain(projectRoot: string, runDir: string): void {
  const relative = path.relative(projectRoot, runDir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("run directory escapes project root");
  }
  let current = projectRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${current} is not a regular directory`);
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}

function parsePersistedWorkflowScriptIdentity(value: unknown): WorkflowRunResultEnvelope["scriptIdentity"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const identity = value as Record<string, unknown>;
  if (typeof identity.sourcePath !== "string" || identity.sourcePath === "") return undefined;
  if (typeof identity.snapshotPath !== "string" || identity.snapshotPath === "") return undefined;
  if (typeof identity.scriptSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(identity.scriptSha256)) return undefined;
  if (identity.schemaVersion === 2) {
    if (identity.identityPolicy !== "static-node-only-v1") return undefined;
    if (identity.identityCoverage !== "self-contained-static" && identity.identityCoverage !== "entry-only")
      return undefined;
    if (identity.executionSource !== "snapshot" && identity.executionSource !== "source") return undefined;
    if (typeof identity.nodeVersion !== "string" || identity.nodeVersion === "") return undefined;
    if (typeof identity.platform !== "string" || identity.platform === "") return undefined;
    if (typeof identity.arch !== "string" || identity.arch === "") return undefined;
    const builtinImports = parsePersistedStringArray(identity.builtinImports);
    const unboundDependencies = parsePersistedStringArray(identity.unboundDependencies);
    if (builtinImports === undefined || unboundDependencies === undefined) return undefined;
    if (!isSortedUniqueStrings(builtinImports) || builtinImports.some((specifier) => !specifier.startsWith("node:"))) {
      return undefined;
    }
    if (!isSortedUniqueStrings(unboundDependencies)) return undefined;
    if (identity.identityCoverage === "self-contained-static") {
      if (identity.executionSource !== "snapshot" || unboundDependencies.length !== 0) return undefined;
    } else if (identity.executionSource !== "source") {
      return undefined;
    }
    return {
      schemaVersion: 2,
      identityPolicy: identity.identityPolicy,
      sourcePath: identity.sourcePath,
      snapshotPath: identity.snapshotPath,
      scriptSha256: identity.scriptSha256,
      identityCoverage: identity.identityCoverage,
      executionSource: identity.executionSource,
      nodeVersion: identity.nodeVersion,
      platform: identity.platform,
      arch: identity.arch,
      builtinImports,
      unboundDependencies,
    };
  }
  // The only legacy format ever written by the old runner was an unversioned
  // three-field entry identity. Unknown/future versions and partial v2 records
  // must not be silently promoted to trusted legacy evidence.
  if (
    identity.schemaVersion !== undefined ||
    [
      "identityPolicy",
      "identityCoverage",
      "executionSource",
      "nodeVersion",
      "platform",
      "arch",
      "builtinImports",
      "unboundDependencies",
    ].some((field) => Object.prototype.hasOwnProperty.call(identity, field))
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    identityPolicy: "legacy-unversioned",
    sourcePath: identity.sourcePath,
    snapshotPath: identity.snapshotPath,
    scriptSha256: identity.scriptSha256,
    identityCoverage: "entry-only-legacy",
    executionSource: "source",
    nodeVersion: "unknown",
    platform: "unknown",
    arch: "unknown",
    builtinImports: [],
    unboundDependencies: [],
  };
}

function parsePersistedStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) return undefined;
  return [...value] as string[];
}

function isSortedUniqueStrings(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) return false;
  }
  return true;
}

function parsePersistedWorkflowTarget(value: unknown): WorkflowRunResultEnvelope["target"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const target = value as Record<string, unknown>;
  if (target.kind !== "name" && target.kind !== "scriptPath") return undefined;
  if (typeof target.ref !== "string") return undefined;
  if (target.source !== "project" && target.source !== "personal" && target.source !== "package") return undefined;
  return { kind: target.kind, ref: target.ref, source: target.source };
}

/**
 * Completed rounds recorded for a slot (REQ-009), ascending, de-duplicated. Rounds live on
 * `agent_end` lines carrying `(slotKey, round)`; an in-flight round (agent_start only) is
 * absent here and shown from the live store instead. An OLD journal without these fields
 * yields `[]` — the drill then hides the rounds submenu. Never throws.
 */
export function listWorkflowRoundsForSlot(projectRoot: string, runId: string, slotKey: string): number[] {
  const rounds = new Set<number>();
  for (const line of readWorkflowRunJournal(projectRoot, runId)) {
    if (line.slotKey === slotKey && typeof line.round === "number") rounds.add(line.round);
  }
  return [...rounds].sort((a, b) => a - b);
}

/**
 * Lazily read a past round's body for the drill submenu (REQ-009): a compact summary of the
 * `agent_end` record for `(slotKey, round)` — the journal is what persists across the run, so a
 * past round shows its recorded status/model/duration/tokens, not a re-hydrated transcript.
 * Returns undefined when no matching record exists (old journal / unknown round). Never throws.
 */
export function readWorkflowRoundBody(
  projectRoot: string,
  runId: string,
  slotKey: string,
  round: number,
): string[] | undefined {
  const end = readWorkflowRunJournal(projectRoot, runId).find(
    (line) => line.kind === "agent_end" && line.slotKey === slotKey && line.round === round,
  );
  if (end === undefined) return undefined;
  const body = [`round ${round} — ${end.agent ?? "agent"}${end.status !== undefined ? ` ${end.status}` : ""}`];
  const meta = [
    ...(end.phase !== undefined ? [`phase ${end.phase}`] : []),
    ...(end.model !== undefined ? [`${end.model}${end.thinking !== undefined ? ` ${end.thinking}` : ""}`] : []),
    ...(end.durationMs !== undefined ? [`${end.durationMs}ms`] : []),
  ];
  if (meta.length > 0) body.push(meta.join(" · "));
  if (end.usage !== undefined) body.push(`tokens in ${end.usage.input} / out ${end.usage.output}`);
  if (end.label !== undefined) body.push(`label: ${end.label}`);
  body.push(`(from run journal — round record ${round})`);
  return body;
}

/** Summarize one run from its journal + result.json. Best-effort; never throws. */
export function readWorkflowRunSummary(projectRoot: string, runId: string): WorkflowRunSummary {
  const resultPath = path.join(workflowRunDir(projectRoot, runId), "result.json");
  const hasResult = existsSync(resultPath);
  const lines = readWorkflowRunJournal(projectRoot, runId);

  let phase: string | null = null;
  let agentsStarted = 0;
  let agentsEnded = 0;
  let agentsReplayed = 0;
  let errors = 0;
  let sawCancellation = false;
  let usageInput = 0;
  let usageOutput = 0;
  let usageTotal = 0;
  let usageCost = 0;
  let sawUsage = false;
  for (const line of lines) {
    if (line.kind === "phase" && typeof line.phase === "string") phase = line.phase;
    else if (line.kind === "agent_start") agentsStarted += 1;
    else if (line.kind === "agent_end") {
      agentsEnded += 1;
      // Only an explicit marker counts. Replay is never inferred from a missing
      // duration, a zero token count, or any other side effect of not running.
      if (line.replayed === true) agentsReplayed += 1;
    } else if (line.kind === "error") errors += 1;
    else if (
      line.kind === "log" &&
      line.source === "runtime" &&
      typeof line.message === "string" &&
      line.message.startsWith("[workflow:cancelled]")
    ) {
      sawCancellation = true;
    }
    // A child normally reports usage on agent_end. When script validation or
    // artifact adoption throws after the child answered, `error` is the sole
    // terminal line and carries the same spend instead.
    if ((line.kind === "agent_end" || line.kind === "error") && line.usage !== undefined) {
      sawUsage = true;
      usageInput += line.usage.input;
      usageOutput += line.usage.output;
      usageTotal += line.usage.totalTokens;
      usageCost += line.usage.costTotal;
    }
  }
  const usage: WorkflowUsage | null = sawUsage
    ? { input: usageInput, output: usageOutput, totalTokens: usageTotal, costTotal: usageCost }
    : null;
  const last = lines.length > 0 ? lines[lines.length - 1] : undefined;

  let status: WorkflowRunStatus;
  if (hasResult) {
    const persisted = readWorkflowRunResult(projectRoot, runId);
    status =
      persisted === null
        ? "unknown"
        : projectWorkflowDisposition({
            ok: persisted.ok === true,
            result: persisted.result,
            ...(persisted.error !== undefined ? { error: persisted.error } : {}),
            ...(persisted.disposition !== undefined ? { disposition: persisted.disposition } : {}),
          }).status;
  } else if (lines.length === 0) {
    status = "unknown";
  } else if (sawCancellation) {
    status = "cancelled";
  } else if (errors > 0) {
    status = "failed";
  } else {
    status = "running";
  }

  return {
    runId,
    status,
    phase,
    agentsStarted,
    agentsEnded,
    agentsReplayed,
    usage,
    errors,
    lastKind: last?.kind ?? null,
    lastTs: last?.ts ?? null,
    hasResult,
  };
}
