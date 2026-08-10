/**
 * extensions/workflows/run-evidence.ts — Disk-backed run evidence blocks.
 *
 * Reads the persisted workflow run directory (journal, summary, result
 * envelope, retained script snapshot) and renders the bounded operator blocks
 * behind `/workflows status` and `/workflows dashboard`. Works across sessions
 * because every value it shows comes from disk, never from live state.
 */

import type { OperatorBlock } from "../_shared/operator/operator-ui.js";
import { formatWorkflowFailureDiagnosticLines } from "./runtime/workflow-failure.js";
import {
  listWorkflowRunIds,
  readWorkflowRunJournalState,
  readWorkflowRunResult,
  readWorkflowRunScriptSnapshot,
  readWorkflowRunSummary,
  workflowRunDir,
} from "./runtime/workflow-journal.js";
import type { WorkflowRunResultEnvelope } from "./runtime/workflow-journal.js";
import {
  formatWorkflowResultDetail,
  projectWorkflowDisposition,
  type WorkflowDispositionProjection,
} from "./runtime/workflow-result.js";
import type { WorkflowJournalLine } from "./runtime/workflow-runtime.js";
import { compactWorkflowLine, formatOperatorScriptIdentity, workflowStatusTone } from "./operator-ui.js";
import {
  matchWorkflowPhaseGroups,
  staticWorkflowMetaPhases,
  WORKFLOW_SOURCE_LEGEND,
  workflowSourceBadge,
} from "./workflow-catalog.js";

export const WORKFLOW_RPC_STATUS_ROWS = 4;
const WORKFLOW_RPC_DETAIL_EVENT_LIMIT = 1;

export const RUNS_IN_STATUS_LIST = 10;
const WORKFLOW_DETAIL_EVENT_LIMIT = 20;

export function buildRunsListBlock(projectRoot: string, limit: number, compact = false): OperatorBlock {
  const ids = listWorkflowRunIds(projectRoot);
  if (ids.length === 0) {
    return {
      type: "VIEW",
      subject: "Workflow runs",
      primary: "No workflow runs yet.",
      metadata: ["status: ok; total=0 shown=0 older=0", WORKFLOW_SOURCE_LEGEND],
      controls: ['Run one: /workflows run requirements-grill "<your request>"'],
    };
  }
  const shownIds = ids.slice(0, Math.max(0, Math.min(limit, ids.length)));
  const older = ids.length - shownIds.length;
  return {
    type: "VIEW",
    subject: "Workflow runs",
    primary: `Showing ${shownIds.length} newest of ${ids.length} workflow run(s).`,
    body: shownIds.map((runId) => formatRunRow(projectRoot, runId, compact)),
    metadata: [
      WORKFLOW_SOURCE_LEGEND,
      `status: ok; total=${ids.length} shown=${shownIds.length} older=${older}`,
      ...(older > 0 ? [`+${older} older run(s) hidden`] : []),
    ],
    controls: ["Detail: /workflows status <runId>"],
  };
}

function formatRunRow(projectRoot: string, runId: string, compact = false): string {
  const s = readWorkflowRunSummary(projectRoot, runId);
  const journalDiagnostics = readWorkflowRunJournalState(projectRoot, runId).diagnostics.length;
  const source = readWorkflowRunResult(projectRoot, runId)?.target?.source;
  if (compact) {
    // The replayed marker survives compaction: a reader must never see a green
    // row and assume every agent in it actually ran.
    const replayed = s.agentsReplayed > 0 ? ` replayed=${s.agentsReplayed}` : "";
    const corruption = journalDiagnostics > 0 ? ` journal-corrupt=${journalDiagnostics}` : "";
    return compactWorkflowLine(
      `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${s.status} ${runId} phase=${s.phase ?? "-"}${replayed}${corruption}`,
    );
  }
  const parts = [
    `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`}`,
    s.status.padEnd(9),
    runId,
    `phase=${s.phase ?? "-"}`,
    `agents=${s.agentsEnded}/${s.agentsStarted}`,
  ];
  if (s.agentsReplayed > 0) parts.push(`replayed=${s.agentsReplayed}`);
  if (s.usage !== null) parts.push(`tok=${s.usage.totalTokens}`);
  if (s.errors > 0) parts.push(`err=${s.errors}`);
  if (journalDiagnostics > 0) parts.push(`journal-corrupt=${journalDiagnostics}`);
  return parts.join("  ");
}

export function buildRunDetailBlock(projectRoot: string, runId: string, compact = false): OperatorBlock {
  const journalState = readWorkflowRunJournalState(projectRoot, runId);
  const journal = journalState.lines;
  const summary = readWorkflowRunSummary(projectRoot, runId);
  const persisted = readWorkflowRunResult(projectRoot, runId);
  if (journal.length === 0 && !summary.hasResult) {
    return {
      type: "ERROR",
      subject: "Workflow run",
      primary: `Workflow run not found: ${runId}`,
      controls: ["Recovery: /workflows status"],
    };
  }
  const budgetLine =
    summary.usage !== null
      ? `budget: tokens=${summary.usage.totalTokens} (in ${summary.usage.input} / out ${summary.usage.output}) cost=$${summary.usage.costTotal.toFixed(4)}`
      : null;
  // Stated as evidence provenance, not as a performance note: these agents did
  // not run in this run, so this run's green is partly inherited.
  const replayLine =
    summary.agentsReplayed > 0
      ? `replay: ${summary.agentsReplayed}/${summary.agentsEnded} agent call(s) reused a recorded run — not fresh evidence`
      : null;
  const phaseLine = declaredPhaseProgressLine(projectRoot, runId, journal);
  const allJournalLines = renderJournalLines(journal);
  const journalCorruptionLine = journalDiagnosticSummary(journalState.diagnostics);
  const eventLimit = compact ? WORKFLOW_RPC_DETAIL_EVENT_LIMIT : WORKFLOW_DETAIL_EVENT_LIMIT;
  const newestJournalLines = allJournalLines.slice(-eventLimit).reverse();
  const older = Math.max(0, allJournalLines.length - newestJournalLines.length);
  const resultDetail =
    persisted === null
      ? summary.hasResult
        ? "result detail: unavailable (result.json is unreadable)"
        : "result: unavailable (run is in flight or was interrupted)"
      : persisted.error !== undefined
        ? `error: ${persisted.error}`
        : `result: ${formatWorkflowResultDetail(persisted.result)}`;
  const source = persisted?.target?.source;
  const scriptIdentity = persisted?.scriptIdentity;
  // Same actionable failure evidence a live run showed, recovered from the
  // persisted envelope so a later `/workflows status <runId>` reads identically.
  const failureLines =
    persisted?.failureDiagnostic === undefined
      ? []
      : formatWorkflowFailureDiagnosticLines(persisted.failureDiagnostic, { repairRequest: true });
  const compactResult =
    persisted === null
      ? resultDetail
      : persisted.error !== undefined
        ? `error: ${persisted.error}`
        : `result: ${persistedWorkflowDisposition(persisted).summary}`;
  return {
    type: "VIEW",
    subject: "Workflow run",
    primary: compact
      ? compactWorkflowLine(
          `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${runId} · ${summary.status}${summary.phase === null ? "" : ` · phase=${summary.phase}`}`,
        )
      : `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${runId} · ${summary.status}${summary.phase === null ? "" : ` · phase=${summary.phase}`}`,
    badges: [
      { text: `status:${summary.status}`, tone: workflowStatusTone(summary.status) },
      ...(source === undefined ? [] : [{ text: workflowSourceBadge(source).slice(1, -1), tone: "muted" as const }]),
    ],
    body:
      newestJournalLines.length === 0
        ? ["No journal events recorded."]
        : compact
          ? newestJournalLines.map(compactWorkflowLine)
          : newestJournalLines,
    metadata: compact
      ? [
          WORKFLOW_SOURCE_LEGEND,
          ...(journalCorruptionLine === null ? [] : [compactWorkflowLine(journalCorruptionLine)]),
          compactWorkflowLine(`runDir: ${workflowRunDir(projectRoot, runId)}`),
          ...(persisted?.workspaceDir === undefined
            ? []
            : [compactWorkflowLine(`workspaceDir: ${persisted.workspaceDir}`)]),
          ...(scriptIdentity === undefined
            ? []
            : [compactWorkflowLine(formatOperatorScriptIdentity(scriptIdentity, persisted?.target?.ref))]),
          ...(phaseLine === null ? [] : [compactWorkflowLine(phaseLine)]),
          ...(replayLine === null ? [] : [compactWorkflowLine(replayLine)]),
          ...(budgetLine === null ? [] : [compactWorkflowLine(budgetLine)]),
          compactWorkflowLine(compactResult),
          ...failureLines,
          ...(older > 0 ? [`+${older} older journal row(s) hidden`] : []),
        ]
      : [
          WORKFLOW_SOURCE_LEGEND,
          `Source: [R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`}`,
          ...(journalCorruptionLine === null ? [] : [journalCorruptionLine]),
          `runDir: ${workflowRunDir(projectRoot, runId)}`,
          ...(persisted?.workspaceDir === undefined ? [] : [`workspaceDir: ${persisted.workspaceDir}`]),
          ...(scriptIdentity === undefined
            ? []
            : [formatOperatorScriptIdentity(scriptIdentity, persisted?.target?.ref)]),
          ...(phaseLine === null ? [] : [phaseLine]),
          ...(replayLine === null ? [] : [replayLine]),
          ...(budgetLine === null ? [] : [budgetLine]),
          resultDetail,
          ...failureLines,
          ...(older > 0 ? [`+${older} older journal row(s) hidden`] : []),
        ],
    controls: ["Refresh/list: /workflows status · Full artifact: result.json"],
  };
}

function journalDiagnosticSummary(
  diagnostics: ReturnType<typeof readWorkflowRunJournalState>["diagnostics"],
): string | null {
  const first = diagnostics[0];
  if (first === undefined) return null;
  const location = first.lineNumber === null ? "journal" : `line ${first.lineNumber}`;
  return `journal corruption: ${diagnostics.length} row(s); first=${location}: ${first.message}`;
}

/**
 * Declared pipeline versus what the run actually did. The declaration is read
 * from the run's retained script snapshot as inert text — the same bounded AST
 * scan the catalog uses, never an import. Absent when the script declared
 * nothing, so a workflow without `meta.phases` renders exactly as before.
 */
function declaredPhaseProgressLine(
  projectRoot: string,
  runId: string,
  journal: readonly WorkflowJournalLine[],
): string | null {
  const snapshot = readWorkflowRunScriptSnapshot(projectRoot, runId);
  if (snapshot.kind !== "ready") return null;
  const declared = staticWorkflowMetaPhases(snapshot.source);
  if (declared.length === 0) return null;
  const observed = journal
    .filter((line) => line.kind === "phase" && typeof line.phase === "string" && line.phase.trim() !== "")
    .map((line) => line.phase!);
  const groups = matchWorkflowPhaseGroups(declared, observed);
  const reached = groups.filter((group) => group.reached).length;
  const rendered = groups
    .map((group) => `${group.reached ? "[x]" : "[ ]"} ${group.title}${group.declared ? "" : " (undeclared)"}`)
    .join(" · ");
  return `phases: ${reached}/${groups.length} reached — ${rendered}`;
}

function persistedWorkflowDisposition(res: WorkflowRunResultEnvelope): WorkflowDispositionProjection {
  return projectWorkflowDisposition({
    ok: res.ok === true,
    result: res.result,
    ...(res.error !== undefined ? { error: res.error } : {}),
    ...(res.disposition !== undefined ? { disposition: res.disposition } : {}),
  });
}

/** Shared journal-line renderer used by live progress, final result, and status detail. */
function renderJournalLines(journal: readonly WorkflowJournalLine[]): string[] {
  const out: string[] = [];
  for (const line of journal) {
    if (line.kind === "phase") {
      out.push(`  [phase] ${line.phase ?? ""}`);
    } else if (line.kind === "log") {
      const label = line.source === "script" ? "script" : line.source === "runtime" ? "runtime" : "journal";
      out.push(`  [${label}] ${line.message ?? ""}`);
    } else if (line.kind === "agent_start") {
      out.push(
        `  [agent] -> ${line.agent ?? ""}${line.label !== undefined ? ` (${line.label})` : ""}${line.replayed === true ? " [replayed]" : ""}`,
      );
    } else if (line.kind === "agent_end") {
      out.push(
        `  [agent] <- ${line.agent ?? ""} ${line.status ?? ""}${line.durationMs !== undefined ? ` ${line.durationMs}ms` : ""}${line.replayed === true ? " [replayed]" : ""}`,
      );
    } else if (line.kind === "error") {
      out.push(`  [error] ${line.message ?? ""}`);
    }
  }
  return out;
}
