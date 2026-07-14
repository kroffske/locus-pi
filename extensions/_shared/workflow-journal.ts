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
import { agentLiveStore, type AgentLiveStatus } from "./agent-sdk-host.js";
import { runtimeStateDir } from "./files.js";
import type { WorkflowJournalLine, WorkflowJournalSink, WorkflowLlmUsage } from "./workflow-runtime.js";
import type { WorkflowExecutionSource, WorkflowIdentityCoverage } from "./workflow-script-identity.js";

const RETAINED_COMPLETED_WORKFLOW_RUNS = 5;

// ---------------------------------------------------------------------------
// runId
// ---------------------------------------------------------------------------

/** e.g. "20260614-031200-ab12" — filesystem-safe timestamp + short random hex. */
export function newWorkflowRunId(now?: () => Date): string {
  const d = now !== undefined ? now() : new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const datePart =
    String(d.getUTCFullYear()) +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate());
  const timePart =
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds());
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

// ---------------------------------------------------------------------------
// File-backed journal sink
// ---------------------------------------------------------------------------

export function createWorkflowJournalSink(projectRoot: string, runId: string): WorkflowJournalSink {
  const runDir = workflowRunDir(projectRoot, runId);
  const journalPath = path.join(runDir, "journal.ndjson");
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

export function applyWorkflowJournalLineToAgentLiveStore(line: WorkflowJournalLine): void {
  if (line.kind === "group_start" || line.kind === "group_end") {
    applyGroupLineToAgentLiveStore(line);
    return;
  }
  if (line.kind === "llm_start" || line.kind === "llm_end" || line.kind === "llm_delta") {
    applyLlmLineToAgentLiveStore(line);
    return;
  }
  if (line.agent === undefined) return;
  const id = workflowAgentLiveRowId(line);
  if (line.kind === "agent_start") {
    agentLiveStore.begin({
      id,
      ...(line.groupId !== undefined ? { parentRowId: workflowGroupLiveRowId(line) } : {}),
      agentName: line.agent,
      label: line.label !== undefined ? `${line.agent} (${line.label})` : line.agent,
      ...(line.model !== undefined ? { model: line.model } : {}),
      ...(line.thinking !== undefined ? { thinking: line.thinking } : {}),
      ...(line.slotKey !== undefined ? { slotKey: line.slotKey } : {}),
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.patch(id, { status: "working", startedAt: Date.now() });
  }
  if (line.status === undefined) return;
  const status = workflowStatusToAgentLiveStatus(line.status);
  if (status === undefined) return;
  const current = agentLiveStore.rows.get(id);
  if (current === undefined) return;
  agentLiveStore.patch(id, {
    status,
    ...(line.model !== undefined ? { model: line.model } : {}),
    ...(line.thinking !== undefined ? { thinking: line.thinking } : {}),
    // Slot round on the anchor row (REQ-009): cosmetic while the executor row carries it, but
    // load-bearing in the degraded fallback where no executor row exists (host unavailable).
    ...(line.slotKey !== undefined ? { slotKey: line.slotKey } : {}),
    ...(line.round !== undefined ? { round: line.round } : {}),
    ...(line.worktreePath !== undefined ? { currentPath: line.worktreePath } : {}),
    ...(line.durationMs !== undefined ? { elapsedMs: line.durationMs } : {}),
    ...(status !== "working" ? { currentTools: [] } : {}),
  });
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
export function workflowAgentLiveChildRowId(line: Pick<WorkflowJournalLine, "runId" | "agent" | "label" | "phase">): string {
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
  const retained = new Set((newestFirst.includes(latestCompletedRunId)
    ? [latestCompletedRunId, ...newestFirst.filter((runId) => runId !== latestCompletedRunId)]
    : newestFirst
  ).slice(0, RETAINED_COMPLETED_WORKFLOW_RUNS));
  let removed = 0;
  for (const runId of terminalRunIds) {
    if (!retained.has(runId)) removed += clearWorkflowRunLiveRows(runId);
  }
  return removed;
}

/** Remove every parent/child/group/llm row owned by one retired workflow run. */
export function clearWorkflowRunLiveRows(runId: string): number {
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
  return [...workflowRunLiveRowIds(runId)]
    .map((id) => agentLiveStore.rows.get(id))
    .filter((row) => row !== undefined);
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

/** Stable live-store row id for an llm() node (it has no `agent` field). */
export function llmLiveRowId(line: Pick<WorkflowJournalLine, "runId" | "label" | "phase">): string {
  return `workflow:${line.runId}:llm:${line.label ?? ""}:${line.phase ?? ""}`;
}

export function workflowGroupLiveRowId(line: Pick<WorkflowJournalLine, "runId" | "groupId">): string {
  return `workflow:${line.runId}:group:${line.groupId ?? ""}`;
}

function applyGroupLineToAgentLiveStore(line: WorkflowJournalLine): void {
  if (line.groupId === undefined || line.groupKind === undefined) return;
  const id = workflowGroupLiveRowId(line);
  if (line.kind === "group_start") {
    agentLiveStore.begin({
      id,
      agentName: "workflow-group",
      label: `${line.groupKind} (${line.groupTotal ?? 0})`,
      groupKind: line.groupKind,
      ...(line.groupTotal !== undefined ? { groupTotal: line.groupTotal } : {}),
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.patch(id, { status: "working", startedAt: Date.now() });
    return;
  }
  const status = workflowStatusToAgentLiveStatus(line.status ?? "");
  if (status === undefined || agentLiveStore.rows.get(id) === undefined) return;
  agentLiveStore.patch(id, {
    status,
    ...(line.durationMs !== undefined ? { elapsedMs: line.durationMs } : {}),
    ...(line.groupTotal !== undefined ? { groupTotal: line.groupTotal } : {}),
    ...(line.groupCompleted !== undefined ? { groupCompleted: line.groupCompleted } : {}),
    ...(line.groupFailed !== undefined ? { groupFailed: line.groupFailed } : {}),
  });
}

/** Surface llm() nodes as live rows too (synthetic agentName "llm"); deltas bump stepCount. */
function applyLlmLineToAgentLiveStore(line: WorkflowJournalLine): void {
  const id = llmLiveRowId(line);
  if (line.kind === "llm_start") {
    agentLiveStore.begin({
      id,
      ...(line.groupId !== undefined ? { parentRowId: workflowGroupLiveRowId(line) } : {}),
      agentName: "llm",
      label: line.label !== undefined ? `llm (${line.label})` : "llm",
      ...(line.model !== undefined ? { model: line.model } : {}),
      ...(line.thinking !== undefined ? { thinking: line.thinking } : {}),
      isolated: false,
      noMcp: false,
    });
    agentLiveStore.patch(id, { status: "working", startedAt: Date.now() });
    return;
  }
  if (line.kind === "llm_delta") {
    const row = agentLiveStore.rows.get(id);
    if (row !== undefined) agentLiveStore.patch(id, { stepCount: row.stepCount + 1, lastActivityAt: Date.now() });
    return;
  }
  // llm_end
  const status = workflowStatusToAgentLiveStatus(line.status ?? "");
  if (status === undefined) return;
  if (agentLiveStore.rows.get(id) === undefined) return;
  agentLiveStore.patch(id, {
    status,
    ...(line.model !== undefined ? { model: line.model } : {}),
    ...(line.thinking !== undefined ? { thinking: line.thinking } : {}),
    ...(line.usage !== undefined ? { tokenCount: { input: line.usage.input, output: line.usage.output } } : {}),
    ...(line.durationMs !== undefined ? { elapsedMs: line.durationMs } : {}),
    ...(status !== "working" ? { currentTools: [] } : {}),
  });
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

export type WorkflowRunStatus = "running" | "completed" | "failed" | "unknown";

export interface WorkflowRunSummary {
  runId: string;
  status: WorkflowRunStatus;
  phase: string | null;       // last phase seen
  agentsStarted: number;
  agentsEnded: number;
  llmStarted: number;         // dsl.llm() direct-model calls started
  llmEnded: number;           // dsl.llm() direct-model calls ended
  /** Run-level token/cost budget summed from llm_end usage; null when no llm() reported usage. */
  usage: WorkflowLlmUsage | null;
  errors: number;
  lastKind: string | null;
  lastTs: string | null;      // ISO timestamp of the last journal line
  hasResult: boolean;         // result.json present (run finished writing a result)
}

export interface WorkflowRunResultEnvelope {
  ok?: boolean;
  result?: unknown;
  error?: string;
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
  const journalPath = path.join(runDir, "journal.ndjson");
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

/** Parse a run's journal.ndjson, best-effort (skips malformed lines, never throws). */
export function readWorkflowRunJournal(projectRoot: string, runId: string): WorkflowJournalLine[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(workflowRunDir(projectRoot, runId), "journal.ndjson"), "utf8");
  } catch {
    return [];
  }
  const lines: WorkflowJournalLine[] = [];
  for (const row of raw.split("\n")) {
    const trimmed = row.trim();
    if (trimmed === "") continue;
    try {
      lines.push(JSON.parse(trimmed) as WorkflowJournalLine);
    } catch {
      // skip malformed line
    }
  }
  return lines;
}

/** Read persisted result detail for `/workflows status <runId>`. Best-effort; never throws. */
export function readWorkflowRunResult(projectRoot: string, runId: string): WorkflowRunResultEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(workflowRunDir(projectRoot, runId), "result.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const target = parsePersistedWorkflowTarget(record.target);
    const scriptIdentity = parsePersistedWorkflowScriptIdentity(record.scriptIdentity);
    return {
      ...(typeof record.ok === "boolean" ? { ok: record.ok } : {}),
      ...(Object.prototype.hasOwnProperty.call(record, "result") ? { result: record.result } : {}),
      ...(typeof record.error === "string" ? { error: record.error } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(scriptIdentity !== undefined ? { scriptIdentity } : {}),
    };
  } catch {
    return null;
  }
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
      return snapshotUnavailable("invalid", runId, `Run ${runId} has malformed persisted workflow snapshot identity.`, result.target);
    }
    return snapshotUnavailable("legacy", runId, `Run ${runId} predates retained workflow source snapshots.`, result.target);
  }
  const details = {
    target: result.target,
    path: identity.snapshotPath,
    sha256: identity.scriptSha256,
    identityCoverage: identity.identityCoverage,
  };
  if (identity.schemaVersion !== 2) {
    return snapshotUnavailable("legacy", runId, `Run ${runId} has legacy entry identity but no trusted executed snapshot.`, result.target, details);
  }

  const lexicalProjectRoot = path.resolve(projectRoot);
  const lexicalWorkflowsRoot = path.resolve(workflowsRootDir(lexicalProjectRoot));
  const lexicalRunDir = path.resolve(lexicalWorkflowsRoot, runId);
  const expectedName = `script-${identity.scriptSha256}.workflow.mjs`;
  const lexicalSnapshot = path.resolve(identity.snapshotPath);
  if (path.dirname(lexicalRunDir) !== lexicalWorkflowsRoot
    || path.dirname(lexicalSnapshot) !== lexicalRunDir
    || path.basename(lexicalSnapshot) !== expectedName
    || identity.snapshotPath !== path.join(lexicalRunDir, expectedName)) {
    return snapshotUnavailable("invalid", runId, `Run ${runId} records a snapshot outside its exact run directory or with the wrong hash-derived filename.`, result.target, details);
  }

  try {
    assertNonSymlinkDirectoryChain(lexicalProjectRoot, lexicalRunDir);
  } catch (error) {
    return snapshotUnavailable("invalid", runId, `Run ${runId} snapshot directory is not a regular non-symlink path: ${errorMessage(error)}.`, result.target, details);
  }

  let snapshotStat;
  try {
    snapshotStat = lstatSync(lexicalSnapshot);
  } catch (error) {
    const kind = isMissingFileError(error) ? "missing" : "unreadable";
    return snapshotUnavailable(kind, runId, `Run ${runId} snapshot is ${kind}: ${errorMessage(error)}.`, result.target, details);
  }
  if (snapshotStat.isSymbolicLink() || !snapshotStat.isFile()) {
    return snapshotUnavailable("invalid", runId, `Run ${runId} snapshot is not a regular non-symlink file.`, result.target, details);
  }

  try {
    const physicalProjectRoot = realpathSync(lexicalProjectRoot);
    const physicalRunDir = realpathSync(lexicalRunDir);
    const physicalSnapshot = realpathSync(lexicalSnapshot);
    if (!isContainedPath(physicalProjectRoot, physicalRunDir)
      || path.dirname(physicalSnapshot) !== physicalRunDir
      || path.basename(physicalSnapshot) !== expectedName) {
      return snapshotUnavailable("invalid", runId, `Run ${runId} snapshot escapes its canonical run directory.`, result.target, details);
    }
    const sourceBytes = readFileSync(lexicalSnapshot);
    const actualSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    if (actualSha256 !== identity.scriptSha256) {
      return snapshotUnavailable("tampered", runId, `Run ${runId} snapshot hash mismatch: expected ${identity.scriptSha256}, got ${actualSha256}.`, result.target, details);
    }
    if (result.target === undefined) {
      return snapshotUnavailable("invalid", runId, `Run ${runId} has snapshot identity but no valid persisted workflow target.`, undefined, details);
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
    return snapshotUnavailable("unreadable", runId, `Run ${runId} snapshot could not be read: ${errorMessage(error)}.`, result.target, details);
  }
}

function persistedResultHasScriptIdentity(projectRoot: string, runId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(workflowRunDir(projectRoot, runId), "result.json"), "utf8"));
    return typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      && Object.prototype.hasOwnProperty.call(parsed, "scriptIdentity");
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
    if (identity.identityCoverage !== "self-contained-static" && identity.identityCoverage !== "entry-only") return undefined;
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
  if (identity.schemaVersion !== undefined || [
    "identityPolicy",
    "identityCoverage",
    "executionSource",
    "nodeVersion",
    "platform",
    "arch",
    "builtinImports",
    "unboundDependencies",
  ].some((field) => Object.prototype.hasOwnProperty.call(identity, field))) {
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
export function readWorkflowRoundBody(projectRoot: string, runId: string, slotKey: string, round: number): string[] | undefined {
  const end = readWorkflowRunJournal(projectRoot, runId).find(
    (line) => line.kind === "agent_end" && line.slotKey === slotKey && line.round === round,
  );
  if (end === undefined) return undefined;
  const body = [
    `round ${round} — ${end.agent ?? "agent"}${end.status !== undefined ? ` ${end.status}` : ""}`,
  ];
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
  let llmStarted = 0;
  let llmEnded = 0;
  let errors = 0;
  let usageInput = 0;
  let usageOutput = 0;
  let usageTotal = 0;
  let usageCost = 0;
  let sawUsage = false;
  for (const line of lines) {
    if (line.kind === "phase" && typeof line.phase === "string") phase = line.phase;
    else if (line.kind === "agent_start") agentsStarted += 1;
    else if (line.kind === "agent_end") agentsEnded += 1;
    else if (line.kind === "llm_start") llmStarted += 1;
    else if (line.kind === "llm_end") {
      llmEnded += 1;
      if (line.usage !== undefined && line.usage !== null) {
        sawUsage = true;
        usageInput += line.usage.input;
        usageOutput += line.usage.output;
        usageTotal += line.usage.totalTokens;
        usageCost += line.usage.costTotal;
      }
    }
    else if (line.kind === "error") errors += 1;
  }
  const usage: WorkflowLlmUsage | null = sawUsage
    ? { input: usageInput, output: usageOutput, totalTokens: usageTotal, costTotal: usageCost }
    : null;
  const last = lines.length > 0 ? lines[lines.length - 1] : undefined;

  let status: WorkflowRunStatus;
  if (hasResult) {
    let ok = false;
    try {
      ok = (JSON.parse(readFileSync(resultPath, "utf8")) as { ok?: boolean }).ok === true;
    } catch {
      ok = false;
    }
    status = ok ? "completed" : "failed";
  } else if (lines.length === 0) {
    status = "unknown";
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
    llmStarted,
    llmEnded,
    usage,
    errors,
    lastKind: last?.kind ?? null,
    lastTs: last?.ts ?? null,
    hasResult,
  };
}
