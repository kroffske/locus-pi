import { agentLiveStore } from "../_shared/agent-sdk-host.js";
import { hasDismissibleCommandView } from "../_shared/command-ui.js";
import { fleetMenuState } from "../_shared/fleet-menu.js";
import type { ExtensionContext } from "../_shared/pi-api.js";
import { hasActiveAgentSessionViewer } from "./session-viewer.js";

const guardByUi = new WeakMap<object, () => void>();

/** Intercept Pi's global app.interrupt Escape only while a visible agent run is active. */
export function installAgentInterruptGuard(ctx: ExtensionContext): void {
  guardByUi.get(ctx.ui)?.();
  guardByUi.delete(ctx.ui);
  if (
    ctx.mode !== "tui" ||
    ctx.hasUI !== true ||
    typeof ctx.abort !== "function" ||
    typeof ctx.ui.onTerminalInput !== "function"
  ) return;

  let confirmationOpen = false;
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!isEscapeInput(data) || confirmationOpen) return undefined;
    if (ctx.isIdle() || activeAgentRows().length === 0) return undefined;
    // These surfaces own Escape as "close/back". Let their component or the
    // shared transient-view listener consume it; closing a view never aborts.
    if (fleetMenuState.focused || hasActiveAgentSessionViewer() || hasDismissibleCommandView(ctx)) return undefined;

    confirmationOpen = true;
    const activeCount = activeAgentRows().length;
    void ctx.ui.confirm(
      "Interrupt agent operation?",
      `This will request cancellation for ${activeCount} active agent${activeCount === 1 ? "" : "s"}. Continue?`,
    ).then((confirmed) => {
      confirmationOpen = false;
      if (!confirmed) {
        ctx.ui.notify("Agent operation continues.", "info");
        return;
      }
      ctx.abort?.();
      ctx.ui.notify("Agent cancellation requested.", "warning");
    }).catch(() => {
      confirmationOpen = false;
      ctx.ui.notify("Agent operation continues; confirmation could not be opened.", "warning");
    });
    return { consume: true };
  });
  guardByUi.set(ctx.ui, unsubscribe);
}

function activeAgentRows() {
  return [...agentLiveStore.rows.values()].filter((row) => row.status === "working" || row.status === "queued");
}

function isEscapeInput(data: string): boolean {
  return data === "escape" || data === "\u001b";
}
