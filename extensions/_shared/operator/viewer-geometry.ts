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
