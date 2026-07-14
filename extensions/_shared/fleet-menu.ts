import { EventEmitter } from "node:events";
import { keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import { AgentLivePanel, orderAgentLiveRows, withWorkflowGroupTokenTotals, type AgentLiveThemeLike } from "./agent-live-panel.js";
import { agentLiveStore, type AgentLiveRow } from "./agent-sdk-host.js";
import type { CustomUiComponent, CustomUiTui } from "./pi-api.js";

export const FLEET_MENU_MAX_ROWS = 8;
export const FLEET_FOCUS_FALLBACK_SHORTCUT = "shift+down";

export type FleetMenuAction =
  | { kind: "close" }
  | { kind: "drill"; rowId: string }
  | { kind: "stop"; rowId: string };

interface KeybindingsLike {
  matches(data: string, keybinding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean;
}

/**
 * UI-only selection state. Runtime facts remain in AgentLiveStore; focus and a
 * cursor are ephemeral projections and must never mutate a row.
 */
class FleetMenuState {
  readonly emitter = new EventEmitter();
  #focused = false;
  #selectedRowId: string | undefined;
  #visibleRowIds: string[] = [];
  #emptyEditorFocusAvailable = false;
  #fallbackFocusAvailable = false;

  get focused(): boolean {
    return this.#focused;
  }

  get selectedRowId(): string | undefined {
    return this.#selectedRowId;
  }

  get focusShortcutsAvailable(): boolean {
    return this.#fallbackFocusAvailable;
  }

  get emptyEditorFocusAvailable(): boolean {
    return this.#emptyEditorFocusAvailable;
  }

  get fallbackFocusAvailable(): boolean {
    return this.#fallbackFocusAvailable;
  }

  /** Compatibility setter for older tests/consumers; new code sets each path honestly. */
  setFocusShortcutsAvailable(available: boolean): void {
    const changed = this.#emptyEditorFocusAvailable !== available || this.#fallbackFocusAvailable !== available;
    if (!changed) return;
    this.#emptyEditorFocusAvailable = available;
    this.#fallbackFocusAvailable = available;
    this.emitter.emit("change");
  }

  setEmptyEditorFocusAvailable(available: boolean): void {
    if (this.#emptyEditorFocusAvailable === available) return;
    this.#emptyEditorFocusAvailable = available;
    this.emitter.emit("change");
  }

  setFallbackFocusAvailable(available: boolean): void {
    if (this.#fallbackFocusAvailable === available) return;
    this.#fallbackFocusAvailable = available;
    this.emitter.emit("change");
  }

  setFocused(focused: boolean): void {
    if (this.#focused === focused) return;
    this.#focused = focused;
    this.emitter.emit("change");
  }

  setVisibleRows(rows: AgentLiveRow[]): void {
    this.#visibleRowIds = rows.map((row) => row.id);
    const selectableRowIds = new Set(selectFleetMenuLeafRows(rows).map((row) => row.id));
    if (this.#selectedRowId === undefined || !selectableRowIds.has(this.#selectedRowId)) {
      this.#selectedRowId = preferredInitialRow(rows)?.id;
    }
  }

  visibleRows(): AgentLiveRow[] {
    return this.#visibleRowIds
      .map((id) => agentLiveStore.rows.get(id))
      .filter((row): row is AgentLiveRow => row !== undefined);
  }

  move(delta: -1 | 1, rows: AgentLiveRow[]): void {
    this.setVisibleRows(rows);
    const selectableRows = selectFleetMenuLeafRows(rows);
    if (selectableRows.length === 0) return;
    const currentIndex = selectableRows.findIndex((row) => row.id === this.#selectedRowId);
    const start = currentIndex < 0 ? 0 : currentIndex;
    const next = Math.max(0, Math.min(selectableRows.length - 1, start + delta));
    const nextId = selectableRows[next]?.id;
    if (nextId === undefined || nextId === this.#selectedRowId) return;
    this.#selectedRowId = nextId;
    this.emitter.emit("change");
  }
}

const FLEET_MENU_STATE_GLOBAL_KEY = Symbol.for("locus-pi.fleet-menu-state.v2");
interface SharedFleetMenuStateSlot {
  version: 2;
  state: FleetMenuState;
}

function sharedFleetMenuState(): FleetMenuState {
  const runtimeGlobal = globalThis as unknown as Record<symbol, unknown>;
  const existing = runtimeGlobal[FLEET_MENU_STATE_GLOBAL_KEY];
  if (existing !== undefined) {
    if (!isSharedFleetMenuStateSlot(existing)) throw new Error("locus-pi: incompatible global fleet-menu state slot");
    return existing.state as FleetMenuState;
  }
  const slot: SharedFleetMenuStateSlot = { version: 2, state: new FleetMenuState() };
  Object.defineProperty(runtimeGlobal, FLEET_MENU_STATE_GLOBAL_KEY, {
    value: slot,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return slot.state;
}

function isSharedFleetMenuStateSlot(value: unknown): value is SharedFleetMenuStateSlot {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.state)) return false;
  return typeof value.state.setFocused === "function" &&
    typeof value.state.visibleRows === "function" &&
    typeof value.state.setEmptyEditorFocusAvailable === "function";
}

export const fleetMenuState = sharedFleetMenuState();

/** Stable active-first projection, capped to the eight rows the menu can own. */
export function selectFleetMenuRows(rows: AgentLiveRow[], limit = FLEET_MENU_MAX_ROWS): AgentLiveRow[] {
  const ordered = orderAgentLiveRows(rows);
  if (ordered.length <= limit) return ordered;
  const active = ordered.filter((row) => row.status === "working" || row.status === "queued");
  const terminal = ordered.filter((row) => row.status === "done" || row.status === "cancelled" || row.status === "error");
  const selected = [...active.slice(0, limit), ...terminal.slice(-Math.max(0, limit - active.length))];
  const ids = new Set(selected.map((row) => row.id));
  return ordered.filter((row) => ids.has(row.id)).slice(0, limit);
}

/** Aggregate/anchor rows remain visible headings; only terminal child/agent rows are actionable. */
export function selectFleetMenuLeafRows(rows: AgentLiveRow[]): AgentLiveRow[] {
  const parentIds = new Set(rows.flatMap((row) => row.parentRowId === undefined ? [] : [row.parentRowId]));
  return rows.filter((row) => row.groupKind === undefined && !parentIds.has(row.id));
}

export interface RenderFleetMenuOptions {
  focused?: boolean;
  selectedRowId?: string;
  spinnerIndex?: number;
  theme?: AgentLiveThemeLike;
  /** Retained for compatibility with older widgets; bare arrows are never fleet shortcuts. */
  emptyEditorFocusAvailable?: boolean;
  /** Shift+Down remains available when raw terminal Down cannot be used. */
  fallbackFocusAvailable?: boolean;
  /** Legacy combined capability flag; prefer the two explicit fields above. */
  focusShortcutsAvailable?: boolean;
}

/**
 * One row projection for passive and focused modes. Focus changes only the
 * two-column cursor prefix; the row text itself comes from AgentLivePanel in
 * both modes, so entering management mode cannot move or reformat the fleet.
 */
export function renderFleetMenuRows(
  sourceRows: AgentLiveRow[],
  width: number,
  options: RenderFleetMenuOptions = {},
): string[] {
  const rows = selectFleetMenuRows(withWorkflowGroupTokenTotals(sourceRows));
  if (rows.length === 0) return [];
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
  const panel = new AgentLivePanel({
    ...(options.spinnerIndex !== undefined ? { spinnerIndex: options.spinnerIndex } : {}),
    ...(options.theme !== undefined ? { theme: options.theme } : {}),
  });
  const focused = options.focused === true;
  const selectedRowId = options.selectedRowId;
  const lines = rows.flatMap((row) => {
    const projected = panel.renderRows([row], Math.max(1, safeWidth - 2));
    return projected.map((line, index) => {
      const prefix = index === 0 && focused && row.groupKind === undefined && row.id === selectedRowId ? "▸ " : "  ";
      return truncateToWidth(`${prefix}${line}`, safeWidth);
    });
  });
  const hidden = Math.max(0, sourceRows.length - rows.length);
  if (hidden > 0) lines.push(truncateToWidth(`  … and ${hidden} more`, safeWidth));
  const selected = rows.find((row) => row.groupKind === undefined && row.id === selectedRowId);
  const focusedHint = [
    safeKeyHint("tui.select.confirm", "drill", "enter drill"),
    ...(selected?.status === "working" ? [safeRawKeyHint("x", "stop")] : []),
    safeKeyHint("tui.select.cancel", "back", "esc back"),
  ].join(" · ");
  const legacyAvailability = options.focusShortcutsAvailable === true;
  const fallbackFocusAvailable = options.fallbackFocusAvailable ?? legacyAvailability;
  const passiveControls = [
    ...(fallbackFocusAvailable ? [safeRawKeyHint(FLEET_FOCUS_FALLBACK_SHORTCUT, "manage")] : []),
  ];
  const hint = focused
    ? focusedHint
    : passiveControls.length === 0
      ? "fleet manage unavailable on this host"
      : passiveControls.join(" · ");
  // Footer belongs to the belowEditor widget in BOTH modes. The custom focus
  // component captures keys only; moving the footer into it would move controls
  // into the editor's screen slot and violate the no-jump projection contract.
  lines.push(truncateToWidth(`  ${hint}`, safeWidth));
  return lines;
}

/** Editor-replacement component: it captures keys but renders only controls. */
export class FleetFocusComponent implements CustomUiComponent {
  constructor(
    private readonly rows: () => AgentLiveRow[],
    private readonly keybindings: unknown,
    private readonly tui: CustomUiTui,
    private readonly done: (action: FleetMenuAction) => void,
  ) {}

  render(width: number): string[] {
    void width;
    return [];
  }

  handleInput(data: string): void {
    const rows = selectFleetMenuRows(this.rows());
    fleetMenuState.setVisibleRows(rows);
    if (matchesConfigured(this.keybindings, data, "tui.select.up", Key.up)) {
      fleetMenuState.move(-1, rows);
      this.tui.requestRender();
      return;
    }
    if (matchesConfigured(this.keybindings, data, "tui.select.down", Key.down)) {
      fleetMenuState.move(1, rows);
      this.tui.requestRender();
      return;
    }
    if (matchesConfigured(this.keybindings, data, "tui.select.confirm", Key.enter)) {
      const rowId = fleetMenuState.selectedRowId;
      if (rowId !== undefined) this.done({ kind: "drill", rowId });
      return;
    }
    if (data === "x") {
      const row = rows.find((candidate) => candidate.id === fleetMenuState.selectedRowId);
      if (row !== undefined && row.groupKind === undefined && row.status === "working") this.done({ kind: "stop", rowId: row.id });
      this.tui.requestRender();
      return;
    }
    if (matchesConfigured(this.keybindings, data, "tui.select.cancel", Key.escape)) {
      this.done({ kind: "close" });
    }
  }

  invalidate(): void {
    // Projection is read lazily from the shared store; no render cache to clear.
  }
}

function preferredInitialRow(rows: AgentLiveRow[]): AgentLiveRow | undefined {
  const selectableRows = selectFleetMenuLeafRows(rows);
  return selectableRows.find((row) => row.status === "working")
    ?? selectableRows.find((row) => row.status === "queued")
    ?? selectableRows.at(-1);
}

function matchesConfigured(
  value: unknown,
  data: string,
  keybinding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
  fallback: KeyId,
): boolean {
  if (isKeybindingsLike(value)) return value.matches(data, keybinding);
  return data === fallback || matchesKey(data, fallback);
}

function isKeybindingsLike(value: unknown): value is KeybindingsLike {
  return isRecord(value) && typeof value.matches === "function";
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function safeKeyHint(
  keybinding: "tui.select.confirm" | "tui.select.cancel",
  description: string,
  fallback: string,
): string {
  try {
    return keyHint(keybinding, description);
  } catch {
    // Headless/unit hosts do not initialize Pi's global theme. The component is
    // still renderable, while interactive Pi takes the configured keyHint path.
    return fallback;
  }
}

function safeRawKeyHint(key: string, description: string): string {
  try {
    return rawKeyHint(key, description);
  } catch {
    return `${key} ${description}`;
  }
}
