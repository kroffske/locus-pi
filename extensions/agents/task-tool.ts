/**
 * extensions/agents/task-tool.ts — the spawn-a-subagent tool, registered under two
 * names: the model-friendly primary `spawn_agent` and the back-compat alias `task`.
 * Both route through the same createAgentSession host + honesty-gate and report
 * requestedSurface:"task" internally, so only the registered tool name differs.
 */
import { AGENT_SDK_UNAVAILABLE_DIAGNOSTIC } from "../_shared/agent-sdk-host.js";
import { pinTransientUiKey, unpinTransientUiKey } from "../_shared/command-ui.js";
import { resolveLiveModelDisplay } from "../_shared/live-model-display.js";
import { loadModelRolesState, resolveAgentModelPreference } from "../_shared/model-settings.js";
import type { ExtensionAPI } from "../_shared/pi-api.js";
import { errorResult, getProjectRoot, textResult } from "../_shared/pi-api.js";
import { validateParams } from "../_shared/validation.js";
import { errorMessage } from "../_shared/error-text.js";
import { installWorkflowProgress } from "../workflows/progress-widget.js";
import {
  DEFAULT_TASK_AGENT_NAME,
  refreshAgents,
  resolveAgentSelection,
  TaskParams,
  type AgentResolution,
} from "./catalog.js";
import { AGENTS_WIDGET_KEY } from "./operator-surface.js";
import { nextAgentRunSequence, resolveAgentTitle, runAgentLiveTask } from "./run-launcher.js";
import { createUnknownAgentReport } from "./unknown-agent-report.js";

type TaskToolCtx = Parameters<ExtensionAPI["registerTool"]>[0]["execute"] extends (...args: infer Args) => unknown
  ? Args[4]
  : never;

export function registerAgentSpawnTools(pi: ExtensionAPI): void {
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
}

function taskApprovalDetails(args: unknown): string[] {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const agent = String(record.agent ?? DEFAULT_TASK_AGENT_NAME);
  return [`Agent: ${agent}`, "Tasks: 1"];
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
      rowId: `task:${resolvedAgent}:${nextAgentRunSequence()}`,
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
    panel?.finish({ ok: false, error: errorMessage(err) });
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
