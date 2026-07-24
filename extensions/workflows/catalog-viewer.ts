import { highlightCode } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CustomUiComponent, CustomUiTui } from "../_shared/pi-api.js";
import { renderOperatorBlock, type OperatorBlock, type OperatorThemeLike } from "../_shared/operator-ui.js";
import {
  readWorkflowCatalogSource,
  workflowSourceBadge,
  type WorkflowBrowserAction,
  type WorkflowBrowserIntent,
  type WorkflowCatalogCurrentRow,
  type WorkflowCatalogHistoryRow,
  type WorkflowCatalogModel,
  type WorkflowSourceReadState,
} from "./workflow-catalog.js";

const DEFAULT_TERMINAL_ROWS = 24;
// Pi 0.82.0 keeps two footer rows plus an optional extension-status row.
const PI_HOST_FOOTER_ROWS = 3;
const COMPACT_FOOTER_ROWS = 2;
const SOURCE_FRAME_ROWS = 2;

interface WorkflowCatalogTheme {
  fg?(color: string, text: string): string;
}

interface WorkflowCatalogKeybindings {
  matches(
    data: string,
    keybinding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
  ): boolean;
}

type SelectableWorkflowRow = WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow;
type SourceAction = "back" | WorkflowBrowserAction;
type CatalogScreen =
  | { kind: "catalog" }
  | { kind: "source"; selected: SelectableWorkflowRow; state: WorkflowSourceReadState }
  | { kind: "identity"; selected: SelectableWorkflowRow; state: WorkflowSourceReadState };

/** Focused read-only browser. It can only resolve a typed editor intent or cancellation. */
export class WorkflowCatalogViewer implements CustomUiComponent {
  #screen: CatalogScreen = { kind: "catalog" };
  #selectedIndex = 0;
  #sourceScroll = 0;
  #identityScroll = 0;
  #actionIndex = 0;
  #lastWidth = 80;
  #highlightedSource: string[] | undefined;
  #done: ((intent?: WorkflowBrowserIntent) => void) | undefined;
  readonly #theme: WorkflowCatalogTheme;

  constructor(
    private readonly tui: CustomUiTui,
    theme: unknown,
    private readonly keybindings: unknown,
    private readonly model: WorkflowCatalogModel,
    private readonly projectRoot: string,
    private readonly workingDirectory: string,
    done: (intent?: WorkflowBrowserIntent) => void,
  ) {
    this.#theme = asTheme(theme);
    this.#done = done;
  }

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    this.#lastWidth = safeWidth;
    if (this.#screen.kind === "catalog") return this.#renderCatalog(safeWidth);
    if (this.#screen.kind === "identity") return this.#renderIdentity(this.#screen, safeWidth);
    return this.#renderSource(this.#screen, safeWidth);
  }

  handleInput(data: string): void {
    if (this.#screen.kind === "catalog") this.#handleCatalogInput(data);
    else if (this.#screen.kind === "identity") this.#handleIdentityInput(data);
    else this.#handleSourceInput(data);
  }

  invalidate(): void {
    this.#highlightedSource = undefined;
  }

  dispose(): void {
    this.#done = undefined;
  }

  get selectedIndex(): number {
    return this.#selectedIndex;
  }
  get screenKind(): CatalogScreen["kind"] {
    return this.#screen.kind;
  }

  #handleCatalogInput(data: string): void {
    if (matchesInput(this.keybindings, data, "tui.select.cancel", ["escape", "\x1b", "q", "Q"])) {
      this.#finish();
      return;
    }
    const rows = selectableRows(this.model);
    if (rows.length === 0) return;
    if (matchesInput(this.keybindings, data, "tui.select.up", ["up", "k", "\x1b[A", "\x1bOA"])) {
      this.#selectedIndex = cycleIndex(this.#selectedIndex, -1, rows.length);
      this.tui.requestRender();
      return;
    }
    if (matchesInput(this.keybindings, data, "tui.select.down", ["down", "j", "\x1b[B", "\x1bOB"])) {
      this.#selectedIndex = cycleIndex(this.#selectedIndex, 1, rows.length);
      this.tui.requestRender();
      return;
    }
    if (matchesInput(this.keybindings, data, "tui.select.confirm", ["enter", "\r", "\n"])) {
      const selected = rows[this.#selectedIndex];
      if (selected === undefined) return;
      this.#screen = {
        kind: "source",
        selected,
        state: readWorkflowCatalogSource(selected, this.projectRoot, this.workingDirectory),
      };
      this.#sourceScroll = 0;
      this.#identityScroll = 0;
      this.#actionIndex = 0;
      this.#highlightedSource = undefined;
      this.tui.requestRender();
    }
  }

  #handleSourceInput(data: string): void {
    if (matchesInput(this.keybindings, data, "tui.select.cancel", ["escape", "\x1b", "q", "Q"])) {
      this.#returnToCatalog();
      return;
    }
    const screen = this.#screen;
    if (screen.kind !== "source") return;
    if (data === "i" || data === "I") {
      this.#screen = { kind: "identity", selected: screen.selected, state: screen.state };
      this.#identityScroll = 0;
      this.tui.requestRender();
      return;
    }
    const actions = sourceActions(screen, viewerRows(this.tui));
    if (["tab", "\t"].includes(data)) {
      this.#actionIndex = cycleIndex(this.#actionIndex, 1, actions.length);
      this.tui.requestRender();
      return;
    }
    if (matchesInput(this.keybindings, data, "tui.select.confirm", ["enter", "\r", "\n"])) {
      const action = actions[this.#actionIndex] ?? "back";
      if (action === "back") this.#returnToCatalog();
      else if (screen.selected.kind === "history") {
        if (action === "review") this.#finish({ action, row: screen.selected, sourceState: screen.state });
      } else {
        this.#finish({ action, row: screen.selected, sourceState: screen.state });
      }
      return;
    }
    if (screen.state.kind !== "ready") return;
    const page = Math.max(1, sourceBodyHeight(this.tui, screen, this.#lastWidth) - 1);
    if (matchesInput(this.keybindings, data, "tui.select.up", ["up", "k", "\x1b[A", "\x1bOA"])) this.#sourceScroll -= 1;
    else if (matchesInput(this.keybindings, data, "tui.select.down", ["down", "j", "\x1b[B", "\x1bOB"]))
      this.#sourceScroll += 1;
    else if (["pageUp", "pageup", "\x1b[5~"].includes(data)) this.#sourceScroll -= page;
    else if (["pageDown", "pagedown", "\x1b[6~"].includes(data)) this.#sourceScroll += page;
    else if (["home", "\x1b[H", "\x1b[1~"].includes(data)) this.#sourceScroll = 0;
    else if (["end", "\x1b[F", "\x1b[4~"].includes(data)) this.#sourceScroll = Number.MAX_SAFE_INTEGER;
    else return;
    this.#sourceScroll = Math.max(0, this.#sourceScroll);
    this.tui.requestRender();
  }

  #handleIdentityInput(data: string): void {
    const screen = this.#screen;
    if (screen.kind !== "identity") return;
    if (
      matchesInput(this.keybindings, data, "tui.select.cancel", ["escape", "\x1b", "q", "Q"]) ||
      data === "i" ||
      data === "I"
    ) {
      this.#screen = { kind: "source", selected: screen.selected, state: screen.state };
      this.tui.requestRender();
      return;
    }
    const page = Math.max(1, identityBodyHeight(this.tui));
    if (matchesInput(this.keybindings, data, "tui.select.up", ["up", "k", "\x1b[A", "\x1bOA"]))
      this.#identityScroll -= 1;
    else if (matchesInput(this.keybindings, data, "tui.select.down", ["down", "j", "\x1b[B", "\x1bOB"]))
      this.#identityScroll += 1;
    else if (["pageUp", "pageup", "\x1b[5~"].includes(data)) this.#identityScroll -= page;
    else if (["pageDown", "pagedown", "\x1b[6~"].includes(data)) this.#identityScroll += page;
    else if (["home", "\x1b[H", "\x1b[1~"].includes(data)) this.#identityScroll = 0;
    else if (["end", "\x1b[F", "\x1b[4~"].includes(data)) this.#identityScroll = Number.MAX_SAFE_INTEGER;
    else return;
    this.#identityScroll = Math.max(0, this.#identityScroll);
    this.tui.requestRender();
  }

  #returnToCatalog(): void {
    this.#screen = { kind: "catalog" };
    this.#sourceScroll = 0;
    this.#identityScroll = 0;
    this.#actionIndex = 0;
    this.#highlightedSource = undefined;
    this.tui.requestRender();
  }

  #finish(intent?: WorkflowBrowserIntent): void {
    const done = this.#done;
    this.#done = undefined;
    done?.(intent);
  }

  #renderCatalog(width: number): string[] {
    const height = viewerRows(this.tui);
    if (height <= 6) return compactCatalogProjection(this.model, this.#selectedIndex, height, width, this.#theme);
    const footer = catalogFooter(this.model);
    const footerHeight = Math.min(COMPACT_FOOTER_ROWS, Math.max(0, height - 1));
    const bodyHeight = Math.max(0, height - 1 - footerHeight);
    const query = this.model.query === undefined ? "" : ` · query ${JSON.stringify(this.model.query)}`;
    const header = fitLine(style(this.#theme, "accent", `[SELECT] Workflow catalog${query}`), width);
    const body = catalogBody(this.model, this.#selectedIndex, bodyHeight, width, this.#theme);
    return [
      header,
      ...padLines(body, bodyHeight, width),
      ...footer.slice(0, footerHeight).map((line) => fitLine(line, width)),
    ];
  }

  #renderSource(screen: Extract<CatalogScreen, { kind: "source" }>, width: number): string[] {
    const height = viewerRows(this.tui);
    if (height === 1) return [fitLine("[Back] · Enter/Esc back", width)];
    const layout = sourceLayout(this.tui, screen, width);
    const identity = sourceIdentityLines(screen.selected, width, layout.identityLimit, this.#theme).slice(
      0,
      height - layout.footerHeight,
    );
    const actions = sourceActions(screen, height);
    this.#actionIndex = clamp(this.#actionIndex, 0, actions.length - 1);
    let body: string[];
    let position = "";
    if (screen.state.kind === "ready") {
      const highlighted = (this.#highlightedSource ??= highlightCode(screen.state.source, "javascript"));
      const total = Math.max(1, highlighted.length);
      const maxScroll = Math.max(0, total - layout.bodyHeight);
      this.#sourceScroll = clamp(this.#sourceScroll, 0, maxScroll);
      body = highlighted
        .slice(this.#sourceScroll, this.#sourceScroll + layout.bodyHeight)
        .map((line) => fitLine(line, width));
      const first = Math.min(total, this.#sourceScroll + 1);
      const last = Math.min(total, this.#sourceScroll + Math.max(1, body.length));
      position = `${first}-${last}/${total}`;
    } else {
      body = wrapPlain(screen.state.message, width).slice(0, layout.bodyHeight);
    }
    const framedBody = layout.framed
      ? [
          sourceFrameLine("top", "Code", width, this.#theme),
          ...padLines(body, layout.bodyHeight, width),
          sourceFrameLine("bottom", position, width, this.#theme),
        ]
      : padLines(body, layout.bodyHeight, width);
    const footer = sourceFooter(screen, actions, this.#actionIndex, layout.framed ? "" : position, this.#theme);
    return [...identity, ...framedBody, ...footer.slice(0, layout.footerHeight).map((line) => fitLine(line, width))];
  }

  #renderIdentity(screen: Extract<CatalogScreen, { kind: "identity" }>, width: number): string[] {
    const height = viewerRows(this.tui);
    const footerHeight = Math.min(COMPACT_FOOTER_ROWS, Math.max(0, height - 1));
    const bodyHeight = Math.max(0, height - 1 - footerHeight);
    const wrapped = identityTextLines(screen.selected).flatMap((line) =>
      wrapTextWithAnsi(styleIdentityLine(line, this.#theme), width),
    );
    const total = Math.max(1, wrapped.length);
    const maxScroll = Math.max(0, total - bodyHeight);
    this.#identityScroll =
      this.#identityScroll === Number.MAX_SAFE_INTEGER ? maxScroll : clamp(this.#identityScroll, 0, maxScroll);
    const visible = wrapped
      .slice(this.#identityScroll, this.#identityScroll + bodyHeight)
      .map((line) => fitLine(line, width));
    const first = Math.min(total, this.#identityScroll + 1);
    const last = Math.min(total, this.#identityScroll + Math.max(1, visible.length));
    return [
      fitLine(`[IDENTITY] ${screen.selected.name}`, width),
      ...padLines(visible, bodyHeight, width),
      ...identityFooter(first, last, total)
        .slice(0, footerHeight)
        .map((line) => fitLine(line, width)),
    ];
  }
}

/** Workflow-owned read-only projection of one immutable semantic info block. */
export class WorkflowInfoViewer implements CustomUiComponent {
  #scroll = 0;
  #done: (() => void) | undefined;
  readonly #theme: OperatorThemeLike | undefined;

  constructor(
    private readonly tui: CustomUiTui,
    theme: unknown,
    private readonly keybindings: unknown,
    private readonly block: OperatorBlock,
    done: () => void,
  ) {
    this.#theme = asOperatorTheme(theme);
    this.#done = done;
  }

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    const height = viewerRows(this.tui);
    const footerHeight = height > 1 ? 1 : 0;
    const bodyHeight = Math.max(1, height - footerHeight);
    const content = renderOperatorBlock(this.block, safeWidth, this.#theme);
    const total = Math.max(1, content.length);
    const maxScroll = Math.max(0, total - bodyHeight);
    this.#scroll = this.#scroll === Number.MAX_SAFE_INTEGER ? maxScroll : clamp(this.#scroll, 0, maxScroll);
    const visible = content.slice(this.#scroll, this.#scroll + bodyHeight);
    if (footerHeight === 0) return visible.slice(0, 1).map((line) => fitLine(line, safeWidth));
    const first = Math.min(total, this.#scroll + 1);
    const last = Math.min(total, this.#scroll + visible.length);
    return [
      ...padLines(visible, bodyHeight, safeWidth),
      fitLine(`${first}-${last}/${total} ↑/↓ PgUp/PgDn Home/End Esc/q`, safeWidth),
    ];
  }

  handleInput(data: string): void {
    if (matchesInput(this.keybindings, data, "tui.select.cancel", ["escape", "\x1b", "q", "Q"])) {
      this.#finish();
      return;
    }
    const page = Math.max(1, viewerRows(this.tui) - 1);
    if (matchesInput(this.keybindings, data, "tui.select.up", ["up", "k", "\x1b[A", "\x1bOA"])) this.#scroll -= 1;
    else if (matchesInput(this.keybindings, data, "tui.select.down", ["down", "j", "\x1b[B", "\x1bOB"]))
      this.#scroll += 1;
    else if (["pageUp", "pageup", "\x1b[5~"].includes(data)) this.#scroll -= page;
    else if (["pageDown", "pagedown", "\x1b[6~"].includes(data)) this.#scroll += page;
    else if (["home", "\x1b[H", "\x1b[1~"].includes(data)) this.#scroll = 0;
    else if (["end", "\x1b[F", "\x1b[4~"].includes(data)) this.#scroll = Number.MAX_SAFE_INTEGER;
    else return;
    this.#scroll = Math.max(0, this.#scroll);
    this.tui.requestRender();
  }

  invalidate(): void {
    // Semantic block is immutable; width-specific projection is rebuilt on render.
  }

  dispose(): void {
    this.#done = undefined;
  }

  #finish(): void {
    const done = this.#done;
    this.#done = undefined;
    done?.();
  }
}

function selectableRows(model: WorkflowCatalogModel): SelectableWorkflowRow[] {
  return [...model.current, ...model.history];
}

function sourceActions(
  screen: Extract<CatalogScreen, { kind: "source" }>,
  height = Number.MAX_SAFE_INTEGER,
): SourceAction[] {
  if (height <= 1) return ["back"];
  if (screen.selected.kind === "history") return ["back", "review"];
  return screen.state.kind === "ready" ? ["back", "start", "edit", "review"] : ["back"];
}

function catalogFooter(model: WorkflowCatalogModel): string[] {
  return selectableRows(model).length === 0
    ? ["Esc close · no selectable rows", "Help: /workflows info"]
    : ["↑/↓ select · Enter inspect · Esc close", "Help: /workflows info · history review-only"];
}

function compactCatalogProjection(
  model: WorkflowCatalogModel,
  selectedIndex: number,
  height: number,
  width: number,
  theme: WorkflowCatalogTheme,
): string[] {
  const rows = selectableRows(model);
  const selected = rows[selectedIndex];
  const row = fitLine(selected === undefined ? "No workflow rows." : compactSelectedRowLine(selected), width);
  if (height === 1) return [row];
  const controls = fitLine(selected === undefined ? "Esc close" : "↑/↓ Enter · Esc", width);
  if (height === 2) return [row, controls];
  const query = model.query === undefined ? "" : ` · query ${JSON.stringify(model.query)}`;
  if (height === 3) {
    return [fitLine(style(theme, "accent", `[SELECT] Workflow catalog${query}`), width), row, controls];
  }
  return padLines(
    [
      fitLine(style(theme, "accent", `[SELECT] Workflow catalog${query}`), width),
      row,
      fitLine(
        selected === undefined ? "Esc close · no selectable rows" : "↑/↓ select · Enter inspect · Esc close",
        width,
      ),
      fitLine("Help: /workflows info", width),
    ],
    height,
    width,
  );
}

function compactSelectedRowLine(row: SelectableWorkflowRow): string {
  const identity = row.kind === "history" ? `[R:${row.runId}]` : "[C]";
  return `${identity} ${workflowSourceBadge(row.source)} ${row.name}`;
}

function sourceFooter(
  screen: Extract<CatalogScreen, { kind: "source" }>,
  actions: readonly SourceAction[],
  selected: number,
  position: string,
  theme: WorkflowCatalogTheme,
): string[] {
  return [
    `${actionBar(screen, actions, selected, theme)}${position === "" ? "" : ` ${position}`}`,
    screen.selected.kind === "history"
      ? "Review: authoring handoff · Tab Enter i Esc"
      : "Start: direct command · Edit/Review: authoring handoff · Tab Enter i Esc",
  ];
}

function identityFooter(first: number, last: number, total: number): string[] {
  return [`${first}-${last}/${total} · ↑/↓ PgUp/PgDn Home/End`, "i/Esc source · Help: /workflows info"];
}

function sourceIdentityLines(
  row: SelectableWorkflowRow,
  width: number,
  limit: number,
  theme: WorkflowCatalogTheme = {},
): string[] {
  const lines = identityTextLines(row).flatMap((line) => wrapTextWithAnsi(styleIdentityLine(line, theme), width));
  return lines.slice(0, limit).map((line) => fitLine(line, width));
}

function styleIdentityLine(line: string, theme: WorkflowCatalogTheme): string {
  if (line.startsWith("[VIEW]")) return `${style(theme, "success", "[VIEW]")}${line.slice("[VIEW]".length)}`;
  const separator = line.indexOf(":");
  return separator < 0 ? line : `${style(theme, "success", line.slice(0, separator + 1))}${line.slice(separator + 1)}`;
}

function identityTextLines(row: SelectableWorkflowRow): string[] {
  return [
    `[VIEW] ${row.kind === "history" ? "[R] " : ""}${workflowSourceBadge(row.source)} ${row.name}`,
    `Source: ${row.sourceLabel}`,
    ...(row.kind === "history" ? [`Run: ${row.runId}`, `Snapshot: ${row.originPath}`] : [`Path: ${row.target.path}`]),
    ...(row.kind === "history" && row.snapshot.sha256 !== undefined ? [`SHA-256: ${row.snapshot.sha256}`] : []),
  ];
}

function actionBar(
  screen: Extract<CatalogScreen, { kind: "source" }>,
  actions: readonly SourceAction[],
  selected: number,
  theme: WorkflowCatalogTheme,
): string {
  return actions
    .map((action, index) => {
      const label = action === "review" && screen.state.kind !== "ready" ? "Diagnose" : title(action);
      return index === selected ? style(theme, "warning", `› [${label}]`) : style(theme, "success", label);
    })
    .join(" ");
}

function title(action: SourceAction): string {
  return action[0]!.toUpperCase() + action.slice(1);
}

function catalogBody(
  model: WorkflowCatalogModel,
  selectedIndex: number,
  height: number,
  width: number,
  theme: WorkflowCatalogTheme,
): string[] {
  const rows = selectableRows(model);
  if (height === 1) {
    const selected = rows[selectedIndex];
    return [
      fitLine(selected === undefined ? "No workflow rows." : rowLines(selected, true, width, theme, false)[0]!, width),
    ];
  }
  const desiredCurrentHeight = sectionDesiredHeight(model.current.length);
  const desiredHistoryHeight = sectionDesiredHeight(model.history.length);
  const contentFits = desiredCurrentHeight + desiredHistoryHeight <= height;
  const currentHeight = contentFits ? desiredCurrentHeight : Math.max(1, Math.ceil(height * 0.6));
  const historyHeight = contentFits ? desiredHistoryHeight : Math.max(1, height - currentHeight);
  const lines = [style(theme, "muted", `Current (${model.current.length}/${model.totalCurrent}):`)];
  const currentBody = Math.max(0, currentHeight - 1);
  lines.push(
    ...catalogSection(
      model.current,
      Math.min(selectedIndex, model.current.length - 1),
      0,
      selectedIndex,
      currentBody,
      width,
      theme,
      model.query === undefined ? "  (none found)" : "  (no current matches)",
    ),
  );
  lines.push(style(theme, "muted", `History [R] review-only (${model.history.length}):`));
  const historyBody = Math.max(0, historyHeight - 1);
  lines.push(
    ...catalogSection(
      model.history,
      clamp(selectedIndex - model.current.length, 0, model.history.length - 1),
      model.current.length,
      selectedIndex,
      historyBody,
      width,
      theme,
      model.query === undefined ? "  (none yet)" : "  (no history matches)",
    ),
  );
  return lines.slice(0, height).map((line) => fitLine(line, width));
}

function sectionDesiredHeight(rowCount: number): number {
  return 1 + Math.max(1, rowCount * 2);
}

function catalogSection(
  rows: readonly SelectableWorkflowRow[],
  localSelection: number,
  globalOffset: number,
  selectedIndex: number,
  height: number,
  width: number,
  theme: WorkflowCatalogTheme,
  emptyMessage: string,
): string[] {
  if (height <= 0) return [];
  if (rows.length === 0) return padLines([emptyMessage], height, width);
  const expanded = height >= 2;
  const rowHeight = expanded ? 2 : 1;
  const capacity = Math.max(1, Math.floor(height / rowHeight));
  const start = windowStart(localSelection, rows.length, capacity);
  const lines: string[] = [];
  for (const [offset, row] of rows.slice(start, start + capacity).entries()) {
    const rowIndex = start + offset;
    lines.push(...rowLines(row, globalOffset + rowIndex === selectedIndex, width, theme, expanded));
  }
  return padLines(lines, height, width);
}

function rowLines(
  row: SelectableWorkflowRow,
  selected: boolean,
  width: number,
  theme: WorkflowCatalogTheme,
  expanded: boolean,
): string[] {
  const history = row.kind === "history" ? `[R:${row.runId}] ` : "";
  const first = `${selected ? ">" : " "} ${history}${workflowSourceBadge(row.source)} ${row.sourceLabel} · ${row.name} · ${row.description}`;
  if (!expanded) return [style(theme, selected ? "accent" : "text", fitLine(first, width))];
  const pathPrefix = "    └ ";
  const pathWidth = Math.max(0, width - visibleWidth(pathPrefix));
  const path = middleTruncate(row.originPath, pathWidth);
  return [
    style(theme, selected ? "accent" : "text", fitLine(first, width)),
    style(theme, selected ? "accent" : "muted", fitLine(`${pathPrefix}${path}`, width)),
  ];
}

function middleTruncate(value: string, width: number): string {
  if (width <= 0) return "";
  const total = visibleWidth(value);
  if (total <= width) return value;
  if (width === 1) return "…";
  const basename = value.split(/[\\/]/u).at(-1) ?? value;
  const suffixWidth = Math.min(width - 2, Math.max(1, visibleWidth(basename), Math.floor(width * 0.55)));
  const prefixWidth = Math.max(1, width - suffixWidth - 1);
  return `${sliceByColumn(value, 0, prefixWidth)}…${sliceByColumn(value, total - suffixWidth, total)}`;
}

function sourceFrameLine(edge: "top" | "bottom", label: string, width: number, theme: WorkflowCatalogTheme): string {
  const left = edge === "top" ? "╭─ " : "╰─ ";
  const right = edge === "top" ? "╮" : "╯";
  const prefix = `${left}${label} `;
  const fill = "─".repeat(Math.max(0, width - visibleWidth(prefix) - visibleWidth(right)));
  return fitLine(style(theme, "borderAccent", `${prefix}${fill}${right}`), width);
}

function matchesInput(
  keybindings: unknown,
  data: string,
  binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
  fallbacks: readonly string[],
): boolean {
  return isKeybindings(keybindings) ? keybindings.matches(data, binding) : fallbacks.includes(data);
}

function isKeybindings(value: unknown): value is WorkflowCatalogKeybindings {
  return typeof value === "object" && value !== null && typeof (value as { matches?: unknown }).matches === "function";
}

function asTheme(value: unknown): WorkflowCatalogTheme {
  return typeof value === "object" && value !== null ? (value as WorkflowCatalogTheme) : {};
}

function asOperatorTheme(value: unknown): OperatorThemeLike | undefined {
  return typeof value === "object" && value !== null ? (value as OperatorThemeLike) : undefined;
}

function style(theme: WorkflowCatalogTheme, color: string, text: string): string {
  return typeof theme.fg === "function" ? theme.fg(color, text) : text;
}

function terminalRows(tui: CustomUiTui): number {
  const rows = tui.terminal?.rows;
  return typeof rows === "number" && Number.isFinite(rows) ? Math.max(3, Math.floor(rows)) : DEFAULT_TERMINAL_ROWS;
}

function viewerRows(tui: CustomUiTui): number {
  return Math.max(1, terminalRows(tui) - PI_HOST_FOOTER_ROWS);
}

function identityBodyHeight(tui: CustomUiTui): number {
  return Math.max(0, viewerRows(tui) - 1 - COMPACT_FOOTER_ROWS);
}

function sourceBodyHeight(tui: CustomUiTui, screen: Extract<CatalogScreen, { kind: "source" }>, width: number): number {
  return sourceLayout(tui, screen, width).bodyHeight;
}

function sourceLayout(
  tui: CustomUiTui,
  screen: Extract<CatalogScreen, { kind: "source" }>,
  width: number,
): {
  bodyHeight: number;
  footerHeight: number;
  framed: boolean;
  identityLimit: number;
} {
  const height = viewerRows(tui);
  const footerHeight = Math.min(COMPACT_FOOTER_ROWS, Math.max(0, height - 1));
  const identityLimit = screen.state.kind === "ready" ? Math.max(1, height - footerHeight - 2) : 1;
  const identityHeight = sourceIdentityLines(screen.selected, width, identityLimit).slice(
    0,
    height - footerHeight,
  ).length;
  const contentHeight = Math.max(0, height - identityHeight - footerHeight);
  const framed = screen.state.kind === "ready" && contentHeight >= SOURCE_FRAME_ROWS + 1;
  return {
    bodyHeight: Math.max(0, contentHeight - (framed ? SOURCE_FRAME_ROWS : 0)),
    footerHeight,
    framed,
    identityLimit,
  };
}

function normalizeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

function fitLine(value: string, width: number): string {
  const fitted = truncateToWidth(value, width, "…");
  return visibleWidth(fitted) <= width ? fitted : truncateToWidth(fitted, width);
}

function wrapPlain(value: string, width: number): string[] {
  return value.split(/\r?\n/u).flatMap((line) => wrapTextWithAnsi(line, width));
}

function padLines(lines: readonly string[], height: number, width: number): string[] {
  const out = lines.slice(0, height).map((line) => fitLine(line, width));
  while (out.length < height) out.push(" ".repeat(width));
  return out;
}

function windowStart(selected: number, total: number, limit: number): number {
  if (limit <= 0 || total <= limit) return 0;
  return clamp(selected - Math.floor(limit / 2), 0, total - limit);
}

function cycleIndex(index: number, delta: number, total: number): number {
  return total <= 0 ? 0 : (index + delta + total) % total;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
