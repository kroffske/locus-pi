/**
 * extensions/_shared/operator/viewer-geometry.ts — Geometry every scrollable TUI viewer
 * recomputes on each render.
 *
 * A `CustomUiComponent` renders into a terminal whose height it cannot trust:
 * `tui.terminal.rows` may be absent, non-numeric, or fractional depending on the
 * host, and every viewer clamps its scroll offset into a valid range. Four
 * viewers across two extensions had grown identical private copies of both
 * answers. The differing numbers — how many rows are a usable minimum, what to
 * assume when the terminal reports nothing — stay with the caller, because those
 * are per-viewer layout decisions rather than shared geometry.
 *
 * Rendering, key handling, and scroll policy stay in the viewer.
 */

/** The value confined to `[min, max]`. Identical to the private copies it replaces. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The shape a viewer needs off its host `tui` handle; both `CustomUiTui` and the agents viewer handle satisfy it. */
export interface TerminalRowsSource {
  terminal?: { rows?: number } | undefined;
}

/**
 * The usable terminal height: the reported row count floored and held at
 * `minimumRows`, or `fallbackRows` when the host reports nothing usable.
 */
export function terminalRows(tui: TerminalRowsSource, minimumRows: number, fallbackRows: number): number {
  const rows = tui.terminal?.rows;
  return typeof rows === "number" && Number.isFinite(rows) ? Math.max(minimumRows, Math.floor(rows)) : fallbackRows;
}

const VIEWER_EXTERNAL_ROWS_KEY = Symbol.for("locus-pi.viewer-external-rows.v1");

interface ViewerExternalRowsRegistry {
  readonly rowsByOwner: Map<string, number>;
}

function viewerExternalRowsRegistry(): ViewerExternalRowsRegistry {
  const root = globalThis as typeof globalThis & { [VIEWER_EXTERNAL_ROWS_KEY]?: ViewerExternalRowsRegistry };
  const existing = root[VIEWER_EXTERNAL_ROWS_KEY];
  if (existing !== undefined) return existing;
  const created: ViewerExternalRowsRegistry = { rowsByOwner: new Map() };
  Object.defineProperty(root, VIEWER_EXTERNAL_ROWS_KEY, {
    value: created,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return created;
}

/** Publish rows that remain outside a focused custom viewer (for example a below-editor workflow widget). */
export function setViewerExternalRows(owner: string, rows: number): void {
  const normalized = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  if (normalized === 0) viewerExternalRowsRegistry().rowsByOwner.delete(owner);
  else viewerExternalRowsRegistry().rowsByOwner.set(owner, normalized);
}

export function clearViewerExternalRows(owner: string): void {
  viewerExternalRowsRegistry().rowsByOwner.delete(owner);
}

/** Total rows Pi still renders above/below the editor container replaced by ctx.ui.custom(). */
export function viewerExternalRows(): number {
  return [...viewerExternalRowsRegistry().rowsByOwner.values()].reduce((total, rows) => total + rows, 0);
}
