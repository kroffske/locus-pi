import type { CustomUiComponent, ExtensionContext, WidgetFactoryTui } from "../_shared/host/pi-api.js";
import { agentLiveStore, type AgentLiveRow, type AgentLiveStatus } from "../_shared/agent-runtime/agent-sdk-host.js";
import {
  AgentLivePanel,
  AGENT_LIVE_SPINNER_FRAME_COUNT,
  elapsedSinceStart,
  formatAgentIdentity,
  formatDuration,
  orderAgentLiveRows,
  selectAgentLiveRowsForParents,
  truncate,
} from "../_shared/agent-runtime/agent-live-panel.js";
import { fleetMenuState, renderFleetMenuRows, selectFleetMenuLeafRows } from "../_shared/agent-runtime/fleet-menu.js";
import { formatWorkflowFailureDiagnosticLines, type WorkflowFailureDiagnostic } from "./runtime/workflow-failure.js";
import { workflowAgentLiveRowId, workflowGroupLiveRowId } from "./runtime/workflow-journal.js";
import {
  projectWorkflowDisposition,
  type WorkflowDisposition,
  type WorkflowProjectedStatus,
  type WorkflowResultPersistence,
} from "./runtime/workflow-result.js";
import { FLEET_MENU_PLACEMENT } from "../_shared/operator/widget-render.js";
import type { WorkflowJournalLine } from "./runtime/workflow-runtime.js";

export interface ThemeLike {
  fg?: (color: string, text: string) => string;
  bold?: (s: string) => string;
}

export function coerceTheme(t: unknown): ThemeLike {
  if (typeof t !== "object" || t === null) return {};
  const theme = t as { fg?: unknown; bold?: unknown };
  const result: ThemeLike = {};
  if (typeof theme.fg === "function") {
    const fg = theme.fg as (this: unknown, color: string, text: string) => unknown;
    result.fg = (color: string, text: string) => String(fg.call(theme, color, text));
  }
  if (typeof theme.bold === "function") {
    const bold = theme.bold as (this: unknown, s: string) => unknown;
    result.bold = (s: string) => String(bold.call(theme, s));
  }
  return result;
}

export const WORKFLOW_LIVE_WIDGET_KEY = "workflows-live";

const LIVE_TICK_MS = 1000;
const NOOP_TUI: WidgetFactoryTui = { requestRender: () => {} };
const OBSERVER_ROW_LIMIT = 2;
const OBSERVER_EVENT_DIGEST_LIMIT = 5;
const OBSERVER_EVENT_DIGEST_CHAR_LIMIT = 120;
const OBSERVER_STATUS_ORDER: Record<AgentLiveStatus, number> = {
  working: 0,
  queued: 1,
  done: 2,
  cancelled: 3,
  error: 4,
};

export interface WorkflowProgressOptions {
  scope?: "fleet" | "workflow";
  /** Statically declared stages (`meta.phases`): titles plus their planned detail. */
  declaredStages?: readonly WorkflowDeclaredStage[];
}

/** One stage a workflow declared before the run started. */
export interface WorkflowDeclaredStage {
  title: string;
  detail?: string;
}

export class WorkflowProgressComponent implements CustomUiComponent {
  journal: WorkflowJournalLine[] = [];
  done?: {
    status: WorkflowProjectedStatus;
    summary: string;
    runDir?: string;
    resultTextPath?: string;
    resultPersistence?: WorkflowResultPersistence;
    failureDiagnostic?: WorkflowFailureDiagnostic;
  };
  #tickTimer: ReturnType<typeof setInterval> | undefined;
  #spinnerIndex = 0;
  #disposed = false;
  readonly #knownRowIds = new Set<string>();
  readonly #onStoreChange = () => {
    this.#syncLiveTimer();
    this.tui.requestRender();
  };

  constructor(
    public tui: WidgetFactoryTui,
    public theme: ThemeLike,
    readonly scriptRef: string,
    readonly runId: string,
    readonly options: WorkflowProgressOptions = {},
  ) {
    agentLiveStore.emitter.on("change", this.#onStoreChange);
    this.#syncLiveTimer();
  }

  attachTui(tui: WidgetFactoryTui): void {
    this.tui = tui;
    this.#syncLiveTimer();
  }

  invalidate(): void {
    // Pi invalidates render/theme cache without disposing live progress state.
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    agentLiveStore.emitter.off("change", this.#onStoreChange);
    this.#stopLiveTimer();
  }

  push(line: WorkflowJournalLine): void {
    this.journal.push(line);
    if (line.agent !== undefined) this.#knownRowIds.add(workflowAgentLiveRowId(line));
    else if (line.kind === "group_start" || line.kind === "group_end") {
      this.#knownRowIds.add(workflowGroupLiveRowId(line));
    }
    this.#syncLiveTimer();
    this.tui.requestRender();
  }

  finish(res: {
    ok: boolean;
    error?: string;
    result?: unknown;
    disposition?: WorkflowDisposition;
    runDir?: string;
    resultTextPath?: string;
    resultPersistence?: WorkflowResultPersistence;
    failureDiagnostic?: WorkflowFailureDiagnostic;
  }): void {
    const disposition = projectWorkflowDisposition({
      ok: res.ok,
      result: res.result,
      ...(res.error !== undefined ? { error: res.error } : {}),
      ...(res.disposition !== undefined ? { disposition: res.disposition } : {}),
    });
    this.done = {
      status: disposition.status,
      summary: disposition.summary,
      ...(res.runDir !== undefined ? { runDir: res.runDir } : {}),
      ...(res.resultTextPath !== undefined ? { resultTextPath: res.resultTextPath } : {}),
      ...(res.resultPersistence !== undefined ? { resultPersistence: res.resultPersistence } : {}),
      ...(res.failureDiagnostic !== undefined ? { failureDiagnostic: res.failureDiagnostic } : {}),
    };
    this.dispose();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const rows = this.tui.terminal?.rows ?? 24;
    const budget = Math.max(1, Math.min(rows - 6, 24));
    const liveRows = this.visibleRows();
    const doneLines = this.doneLines(width);
    const header = this.renderHeader(width, liveRows);
    if (this.options.scope !== "workflow") {
      const fleetLines = renderFleetMenuRows(liveRows, width, {
        spinnerIndex: this.#spinnerIndex,
        theme: this.theme,
        emptyEditorFocusAvailable: fleetMenuState.emptyEditorFocusAvailable,
        fallbackFocusAvailable: fleetMenuState.fallbackFocusAvailable,
      });
      const fleetFooter = fleetLines.at(-1);
      const fleetBody = fleetFooter === undefined ? [] : fleetLines.slice(0, -1);
      const fixedLines = [header, ...fleetBody, ...doneLines];
      const tailLines = this.progressTailLines(width);
      if (fleetFooter === undefined) return fitLines(fixedLines, tailLines, budget, width, doneLines.length);
      return [...fitLines(fixedLines, tailLines, Math.max(0, budget - 1), width, doneLines.length), fleetFooter];
    }

    const stageLine = [this.renderStageFrontier(width)];
    const passiveDiagnostics = this.journal
      .filter(
        (line) =>
          line.kind === "error" ||
          (line.kind === "agent_end" && line.evidenceWarnings !== undefined && line.evidenceWarnings.length > 0),
      )
      .slice(-2)
      .map((line) => truncate(formatProgressTailLine(line), width));
    const hint = truncate("  /ps inspect agents", width);
    // The roster owns the variable-height middle: fixed lines (header, stages,
    // verdict, diagnostics, hint) are reserved first, so the roster clamps itself
    // instead of pushing the verdict off a short terminal.
    const fixedCount = 1 + stageLine.length + doneLines.length + passiveDiagnostics.length + 1;
    const rowLines = this.renderRoster(liveRows, width, Math.max(1, budget - fixedCount));
    const body = [header, ...stageLine, ...rowLines, ...doneLines];
    return [...fitLines(body, passiveDiagnostics, Math.max(0, budget - 1), width, doneLines.length), hint];
  }

  private progressTailLines(width: number): string[] {
    return this.journal
      .filter(
        (line) =>
          line.kind === "log" ||
          line.kind === "error" ||
          (line.kind === "agent_end" && line.evidenceWarnings !== undefined && line.evidenceWarnings.length > 0),
      )
      .slice(-3)
      .map((line) => truncate(formatProgressTailLine(line), width));
  }

  private visibleRows(): AgentLiveRow[] {
    const all = [...agentLiveStore.rows.values()];
    if (this.#knownRowIds.size > 0) {
      return compactWorkflowParentRows(selectAgentLiveRowsForParents(all, this.#knownRowIds));
    }
    if (this.options.scope !== "workflow") return compactWorkflowParentRows(all);
    const prefix = `workflow:${this.runId}:`;
    const scopedParentIds = new Set(all.filter((row) => row.id.startsWith(prefix)).map((row) => row.id));
    const scoped = all.filter(
      (row) => row.id.startsWith(prefix) || (row.parentRowId !== undefined && scopedParentIds.has(row.parentRowId)),
    );
    return compactWorkflowParentRows(scoped);
  }

  private renderHeader(width: number, rows: AgentLiveRow[]): string {
    const headerStatus: WorkflowProjectedStatus | "running" = this.done?.status ?? "running";
    const headerLabel = workflowProgressStatusLabel(headerStatus);
    if (this.options.scope !== "workflow") {
      const counts = countAgentLiveStatuses(rows);
      const phase = currentWorkflowPhase(this.journal);
      const terminalCount = counts.done + counts.cancelled + counts.error;
      const cancelledText = counts.cancelled > 0 ? ` cancelled=${counts.cancelled}` : "";
      const failedText = counts.error > 0 ? ` failed=${counts.error}` : "";
      const replayedCount = this.journal.filter((line) => line.kind === "agent_end" && line.replayed === true).length;
      const replayedText = replayedCount > 0 ? ` replayed=${replayedCount}` : "";
      const text = `workflow ${this.scriptRef} (${this.runId}) - ${headerLabel} phase=${phase ?? "not-set"} active=${counts.working} done=${terminalCount}/${rows.length}${cancelledText}${failedText}${replayedText}`;
      return this.#bold(truncate(text, width));
    }
    const statusMark = workflowProgressStatusMark(headerStatus);
    const frontier = workflowStageFrontier(this.options.declaredStages ?? [], this.journal);
    const progress =
      this.options.scope === "workflow" && frontier.length > 0
        ? `  ${frontier.filter((stage) => stage.state !== "declared").length}/${frontier.length}`
        : "";
    const replayedCount = this.journal.filter((line) => line.kind === "agent_end" && line.replayed === true).length;
    const replayedText = replayedCount > 0 ? `  replayed=${replayedCount}` : "";
    const runSuffix = shortWorkflowRunId(this.runId);
    const owner = `workflow ${this.scriptRef} #${runSuffix}`;
    const text = `agents · ${owner}  ${statusMark} ${headerLabel}${progress}${replayedText}`;
    return this.#bold(truncate(text, width));
  }

  private renderStageFrontier(width: number): string {
    const stages = workflowStageFrontier(this.options.declaredStages ?? [], this.journal);
    if (stages.length === 0) return this.#fg("dim", truncate("stages · none declared", width));
    const full = `stages · ${stages.map((stage) => `${stage.title} (${stage.state})`).join(" — ")}`;
    if (full.length <= width) return full;
    const current = stages.find((stage) => stage.state === "current");
    const reached = stages.filter((stage) => stage.state === "reached").length;
    const declared = stages.filter((stage) => stage.state === "declared").length;
    if (current === undefined) return truncate(`stages · reached ${reached} · declared ${declared}`, width);
    const suffix = ` · reached ${reached} · declared ${declared}`;
    const currentLine = `stages · current ${current.title}`;
    return currentLine.length + suffix.length <= width ? `${currentLine}${suffix}` : truncate(currentLine, width);
  }

  /**
   * The full agent roster for this run, in the order the run produced it:
   * finished agents (`✓`, green), the agent working right now (its spinner, in
   * `warning` so it reads apart from settled rows), then every declared stage the
   * run has not reached yet (`○`, dim) with the detail `meta.phases` planned for
   * it. A re-entered slot keeps ONE row and carries its `r<N>` round badge, so a
   * loop updates a row instead of appending a duplicate.
   */
  private renderRoster(rows: AgentLiveRow[], width: number, budget: number): string[] {
    const leaves = selectFleetMenuLeafRows(orderAgentLiveRows(rows));
    const current =
      leaves.find((row) => row.status === "working") ?? leaves.find((row) => row.status === "queued") ?? leaves.at(-1);
    const rowWidth = Math.max(1, width - 2);
    const panel = new AgentLivePanel({
      spinnerIndex: this.#spinnerIndex,
      theme: this.theme,
      statusColors: { working: "warning" },
    });
    // Only the current row keeps its sub-lines (latest message / live tool action);
    // settled rows stay one line each so the roster fits a short terminal.
    const agentLines = leaves.map((row) => ({
      settled: row !== current,
      lines: (row === current ? panel.renderRows([row], rowWidth) : [panel.renderRow(row, rowWidth)]).map(
        (line) => `  ${line}`,
      ),
    }));
    const pendingLines = this.pendingStageLines(width).map((line) => ({ settled: false, lines: [line] }));
    const roster = [...agentLines, ...pendingLines];
    if (roster.length === 0) return [this.#fg("dim", truncate("  waiting for workflow agents…", width))];
    return clampRosterLines(roster, budget, width);
  }

  /**
   * Declared stages the run has not reached yet — the work still ahead. Titles
   * come from `meta.phases`, so an undeclared dynamic stage never appears here
   * before it actually runs.
   */
  private pendingStageLines(width: number): string[] {
    const declared = new Map(
      (this.options.declaredStages ?? []).flatMap((stage) => {
        const title = normalizeWorkflowPhase(stage.title);
        return title === undefined ? [] : [[title, stage.detail] as const];
      }),
    );
    return workflowStageFrontier(this.options.declaredStages ?? [], this.journal)
      .filter((stage) => stage.state === "declared")
      .map((stage) => {
        const detail = normalizeWorkflowPhase(declared.get(stage.title));
        const text = `  ○ ${stage.title}  ·  planned${detail === undefined ? "" : `  ·  ${detail}`}`;
        return this.#fg("dim", truncate(text, width));
      });
  }

  private doneLines(width: number): string[] {
    if (this.done === undefined) return [];
    const lines: string[] = [];
    const presentation = workflowProgressDonePresentation(this.done.status);
    lines.push(this.#fg(presentation.color, truncate(`${presentation.marker} ${this.done.summary}`, width)));
    if (this.done.resultPersistence?.ok === false) {
      lines.push(this.#fg("warning", truncate(`persistence: ${this.done.resultPersistence.code}`, width)));
    }
    // A failed run says WHERE it broke and WHAT to hand a repairing agent; the
    // `copy:` line is one selectable line, never wrapped or abbreviated.
    if (this.done.failureDiagnostic !== undefined) {
      for (const line of formatWorkflowFailureDiagnosticLines(this.done.failureDiagnostic)) {
        lines.push(this.#fg("dim", truncate(line, width)));
      }
    }
    // The verdict line above is clipped to the terminal width, so a run whose
    // result is prose needs one line saying where the whole text is and the one
    // command that opens it.
    // Gated on the same fact the digest uses: a readable text copy exists. A run
    // that produced none must not be told to go and read one.
    if (this.done.resultTextPath !== undefined) {
      const command = `read the full result: /workflows result ${shortWorkflowRunId(this.runId)}`;
      lines.push(this.#fg("dim", truncate(command, width)));
      lines.push(this.#fg("dim", truncate(`result: ${this.done.resultTextPath}`, width)));
    } else if (this.done.status !== "completed") {
      // Same rule for the run that ended badly with no prose result: the clipped
      // verdict line above is all the operator got, and the reason lives in the
      // structured result that only this command prints.
      const command = `read the full reason: /workflows status ${shortWorkflowRunId(this.runId)}`;
      lines.push(this.#fg("dim", truncate(command, width)));
    }
    // Honest pointer to the saved run on disk (T-188 W5, fix-candidate #8).
    if (this.done.runDir !== undefined) lines.push(this.#fg("dim", truncate(`saved: ${this.done.runDir}`, width)));
    return lines;
  }

  #syncLiveTimer(): void {
    if (this.#disposed || this.done !== undefined) {
      this.#stopLiveTimer();
      return;
    }
    if (this.visibleRows().some((row) => row.status === "working")) this.#startLiveTimer();
    else this.#stopLiveTimer();
  }

  #startLiveTimer(): void {
    if (this.#disposed || this.#tickTimer !== undefined) return;
    const timer = setInterval(() => {
      if (this.#disposed || this.done !== undefined || !this.visibleRows().some((row) => row.status === "working")) {
        this.#stopLiveTimer();
        return;
      }
      this.#spinnerIndex = (this.#spinnerIndex + 1) % AGENT_LIVE_SPINNER_FRAME_COUNT;
      this.tui.requestRender();
    }, LIVE_TICK_MS);
    (timer as { unref?: () => void }).unref?.();
    this.#tickTimer = timer;
  }

  #stopLiveTimer(): void {
    if (this.#tickTimer === undefined) return;
    clearInterval(this.#tickTimer);
    this.#tickTimer = undefined;
  }

  #fg(color: string, text: string): string {
    return this.theme.fg ? this.theme.fg(color, text) : text;
  }

  #bold(text: string): string {
    return this.theme.bold ? this.theme.bold(text) : text;
  }
}

function workflowProgressStatusMark(status: WorkflowProjectedStatus | "running"): string {
  switch (status) {
    case "running":
      return "●";
    case "completed":
      return "✓";
    case "awaiting_operator":
      return "◐";
    case "cancelled":
      return "⊘";
    case "failed":
      return "✗";
    case "unknown":
      return "■";
    default:
      return assertNever(status);
  }
}

function workflowProgressStatusLabel(status: WorkflowProjectedStatus | "running"): string {
  switch (status) {
    case "running":
      return "RUNNING";
    case "completed":
      return "OK";
    case "awaiting_operator":
      return "AWAITING OPERATOR";
    case "cancelled":
      return "CANCELLED";
    case "failed":
      return "FAILED";
    case "unknown":
      return "UNKNOWN";
    default:
      return assertNever(status);
  }
}

function workflowProgressDonePresentation(status: WorkflowProjectedStatus): {
  marker: string;
  color: "success" | "warning" | "error";
} {
  switch (status) {
    case "completed":
      return { marker: "✓", color: "success" };
    case "awaiting_operator":
      return { marker: "◐", color: "warning" };
    case "cancelled":
      return { marker: "⊘", color: "warning" };
    case "failed":
      return { marker: "✗", color: "error" };
    case "unknown":
      return { marker: "■", color: "warning" };
    default:
      return assertNever(status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled workflow progress status: ${String(value)}`);
}

function formatProgressTailLine(line: WorkflowJournalLine): string {
  if (line.kind === "agent_end") {
    const warnings = line.evidenceWarnings?.filter((warning) => warning.trim() !== "") ?? [];
    const suffix = warnings.length > 0 ? ` evidenceWarnings=${warnings.join("; ")}` : "";
    return `  agent_end: ${line.agent ?? ""} ${line.status ?? ""}${suffix}`;
  }
  if (line.kind === "log") {
    if (line.source === "script") return `│ script · ${line.message ?? ""}`;
    if (line.source === "runtime") return `│ runtime · ${line.message ?? ""}`;
    return `│ journal · ${line.message ?? ""}`;
  }
  return `  ${line.kind}: ${line.message ?? ""}`;
}

export class WorkflowTextComponent implements CustomUiComponent {
  constructor(
    public tui: WidgetFactoryTui,
    public theme: ThemeLike,
    readonly content: string,
  ) {}

  attachTui(tui: WidgetFactoryTui): void {
    this.tui = tui;
  }

  invalidate(): void {
    // Static text widget owns no timers or external handles.
  }

  render(width: number): string[] {
    const rows = this.tui.terminal?.rows ?? 24;
    const budget = Math.max(1, Math.min(rows - 6, 48));
    const lines = this.content.split(/\r?\n/).map((line) => truncate(line, width));
    if (lines.length <= budget) return lines;
    const visible = lines.slice(0, Math.max(0, budget - 1));
    return [...visible, truncate(`(+${lines.length - visible.length} more)`, width)];
  }
}

export function installWorkflowTextWidget(ctx: ExtensionContext, key: string, content: string): WorkflowTextComponent {
  const component = new WorkflowTextComponent(NOOP_TUI, coerceTheme(undefined), content);
  if (ctx.hasUI === true) {
    if (ctx.mode !== "tui") {
      ctx.ui.setWidget(key, component.render(80), { placement: "belowEditor" });
      return component;
    }
    try {
      ctx.ui?.setWidget?.(key, (tui, theme) => {
        component.attachTui(tui as WidgetFactoryTui);
        component.theme = coerceTheme(theme);
        return component;
      });
    } catch {
      try {
        ctx.ui?.setWidget?.(key, content.split(/\r?\n/));
      } catch {
        // Best-effort display path only.
      }
    }
  }
  return component;
}

export function installWorkflowProgress(
  ctx: ExtensionContext,
  key: string,
  scriptRef: string,
  runIdPlaceholder: string,
  options: WorkflowProgressOptions = {},
): WorkflowProgressComponent {
  const component = new WorkflowProgressComponent(
    NOOP_TUI,
    coerceTheme(undefined),
    scriptRef,
    runIdPlaceholder,
    options,
  );
  if (ctx.hasUI === true) {
    if (ctx.mode !== "tui") {
      const requestRender = () => {
        ctx.ui.setWidget(key, component.render(80), { placement: FLEET_MENU_PLACEMENT });
      };
      component.attachTui({ requestRender });
      requestRender();
      return component;
    }
    try {
      ctx.ui?.setWidget?.(
        key,
        (tui, theme) => {
          component.attachTui(tui as WidgetFactoryTui);
          component.theme = coerceTheme(theme);
          return component;
        },
        // Fleet control surface → below the editor (REQ-007; policy in widget-render.ts).
        { placement: FLEET_MENU_PLACEMENT },
      );
    } catch {
      // Host accepted UI but rejected this widget: keep the live component anyway.
    }
  }
  return component;
}

export function renderAgentLiveRowsText(): string {
  const rows = [...agentLiveStore.rows.values()];
  if (rows.length === 0) return "Agents: no live rows.";
  return new AgentLivePanel({})
    .renderRows(orderAgentLiveRows(compactWorkflowParentRows(rows)), Number.POSITIVE_INFINITY)
    .join("\n");
}

export function compactWorkflowParentRows(rows: AgentLiveRow[]): AgentLiveRow[] {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const parentIdsWithChildren = new Set(
    rows.map((row) => row.parentRowId).filter((id): id is string => id !== undefined),
  );
  const collapsedParentIds = new Set(
    rows.filter((row) => parentIdsWithChildren.has(row.id) && isWorkflowAgentParentRow(row)).map((row) => row.id),
  );
  if (collapsedParentIds.size === 0) return rows;

  return rows
    .filter((row) => !collapsedParentIds.has(row.id))
    .map((row) => {
      if (row.parentRowId === undefined || !collapsedParentIds.has(row.parentRowId)) return row;
      const collapsedParent = rowById.get(row.parentRowId);
      const nextParentRowId = collapsedParent?.parentRowId;
      const { parentRowId: _oldParentRowId, ...rest } = row;
      return nextParentRowId === undefined ? rest : { ...rest, parentRowId: nextParentRowId };
    });
}

function isWorkflowAgentParentRow(row: AgentLiveRow): boolean {
  return row.id.startsWith("workflow:") && !row.id.includes(":group:");
}

export function renderAgentObserverText(): string {
  const rows = [...agentLiveStore.rows.values()];
  if (rows.length === 0) return "Agent observer: no live rows";
  const counts = countAgentLiveStatuses(rows);
  const selectedRows = selectAgentObserverRows(rows, OBSERVER_ROW_LIMIT);
  const lines = [
    `Agent observer: ${rows.length} rows total; showing ${selectedRows.length} current/recent rows`,
    `counts: queued=${counts.queued} waiting; working=${counts.working} running; done=${counts.done} completed; cancelled=${counts.cancelled} terminal/not-running; error=${counts.error} terminal/not-running`,
    ...selectedRows.flatMap((row) => formatAgentObserverRow(row)),
  ];
  if (selectedRows.length < rows.length) lines.push(`more: ${rows.length - selectedRows.length} row(s) not shown`);
  return lines.join("\n");
}

function countAgentLiveStatuses(rows: AgentLiveRow[]): Record<AgentLiveStatus, number> {
  const counts: Record<AgentLiveStatus, number> = {
    queued: 0,
    working: 0,
    done: 0,
    cancelled: 0,
    error: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

function currentWorkflowPhase(journal: readonly WorkflowJournalLine[]): string | undefined {
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    const line = journal[i];
    if (line === undefined) continue;
    if (line.kind !== "phase") continue;
    const phase = normalizeWorkflowPhase(line.phase);
    if (phase !== undefined) return phase;
  }
  return undefined;
}

function normalizeWorkflowPhase(phase: string | undefined): string | undefined {
  const normalized = phase?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

type WorkflowStageState = "declared" | "reached" | "current";

interface WorkflowStageFrontierItem {
  title: string;
  state: WorkflowStageState;
}

function workflowStageFrontier(
  declaredStages: readonly WorkflowDeclaredStage[],
  journal: readonly WorkflowJournalLine[],
): WorkflowStageFrontierItem[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  const append = (title: string | undefined): void => {
    const normalized = normalizeWorkflowPhase(title);
    if (normalized === undefined || seen.has(normalized)) return;
    seen.add(normalized);
    titles.push(normalized);
  };
  for (const stage of declaredStages) append(stage.title);
  const reached = new Set<string>();
  for (const line of journal) {
    if (line.kind !== "phase") continue;
    const phase = normalizeWorkflowPhase(line.phase);
    if (phase === undefined) continue;
    append(phase);
    reached.add(phase);
  }
  const current = currentWorkflowPhase(journal);
  return titles.map((title) => ({
    title,
    state: title === current ? "current" : reached.has(title) ? "reached" : "declared",
  }));
}

function shortWorkflowRunId(runId: string): string {
  const compact = runId.replace(/[^a-zA-Z0-9]/gu, "");
  if (compact === "") return runId;
  return compact.slice(-4);
}

function selectAgentObserverRows(rows: AgentLiveRow[], limit: number): AgentLiveRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const statusDelta = OBSERVER_STATUS_ORDER[a.row.status] - OBSERVER_STATUS_ORDER[b.row.status];
      if (statusDelta !== 0) return statusDelta;
      const aStartedAt = a.row.startedAt;
      const bStartedAt = b.row.startedAt;
      if (aStartedAt !== undefined && bStartedAt !== undefined && aStartedAt !== bStartedAt)
        return bStartedAt - aStartedAt;
      if (aStartedAt !== undefined) return -1;
      if (bStartedAt !== undefined) return 1;
      return a.index - b.index;
    })
    .slice(0, limit)
    .map(({ row }) => row);
}

function formatAgentObserverRow(row: AgentLiveRow): string[] {
  const activeTools = row.status === "working" ? row.currentTools : [];
  const agent = row.agentName === undefined ? "" : ` agent=${formatAgentIdentity(row)}`;
  const tools = activeTools.length === 0 ? "" : ` tools=${activeTools.join(",")}`;
  const model = row.model === undefined ? "" : ` model=${row.model}`;
  const effort = row.thinking === undefined ? "" : ` /effort=${row.thinking}`;
  return [
    `- ${row.id}${agent}${model}${effort} status=${formatAgentObserverStatus(row.status)} label=${JSON.stringify(row.label)}`,
    `  elapsed=${formatAgentObserverElapsed(row)} steps=${row.stepCount}(events)${tools}`,
    `  events: ${formatAgentObserverDigest(row.eventLines)}`,
  ];
}

function formatAgentObserverStatus(status: AgentLiveStatus): string {
  switch (status) {
    case "queued":
      return "queued (waiting)";
    case "working":
      return "working (running)";
    case "done":
      return "done (terminal, not running)";
    case "cancelled":
      return "cancelled (terminal, not running)";
    case "error":
      return "error (terminal, not running)";
  }
}

function formatAgentObserverElapsed(row: AgentLiveRow): string {
  return formatDuration(row.elapsedMs ?? elapsedSinceStart(row)) || "n/a";
}

function formatAgentObserverDigest(eventLines: string[]): string {
  if (eventLines.length === 0) return "(no events)";
  const recent = eventLines.slice(-OBSERVER_EVENT_DIGEST_LIMIT);
  const omitted = eventLines.length - recent.length;
  const collapsed = collapseConsecutiveDuplicateLines(recent);
  let text = collapsed.join(" | ");
  if (text.length > OBSERVER_EVENT_DIGEST_CHAR_LIMIT) text = `${text.slice(0, OBSERVER_EVENT_DIGEST_CHAR_LIMIT - 1)}…`;
  if (omitted > 0) text = `${text} (+${omitted} earlier events omitted)`;
  return text;
}

function collapseConsecutiveDuplicateLines(lines: string[]): string[] {
  const collapsed: string[] = [];
  let lastLine: string | undefined;
  let count = 0;
  const flush = () => {
    if (lastLine === undefined) return;
    collapsed.push(count > 1 ? `${lastLine} x${count}` : lastLine);
  };
  for (const line of lines) {
    if (lastLine === line) {
      count += 1;
      continue;
    }
    flush();
    lastLine = line;
    count = 1;
  }
  flush();
  return collapsed;
}

/**
 * Keep the roster inside its budget by collapsing the OLDEST settled agents
 * first: the current agent, the pending stages, and the most recent finished work
 * are what an operator steers on. The collapse is announced, never silent.
 */
function clampRosterLines(
  entries: readonly { settled: boolean; lines: string[] }[],
  budget: number,
  width: number,
): string[] {
  const all = entries.flatMap((entry) => entry.lines);
  if (all.length <= budget) return all;
  let dropped = 0;
  const kept = [...entries];
  while (kept.flatMap((entry) => entry.lines).length + 1 > budget) {
    const index = kept.findIndex((entry) => entry.settled);
    if (index < 0) break;
    kept.splice(index, 1);
    dropped += 1;
  }
  const lines = kept.flatMap((entry) => entry.lines);
  if (dropped === 0) return lines.slice(0, budget);
  return [truncate(`  (+${dropped} earlier agents)`, width), ...lines].slice(0, budget);
}

function fitLines(
  fixedLines: string[],
  tailLines: string[],
  budget: number,
  width: number,
  protectedDone = 0,
): string[] {
  if (fixedLines.length + tailLines.length <= budget) return [...fixedLines, ...tailLines];
  let dropped = 0;
  let visibleTail = [...tailLines];
  while (fixedLines.length + visibleTail.length + 1 > budget && visibleTail.length > 0) {
    visibleTail = visibleTail.slice(1);
    dropped += 1;
  }
  if (fixedLines.length + visibleTail.length + 1 <= budget) {
    return [...fixedLines, truncate(`  (+${dropped} more)`, width), ...visibleTail];
  }
  const doneCount = Math.min(protectedDone, Math.max(0, budget - 1), fixedLines.length);
  const doneBlock = doneCount > 0 ? fixedLines.slice(fixedLines.length - doneCount) : [];
  const middle = fixedLines.slice(0, fixedLines.length - doneCount);
  const middleSlots = Math.max(1, budget - 1 - doneBlock.length);
  const visibleMiddle = middle.slice(0, middleSlots);
  const hiddenCount = fixedLines.length + visibleTail.length - visibleMiddle.length - doneBlock.length;
  return [...visibleMiddle, truncate(`  (+${hiddenCount} more)`, width), ...doneBlock].slice(0, budget);
}
