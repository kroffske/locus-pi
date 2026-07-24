import type { CustomUiFactory, ExtensionContext } from "./pi-api.js";

/**
 * Canonical blocking interaction surface for locus-pi.
 *
 * Pi's non-overlay custom UI replaces the editor container, so the interaction
 * stays anchored at the command line and disappears when `done()` resolves.
 * Raw overlay mode is deliberately centralized away from feature callers:
 * overlays cover scrollback and can leave the triggering key on a competing
 * global route while the focused component is closing.
 */
export const INLINE_OPERATOR_INTERACTION_OPTIONS = Object.freeze({
  overlay: false as const,
});

export async function requestInlineOperatorInteraction<T>(
  ctx: ExtensionContext,
  factory: CustomUiFactory<T>,
): Promise<T> {
  const custom = ctx.ui.custom;
  if (custom === undefined) {
    throw new Error("Inline operator interaction is unavailable because this Pi host does not expose custom UI.");
  }
  return await (custom.call(ctx.ui, factory, INLINE_OPERATOR_INTERACTION_OPTIONS) as Promise<T>);
}
