/**
 * extensions/agents/fleet-menu-controller.ts — the interactive fleet (`/ps` with no
 * target). Owns the per-session ownership epoch that keeps a late menu result from
 * acting on a reloaded session, and the open → select → drill/stop/close flow.
 */
import { agentLiveStore } from "../_shared/agent-sdk-host.js";
import {
  FleetFocusComponent,
  fleetMenuState,
  isFleetRowStoppable,
  selectFleetMenuRows,
} from "../_shared/fleet-menu.js";
import {
  isStaleInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
} from "../_shared/operator-interaction.js";
import type { ExtensionCommandContext, ExtensionContext } from "../_shared/pi-api.js";
import { setOperatorWidget } from "../_shared/widget-render.js";
import { coerceTheme } from "../workflows/progress-widget.js";
import { executeAgentDrillCommand, type AgentSessionAuthority } from "./drill-command.js";
import { AGENTS_WIDGET_KEY, notifyActiveAgentsContinue, notifyInteractionEnded } from "./operator-surface.js";

export interface AgentFleetMenuController {
  /** Open the fleet for this session, replacing any menu an earlier open still owns. */
  open(ctx: ExtensionContext): Promise<void>;
  /** Drop ownership of any open menu — a session start/shutdown must not leave one live. */
  invalidate(): void;
}

export function createAgentFleetMenuController(agentSessionAuthority: AgentSessionAuthority): AgentFleetMenuController {
  const fleetFocusComponents = new Set<FleetFocusComponent>();
  let fleetMenuEpoch = 0;
  let currentFleetMenuOwner: symbol | undefined;
  const invalidateFleetMenuOwnership = (): void => {
    fleetMenuEpoch += 1;
    currentFleetMenuOwner = undefined;
    for (const component of fleetFocusComponents) component.dispose();
    fleetFocusComponents.clear();
    fleetMenuState.setFocused(false);
    fleetMenuState.setVisibleRows([]);
  };
  const open = (ctx: ExtensionContext): Promise<void> => {
    invalidateFleetMenuOwnership();
    const owner = Symbol("fleet-menu-owner");
    const epoch = fleetMenuEpoch;
    currentFleetMenuOwner = owner;
    const release = (): boolean => {
      if (currentFleetMenuOwner !== owner || fleetMenuEpoch !== epoch) return false;
      currentFleetMenuOwner = undefined;
      return true;
    };
    const finish = (): void => {
      if (!release()) return;
      fleetMenuState.setFocused(false);
      fleetMenuState.setVisibleRows([]);
    };
    const ownership = {
      isCurrent: () => currentFleetMenuOwner === owner && fleetMenuEpoch === epoch,
      finish,
    };
    return openFleetMenu(ctx, fleetFocusComponents, ownership, agentSessionAuthority).finally(finish);
  };
  return { open, invalidate: invalidateFleetMenuOwnership };
}

async function openFleetMenu(
  ctx: ExtensionContext,
  fleetFocusComponents: Set<FleetFocusComponent>,
  ownership: { isCurrent(): boolean; finish(): void },
  agentSessionAuthority: AgentSessionAuthority,
): Promise<void> {
  if (ctx.mode !== "tui") {
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "WARN",
      subject: "Agent fleet focus",
      primary: `Interactive focus is unavailable in ${ctx.mode ?? "unknown"} mode.`,
      metadata: ["Passive agent rows remain available."],
      controls: ["Inspect: /agent observe · Drill: /agent drill <row-id|agent|last>"],
    });
    return;
  }
  if (ctx.hasUI !== true || ctx.ui.custom === undefined) {
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "WARN",
      subject: "Agent fleet focus",
      primary: "This Pi TUI host does not expose custom UI.",
      metadata: ["Passive agent rows remain available."],
      controls: ["Inspect: /agent observe · Drill: /agent drill <row-id|agent|last>"],
    });
    return;
  }
  const rows = () => [...agentLiveStore.rows.values()];
  const initialRows = selectFleetMenuRows(rows());
  if (initialRows.length === 0) {
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "VIEW",
      subject: "Agent fleet",
      primary: "No live agent rows.",
      controls: ["Catalog: /agent list"],
    });
    // A widget alone is easy to miss under a live workflow panel, and an
    // operator who sees nothing at all reads it as a broken command.
    ctx.ui.notify("/ps found no live agent rows.", "warning");
    return;
  }
  fleetMenuState.setVisibleRows(initialRows);
  fleetMenuState.setFocused(true);
  let component: FleetFocusComponent | undefined;
  const disposeComponent = (): void => {
    if (component === undefined) return;
    component.dispose();
    fleetFocusComponents.delete(component);
  };
  let action: { kind: "close" } | { kind: "drill"; rowId: string } | { kind: "stop"; rowId: string };
  try {
    try {
      action = await requestInlineOperatorInteraction(ctx, (tui, theme, keybindings, done) => {
        if (component !== undefined) {
          disposeComponent();
        }
        component = new FleetFocusComponent(rows, keybindings, tui, done, coerceTheme(theme));
        fleetFocusComponents.add(component);
        return component;
      });
    } catch (error) {
      if (isStaleInlineOperatorInteractionError(error)) {
        notifyInteractionEnded(ctx, error, "Agent fleet");
        return;
      }
      throw error;
    }
    disposeComponent();
    if (!ownership.isCurrent()) return;
    if (action.kind === "stop") {
      const cancellationAuthority = agentLiveStore.captureCancellationAuthority(action.rowId);
      const row = agentLiveStore.rows.get(action.rowId);
      if (!isFleetRowStoppable(row) || cancellationAuthority === undefined) {
        ctx.ui.notify(`Agent ${action.rowId} is no longer stoppable.`, "warning");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Stop agent?",
        `Stop ${row.displayName ?? row.agentName ?? row.id} — ${row.title ?? row.label}?`,
      );
      if (!ownership.isCurrent()) return;
      if (!confirmed) {
        ctx.ui.notify("Agent continues running.", "info");
        return;
      }
      const currentRow = agentLiveStore.rows.get(action.rowId);
      if (!isFleetRowStoppable(currentRow) || !agentLiveStore.isCancellationAuthorityCurrent(cancellationAuthority)) {
        ctx.ui.notify(`Agent ${action.rowId} is no longer stoppable.`, "warning");
        return;
      }
      if (agentLiveStore.cancelWithAuthority(cancellationAuthority))
        ctx.ui.notify("Agent cancellation requested.", "warning");
      else ctx.ui.notify(`Agent ${action.rowId} is no longer stoppable.`, "warning");
      return;
    }
    if (action.kind === "close") {
      notifyActiveAgentsContinue(ctx, "Agent menu closed.");
      return;
    }
    if (action.kind === "drill") {
      ownership.finish();
      await executeAgentDrillCommand(ctx as ExtensionCommandContext, { target: action.rowId }, agentSessionAuthority);
    }
  } finally {
    disposeComponent();
  }
}
