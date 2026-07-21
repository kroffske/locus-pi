import type { CustomUiComponent, ExtensionContext, WidgetFactoryTui } from "../_shared/pi-api.js";
import { agentLiveStore, type AgentLiveRow, type AgentLiveStatus } from "../_shared/agent-sdk-host.js";
import {
  AgentLivePanel,
  AGENT_LIVE_SPINNER_FRAME_COUNT,
  elapsedSinceStart,
  formatAgentIdentity,
  formatDuration,
  orderAgentLiveRows,
  selectAgentLiveRowsForParents,
  truncate,
} from "../_shared/agent-live-panel.js";
import { fleetMenuState, renderFleetMenuRows, selectFleetMenuRows } from "../_shared/fleet-menu.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  workflowAgentLiveRowId,
  workflowGroupLiveRowId,
} from "../_shared/workflow-journal.js";
import {
  formatWorkflowFailureSummary,
  formatWorkflowResultSummary,
  type WorkflowResultPersistence,
} from "../_shared/workflow-result.js";
import { FLEET_MENU_PLACEMENT } from "../_shared/widget-render.js";
import type { WorkflowJournalLine } from "../_shared/workflow-runtime.js";

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

export class WorkflowProgressComponent implements CustomUiComponent {
  journal: WorkflowJournalLine[] = [];
  done?: {
    ok: boolean;
    failureSummary?: string;
    resultSummary?: string;
    runDir?: string;
    resultPersistence?: WorkflowResultPersistence;
  };
  #tickTimer: ReturnType<typeof setInterval> | undefined;
  #spinnerIndex = 0;
  #disposed = false;
  readonly #knownRowIds = new Set<string>();
  readonly #onStoreChange = () => {
    this.#syncLiveTimer();
    this.tui.requestRender();
  };
  readonly #onFleetStateChange = () => this.tui.requestRender();

  constructor(
    public tui: WidgetFactoryTui,
    public theme: ThemeLike,
    readonly scriptRef: string,
    readonly runId: string,
  ) {
    agentLiveStore.emitter.on("change", this.#onStoreChange);
    fleetMenuState.emitter.on("change", this.#onFleetStateChange);
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
    fleetMenuState.emitter.off("change", this.#onFleetStateChange);
    this.#stopLiveTimer();
  }

  push(line: WorkflowJournalLine): void {
    this.journal.push(line);
    if (line.agent !== undefined) this.#knownRowIds.add(workflowAgentLiveRowId(line));
    else if (line.kind === "group_start" || line.kind === "group_end") {
      this.#knownRowIds.add(workflowGroupLiveRowId(line));
    }
    applyWorkflowJournalLineToAgentLiveStore(line);
    this.#syncLiveTimer();
    this.tui.requestRender();
  }

  finish(res: {
    ok: boolean;
    error?: string;
    result?: unknown;
    runDir?: string;
    resultPersistence?: WorkflowResultPersistence;
  }): void {
    this.done = {
      ok: res.ok,
      ...(!res.ok ? { failureSummary: formatWorkflowFailureSummary(res.result, res.error) } : {}),
      ...(res.ok ? { resultSummary: formatWorkflowResultSummary(res.result) } : {}),
      ...(res.runDir !== undefined ? { runDir: res.runDir } : {}),
      ...(res.resultPersistence !== undefined ? { resultPersistence: res.resultPersistence } : {}),
    };
    this.dispose();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const rows = this.tui.terminal?.rows ?? 24;
    const budget = Math.max(1, Math.min(rows - 6, 24));
    const liveRows = this.visibleRows();
    const fleetRows = selectFleetMenuRows(liveRows);
    fleetMenuState.setVisibleRows(fleetRows);
    const doneLines = this.doneLines(width);
    const fleetLines = renderFleetMenuRows(liveRows, width, {
      spinnerIndex: this.#spinnerIndex,
      theme: this.theme,
      focused: fleetMenuState.focused,
      ...(fleetMenuState.selectedRowId !== undefined ? { selectedRowId: fleetMenuState.selectedRowId } : {}),
      emptyEditorFocusAvailable: fleetMenuState.emptyEditorFocusAvailable,
      fallbackFocusAvailable: fleetMenuState.fallbackFocusAvailable,
    });
    // Fleet render always keeps its hint/control footer last. Protect that
    // ordering even when workflow tail diagnostics consume the line budget.
    const fleetFooter = fleetLines.at(-1);
    const fleetBody = fleetFooter === undefined ? [] : fleetLines.slice(0, -1);
    const fixedLines = [this.renderHeader(width, liveRows), ...fleetBody, ...doneLines];
    const tailLines = this.journal
      .filter(
        (line) =>
          line.kind === "log" ||
          line.kind === "error" ||
          (line.kind === "agent_end" && line.evidenceWarnings !== undefined && line.evidenceWarnings.length > 0),
      )
      .slice(-3)
      .map((line) => truncate(formatProgressTailLine(line), width));
    if (fleetFooter === undefined) return fitLines(fixedLines, tailLines, budget, width, doneLines.length);
    return [...fitLines(fixedLines, tailLines, Math.max(0, budget - 1), width, doneLines.length), fleetFooter];
  }

  private visibleRows(): AgentLiveRow[] {
    const all = [...agentLiveStore.rows.values()];
    if (this.#knownRowIds.size > 0) {
      return compactWorkflowParentRows(selectAgentLiveRowsForParents(all, this.#knownRowIds));
    }
    const prefix = `workflow:${this.runId}:`;
    const scopedParentIds = new Set(all.filter((row) => row.id.startsWith(prefix)).map((row) => row.id));
    const scoped = all.filter(
      (row) => row.id.startsWith(prefix) || (row.parentRowId !== undefined && scopedParentIds.has(row.parentRowId)),
    );
    return compactWorkflowParentRows(scoped.length > 0 ? scoped : all);
  }

  private renderHeader(width: number, rows: AgentLiveRow[]): string {
    const headerStatus = this.done === undefined ? "running" : this.done.ok ? "ok" : "failed";
    const counts = countAgentLiveStatuses(rows);
    const phase = currentWorkflowPhase(this.journal);
    const terminalCount = counts.done + counts.cancelled + counts.error;
    const cancelledText = counts.cancelled > 0 ? ` cancelled=${counts.cancelled}` : "";
    const failedText = counts.error > 0 ? ` failed=${counts.error}` : "";
    // Replay is a property of the EVIDENCE, so it belongs in the header beside
    // the status word rather than in the scrolling tail a reader may miss.
    const replayedCount = this.journal.filter((line) => line.kind === "agent_end" && line.replayed === true).length;
    const replayedText = replayedCount > 0 ? ` replayed=${replayedCount}` : "";
    const text = `workflow ${this.scriptRef} (${this.runId}) - ${headerStatus.toUpperCase()} phase=${phase ?? "not-set"} active=${counts.working} done=${terminalCount}/${rows.length}${cancelledText}${failedText}${replayedText}`;
    return this.#bold(truncate(text, width));
  }

  private doneLines(width: number): string[] {
    if (this.done === undefined) return [];
    const lines: string[] = [];
    if (this.done.failureSummary !== undefined)
      lines.push(this.#fg("error", truncate(`✗ ${this.done.failureSummary}`, width)));
    else if (this.done.resultSummary !== undefined)
      lines.push(this.#fg("success", truncate(`✓ ${this.done.resultSummary}`, width)));
    if (this.done.resultPersistence?.ok === false) {
      lines.push(this.#fg("warning", truncate(`persistence: ${this.done.resultPersistence.code}`, width)));
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
): WorkflowProgressComponent {
  const component = new WorkflowProgressComponent(NOOP_TUI, coerceTheme(undefined), scriptRef, runIdPlaceholder);
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

function currentWorkflowPhase(journal: WorkflowJournalLine[]): string | undefined {
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    const line = journal[i];
    if (line === undefined) continue;
    if (line.kind === "phase" && line.phase !== undefined) return line.phase;
    if ("phase" in line && typeof line.phase === "string" && line.phase.trim() !== "") return line.phase;
  }
  return undefined;
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
