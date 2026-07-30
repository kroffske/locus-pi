/**
 * extensions/plan/operator-surface.ts — the ctx-bound writes this extension
 * makes to its three widget keys (`plan`, `goal`, and the prompt-shelf key) and
 * to the `plan.mode` status lane, plus the one-time install of the mode-aware
 * input editor whose border tracks plan mode. Pure block construction stays in
 * the `-ui` modules.
 */

import type { ExtensionContext } from "../_shared/host/pi-api.js";
import { clearOperatorStatus, setOperatorStatus } from "../_shared/operator/operator-status.js";
import type { OperatorBlock } from "../_shared/operator/operator-ui.js";
import { setOperatorWidget } from "../_shared/operator/widget-render.js";
import {
  type ModeState,
  isInPlanMode,
  makeModeAwareEditorClass,
  modeStatusLabel,
  PLAN_MODE_COLOR,
} from "./mode-state.js";
import type { PromptShelfKind } from "./command-parser.js";

export function setPlanOperatorBlock(
  ctx: ExtensionContext,
  block: OperatorBlock,
  placement?: "aboveEditor" | "belowEditor",
): void {
  setOperatorWidget(ctx, "plan", block, placement === undefined ? {} : { placement });
}

export function setGoalOperatorBlock(
  ctx: ExtensionContext,
  block: OperatorBlock,
  placement?: "aboveEditor" | "belowEditor",
): void {
  setOperatorWidget(ctx, "goal", block, placement === undefined ? {} : { placement });
}

export function setPromptShelfOperatorBlock(
  ctx: ExtensionContext,
  key: PromptShelfKind,
  block: OperatorBlock,
  placement?: "aboveEditor" | "belowEditor",
): void {
  setOperatorWidget(ctx, key, block, placement === undefined ? {} : { placement });
}

// ---------------------------------------------------------------------------
// Mode-aware UI state (status badge + input border color)
// ---------------------------------------------------------------------------

/**
 * Whether the input editor should render its plan-mode border color. Read live by
 * the mode-aware editor's border getter, so flipping it (then triggering a render
 * via setStatus) recolors the input. Module-level because it is shared between the
 * editor factory closure and the mode-change handlers.
 */
let planBorderActive = false;
/** Guards the one-time install of the mode-aware editor component. */
let editorInstalled = false;
const PLAN_MODE_STATUS_ID = "plan.mode";

type EditorBase = new (...args: any[]) => any;
type EditorBaseLoader = () => Promise<EditorBase | undefined>;

/**
 * Resolve Pi's `CustomEditor` base class at runtime. The specifier is widened to
 * `string` so tsc/bundlers do not require the host package as a dependency (it is
 * resolved by Pi's loader at runtime). Returns undefined when unavailable.
 */
const defaultEditorBaseLoader: EditorBaseLoader = async () => {
  const mod: any = await import("@earendil-works/pi-coding-agent" as string);
  return mod?.CustomEditor as EditorBase | undefined;
};
let editorBaseLoader: EditorBaseLoader = defaultEditorBaseLoader;

/** Test seam: override how the editor base class is resolved (null restores default). */
export function __setEditorBaseLoaderForTests(loader: EditorBaseLoader | null): void {
  editorBaseLoader = loader ?? defaultEditorBaseLoader;
}

/** Test seam: reset module-level mode-UI state between tests. */
export function __resetModeUiStateForTests(): void {
  planBorderActive = false;
  editorInstalled = false;
  editorBaseLoader = defaultEditorBaseLoader;
}

/**
 * Set (or clear) the mode status badge AND the input-border flag from a mode
 * state, in one place. The badge is styled via the live theme when present (plain
 * text otherwise); the border flag is read by the mode-aware editor on next render.
 */
export function setModeStatus(ctx: ExtensionContext, state: ModeState | null): void {
  planBorderActive = isInPlanMode(state);
  const label = modeStatusLabel(state);
  // Clear the pre-M02 key while installed sessions migrate to the shared
  // bounded status registry.
  ctx.ui.setStatus("mode", undefined);
  if (label === undefined) {
    clearOperatorStatus(ctx, PLAN_MODE_STATUS_ID);
    return;
  }
  setOperatorStatus(ctx, {
    id: PLAN_MODE_STATUS_ID,
    lane: "route",
    priority: 60,
    wide: `MODE ${label}`,
    compact: "MODE plan",
    narrow: "PLAN",
    tone: PLAN_MODE_COLOR,
  });
}

/**
 * Install the mode-aware input editor once, so its border color tracks plan mode.
 * No-op when the UI cannot host a custom editor (non-interactive mode, missing
 * theme, or unavailable host editor base) — the default editor stays in place.
 */
export async function ensureModeAwareEditor(ctx: ExtensionContext): Promise<void> {
  if (editorInstalled) return;
  if (ctx.mode !== "tui" || ctx.hasUI === false) return;
  const ui = ctx.ui;
  if (typeof ui.setEditorComponent !== "function" || !ui.theme) return;
  const theme = ui.theme;
  let Base: EditorBase | undefined;
  try {
    Base = await editorBaseLoader();
  } catch {
    return;
  }
  if (typeof Base !== "function") return;
  const planColor = (str: string) => theme.fg(PLAN_MODE_COLOR, str);
  const ModeAwareEditor = makeModeAwareEditorClass(Base, planColor, () => planBorderActive);
  ui.setEditorComponent((tui, editorTheme, keybindings) => new ModeAwareEditor(tui, editorTheme, keybindings));
  editorInstalled = true;
}
