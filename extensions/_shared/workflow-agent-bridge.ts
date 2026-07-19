/**
 * workflow-agent-bridge.ts — Adapter: agent() -> Pi task/createAgentSession path.
 *
 * Turns a WorkflowAgentRequest into exactly one Pi task execution through
 * createAgentRunRequest + executeAgentRunBoundary, reusing the same helper path the
 * `task` tool uses. Injectable createExecutor factory (default createAgentSdkSessionExecutor)
 * so tests can mock createSession and prove the wiring.
 */

import type { ExtensionAPI, ExtensionContext } from "./pi-api.js";
import { getProjectRoot } from "./pi-api.js";
import { createAgentRunRequest, executeAgentRunBoundary } from "./agent-runner.js";
import { createWorkflowWorktree } from "./workflow-worktree.js";
import type { WorkflowWorkspaceManager } from "./workflow-worktree.js";
import type { AgentExecutor } from "./agent-runner.js";
import {
  agentLiveStore,
  createAgentSdkSessionExecutor,
  AGENT_SDK_UNAVAILABLE_DIAGNOSTIC,
  AGENT_SDK_UNAVAILABLE_HINT,
  type AgentLiveRow,
  type AgentSdkSessionExecutorOptions,
} from "./agent-sdk-host.js";
import { discoverAgentDefinitions } from "./agents.js";
import { loadModelRolesState, resolveAgentModelPreference } from "./model-settings.js";
import { resolveLiveModelDisplay } from "./live-model-display.js";
import { DEFAULT_WORKFLOW_AGENT, workflowSlotKey } from "./workflow-runtime.js";
import { workflowAgentLiveRowId, workflowAgentLiveChildRowId } from "./workflow-journal.js";
import type {
  WorkflowAgentRunner,
  WorkflowAgentRequest,
  WorkflowAgentResult,
  WorkflowLlmUsage,
} from "./workflow-runtime.js";
import { defaultResolveModel } from "./workflow-model-resolve.js";
import type { AgentDefinition, PermissionMode, WorkspaceMode } from "./types.js";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Thrown when the host genuinely cannot spawn a child (fail closed, honest reason). */
export class WorkflowAgentUnavailableError extends Error {
  readonly diagnostics: string[];
  constructor(message: string, diagnostics: string[]) {
    super(message);
    this.name = "WorkflowAgentUnavailableError";
    this.diagnostics = diagnostics;
  }
}

export interface WorkflowAgentBridgeOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext; // captured at tool/command execute time
  signal: AbortSignal;
  workflowRunId?: string;
  args?: unknown;
  /**
   * Injectable executor factory — defaults to createAgentSdkSessionExecutor.
   * Tests inject a factory that returns createAgentSdkSessionExecutor({ createSession: fake })
   * so the bridge PROVABLY routes through the real task/createAgentSession path.
   */
  createExecutor?: (opts: {
    model?: unknown;
    live?: AgentSdkSessionExecutorOptions["live"];
    maxToolCalls?: number;
  }) => AgentExecutor;
  resolveModel?: (selector: string) => unknown;
  defaultAgent?: string; // default DEFAULT_WORKFLOW_AGENT
  workspaceManager?: WorkflowWorkspaceManager;
}

export function resolvePermissionMode(input: {
  agent: AgentDefinition;
  reqMode: PermissionMode | undefined;
  isDefaultAgent: boolean;
}): PermissionMode {
  const hasExplicitTools = input.agent.tools !== undefined && input.agent.tools.length > 0;
  if (input.reqMode === "restricted") {
    return input.isDefaultAgent && !hasExplicitTools ? "inherit-parent" : "restricted";
  }
  if (input.reqMode !== undefined) return input.reqMode;
  if (input.agent.permissionMode === "restricted") {
    return input.isDefaultAgent && !hasExplicitTools ? "inherit-parent" : "restricted";
  }
  if (input.agent.permissionMode !== undefined) return input.agent.permissionMode;
  if (input.isDefaultAgent && !hasExplicitTools && !input.agent.readOnly) return "inherit-parent";
  return "agent-defined";
}

export function resolveWorkspaceMode(input: {
  reqMode: WorkspaceMode | undefined;
  sandbox: WorkflowAgentRequest["sandbox"] | undefined;
}): WorkspaceMode {
  if (input.reqMode !== undefined) return input.reqMode;
  if (input.sandbox === "workspace-write") return "worktree";
  return "project";
}

// ---------------------------------------------------------------------------
// createWorkflowAgentRunner
// ---------------------------------------------------------------------------

/** Builds the WorkflowAgentRunner the runtime depends on. */
export function createWorkflowAgentRunner(options: WorkflowAgentBridgeOptions): WorkflowAgentRunner {
  const { pi, ctx, signal, resolveModel } = options;
  const defaultAgentName = options.defaultAgent ?? DEFAULT_WORKFLOW_AGENT;
  const resolveModelFn = resolveModel ?? defaultResolveModel;
  let worktreeCounter = 0;
  // Per-run slot → round counter (REQ-009). The runner is created once per run
  // (workflow-runner.ts), so this closure persists across agent() calls: a slot re-invoked
  // in a loop increments its round, keyed by the stable live-row id (agent+label+phase) so
  // it never bleeds across distinct slots. First call = 1 (badge hidden), then 2, 3, ….
  const roundByRowId = new Map<string, number>();

  return async function runWorkflowAgent(req: WorkflowAgentRequest): Promise<WorkflowAgentResult> {
    const projectRoot = getProjectRoot(ctx);

    // 1. Resolve one catalog agent. Workflow-local behavior belongs in the rendered prompt.
    const agentName = req.agent !== "" ? req.agent : defaultAgentName;
    const discovered = discoverAgentDefinitions(projectRoot);
    const agentMap = new Map(discovered.definitions.map((a) => [a.name, a]));
    const selectedAgent = agentMap.get(agentName) ?? agentMap.get(defaultAgentName);

    if (selectedAgent === undefined || !agentMap.has(agentName)) {
      // Unknown catalog name -> return a result (not throw); script error, not host-unavailable.
      return {
        ok: false,
        status: "failed",
        summary: `Unknown agent: ${agentName}`,
        diagnostics: [
          `Workflow agent bridge: agent "${agentName}" not found in catalog. Available: ${[...agentMap.keys()].join(", ")}`,
        ],
        agent: agentName,
        workspaceMode: resolveWorkspaceMode({ reqMode: req.workspaceMode, sandbox: req.sandbox }),
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
    }
    const agent =
      req.readOnly === true && !selectedAgent.readOnly ? { ...selectedAgent, readOnly: true } : selectedAgent;

    // 2. Pi still owns operator approval. The SDK host separately enforces
    //    `agent.readOnly` as a capability allowlist: no shell, write/edit,
    //    nested workflow, or unknown custom tool reaches a read-only child.
    const approvalTier: "allow" = "allow";
    const permissionMode = resolvePermissionMode({
      agent,
      reqMode: req.permissionMode,
      isDefaultAgent: agent.name === defaultAgentName,
    });
    const workspaceMode = resolveWorkspaceMode({ reqMode: req.workspaceMode, sandbox: req.sandbox });

    // 3. Model role resolution (mirror runTaskTool)
    const modelRoles = await loadModelRolesState(ctx);
    const modelRoleResolution = resolveAgentModelPreference(modelRoles, agent.model ?? []);
    const liveModel = resolveLiveModelDisplay({
      pi,
      ctx,
      requestedModel: req.model,
      assignment: modelRoleResolution.assignment,
    });

    let worktreePath: string | undefined;
    let worktreeId: string | undefined;
    if (req.workspaceHandle !== undefined) {
      if (options.workspaceManager === undefined) {
        const message = "Workflow workspace handle was supplied without a workspace manager.";
        return {
          ok: false,
          status: "failed",
          summary: message,
          diagnostics: [message],
          agent: agent.name,
          workspaceMode,
          ...(req.label !== undefined ? { label: req.label } : {}),
        };
      }
      try {
        const workspace = options.workspaceManager.resolve(req.workspaceHandle);
        worktreePath = workspace.path;
        worktreeId = workspace.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          status: "failed",
          summary: message,
          diagnostics: [message],
          agent: agent.name,
          workspaceMode,
          ...(req.label !== undefined ? { label: req.label } : {}),
        };
      }
    } else if (workspaceMode === "worktree" || workspaceMode === "temporary-worktree") {
      if (options.workflowRunId === undefined || options.workflowRunId.trim() === "") {
        const message = "Workflow write agent requires workflowRunId for isolated git worktree allocation.";
        return {
          ok: false,
          status: "failed",
          summary: message,
          diagnostics: [message],
          agent: agent.name,
          workspaceMode,
          ...(req.label !== undefined ? { label: req.label } : {}),
        };
      }
      try {
        const callId = `${agent.name}-${req.label ?? "agent"}-${++worktreeCounter}`;
        const worktree = createWorkflowWorktree({
          projectRoot,
          runId: options.workflowRunId,
          safeCallId: callId,
        });
        worktreePath = worktree.path;
        worktreeId = worktree.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          status: "failed",
          summary: message,
          diagnostics: [message],
          agent: agent.name,
          workspaceMode,
          ...(req.label !== undefined ? { label: req.label } : {}),
        };
      }
    }

    // 4. Build the request
    const request = createAgentRunRequest(agent, req.prompt, {
      maxTurns: 5,
      approvalTier,
      ...(req.tools !== undefined ? { allowedTools: req.tools } : {}),
      modelRoleResolution,
      ...(worktreePath !== undefined ? { workingDirectory: worktreePath } : {}),
      ...(options.args !== undefined || worktreePath !== undefined
        ? {
            metadata: {
              ...(options.args !== undefined ? { workflowArgs: options.args } : {}),
              ...(worktreePath !== undefined
                ? {
                    workflowWorktree: {
                      id: worktreeId,
                      path: worktreePath,
                      runId: options.workflowRunId,
                      ...(req.workspaceHandle !== undefined ? { handle: req.workspaceHandle } : {}),
                    },
                  }
                : {}),
              permissionMode,
              workspaceMode,
            },
          }
        : { metadata: { permissionMode, workspaceMode } }),
      // depth defaults to 0, maxDepth defaults to 1 (children are leaves)
    });

    // 5. Build the executor via the injectable factory
    const createExecutorFn =
      options.createExecutor ??
      ((o: { model?: unknown; live?: AgentSdkSessionExecutorOptions["live"]; maxToolCalls?: number }) =>
        createAgentSdkSessionExecutor({
          ...(o.model !== undefined ? { model: o.model } : {}),
          ...(o.live !== undefined ? { live: o.live } : {}),
          ...(o.maxToolCalls !== undefined ? { maxToolCalls: o.maxToolCalls } : {}),
        }));
    const perCallModel = req.model !== undefined ? await Promise.resolve(resolveModelFn(req.model)) : undefined;
    const workflowParentRowId =
      options.workflowRunId !== undefined
        ? workflowAgentLiveRowId({
            runId: options.workflowRunId,
            agent: agent.name,
            ...(req.label !== undefined ? { label: req.label } : {}),
            ...(req.phase !== undefined ? { phase: req.phase } : {}),
          })
        : undefined;
    // Slot anchoring (REQ-009, D-006): a workflow agent with a `label` is a repeatable slot.
    // Give its live row a STABLE id derived from (runId, agent, label, phase) so a loop re-invoke
    // REUSES the one row (round++) instead of spawning a fresh `agent-live-*` row each iteration.
    // No label ⇒ not a slot: leave rowId unset (fresh-row-per-call legacy behaviour, no rounds).
    const slotRowId =
      options.workflowRunId !== undefined && req.label !== undefined
        ? workflowAgentLiveChildRowId({
            runId: options.workflowRunId,
            agent: agent.name,
            label: req.label,
            ...(req.phase !== undefined ? { phase: req.phase } : {}),
          })
        : undefined;
    const slotKey = slotRowId !== undefined ? workflowSlotKey({ phase: req.phase, label: req.label }) : undefined;
    const round = slotRowId !== undefined ? nextRound(roundByRowId, slotRowId) : undefined;
    const live: AgentSdkSessionExecutorOptions["live"] = {
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(slotRowId !== undefined ? { rowId: slotRowId } : {}),
      ...(workflowParentRowId !== undefined ? { parentRowId: workflowParentRowId } : {}),
      ...(slotKey !== undefined ? { slotKey } : {}),
      ...(round !== undefined ? { round } : {}),
      ...(liveModel?.model !== undefined ? { model: liveModel.model } : {}),
      ...(liveModel?.thinking !== undefined ? { thinking: liveModel.thinking } : {}),
      isolated: workspaceMode !== "project",
      noMcp: permissionMode === "restricted",
    };
    const executor = createExecutorFn({
      model: perCallModel ?? (ctx as { model?: unknown }).model,
      live,
      ...(req.maxToolCalls !== undefined ? { maxToolCalls: req.maxToolCalls } : {}),
    });

    // 6. Execute through the boundary (same as task tool)
    const boundary = await executeAgentRunBoundary({ pi, ctx, request, executor, signal });
    if (req.workspaceHandle !== undefined) {
      options.workspaceManager?.resolve(req.workspaceHandle);
    }

    // 7. Fail-closed mapping: SDK host unavailable -> throw WorkflowAgentUnavailableError
    if (
      boundary.status === "blocked" &&
      boundary.diagnostics.some((d) => typeof d === "string" && d.includes(AGENT_SDK_UNAVAILABLE_DIAGNOSTIC))
    ) {
      throw new WorkflowAgentUnavailableError(
        `${AGENT_SDK_UNAVAILABLE_HINT}: ${boundary.reason}`,
        boundary.diagnostics,
      );
    }

    // 8. Success / other outcomes -> map to WorkflowAgentResult
    // Round journal payload (REQ-009): the accumulated child-session tokens land on the live
    // row (applySessionStats); project them into the agent_end usage so the drill shows a
    // per-round token count. No usage on the row ⇒ omit (never a fabricated 0).
    const usage = slotRowId !== undefined ? usageFromRow(agentLiveStore.rows.get(slotRowId)) : undefined;
    const result: WorkflowAgentResult = {
      ok: boundary.status === "completed",
      status: boundary.status as WorkflowAgentResult["status"],
      summary: boundary.reason,
      ...(boundary.text !== undefined ? { text: boundary.text } : {}),
      diagnostics: boundary.diagnostics,
      ...(boundary.evidence !== undefined ? { evidence: boundary.evidence } : {}),
      agent: agent.name,
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(boundary.childSession?.id !== undefined ? { childSessionId: boundary.childSession.id } : {}),
      ...(boundary.childTrace !== undefined ? { childTrace: boundary.childTrace } : {}),
      ...(boundary.resultArtifact?.path !== undefined ? { resultArtifact: boundary.resultArtifact.path } : {}),
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      ...(liveModel?.model !== undefined ? { model: liveModel.model } : {}),
      ...(liveModel?.thinking !== undefined ? { thinking: liveModel.thinking } : {}),
      ...(slotKey !== undefined ? { slotKey } : {}),
      ...(round !== undefined ? { round } : {}),
      ...(usage !== undefined ? { usage } : {}),
      permissionMode,
      workspaceMode,
      readOnly: agent.readOnly,
    };
    return result;
  };
}

/** Increment and return the round for a slot row id (first call → 1). */
function nextRound(counter: Map<string, number>, rowId: string): number {
  const round = (counter.get(rowId) ?? 0) + 1;
  counter.set(rowId, round);
  return round;
}

/** Project a live row's accumulated child tokens into a round `usage`, or undefined when absent. */
function usageFromRow(row: AgentLiveRow | undefined): WorkflowLlmUsage | undefined {
  if (row?.tokenCount === undefined) return undefined;
  const { input, output } = row.tokenCount;
  return { input, output, totalTokens: input + output, costTotal: 0 };
}
