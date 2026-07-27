/**
 * extensions/agents/drill-command.ts — `/agent drill` / `/ps <target>`: resolve the
 * operator's target to exactly one live row, refuse honestly when it is missing,
 * a group summary, or ambiguous, and open the native session viewer on it with
 * the loop-round submenu the run journal supports.
 */
import { agentLiveStore } from "../_shared/agent-sdk-host.js";
import type { AgentLiveRow } from "../_shared/agent-sdk-host.js";
import { agentLiveShortId, formatAgentDrillTitle } from "../_shared/agent-live-panel.js";
import { newestWorkflowRunId, selectFleetMenuLeafRows } from "../_shared/fleet-menu.js";
import {
  isStaleInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
} from "../_shared/operator-interaction.js";
import type { ExtensionCommandContext } from "../_shared/pi-api.js";
import { getProjectRoot } from "../_shared/pi-api.js";
import { setOperatorWidget } from "../_shared/widget-render.js";
import {
  listWorkflowRoundsForSlot,
  readWorkflowRoundBody,
  workflowRunIdFromRowId,
} from "../_shared/workflow-journal.js";
import type { DrillRoundsConfig } from "./drill-overlay.js";
import { AGENTS_WIDGET_KEY, notifyInteractionEnded } from "./operator-surface.js";
import { AgentSessionViewer, loadAgentViewerCapability } from "./session-viewer.js";
import type { ParsedAgentDrillCommand } from "./command-parser.js";

export const AGENT_DRILL_USAGE = "Usage: /agent drill <row-id|agent|last>";

/**
 * The lease a drill holds on the session that asked for it: a reload must not let
 * a late-resolving viewer attach to the replacement session.
 */
export interface AgentSessionAuthority {
  capture(): number;
  isCurrent(authority: number): boolean;
}

export async function executeAgentDrillCommand(
  ctx: ExtensionCommandContext,
  command: ParsedAgentDrillCommand,
  sessionAuthority: AgentSessionAuthority,
): Promise<void> {
  const capturedSessionAuthority = sessionAuthority.capture();
  if (command.target === "") {
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "WARN",
      subject: "Agent drill",
      primary: "A row id, agent, or last target is required.",
      controls: [`Retry: ${AGENT_DRILL_USAGE.replace("Usage: ", "")}`],
    });
    return;
  }
  if (command.target.startsWith("--")) {
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "ERROR",
      subject: "Agent drill",
      primary: `Unknown /agent drill flag: ${command.target}`,
      controls: [`Retry: ${AGENT_DRILL_USAGE.replace("Usage: ", "")}`],
    });
    return;
  }
  if (ctx.mode !== "tui") {
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "WARN",
      subject: "Agent drill",
      primary: `Interactive drill is unavailable in ${ctx.mode ?? "unknown"} mode.`,
      metadata: ["Passive agent rows remain available."],
      controls: ["Inspect: /agent observe"],
    });
    return;
  }
  if (ctx.hasUI !== true || ctx.ui.custom === undefined) {
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "WARN",
      subject: "Agent drill",
      primary: "This Pi TUI host does not expose custom UI.",
      controls: ["Inspect: /agent observe"],
    });
    return;
  }
  const resolution = resolveAgentDrillTarget(command.target);
  if (!resolution.ok && resolution.reason === "not-found") {
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "ERROR",
      subject: "Agent drill",
      primary: `Agent drill target not found: ${command.target}`,
      controls: ["Recovery: /agent observe · /agent drill last"],
    });
    return;
  }
  if (!resolution.ok && resolution.reason === "aggregate") {
    const children = resolution.children.map((row) => {
      const anchor =
        row.parentRowId !== undefined && row.parentRowId !== resolution.row.id ? ` · via ${row.parentRowId}` : "";
      return `- ${formatAgentDrillTitle(row)} · ${row.id}${anchor}`;
    });
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "WARN",
      subject: "Agent drill",
      primary: `${formatAgentDrillTitle(resolution.row)} is a group summary; choose one child agent.`,
      ...(children.length > 0 ? { body: ["Children:", ...children] } : {}),
      controls: [
        children.length > 0
          ? `Open /ps and select a child, or run /ps ${resolution.children[0]!.id}.`
          : "Open /ps after the group creates a child row.",
      ],
    });
    return;
  }
  if (!resolution.ok) {
    const candidates = resolution.candidates.map((row) => `- ${formatAgentDrillTitle(row)} · ${row.id}`);
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "WARN",
      subject: "Agent drill",
      primary: `Agent drill target is ambiguous: ${command.target}`,
      body: ["Candidates:", ...candidates],
      controls: ["Retry with an exact row id, petname, or child session id."],
    });
    return;
  }
  const row = resolution.row;
  const executionAuthority = agentLiveStore.captureExecutionAuthority(row.id);
  if (executionAuthority === undefined) {
    // A row the store can no longer bind to an execution cannot be opened. It is
    // still a resolved target the operator asked for by name, so it says so
    // instead of returning to an unchanged screen.
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "WARN",
      subject: "Agent view",
      primary: `Agent ${row.displayName ?? row.agentName ?? row.id} is no longer attached to a session.`,
      metadata: ["Its live row was retired; persisted evidence is unaffected."],
      controls: ["Fleet: /ps · Catalog: /agent list"],
    });
    return;
  }
  const isCurrent = (): boolean =>
    sessionAuthority.isCurrent(capturedSessionAuthority) &&
    agentLiveStore.isExecutionAuthorityCurrent(executionAuthority);
  const capability = await loadAgentViewerCapability();
  if (!isCurrent()) return;
  if (!capability.ok) {
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
      type: "WARN",
      subject: "Agent viewer",
      primary: capability.reason,
      metadata: ["The agent continues running; no native transcript parity is claimed on this host."],
      controls: ["Fallback: /agent observe · Navigation: /agent ps"],
    });
    return;
  }
  const rounds = buildDrillRounds(ctx, row);
  if (!isCurrent()) return;
  let viewer: AgentSessionViewer | undefined;
  try {
    try {
      await requestInlineOperatorInteraction<void>(ctx, (tui, _theme, _keybindings, done) => {
        viewer = new AgentSessionViewer(executionAuthority, tui, done, capability.capability, rounds);
        return viewer;
      });
    } catch (error) {
      if (isStaleInlineOperatorInteractionError(error)) {
        notifyInteractionEnded(ctx, error, "Agent view");
        return;
      }
      throw error;
    }
  } finally {
    viewer?.dispose();
  }
  if (!isCurrent()) return;
  const current = agentLiveStore.rows.get(row.id);
  if (current?.status === "working" || current?.status === "queued") {
    ctx.ui.notify(
      `Agent view closed; ${current.displayName ?? current.agentName ?? current.id} continues running.`,
      "info",
    );
  }
}

/**
 * Build the drill rounds submenu config for a workflow loop-slot row (REQ-009), or undefined
 * when the row is not slotted or the run journal exposes ≤1 round (submenu hidden). The active
 * round is the live row's; past rounds are lazily read from the run journal on selection.
 */
function buildDrillRounds(ctx: ExtensionCommandContext, row: AgentLiveRow): DrillRoundsConfig | undefined {
  if (row.slotKey === undefined || row.round === undefined) return undefined;
  const runId =
    workflowRunIdFromRowId(row.id) ??
    (row.parentRowId !== undefined ? workflowRunIdFromRowId(row.parentRowId) : undefined);
  if (runId === undefined) return undefined;
  const projectRoot = getProjectRoot(ctx);
  const slotKey = row.slotKey;
  const list = [...new Set([...listWorkflowRoundsForSlot(projectRoot, runId, slotKey), row.round])].sort(
    (a, b) => a - b,
  );
  if (list.length <= 1) return undefined; // one round → no switcher
  return {
    active: row.round,
    list,
    readBody: (round: number) => readWorkflowRoundBody(projectRoot, runId, slotKey, round),
  };
}

type AgentDrillResolution =
  | { ok: true; row: AgentLiveRow }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "aggregate"; row: AgentLiveRow; children: AgentLiveRow[] }
  | { ok: false; reason: "ambiguous"; candidates: AgentLiveRow[] };

function resolveAgentDrillTarget(target: string): AgentDrillResolution {
  const exactRow = agentLiveStore.rows.get(target);
  const allRows = [...agentLiveStore.rows.values()];
  const descendants = exactRow === undefined ? [] : agentDescendants(exactRow.id, allRows);
  if (exactRow !== undefined && (exactRow.groupKind !== undefined || descendants.length > 0)) {
    return {
      ok: false,
      reason: "aggregate",
      row: exactRow,
      children: selectFleetMenuLeafRows(descendants),
    };
  }
  if (exactRow !== undefined) return { ok: true, row: exactRow };
  const rows = selectFleetMenuLeafRows(allRows);
  if (target.toLocaleLowerCase() === "last") {
    const last = rows.at(-1);
    return last === undefined ? { ok: false, reason: "not-found" } : { ok: true, row: last };
  }

  // Exact semantic identifiers win before any substring matching. Case is
  // normalized, but multiplicity is not hidden: duplicate agent names/labels or
  // colliding short ids require an explicit row id/petname/uuid from the user.
  const targetLower = target.toLocaleLowerCase();
  const exact = uniqueRows(
    rows.filter((row) =>
      [row.displayName, row.agentName, row.childSessionId, agentLiveShortId(row), row.label].some(
        (value) => value?.toLocaleLowerCase() === targetLower,
      ),
    ),
  );
  const exactResult = resolutionFromCandidates(exact);
  if (exactResult !== undefined) return exactResult;

  const needle = normalizeDrillToken(target);
  if (needle.length === 0) return { ok: false, reason: "not-found" };
  const fragments = uniqueRows(
    rows.filter((row) => {
      const sources = [row.displayName, row.childSessionId, row.id];
      if (target.length >= 3) sources.push(row.label);
      return sources.some((value) => value !== undefined && normalizeDrillToken(value).includes(needle));
    }),
  );
  return resolutionFromCandidates(fragments) ?? { ok: false, reason: "not-found" };
}

function agentDescendants(parentRowId: string, rows: readonly AgentLiveRow[]): AgentLiveRow[] {
  const childrenByParent = new Map<string, AgentLiveRow[]>();
  for (const row of rows) {
    if (row.parentRowId === undefined) continue;
    const children = childrenByParent.get(row.parentRowId) ?? [];
    children.push(row);
    childrenByParent.set(row.parentRowId, children);
  }
  const descendants: AgentLiveRow[] = [];
  const pending = [...(childrenByParent.get(parentRowId) ?? [])];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const row = pending.shift()!;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    descendants.push(row);
    pending.push(...(childrenByParent.get(row.id) ?? []));
  }
  return descendants;
}

function resolutionFromCandidates(candidates: AgentLiveRow[]): AgentDrillResolution | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return { ok: true, row: candidates[0]! };
  // An agent that ran again matches its own retained row from every earlier run
  // of the same workflow, which used to make its plain name ambiguous. The name
  // means the newest run — the one the operator is watching — and an earlier
  // run stays reachable through its own row id.
  const newestRunId = newestWorkflowRunId(candidates);
  if (newestRunId !== undefined && candidates.every((row) => row.workflowRunId !== undefined)) {
    const newest = candidates.filter((row) => row.workflowRunId === newestRunId);
    if (newest.length === 1) return { ok: true, row: newest[0]! };
  }
  return { ok: false, reason: "ambiguous", candidates };
}

function uniqueRows(rows: AgentLiveRow[]): AgentLiveRow[] {
  const byId = new Map<string, AgentLiveRow>();
  for (const row of rows) byId.set(row.id, row);
  return [...byId.values()];
}

function normalizeDrillToken(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
