import { relative } from "node:path";
import { Type } from "@sinclair/typebox";
import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CustomUiComponent, ExtensionAPI, ExtensionContext } from "../_shared/pi-api.js";
import {
  errorResult,
  getCommandText,
  getProjectRoot,
  getSessionId,
  setTextWidget,
  textResult,
} from "../_shared/pi-api.js";
import { validateParams } from "../_shared/validation.js";
import { pinTransientUiKey, registerCommandWithUiLifecycle, unpinTransientUiKey } from "../_shared/command-ui.js";
import { sharedState } from "../_shared/state.js";
import {
  discoverAgentDefinitions,
  formatAgentCatalogHint,
  formatAgentListItem,
  type AgentDiagnostic,
} from "../_shared/agents.js";
import { createAgentRunRequest, executeAgentRunBoundary, type ApprovalTier } from "../_shared/agent-runner.js";
import { createRuntimeArtifactStore } from "../_shared/artifacts.js";
import {
  AGENT_SDK_UNAVAILABLE_DIAGNOSTIC,
  agentLiveStore,
  createAgentSdkSessionExecutor,
} from "../_shared/agent-sdk-host.js";
import {
  agentLiveShortId,
  agentShortIdFromSource,
  formatAgentDrillTitle,
  formatAgentFinishedEventLine,
  formatAgentStartedEventLine,
} from "../_shared/agent-live-panel.js";
import {
  FLEET_FOCUS_FALLBACK_SHORTCUT,
  FleetFocusComponent,
  fleetMenuState,
  isFleetRowStoppable,
  newestWorkflowRunId,
  selectFleetMenuLeafRows,
  selectFleetMenuRows,
} from "../_shared/fleet-menu.js";
import {
  loadModelRolesState,
  resolveAgentModelPreference,
  type ModelRoleResolution,
} from "../_shared/model-settings.js";
import { resolveLiveModelDisplay } from "../_shared/live-model-display.js";
import type { ExtensionCommandContext } from "../_shared/pi-api.js";
import { registerAgentWorkloadProofHooks, writeAgentWorkloadProof } from "../_shared/agent-workload-proof.js";
import { coerceTheme, installWorkflowProgress, renderAgentObserverText } from "../workflows/progress-widget.js";
import {
  listWorkflowRoundsForSlot,
  readWorkflowRoundBody,
  workflowRunIdFromRowId,
} from "../_shared/workflow-journal.js";
import { ScrollableTextOverlay, type DrillRoundsConfig } from "./drill-overlay.js";
import { AgentSessionViewer, disposeAgentSessionViewers, loadAgentViewerCapability } from "./session-viewer.js";
import { installAgentInterruptGuard } from "./interrupt-guard.js";
import type { AgentLiveExecutionHandle, AgentLiveRow } from "../_shared/agent-sdk-host.js";
import type { AgentDefinition } from "../_shared/types.js";
import { renderOperatorBlockPlain, type OperatorBlock } from "../_shared/operator-ui.js";
import { setOperatorWidget } from "../_shared/widget-render.js";
import {
  isStaleInlineOperatorInteractionError,
  isSupersededInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
} from "../_shared/operator-interaction.js";

const AGENT_PARAM_BASE_DESCRIPTION =
  "Agent catalog name. Omit, use default, or use general to run task unless a project/user definition with that name exists.";
const AGENT_PARAM_CATALOG_HEADING = "Available agents (name — description):";

const TaskParams = Type.Object({
  agent: Type.Optional(Type.String({ description: AGENT_PARAM_BASE_DESCRIPTION })),
  task: Type.String({ description: "Self-contained subagent instructions", minLength: 1, maxLength: 16000 }),
  title: Type.Optional(
    Type.String({
      description: "Short work title shown in the live agent row; falls back to the first words of task",
      maxLength: 48,
    }),
  ),
  parentContext: Type.Optional(
    Type.Object({
      inline: Type.Optional(Type.String({ description: "Explicit parent-provided context text", maxLength: 32000 })),
      artifactPath: Type.Optional(Type.String({ description: "Path to an explicit parent context artifact" })),
    }),
  ),
});

const WorkloadProofParams = Type.Object({
  summary: Type.String({
    description: "Short description of the bounded child workload already performed",
    maxLength: 500,
  }),
});

const AGENT_RUN_USAGE =
  "Usage: /agent list | /agent inspect <name> | /agent run [--yes|--approve] [--title <title>] <name> <task>";
const AGENT_DRILL_USAGE = "Usage: /agent drill <row-id|agent|last>";
const AGENT_OBSERVER_USAGE = "Usage: /agent observe | /agent summary";
const AGENT_COMMAND_USAGE =
  "Usage: /agent list | /agent inspect <name> | /agent run [--yes|--approve] <name> <task> | /agent drill <row-id|agent|last> | /agent observe | /agent summary";
const PS_USAGE = "Usage: /ps [row-id|agent|last]";
const AGENTS_WIDGET_KEY = "agents";
const AGENTS_WIDGET_MAX_LINES = 10;
const AGENTS_WIDGET_FALLBACK_WIDTH = 80;
const DEFAULT_TASK_AGENT_NAME = "task";
const BUILT_IN_AGENT_ALIASES = { default: DEFAULT_TASK_AGENT_NAME, general: DEFAULT_TASK_AGENT_NAME } as const;

type CommandApprovalTier = "prompt" | "allow";

interface ParsedAgentRunCommand {
  name: string;
  task: string;
  approvalTier: CommandApprovalTier;
  title?: string;
}

interface ParsedAgentDrillCommand {
  target: string;
}

interface ParsedAgentObserverCommand {
  target: "observe" | "summary";
}

interface AgentResolution {
  requestedAgent: string;
  resolvedAgent: string;
  agent: AgentDefinition;
  aliasApplied?: string;
}

interface UnknownAgentReport {
  text: string;
  block: OperatorBlock;
  details: Record<string, unknown>;
  artifactPath?: string;
}

interface AgentSessionAuthority {
  capture(): number;
  isCurrent(authority: number): boolean;
}

/** Registers safe catalog commands and fail-closed agent execution tools. */
export default function agents(pi: ExtensionAPI): void {
  registerAgentWorkloadProofHooks(pi);
  let agentSessionEpoch = 0;
  const agentSessionAuthority: AgentSessionAuthority = {
    capture: () => agentSessionEpoch,
    isCurrent: (authority) => authority === agentSessionEpoch,
  };
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
  const openSessionFleetMenu = (ctx: ExtensionContext): Promise<void> => {
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
  const fallbackFocusRegistered = registerFleetShortcut(pi, openSessionFleetMenu);
  // A fresh/reloaded Pi session used to get a fresh module-local store. Preserve
  // that lifecycle now that the store is process-shared across package entrypoints.
  pi.on("session_start", (_event, ctx) => {
    agentSessionEpoch += 1;
    disposeAgentSessionViewers();
    invalidateFleetMenuOwnership();
    agentLiveStore.reset();
    installAgentInterruptGuard(ctx);
    fleetMenuState.setFallbackFocusAvailable(ctx.mode === "tui" && fallbackFocusRegistered);
    // Parent Pi owns bare Up/Down. Fleet entry is explicit via /ps or shift+down.
    fleetMenuState.setEmptyEditorFocusAvailable(false);
    warnOnPsCollision(pi, ctx);
  });
  pi.on("session_shutdown", () => {
    agentSessionEpoch += 1;
    invalidateFleetMenuOwnership();
  });
  // The catalog the caller reads must be current at the moment it picks a name,
  // not at the moment it calls: refresh before the turn, exactly like the other
  // refreshAgents call sites do before a command or a tool body runs.
  pi.on("before_agent_start", (_event, ctx) => {
    refreshAgents(getProjectRoot(ctx));
  });
  pi.registerTool({
    name: "locus_workload_proof",
    description:
      "Record diagnostic evidence that an SDK child agent claims bounded workload. This does not make a parser-clean result successful by itself.",
    parameters: WorkloadProofParams,
    approval: "write",
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(WorkloadProofParams, params);
      if (!valid.ok) return valid.result;
      const proofPath = writeAgentWorkloadProof(ctx, "locus_workload_proof");
      return textResult(`Workload proof recorded: ${valid.value.summary}`, {
        proofPath,
        source: "locus-workload-proof",
      });
    },
  });
  // Shared spawn-a-subagent execution. Registered under two names: the
  // model-friendly primary `spawn_agent` and the back-compat alias `task`.
  // Both route through the same createAgentSession host + honesty-gate and
  // report requestedSurface:"task" internally so existing detail-shape tests
  // are unaffected. Only the registered tool name differs.
  const spawnAgentExecute: Parameters<ExtensionAPI["registerTool"]>[0]["execute"] = async (
    _toolCallId,
    params,
    signal,
    _update,
    ctx,
  ) => {
    const valid = validateParams(TaskParams, params);
    if (!valid.ok) return valid.result;
    refreshAgents(getProjectRoot(ctx));
    return runTaskTool(
      pi,
      ctx,
      signal,
      valid.value.agent,
      valid.value.task,
      valid.value.title,
      valid.value.parentContext,
    );
  };
  pi.registerTool({
    name: "spawn_agent",
    description:
      "Spawn one subagent to run one self-contained task in a headless child agent session. Pick a .agents catalog agent or omit for the default. Successful content is the child's exact final text.",
    parameters: TaskParams,
    approval: "exec",
    formatApprovalDetails: taskApprovalDetails,
    execute: spawnAgentExecute,
  });
  pi.registerTool({
    name: "task",
    description:
      "Run one local .agents catalog agent on one task in a headless child agent session. Successful content is the child's exact final text.",
    parameters: TaskParams,
    approval: "exec",
    formatApprovalDetails: taskApprovalDetails,
    execute: spawnAgentExecute,
  });
  registerCommandWithUiLifecycle(
    pi,
    {
      command: "ps",
      group: "agents",
      surfaces: ["transient-widget", "overlay-selector"],
      transientWidgets: [AGENTS_WIDGET_KEY],
      transientStatuses: [AGENTS_WIDGET_KEY],
    },
    {
      description: "Open the agent fleet or view one live/recent agent.",
      handler: async (args, ctx) => {
        clearAgentsTransient(ctx);
        const target = parsePsTarget(getCommandText(args));
        if (target === undefined) {
          setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
            type: "WARN",
            subject: "Agent processes",
            primary: "A single row id, agent, or last target is required.",
            controls: [PS_USAGE],
          });
          return;
        }
        if (target === "") await openSessionFleetMenu(ctx);
        else await executeAgentDrillCommand(ctx as ExtensionCommandContext, { target }, agentSessionAuthority);
      },
    },
  );
  registerCommandWithUiLifecycle(
    pi,
    {
      command: "agent",
      group: "agents",
      surfaces: ["transient-widget", "status", "overlay-selector", "artifact-write"],
      transientWidgets: [AGENTS_WIDGET_KEY],
      transientStatuses: [AGENTS_WIDGET_KEY],
    },
    {
      description: "List, inspect, run, observe, summary, or drill into agent definitions and live rows.",
      handler: async (args, ctx) => {
        const discovery = refreshAgents(getProjectRoot(ctx));
        clearAgentsStatus(ctx);
        const text = getCommandText(args).trim();
        if (text === "list" || text === "") {
          const catalog = [...sharedState.agents.values()];
          const fullBlock = agentCatalogBlock(catalog, discovery.diagnostics);
          if (await renderAgentBlockInteraction(ctx as ExtensionCommandContext, fullBlock)) return;
          setOperatorWidget(
            ctx,
            AGENTS_WIDGET_KEY,
            agentCatalogBlock(catalog, discovery.diagnostics, AGENT_CATALOG_FALLBACK_ROWS),
          );
          return;
        }
        const inspectMatch = /^inspect\s+(\S+)/.exec(text);
        if (inspectMatch) {
          const agent = sharedState.agents.get(inspectMatch[1]!);
          if (agent !== undefined) {
            const fullBlock = agentInspectBlock(agent);
            if (await renderAgentBlockInteraction(ctx as ExtensionCommandContext, fullBlock)) return;
            setOperatorWidget(ctx, AGENTS_WIDGET_KEY, ctx.mode === "tui" ? fullBlock : agentInspectBlock(agent, true));
          } else {
            const report = createUnknownAgentReport(ctx, "agent-inspect", inspectMatch[1]!);
            setOperatorWidget(ctx, AGENTS_WIDGET_KEY, report.block);
          }
          return;
        }
        const drillCommand = parseAgentDrillCommand(text);
        if (drillCommand !== undefined) {
          clearAgentsTransient(ctx);
          await executeAgentDrillCommand(ctx as ExtensionCommandContext, drillCommand, agentSessionAuthority);
          return;
        }
        const psTarget = parseAgentPsCommand(text);
        if (psTarget !== undefined) {
          clearAgentsTransient(ctx);
          if (psTarget === "") await openSessionFleetMenu(ctx);
          else
            await executeAgentDrillCommand(ctx as ExtensionCommandContext, { target: psTarget }, agentSessionAuthority);
          return;
        }
        const observerCommand = parseAgentObserverCommand(text);
        if (observerCommand !== undefined) {
          const observerText = renderAgentObserverText();
          clearAgentsStatus(ctx);
          setAgentsWidget(ctx, observerText);
          return;
        }
        const runCommand = parseAgentRunCommand(text);
        if (runCommand === undefined) {
          const usage = text.startsWith("run")
            ? AGENT_RUN_USAGE
            : text.startsWith("observe") || text.startsWith("summary")
              ? AGENT_OBSERVER_USAGE
              : AGENT_COMMAND_USAGE;
          setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
            type: "WARN",
            subject: "Agent command",
            primary: text === "" ? "An agent action is required." : `Unknown or incomplete /agent action: ${text}`,
            metadata: ["No agent run, catalog mutation, or live control action was attempted."],
            controls: [usage],
          });
          return;
        }
        await executeAgentRunCommand(
          pi,
          ctx as ExtensionCommandContext,
          runCommand.name,
          runCommand.task,
          runCommand.approvalTier,
          runCommand.title,
        );
      },
    },
  );
}

function warnOnPsCollision(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (typeof pi.getCommands !== "function") return;
  let commands: ReturnType<NonNullable<ExtensionAPI["getCommands"]>>;
  try {
    commands = pi.getCommands();
  } catch {
    return;
  }
  // Pi disambiguates duplicate extension commands as ps:1, ps:2, ... .
  const psCommands = commands.filter((command) => /^ps(?::\d+)?$/u.test(command.name));
  if (psCommands.length <= 1) return;
  ctx.ui.notify(
    `Multiple /ps commands are loaded (${psCommands.map((command) => command.name).join(", ")}). Use /agent ps as the stable Locus fallback.`,
    "warning",
  );
}

function registerFleetShortcut(pi: ExtensionAPI, handler: (ctx: ExtensionContext) => Promise<void>): boolean {
  const registerShortcut = pi.registerShortcut;
  if (registerShortcut === undefined) {
    return false;
  }
  try {
    registerShortcut.call(pi, FLEET_FOCUS_FALLBACK_SHORTCUT, {
      description: "Focus the agent fleet menu (fallback when the editor is not empty-editor aware)",
      handler,
    });
    return true;
  } catch {
    return false;
  }
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

function taskApprovalDetails(args: unknown): string[] {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const agent = String(record.agent ?? DEFAULT_TASK_AGENT_NAME);
  return [`Agent: ${agent}`, "Tasks: 1"];
}

/**
 * Routes a catalog text surface (list/inspect) through the inline scrollable
 * interaction when the host exposes custom UI, so output is never silently
 * clipped to AGENTS_WIDGET_MAX_LINES. Returns true when the interaction was
 * used; false signals the caller to fall back to the bounded text widget,
 * exactly as /agent drill does for headless hosts.
 */
async function renderAgentBlockInteraction(ctx: ExtensionCommandContext, block: OperatorBlock): Promise<boolean> {
  if (ctx.mode !== "tui" || ctx.hasUI !== true || ctx.ui.custom === undefined) return false;
  const [title = `[${block.type}] ${block.subject}`, ...lines] = renderOperatorBlockPlain(
    block,
    AGENTS_WIDGET_FALLBACK_WIDTH,
  );
  clearAgentsTransient(ctx);
  try {
    await requestInlineOperatorInteraction<void>(
      ctx,
      (tui, _theme, _keybindings, done) => new ScrollableTextOverlay(title, () => lines, tui, done),
    );
  } catch (error) {
    if (isStaleInlineOperatorInteractionError(error)) {
      // The scroll surface never made it to the screen, and the transient widget
      // was already cleared for it. Reporting success here left the operator with
      // a blank screen and no catalog at all, so the bounded widget renders
      // instead — the same fallback a host without custom UI gets.
      notifyInteractionEnded(ctx, error, "Agent catalog");
      return false;
    }
    throw error;
  }
  return true;
}

const AGENT_CATALOG_FALLBACK_ROWS = 2;

function agentCatalogBlock(
  catalog: readonly AgentDefinition[],
  diagnostics: readonly AgentDiagnostic[],
  previewLimit?: number,
): OperatorBlock {
  const sourceCounts = { project: 0, user: 0, bundled: 0, workflow: 0 };
  for (const agent of catalog) sourceCounts[agent.source ?? "bundled"] += 1;
  const shown = previewLimit === undefined ? catalog : catalog.slice(0, previewLimit);
  const hidden = catalog.length - shown.length;
  return {
    type: "VIEW",
    subject: "Agent catalog",
    primary: `${catalog.length} loaded definition(s).`,
    body:
      catalog.length === 0
        ? ["No loaded agent definitions."]
        : [
            ...shown.map((agent) =>
              previewLimit === undefined
                ? formatAgentListItem(agent)
                : compactAgentCatalogLine(`${agent.name} [${agent.source ?? "bundled"}] · ${agent.description}`),
            ),
            ...(hidden > 0 ? [`+${hidden} definition(s) hidden`] : []),
          ],
    metadata: [
      `Sources: project=${sourceCounts.project} user=${sourceCounts.user} bundled=${sourceCounts.bundled}`,
      ...(diagnostics.length === 0
        ? []
        : [
            compactAgentCatalogLine(
              `Diagnostics: ${diagnostics.length} issue(s); first: ${diagnostics[0]?.message ?? "unknown"}`,
            ),
          ]),
    ],
    controls: ["Inspect: /agent inspect <name> · Run: /agent run <name> <task>"],
  };
}

function agentInspectBlock(agent: AgentDefinition, compact = false): OperatorBlock {
  if (compact) {
    return {
      type: "VIEW",
      subject: "Agent definition",
      primary: compactAgentCatalogLine(`${agent.name}: ${agent.description}`),
      badges: [
        { text: agent.source ?? "unknown", tone: "muted" },
        { text: `risk:${agent.risk}`, tone: agent.risk === "high" ? "warning" : "muted" },
      ],
      body: [
        compactAgentCatalogLine(`tools: ${agent.allowedTools.join(", ")}`),
        `readOnly: ${String(agent.readOnly)} · risk: ${agent.risk}`,
        compactAgentCatalogLine(
          `model: ${agent.model?.join(", ") || "host default"} · thinking: ${agent.thinkingLevel ?? "host default"}`,
        ),
      ],
      metadata: [
        `source: ${agent.source ?? "unknown"}`,
        compactAgentCatalogLine(`file: ${agent.filePath ?? "unknown"}`),
      ],
      controls: [`Run: /agent run ${agent.name} <task> · Catalog: /agent list`],
    };
  }
  return {
    type: "VIEW",
    subject: "Agent definition",
    primary: `${agent.name}: ${agent.description}`,
    badges: [
      { text: agent.source ?? "unknown", tone: "muted" },
      { text: `risk:${agent.risk}`, tone: agent.risk === "high" ? "warning" : "muted" },
    ],
    body: [
      `tools: ${agent.allowedTools.join(", ")}`,
      `readOnly: ${String(agent.readOnly)}`,
      `risk: ${agent.risk}`,
      ...(agent.permissionMode === undefined ? [] : [`permissionMode: ${agent.permissionMode}`]),
      ...(agent.spawns === undefined ? [] : [`spawns: ${agent.spawns === "*" ? "*" : agent.spawns.join(", ")}`]),
      ...(agent.model?.length ? [`model: ${agent.model.join(", ")}`] : []),
      ...(agent.thinkingLevel ? [`thinking: ${agent.thinkingLevel}`] : []),
      ...(agent.blocking === undefined ? [] : [`blocking: ${String(agent.blocking)}`]),
    ],
    metadata: [`source: ${agent.source ?? "unknown"}`, `file: ${agent.filePath ?? "unknown"}`],
    controls: [`Run: /agent run ${agent.name} <task> · Catalog: /agent list`],
  };
}

function compactAgentCatalogLine(value: string): string {
  const plain = value.replace(/\s+/gu, " ").trim();
  const width = AGENTS_WIDGET_FALLBACK_WIDTH - 8;
  if (visibleWidth(plain) <= width) return plain;
  return `${sliceByColumn(plain, 0, width - 1)}…`;
}

function setAgentsWidget(
  ctx: ExtensionContext,
  content: string,
  maxLines: number = AGENTS_WIDGET_MAX_LINES,
  wrap = false,
): void {
  const lines = content.split(/\r?\n/).map((line) => line.trimEnd());
  const component = new BoundedTextWidget(lines, maxLines, wrap);
  if (ctx.mode !== "tui") {
    setTextWidget(ctx, AGENTS_WIDGET_KEY, component.render(AGENTS_WIDGET_FALLBACK_WIDTH).join("\n"), {
      placement: "belowEditor",
    });
    return;
  }
  try {
    ctx.ui.setWidget(AGENTS_WIDGET_KEY, () => component, { placement: "belowEditor" });
  } catch {
    setTextWidget(ctx, AGENTS_WIDGET_KEY, component.render(AGENTS_WIDGET_FALLBACK_WIDTH).join("\n"), {
      placement: "belowEditor",
    });
  }
}

function clearAgentsStatus(ctx: ExtensionContext): void {
  try {
    ctx.ui.setStatus(AGENTS_WIDGET_KEY, undefined);
  } catch {
    // Best-effort cleanup for hosts that expose a partial UI surface.
  }
}

function clearAgentsTransient(ctx: ExtensionContext): void {
  clearAgentsStatus(ctx);
  try {
    ctx.ui.setWidget(AGENTS_WIDGET_KEY, undefined);
  } catch {
    // Best-effort cleanup for hosts that expose a partial UI surface.
  }
}

class BoundedTextWidget implements CustomUiComponent {
  constructor(
    private readonly lines: string[],
    private readonly maxLines: number,
    /**
     * Structured proof lines (e.g. "Artifact: <path>") must survive intact for
     * tooling to grep — wrap them across lines instead of ellipsis-clipping,
     * which would corrupt the path. Prose content (catalog/observer text)
     * keeps the default clip behavior, which is more compact.
     */
    private readonly wrap: boolean = false,
  ) {}

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : AGENTS_WIDGET_FALLBACK_WIDTH;
    const rendered = this.wrap
      ? this.lines.flatMap((line) => wrapTextWithAnsi(line, safeWidth))
      : this.lines.map((line) => truncatePlain(line, safeWidth));
    if (rendered.length <= this.maxLines) return rendered;
    const visibleCount = Math.max(0, this.maxLines - 1);
    const hiddenCount = rendered.length - visibleCount;
    return [...rendered.slice(0, visibleCount), truncatePlain(`more: ${hiddenCount} line(s) not shown`, safeWidth)];
  }

  invalidate(): void {
    // Static text widget owns no cache or external handles.
  }
}

function truncatePlain(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 0) return "";
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function parseAgentObserverCommand(text: string): ParsedAgentObserverCommand | undefined {
  if (text === "observe") return { target: "observe" };
  if (text === "summary") return { target: "summary" };
  return undefined;
}

function parseAgentDrillCommand(text: string): ParsedAgentDrillCommand | undefined {
  const drillMatch = /^drill(?:\s+([\s\S]+))?$/.exec(text);
  if (drillMatch === null) return undefined;
  const rest = drillMatch[1]?.trim() ?? "";
  if (rest === "") return { target: "" };
  const tokens = rest.split(/\s+/);
  const flag = tokens.find((token) => token.startsWith("--"));
  if (flag !== undefined) return { target: flag };
  if (tokens.length !== 1) return { target: "" };
  return { target: tokens[0]! };
}

function parseAgentPsCommand(text: string): string | undefined {
  if (text === "ps") return "";
  if (!text.startsWith("ps ")) return undefined;
  return parsePsTarget(text.slice(3));
}

function parsePsTarget(value: string): string | undefined {
  const target = value.trim();
  if (target === "") return "";
  if (target.startsWith("--")) return undefined;
  return target;
}

async function executeAgentDrillCommand(
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

function notifyActiveAgentsContinue(ctx: ExtensionContext, prefix: string): void {
  const count = [...agentLiveStore.rows.values()].filter(
    (row) => row.status === "working" || row.status === "queued",
  ).length;
  if (count > 0) ctx.ui.notify(`${prefix} ${count} agent${count === 1 ? "" : "s"} continue running.`, "info");
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

/**
 * Pi shows one inline component at a time, so a newer prompt can take the screen
 * from an open fleet or viewer. Saying so is the difference between a surface
 * that closed for a reason and a command that looks broken, and both reasons are
 * worth saying: a takeover, and a lease that went stale — which also covers a
 * failure to read host session state, in a session that is very much alive and
 * waiting for its answer. The only silence left is a host that cannot deliver a
 * notification at all.
 */
function notifyInteractionEnded(ctx: ExtensionContext, error: unknown, subject: string): void {
  if (!isStaleInlineOperatorInteractionError(error)) return;
  const message = isSupersededInlineOperatorInteractionError(error)
    ? `${subject} closed: another prompt took the screen. Run /ps again when it is answered.`
    : `${subject} did not open: this session's UI surface is no longer the one that asked. Run /ps again.`;
  try {
    ctx.ui.notify(message, "info");
  } catch {
    // A replaced session has nobody left to tell.
  }
}

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

function parseAgentRunCommand(text: string): ParsedAgentRunCommand | undefined {
  const runMatch = /^run\s+([\s\S]+)$/.exec(text);
  if (runMatch === null) return undefined;
  let rest = runMatch[1]!.trim();
  let approvalTier: CommandApprovalTier = "prompt";
  const overrideMatch = /^(--yes|--approve)(?:\s+([\s\S]+))?$/.exec(rest);
  if (overrideMatch !== null) {
    approvalTier = "allow";
    rest = overrideMatch[2]?.trim() ?? "";
  }
  // Optional `--title <quoted phrase|token>` before `<name> <task>` (REQ-003).
  let title: string | undefined;
  if (/^--title(?:\s|$)/.test(rest)) {
    const parsed = extractTitleFlag(rest);
    if (parsed === undefined) return undefined;
    title = parsed.title;
    rest = parsed.rest;
  }
  if (/^--\S+(?:\s|$)/.test(rest)) return undefined;
  const argsMatch = /^(\S+)\s+([\s\S]+)$/.exec(rest);
  if (argsMatch === null) return undefined;
  return { name: argsMatch[1]!, task: argsMatch[2]!, approvalTier, ...(title !== undefined ? { title } : {}) };
}

/**
 * Split a leading `--title` flag off a `/agent run` argument string. The value is
 * either a quoted phrase (`--title "review auth"`) or a single token
 * (`--title smoke`); returns undefined (→ usage error) when malformed or when no
 * `<name> <task>` remainder follows.
 */
function extractTitleFlag(rest: string): { title: string; rest: string } | undefined {
  const flag = /^--title\s+([\s\S]+)$/.exec(rest);
  if (flag === null) return undefined;
  const after = flag[1]!;
  const quoted = /^(["'])([\s\S]*?)\1\s*([\s\S]*)$/.exec(after);
  if (quoted !== null) {
    const title = quoted[2]!.trim();
    const remainder = quoted[3]!.trim();
    if (title === "" || remainder === "") return undefined;
    return { title, rest: remainder };
  }
  const token = /^(\S+)\s+([\s\S]+)$/.exec(after);
  if (token === null) return undefined;
  return { title: token[1]!, rest: token[2]!.trim() };
}

/**
 * Resolve the live-row title (REQ-003): explicit `title` wins, else the UI label,
 * else the first words of the prompt; the result is clamped to ≤48 columns.
 */
function resolveAgentTitle(explicit: string | undefined, fallbackLabel: string, prompt: string): string {
  const fromExplicit = explicit?.trim();
  if (fromExplicit !== undefined && fromExplicit !== "") return clampTitle(fromExplicit);
  const fromLabel = fallbackLabel.trim();
  if (fromLabel !== "") return clampTitle(fromLabel);
  return clampTitle(headOfPrompt(prompt));
}

const AGENT_TITLE_MAX_COLS = 48;

function clampTitle(value: string): string {
  if (value.length <= AGENT_TITLE_MAX_COLS) return value;
  return `${value.slice(0, AGENT_TITLE_MAX_COLS - 1).trimEnd()}…`;
}

function headOfPrompt(prompt: string): string {
  const firstLine = (prompt.split(/\r?\n/, 1)[0] ?? "").trim();
  return firstLine
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 8)
    .join(" ");
}

function refreshAgents(projectRoot: string) {
  const discovered = discoverAgentDefinitions(projectRoot);
  sharedState.agents.clear();
  for (const agent of discovered.definitions) {
    sharedState.agents.set(agent.name, agent);
  }
  writeAgentCatalogHint(discovered.definitions);
  return discovered;
}

/**
 * T-111: publish the resolved catalog on the `agent` parameter of
 * `spawn_agent`/`task`, which is where the calling model chooses the name. Both
 * tools are registered with the same `TaskParams` object and Pi hands
 * `ToolDefinition.parameters` to the provider by reference on every request
 * (unlike `description`, which it snapshots when the tool is wrapped), so
 * rewriting the schema field here is what makes the catalog refreshable instead
 * of frozen at registration. Every `refreshAgents` caller therefore republishes
 * it, and `before_agent_start` runs one refresh per turn so an agent added to
 * `.agents/agents/` mid-session is selectable without a restart.
 */
function writeAgentCatalogHint(definitions: readonly AgentDefinition[]): void {
  const catalog = formatAgentCatalogHint(definitions);
  TaskParams.properties.agent.description =
    catalog === ""
      ? AGENT_PARAM_BASE_DESCRIPTION
      : `${AGENT_PARAM_BASE_DESCRIPTION}\n${AGENT_PARAM_CATALOG_HEADING}\n${catalog}`;
}

function resolveAgentSelection(agentName: string | undefined): AgentResolution | undefined {
  const requestedAgent = normalizeRequestedAgentName(agentName);
  if (requestedAgent === "default") {
    const aliased = sharedState.agents.get(DEFAULT_TASK_AGENT_NAME);
    if (aliased !== undefined)
      return { requestedAgent, resolvedAgent: aliased.name, agent: aliased, aliasApplied: requestedAgent };
    return undefined;
  }
  const exact = sharedState.agents.get(requestedAgent);
  if (exact !== undefined && (!isBuiltInAgentAlias(requestedAgent) || isProjectOrUserAgent(exact))) {
    return { requestedAgent, resolvedAgent: exact.name, agent: exact };
  }
  const aliasTarget = builtInAliasTarget(requestedAgent);
  if (aliasTarget !== undefined) {
    const aliased = sharedState.agents.get(aliasTarget);
    if (aliased !== undefined)
      return { requestedAgent, resolvedAgent: aliased.name, agent: aliased, aliasApplied: requestedAgent };
  }
  if (exact !== undefined) return { requestedAgent, resolvedAgent: exact.name, agent: exact };
  return undefined;
}

function normalizeRequestedAgentName(agentName: string | undefined): string {
  const trimmed = agentName?.trim();
  return trimmed === undefined || trimmed === "" ? DEFAULT_TASK_AGENT_NAME : trimmed;
}

function isProjectOrUserAgent(agent: AgentDefinition): boolean {
  return agent.source === "project" || agent.source === "user";
}

function isBuiltInAgentAlias(name: string): name is keyof typeof BUILT_IN_AGENT_ALIASES {
  return name === "default" || name === "general";
}

function builtInAliasTarget(name: string): string | undefined {
  return isBuiltInAgentAlias(name) ? BUILT_IN_AGENT_ALIASES[name] : undefined;
}

function createUnknownAgentReport(
  ctx: ExtensionContext,
  requestedSurface: string,
  agentName: string | undefined,
): UnknownAgentReport {
  const requestedAgent = normalizeRequestedAgentName(agentName);
  const availableAgents = listAvailableAgents();
  const builtInAliases = listBuiltInAliases();
  const artifact = writeUnknownAgentArtifact(ctx, requestedSurface, requestedAgent, availableAgents, builtInAliases);
  const details: Record<string, unknown> = {
    owner: "agents-catalog",
    requestedSurface,
    status: "blocked",
    errorCode: "unknown-agent",
    requestedAgent,
    availableAgents,
    builtInAliases,
    hint: "/agent list",
  };
  if (artifact.ok) details.artifactPath = artifact.path;
  else details.artifactError = artifact.reason;
  return {
    text: formatUnknownAgentMessage(requestedAgent, availableAgents, builtInAliases, artifact, getProjectRoot(ctx)),
    block: unknownAgentBlock(
      requestedAgent,
      availableAgents,
      builtInAliases,
      artifact,
      getProjectRoot(ctx),
      ctx.mode === "tui" ? 5 : 2,
    ),
    details,
    ...(artifact.ok ? { artifactPath: artifact.path } : {}),
  };
}

function unknownAgentBlock(
  requestedAgent: string,
  availableAgents: Array<{ name: string; source: string; description: string }>,
  builtInAliases: Array<{ alias: string; target: string; condition?: string }>,
  artifact: { ok: true; path: string } | { ok: false; reason: string },
  projectRoot: string,
  previewLimit: number,
): OperatorBlock {
  const sourceRank = (source: string): number => (source === "project" ? 0 : source === "user" ? 1 : 2);
  const preview = [...availableAgents]
    .sort((left, right) => sourceRank(left.source) - sourceRank(right.source) || left.name.localeCompare(right.name))
    .slice(0, previewLimit);
  const hidden = availableAgents.length - preview.length;
  return {
    type: "ERROR",
    subject: "Agent catalog",
    primary: compactAgentCatalogLine(`Unknown agent: "${requestedAgent}".`),
    body: [
      `Available agents (${availableAgents.length}):`,
      ...(preview.length === 0
        ? ["- (none)"]
        : preview.map((agent) => compactAgentCatalogLine(`- ${agent.name} [${agent.source}] - ${agent.description}`))),
      ...(hidden > 0 ? [`+${hidden} agent(s) not shown`] : []),
    ],
    metadata: [
      compactAgentCatalogLine(
        `Built-in aliases: ${builtInAliases.map((alias) => `${alias.alias} -> ${alias.target}${alias.condition === undefined ? "" : " (conditional)"}`).join("; ")}`,
      ),
    ],
    hint: [
      compactAgentCatalogLine(
        artifact.ok ? `Artifact: ${relative(projectRoot, artifact.path)}` : `Artifact write failed: ${artifact.reason}`,
      ),
      compactAgentCatalogLine("Evidence boundary: catalog failure only; not child-execution proof."),
    ],
    controls: ["Recovery: /agent list"],
  };
}

function listAvailableAgents(): Array<{ name: string; source: string; description: string }> {
  return [...sharedState.agents.values()]
    .map((agent) => ({ name: agent.name, source: agent.source ?? "unknown", description: agent.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listBuiltInAliases(): Array<{ alias: string; target: string; condition?: string }> {
  return [
    { alias: "default", target: DEFAULT_TASK_AGENT_NAME },
    { alias: "general", target: DEFAULT_TASK_AGENT_NAME, condition: "only when no project/user general agent exists" },
  ];
}

function formatUnknownAgentMessage(
  requestedAgent: string,
  availableAgents: Array<{ name: string; source: string; description: string }>,
  builtInAliases: Array<{ alias: string; target: string; condition?: string }>,
  artifact: { ok: true; path: string } | { ok: false; reason: string },
  projectRoot: string,
): string {
  const availableLines =
    availableAgents.length === 0
      ? ["- (none)"]
      : availableAgents.map((agent) => `- ${agent.name} [${agent.source}] - ${agent.description}`);
  const aliasLines = builtInAliases.map(
    (alias) => `- ${alias.alias} -> ${alias.target}${alias.condition === undefined ? "" : ` (${alias.condition})`}`,
  );
  return [
    `Unknown agent: "${requestedAgent}".`,
    "",
    "Available agents:",
    ...availableLines,
    "",
    "Built-in aliases:",
    ...aliasLines,
    "",
    "Run /agent list to inspect the current catalog.",
    artifact.ok ? `Artifact: ${relative(projectRoot, artifact.path)}` : `Artifact write failed: ${artifact.reason}`,
  ].join("\n");
}

function writeUnknownAgentArtifact(
  ctx: ExtensionContext,
  requestedSurface: string,
  requestedAgent: string,
  availableAgents: Array<{ name: string; source: string; description: string }>,
  builtInAliases: Array<{ alias: string; target: string; condition?: string }>,
): { ok: true; path: string } | { ok: false; reason: string } {
  const projectRoot = getProjectRoot(ctx);
  const body = {
    version: "locus.agent.unknown-agent.v1",
    status: "blocked",
    errorCode: "unknown-agent",
    requestedSurface,
    requestedAgent,
    availableAgents,
    builtInAliases,
    hint: "/agent list",
  };
  try {
    const artifact = createRuntimeArtifactStore(projectRoot).writeArtifact({
      kind: "json",
      content: `${JSON.stringify(body, null, 2)}\n`,
      sessionId: getSessionId(ctx),
      title: `Unknown agent: ${requestedAgent}`,
      metadata: {
        source: "agents-catalog",
        requestedSurface,
        errorCode: "unknown-agent",
        requestedAgent,
      },
    });
    return { ok: true, path: artifact.path };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

type TaskToolCtx = Parameters<ExtensionAPI["registerTool"]>[0]["execute"] extends (...args: infer Args) => unknown
  ? Args[4]
  : never;

/** Monotonic suffix so repeated `/agent run` of the same agent get distinct rows. */
let agentRunSeq = 0;

interface AgentLiveTaskInput {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  signal: AbortSignal;
  agent: AgentDefinition;
  resolvedAgent: string;
  rowId: string;
  label: string;
  title: string;
  task: string;
  approvalTier: ApprovalTier;
  liveModel: { model?: string; thinking?: string } | undefined;
  modelRoleResolution: ModelRoleResolution;
  maxTurns: number;
  parentContext?: { inline?: string; artifactPath?: string };
}

/**
 * Single source of truth for running ONE catalog agent as a live row (T-188 W2).
 * Both the `task`/`spawn_agent` tool loop and the `/agent run` slash command call
 * this, so the two triggers produce identical `agentLiveStore` rows and panel
 * output (Q8 parity is structural, not incidental). It creates/updates the row,
 * drives the SDK headless child through the shared boundary, and patches the
 * terminal state. It does NOT own the widget/panel or the aggregation — callers do.
 */
async function runAgentLiveTask(
  input: AgentLiveTaskInput,
): Promise<Awaited<ReturnType<typeof executeAgentRunBoundary>>> {
  const { ctx, resolvedAgent, rowId, label, title, liveModel } = input;
  const execution = agentLiveStore.beginExecution({
    id: rowId,
    agentName: resolvedAgent,
    label,
    title,
    ...(liveModel?.model !== undefined ? { model: liveModel.model } : {}),
    ...(liveModel?.thinking !== undefined ? { thinking: liveModel.thinking } : {}),
    isolated: false,
    noMcp: false,
  });
  const startedRow = agentLiveStore.rowForExecution(execution);
  // REQ-011: append-only transcript event line at kickoff.
  if (startedRow !== undefined) emitAgentEventLine(ctx, formatAgentStartedEventLine(startedRow), "info");
  // Child inherits the parent's resolved model (ctx.model) so it runs on the same
  // authenticated/capable model as the caller instead of the host default.
  const executor = createAgentSdkSessionExecutor({
    model: (ctx as { model?: unknown }).model,
    live: {
      rowId,
      label,
      title,
      ...(liveModel?.model !== undefined ? { model: liveModel.model } : {}),
      ...(liveModel?.thinking !== undefined ? { thinking: liveModel.thinking } : {}),
    },
    liveExecution: execution,
  });
  const request = createAgentRunRequest(input.agent, input.task, {
    maxTurns: input.maxTurns,
    approvalTier: input.approvalTier,
    modelRoleResolution: input.modelRoleResolution,
    ...(input.parentContext !== undefined ? { parentContext: input.parentContext } : {}),
  });
  const boundary = await executeAgentRunBoundary({ pi: input.pi, ctx, request, executor, signal: input.signal });
  const finishedRow = agentLiveStore.patchExecution(execution, {
    status: boundary.status === "completed" ? "done" : boundary.status === "cancelled" ? "cancelled" : "error",
    ...(boundary.childSession?.id !== undefined ? { childSessionId: boundary.childSession.id } : {}),
    ...(boundary.resultArtifact?.path !== undefined ? { resultArtifact: boundary.resultArtifact.path } : {}),
    finalAnswer: boundary.reason,
    errors: boundary.status === "completed" ? [] : [boundary.reason, ...boundary.diagnostics],
  });
  // REQ-011: append-only transcript event line at completion (finished / error).
  if (finishedRow !== undefined) {
    const level = boundary.status === "completed" ? "info" : boundary.status === "cancelled" ? "warning" : "error";
    emitAgentEventLine(ctx, formatAgentFinishedEventLine(finishedRow), level);
  }
  return boundary;
}

/**
 * Best-effort append of a REQ-011 lifecycle line to the transcript surface. Guarded
 * so a host without a live UI (or a partial UI surface) degrades to a no-op rather
 * than throwing into the agent run.
 */
function emitAgentEventLine(ctx: ExtensionContext, line: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(line, level);
  } catch {
    // Headless / partial UI host: the row + drill remain the durable record.
  }
}

/**
 * Real single-task execution path for the `task` tool. One invocation spawns one
 * genuine headless child agent session through the SDK host (the tool-context executor),
 * routed through the same `executeAgentRunBoundary` as the /agent command. Falls
 * back to the honest fail-closed `sdkUnavailableResult` surface only when the SDK
 * host is genuinely unavailable on this machine.
 */
async function runTaskTool(
  pi: ExtensionAPI,
  ctx: TaskToolCtx,
  signal: AbortSignal,
  agentName: string | undefined,
  task: string,
  title: string | undefined,
  parentContext?: { inline?: string; artifactPath?: string },
) {
  const resolution = resolveAgentSelection(agentName);
  if (resolution === undefined) {
    const report = createUnknownAgentReport(ctx, "task", agentName);
    return errorResult(report.text, report.details);
  }
  const { agent, requestedAgent, resolvedAgent, aliasApplied } = resolution;
  const agentDefault = agent.parentContextDefault === true;
  const modelRoles = await loadModelRolesState(ctx);
  const modelRoleResolution = resolveAgentModelPreference(modelRoles, agent.model ?? []);
  const liveModel = resolveLiveModelDisplay({ pi, ctx, assignment: modelRoleResolution.assignment });
  const hasUI = ctx.hasUI === true;
  const panel = hasUI ? installWorkflowProgress(ctx, "agents", `task ${resolvedAgent}`, "task") : undefined;
  let boundary: Awaited<ReturnType<typeof runAgentLiveTask>>;
  // Pin the "agents" progress key for the duration of the live run so a chat
  // message (which clears transient command UI) cannot dispose the progress
  // widget mid-flight. Unpinned in the finally below, even on throw.
  if (hasUI) pinTransientUiKey(pi, AGENTS_WIDGET_KEY);
  try {
    // Pi native tool approval happens before this handler runs, so the child runs
    // under the already-approved bounds (approvalTier "allow").
    const parentContextBroker = summarizeParentContextBroker(parentContext, agentDefault);
    boundary = await runAgentLiveTask({
      pi,
      ctx,
      signal,
      agent,
      resolvedAgent,
      rowId: `task:${resolvedAgent}:${++agentRunSeq}`,
      label: resolveAgentTitle(title, "", task),
      title: resolveAgentTitle(title, "", task),
      task,
      approvalTier: "allow",
      liveModel,
      modelRoleResolution,
      maxTurns: 5,
      ...(parentContextBroker.forwarded && parentContext !== undefined ? { parentContext } : {}),
    });
    if (hasUI) panel?.render(80);
    panel?.finish({ ok: boundary.status === "completed", result: boundary });
  } catch (err) {
    // Agent/host crash mid-run: stop the spinner AND surface a visible error
    // instead of leaving the panel spinning forever (no silent vanish). finish()
    // disposes the live timer and doneLines() renders the "error: <msg>" line.
    panel?.finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    if (hasUI) unpinTransientUiKey(pi, AGENTS_WIDGET_KEY);
  }
  if (boundary.status === "blocked" && diagnosticsInclude(boundary.diagnostics, AGENT_SDK_UNAVAILABLE_DIAGNOSTIC)) {
    return sdkUnavailableResult(
      {
        requestedAgent,
        resolvedAgent,
        ...(aliasApplied === undefined ? {} : { aliasApplied }),
      },
      boundary,
    );
  }
  const parentContextBroker = summarizeParentContextBroker(parentContext, agentDefault);
  const details = {
    owner: "agents-catalog",
    requestedSurface: "task",
    requestedAgent,
    agent: resolvedAgent,
    ...(aliasApplied === undefined ? {} : { aliasApplied }),
    taskCount: 1,
    executor: "agent-sdk-session-host",
    parentContextBroker,
    status: boundary.status,
    diagnostics: boundary.diagnostics,
    evidence: boundary.evidence,
    childSessionId: boundary.childSession?.id,
    childOutputStats: boundary.childOutputStats,
    resultArtifact: boundary.resultArtifact?.path,
  };
  if (boundary.status !== "completed" || boundary.text === undefined) {
    return errorResult(boundary.reason, details);
  }
  return textResult(boundary.text, details);
}

function summarizeParentContextBroker(
  parentContext: { inline?: string; artifactPath?: string } | undefined,
  agentDefault: boolean,
) {
  const sources: string[] = [];
  if (parentContext?.inline !== undefined && parentContext.inline.length > 0) sources.push("inline");
  if (parentContext?.artifactPath !== undefined && parentContext.artifactPath.length > 0) sources.push("artifactPath");
  const forwarded = sources.length > 0;
  return { forwarded, sources, agentDefault };
}

function diagnosticsInclude(diagnostics: unknown, token: string): boolean {
  return Array.isArray(diagnostics) && diagnostics.some((entry) => typeof entry === "string" && entry.includes(token));
}

/**
 * Honest fail-closed surface for the `task` tool when the installed Pi host
 * genuinely cannot spawn a child agent session (e.g. an older host that does not
 * export `createAgentSession`, or a stripped SDK namespace). The reason reflects
 * the real substrate gap and reuses the per-task diagnostics already gathered —
 * it never claims a replacement session was attempted.
 */
function sdkUnavailableResult(
  resolution: Pick<AgentResolution, "requestedAgent" | "resolvedAgent" | "aliasApplied">,
  result: Awaited<ReturnType<typeof runAgentLiveTask>>,
) {
  const reason = result.reason || "createAgentSession is unavailable on this host.";
  return errorResult(
    [
      `Agent task execution is unavailable: this Pi host cannot spawn a child agent session for "${resolution.resolvedAgent}".`,
      reason,
    ].join("\n"),
    {
      owner: "agents-catalog",
      requestedSurface: "task",
      requestedAgent: resolution.requestedAgent,
      agent: resolution.resolvedAgent,
      ...(resolution.aliasApplied === undefined ? {} : { aliasApplied: resolution.aliasApplied }),
      taskCount: 1,
      executor: "agent-sdk-session-host",
      status: "blocked",
      hostCapability: "agent-sdk-session-unavailable",
      toolExecutorAvailable: false,
      result: {
        status: result.status,
        reason: result.reason,
        diagnostics: result.diagnostics,
        resultArtifact: result.resultArtifact?.path,
      },
      sources: [".agents/agents"],
    },
  );
}

/**
 * `/agent run` — the single-agent slash trigger. T-188 W2: it is now a client of
 * the shared live-row model (agentLiveStore + the AgentLivePanel installed by
 * installWorkflowProgress), exactly like the `task`/`spawn_agent` tool. There is
 * no replacement-session transcript switch (the T-187 root cause of "who is
 * working?", the upward jump, and `drill last → not found`): the run streams into
 * the live panel above the editor, its row survives for `/agent drill`, and the
 * detailed flow goes through drill + the JSONL journal.
 */
async function executeAgentRunCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  name: string,
  task: string,
  approvalTier: CommandApprovalTier = "prompt",
  title?: string,
): Promise<void> {
  const resolution = resolveAgentSelection(name);
  if (resolution === undefined) {
    const report = createUnknownAgentReport(ctx, "agent-run", name);
    setOperatorWidget(ctx, AGENTS_WIDGET_KEY, report.block);
    return;
  }
  const { agent, resolvedAgent } = resolution;
  const modelRoles = await loadModelRolesState(ctx);
  const modelRoleResolution = resolveAgentModelPreference(modelRoles, agent.model ?? []);
  const liveModel = resolveLiveModelDisplay({ pi, ctx, assignment: modelRoleResolution.assignment });
  const hasUI = ctx.hasUI === true;
  const panel = hasUI ? installWorkflowProgress(ctx, AGENTS_WIDGET_KEY, `run ${resolvedAgent}`, "agent") : undefined;
  if (hasUI) pinTransientUiKey(pi, AGENTS_WIDGET_KEY);
  const controller = new AbortController();
  try {
    const boundary = await runAgentLiveTask({
      pi,
      ctx,
      signal: controller.signal,
      agent,
      resolvedAgent,
      rowId: `run:${resolvedAgent}:${++agentRunSeq}`,
      label: task,
      title: resolveAgentTitle(title, "", task),
      task,
      approvalTier,
      liveModel,
      modelRoleResolution,
      maxTurns: 5,
    });
    if (hasUI) {
      panel?.render(80);
      panel?.finish({
        ok: boundary.status === "completed",
        result: { status: boundary.status, summary: boundary.reason },
      });
    } else {
      // Headless host: no live panel, so surface the honest settled result.
      setOperatorWidget(ctx, AGENTS_WIDGET_KEY, agentRunBoundaryBlock(boundary));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (hasUI) panel?.finish({ ok: false, error: message });
    else
      setOperatorWidget(ctx, AGENTS_WIDGET_KEY, {
        type: "ERROR",
        subject: "Agent run",
        primary: `Agent ${resolvedAgent}: error`,
        body: [`Reason: ${message}`],
        controls: ["Recovery: inspect the live row with /agent drill last, then retry."],
      });
    throw err;
  } finally {
    if (hasUI) unpinTransientUiKey(pi, AGENTS_WIDGET_KEY);
  }
}

function agentRunBoundaryBlock(boundary: Awaited<ReturnType<typeof executeAgentRunBoundary>>): OperatorBlock {
  const identity =
    boundary.childSession?.id !== undefined
      ? `${boundary.agentName}#${agentShortIdFromSource(boundary.childSession.id)}`
      : boundary.agentName;
  const metadata: string[] = [];
  if (boundary.childSession !== undefined) {
    metadata.push(`childSessionId: ${boundary.childSession.id}`);
    if (boundary.childSession.parentSessionId !== undefined)
      metadata.push(`parentSessionId: ${boundary.childSession.parentSessionId}`);
  }
  if (boundary.resultArtifact !== undefined) metadata.push(`resultArtifact: ${boundary.resultArtifact.path}`);
  if (boundary.childOutputStats !== undefined) {
    // T-188 W6 (fix-candidate #4): units + honest label. childToolCalls is the SDK's
    // genuine tool-call count for this child; entries are its recorded events.
    metadata.push(`childEntries: ${boundary.childOutputStats.entryCount} (events)`);
    metadata.push(`childToolCalls: ${boundary.childOutputStats.assistantToolCallCount} (tool calls)`);
  }
  const isCompleted = boundary.status === "completed";
  const isCancelled = boundary.status === "cancelled";
  return {
    type: isCompleted || isCancelled ? "RESULT" : "ERROR",
    subject: "Agent run",
    primary: `Agent ${identity}: ${boundary.status}`,
    body: [boundary.reason],
    badges: [
      {
        text: `status:${boundary.status}`,
        tone: isCompleted ? "success" : isCancelled ? "muted" : "error",
      },
    ],
    metadata,
    hint: boundary.diagnostics.length === 0 ? [] : ["Diagnostics:", ...boundary.diagnostics.map((item) => `- ${item}`)],
    controls: [`Drill: /agent drill ${boundary.childSession?.id ?? "last"}`],
  };
}
