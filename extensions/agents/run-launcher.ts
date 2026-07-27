/**
 * extensions/agents/run-launcher.ts — the single start-a-run pipeline behind both
 * agent triggers: `runAgentLiveTask` (the live row + SDK child + terminal patch)
 * plus the `/agent run` slash wrapper that installs the progress panel around it.
 * The `task`/`spawn_agent` tool is the other client (see task-tool.ts).
 */
import { createAgentRunRequest, executeAgentRunBoundary, type ApprovalTier } from "../_shared/agent-runner.js";
import { agentLiveStore, createAgentSdkSessionExecutor } from "../_shared/agent-sdk-host.js";
import { formatAgentFinishedEventLine, formatAgentStartedEventLine } from "../_shared/agent-live-panel.js";
import { pinTransientUiKey, unpinTransientUiKey } from "../_shared/command-ui.js";
import { resolveLiveModelDisplay } from "../_shared/live-model-display.js";
import {
  loadModelRolesState,
  resolveAgentModelPreference,
  type ModelRoleResolution,
} from "../_shared/model-settings.js";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../_shared/pi-api.js";
import type { AgentDefinition } from "../_shared/types.js";
import { setOperatorWidget } from "../_shared/widget-render.js";
import { errorMessage } from "../_shared/error-text.js";
import { installWorkflowProgress } from "../workflows/progress-widget.js";
import { resolveAgentSelection } from "./catalog.js";
import type { CommandApprovalTier } from "./command-parser.js";
import { AGENTS_WIDGET_KEY, emitAgentEventLine } from "./operator-surface.js";
import { agentRunBoundaryBlock } from "./operator-ui.js";
import { createUnknownAgentReport } from "./unknown-agent-report.js";

/** Monotonic suffix so repeated `/agent run` of the same agent get distinct rows. */
let agentRunSeq = 0;

/** Shared by both triggers so a task row and a run row can never collide. */
export function nextAgentRunSequence(): number {
  return ++agentRunSeq;
}

export interface AgentLiveTaskInput {
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
export async function runAgentLiveTask(
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
 * Resolve the live-row title (REQ-003): explicit `title` wins, else the UI label,
 * else the first words of the prompt; the result is clamped to ≤48 columns.
 */
export function resolveAgentTitle(explicit: string | undefined, fallbackLabel: string, prompt: string): string {
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

/**
 * `/agent run` — the single-agent slash trigger. T-188 W2: it is now a client of
 * the shared live-row model (agentLiveStore + the AgentLivePanel installed by
 * installWorkflowProgress), exactly like the `task`/`spawn_agent` tool. There is
 * no replacement-session transcript switch (the T-187 root cause of "who is
 * working?", the upward jump, and `drill last → not found`): the run streams into
 * the live panel above the editor, its row survives for `/agent drill`, and the
 * detailed flow goes through drill + the JSONL journal.
 */
export async function executeAgentRunCommand(
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
      rowId: `run:${resolvedAgent}:${nextAgentRunSequence()}`,
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
    const message = errorMessage(err);
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
