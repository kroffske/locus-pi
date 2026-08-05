/**
 * workflow-agent-bridge.ts — Adapter: agent() -> Pi task/createAgentSession path.
 *
 * Turns a WorkflowAgentRequest into exactly one Pi task execution through
 * createAgentRunRequest + executeAgentRunBoundary, reusing the same helper path the
 * `task` tool uses. Injectable createExecutor factory (default createAgentSdkSessionExecutor)
 * so tests can mock createSession and prove the wiring.
 */

import type { ExtensionAPI, ExtensionContext, ThinkingLevel } from "../../_shared/host/pi-api.js";
import { getProjectRoot, getWorkingDirectory } from "../../_shared/host/pi-api.js";
import { createAgentRunRequest, executeAgentRunBoundary } from "../../_shared/agent-runtime/agent-runner.js";
import { createWorkflowWorktree } from "./workflow-worktree.js";
import type { WorkflowWorkspaceManager } from "./workflow-worktree.js";
import type { AgentExecutor } from "../../_shared/agent-runtime/agent-runner.js";
import {
  agentLiveStore,
  createAgentSdkSessionExecutor,
  AGENT_SDK_UNAVAILABLE_HINT,
  type AgentLiveExecutionHandle,
  type AgentSdkSessionExecutorOptions,
} from "../../_shared/agent-runtime/agent-sdk-host.js";
import { EXECUTED_MODEL_UNAVAILABLE } from "../../_shared/agent-runtime/agent-runner.js";
import { discoverAgentDefinitions } from "../../_shared/agent-runtime/agents.js";
import type { ModelRoleResolution } from "../../_shared/model/model-settings.js";
import {
  DEFAULT_MODEL_ROLES,
  formatAssignment,
  loadModelRolesState,
  resolveAgentModelPreference,
  malformedRoleAssignmentNote,
  resolveDeclaredModelRole,
  unassignedAgentTierNote,
  unassignedRoleNote,
  type ModelRolesState,
} from "../../_shared/model/model-settings.js";
import { resolveLiveModelDisplay } from "../../_shared/model/live-model-display.js";
import { DEFAULT_WORKFLOW_AGENT, workflowSlotKey } from "./workflow-runtime.js";
import { workflowAgentLiveRowId, workflowAgentLiveChildRowId } from "./workflow-journal.js";
import type {
  WorkflowAgentPreflight,
  WorkflowAgentRunner,
  WorkflowAgentRequest,
  WorkflowAgentResult,
  WorkflowUsage,
  WorkspaceMode,
} from "./workflow-runtime.js";
import { DEFAULT_WORKFLOW_BUDGET, workflowSdkTurnTimeoutMs } from "./workflow-budget.js";
import { createWorkflowModelResolver, type WorkflowModelResolver } from "../../_shared/model/workflow-model-resolve.js";
import type { AgentDefinition, PermissionMode } from "../../_shared/agent-runtime/agents.js";
import type { AgentFailureCause } from "../../_shared/agent-runtime/agent-failure-cause.js";
import type { WorkflowChildEvidenceDestinations } from "./workflow-artifacts.js";
import { captureRepositoryCheckScripts } from "../../_shared/agent-runtime/agent-read-only-policy.js";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Thrown when the host genuinely cannot spawn a child (fail closed, honest reason). */
export class WorkflowAgentUnavailableError extends Error {
  readonly diagnostics: string[];
  /**
   * The same closed cause a result-shaped failure would carry.
   *
   * This failure never becomes a `WorkflowAgentResult` — the run must end, not be re-asked
   * — so without the cause on the error itself the journal's terminal record of the call is
   * an English sentence a reader would have to match on. The runtime reads it structurally
   * and puts it on the `error` line.
   */
  readonly failureCause: AgentFailureCause = "sdk-unavailable";
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
  /** Optional human semantic input; host continuation metadata is never mixed into it. */
  args?: string;
  /**
   * Injectable executor factory — defaults to createAgentSdkSessionExecutor.
   * Tests inject a factory that returns createAgentSdkSessionExecutor({ createSession: fake })
   * so the bridge PROVABLY routes through the real task/createAgentSession path.
   */
  createExecutor?: (opts: {
    model?: unknown;
    thinkingLevel?: ThinkingLevel;
    live?: AgentSdkSessionExecutorOptions["live"];
    maxToolCalls?: number;
    /** SDK turn budget derived from the call's declared `timeoutMs` (D4), so the
     *  host's own child deadline can only ever fire after the workflow fuse. */
    turnTimeoutMs?: number;
    reportsDir?: string;
    onLiveExecution?: (execution: AgentLiveExecutionHandle) => void;
  }) => AgentExecutor;
  /** Injectable concrete-selector resolver; defaults to the host model registry on `ctx`. */
  resolveModel?: WorkflowModelResolver;
  defaultAgent?: string; // default DEFAULT_WORKFLOW_AGENT
  workspaceManager?: WorkflowWorkspaceManager;
  evidenceDestinations?: (callId: string) => WorkflowChildEvidenceDestinations;
  /** Project-local workflow workspace shared by the root and saved children. */
  workflowWorkspaceDir?: string;
}

/**
 * Rule between this run's working-directory note and the workflow's own prompt.
 *
 * A stable, single boundary: the note never contains it, so the FIRST occurrence
 * in a composed child task always marks where the author's prompt begins.
 */
export const WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR = "\n\n---\n\n";

/**
 * The child task as the model receives it: this run's working-directory note,
 * then the workflow's own prompt.
 *
 * The note goes FIRST so the schema contract and any retry-repair block a shaped
 * call appends stay the last thing the child reads. Without a configured
 * directory the author's prompt travels alone.
 *
 * Every workflow child receives the full tool surface. When a run workspace is
 * configured, say plainly where files belong so write/edit/bash work without an
 * author-maintained tool list.
 */
export function composeWorkflowChildTask(
  prompt: string,
  workflowWorkspaceDir: string | undefined,
  locations: { pwd?: string; projectRoot?: string } = {},
): string {
  if (
    (workflowWorkspaceDir === undefined || workflowWorkspaceDir.trim() === "") &&
    locations.projectRoot === undefined
  ) {
    return prompt;
  }
  const note = [
    "## Workflow filesystem locations",
    "",
    ...(workflowWorkspaceDir === undefined
      ? []
      : [`workflow workspace (write intermediate and final workflow files here): ${workflowWorkspaceDir}`]),
    ...(locations.pwd === undefined ? [] : [`pwd (code workspace): ${locations.pwd}`]),
    ...(locations.projectRoot === undefined ? [] : [`project root (source context): ${locations.projectRoot}`]),
    "",
    "Use pwd for code work. Use the workflow workspace for workflow artifacts; replace assigned files idempotently.",
    "Treat the project root as source context, not as a default artifact destination.",
    "Use the exact paths above. Do not substitute the user home directory or /tmp.",
    "Workflow files keep their exact names; runtime records references and does not reconstruct their content.",
  ].join("\n");
  return `${note}${WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR}${prompt}`;
}

export function resolvePermissionMode(input: {
  agent: AgentDefinition;
  reqMode: PermissionMode | undefined;
  isDefaultAgent: boolean;
}): PermissionMode {
  void input;
  return "inherit-parent";
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

/** Resolve every declared agent/model leg without creating a child session.
 *  Compositions use this before fan-out so a bad judge cannot spend members. */
export function createWorkflowAgentPreflight(options: WorkflowAgentBridgeOptions): WorkflowAgentPreflight {
  const defaultAgentName = options.defaultAgent ?? DEFAULT_WORKFLOW_AGENT;
  const resolveModelFn: WorkflowModelResolver = options.resolveModel ?? createWorkflowModelResolver(options.ctx);

  return async function preflightWorkflowAgents(requests): Promise<void> {
    const projectRoot = getProjectRoot(options.ctx);
    const discovered = discoverAgentDefinitions(projectRoot);
    const agentMap = new Map(discovered.definitions.map((agent) => [agent.name, agent]));
    const modelRoles = await loadModelRolesState(options.ctx);

    for (const request of requests) {
      const agentName = request.agent !== undefined && request.agent !== "" ? request.agent : defaultAgentName;
      const agent = agentMap.get(agentName) ?? agentMap.get(defaultAgentName);
      if (agent === undefined || !agentMap.has(agentName)) {
        throw new Error(`Unknown agent: ${agentName}. Available: ${[...agentMap.keys()].join(", ")}`);
      }
      const req: WorkflowAgentRequest = {
        prompt: "Fusion model preflight",
        agent: agentName,
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.modelRole !== undefined ? { modelRole: request.modelRole } : {}),
      };
      const tier = await resolveWorkflowTier({ req, agent, modelRoles, resolveModelFn });
      if (tier.kind === "refused") throw new Error(tier.message);
    }
  };
}

/** Builds the WorkflowAgentRunner the runtime depends on. */
export function createWorkflowAgentRunner(options: WorkflowAgentBridgeOptions): WorkflowAgentRunner {
  const { pi, ctx, signal, resolveModel } = options;
  const defaultAgentName = options.defaultAgent ?? DEFAULT_WORKFLOW_AGENT;
  const resolveModelFn: WorkflowModelResolver = resolveModel ?? createWorkflowModelResolver(ctx);
  // Freeze executable package commands once, before the first workflow child can write.
  const repositoryCheckScripts = captureRepositoryCheckScripts(getWorkingDirectory(ctx));
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
        failureCause: "unknown-agent",
        summary: `Unknown agent: ${agentName}`,
        diagnostics: [
          `Workflow agent bridge: agent "${agentName}" not found in catalog. Available: ${[...agentMap.keys()].join(", ")}`,
        ],
        agent: agentName,
        workspaceMode: resolveWorkspaceMode({ reqMode: req.workspaceMode, sandbox: req.sandbox }),
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
    }
    // A workflow-selected catalog role contributes its prompt/model identity, not
    // a hidden capability downgrade. Every workflow child receives the host's
    // full available tool surface. `allowedTools: ["*"]` is the SDK contract.
    const agent: AgentDefinition = {
      ...selectedAgent,
      allowedTools: ["*"],
      tools: ["*"],
      readOnly: false,
      permissionMode: "inherit-parent",
    };

    // 2. Pi still owns operator approval. Workflow source cannot maintain a
    //    second capability policy: every call uses the wildcard tool set.
    const approvalTier: "allow" = "allow";
    const permissionMode = resolvePermissionMode({
      agent,
      reqMode: req.permissionMode,
      isDefaultAgent: agent.name === defaultAgentName,
    });
    const workspaceMode = resolveWorkspaceMode({ reqMode: req.workspaceMode, sandbox: req.sandbox });

    // 3. Tier resolution. This is the one place that decides which model the child
    //    runs on, and it decides it BEFORE any child is spawned so a refusal costs
    //    nothing. `modelRoleResolution` continues to travel into the request capsule
    //    and the run-result artifact exactly as it did before.
    const modelRoles = await loadModelRolesState(ctx);
    const tier = await resolveWorkflowTier({ req, agent, modelRoles, resolveModelFn });
    if (tier.kind === "refused") {
      return {
        ok: false,
        status: "failed",
        // Permanent configuration fault. Explicitly non-retryable; kept inside the
        // closed cause set instead of widening it on no evidence of a new class.
        failureCause: "unclassified",
        // The SUMMARY carries the whole reason, not a headline. `diagnostics` does not
        // reach `agent_end` or the result envelope — a live run proved the actionable
        // half ("provider X has no model Y", the pi/<role> migration hint) was being
        // dropped and the operator was left with a quoted selector and no next step.
        summary: tier.message,
        diagnostics: [tier.message],
        agent: agent.name,
        workspaceMode,
        ...(req.label !== undefined ? { label: req.label } : {}),
      };
    }
    const modelRoleResolution = tier.roleResolution;
    const liveModel = resolveLiveModelDisplay({
      pi,
      ctx,
      ...(tier.kind === "resolved" ? { requestedModel: tier.selector } : {}),
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
          failureCause: "workspace-allocation",
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
          failureCause: "workspace-allocation",
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
          failureCause: "workspace-allocation",
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
          failureCause: "workspace-allocation",
          summary: message,
          diagnostics: [message],
          agent: agent.name,
          workspaceMode,
          ...(req.label !== undefined ? { label: req.label } : {}),
        };
      }
    }

    // 4. Build the request
    // The turn budget is declared by the runtime (package contract or per-call
    // option) and only falls back here when an embedder configured neither. It was
    // a literal `5` invisible to authors while the child's whole wall clock is
    // computed from it.
    const maxTurns = req.maxTurns ?? DEFAULT_WORKFLOW_BUDGET.turns;
    const childTask = composeWorkflowChildTask(req.prompt, options.workflowWorkspaceDir, {
      pwd: worktreePath ?? projectRoot,
      projectRoot,
    });
    const request = createAgentRunRequest(agent, childTask, {
      maxTurns,
      approvalTier,
      allowedTools: ["*"],
      modelRoleResolution,
      // Travels on the REQUEST because the run-result artifact is written from the
      // request, inside the boundary, before this bridge ever sees a result.
      ...(tier.kind === "inherit" && tier.fallback !== undefined ? { modelRoleFallback: tier.fallback } : {}),
      repositoryCheckScripts,
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
      ((o: {
        model?: unknown;
        thinkingLevel?: ThinkingLevel;
        live?: AgentSdkSessionExecutorOptions["live"];
        maxToolCalls?: number;
        turnTimeoutMs?: number;
        reportsDir?: string;
        onLiveExecution?: (execution: AgentLiveExecutionHandle) => void;
      }) =>
        createAgentSdkSessionExecutor({
          ...(o.model !== undefined ? { model: o.model } : {}),
          ...(o.thinkingLevel !== undefined ? { thinkingLevel: o.thinkingLevel } : {}),
          ...(o.live !== undefined ? { live: o.live } : {}),
          ...(o.maxToolCalls !== undefined ? { maxToolCalls: o.maxToolCalls } : {}),
          ...(o.turnTimeoutMs !== undefined ? { turnTimeoutMs: o.turnTimeoutMs } : {}),
          ...(o.reportsDir !== undefined ? { reportsDir: o.reportsDir } : {}),
          ...(o.onLiveExecution !== undefined ? { onLiveExecution: o.onLiveExecution } : {}),
        }));
    const evidenceDestinations =
      options.evidenceDestinations !== undefined && req.callId !== undefined
        ? options.evidenceDestinations(req.callId)
        : undefined;
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
      ...(options.workflowRunId !== undefined ? { workflowRunId: options.workflowRunId } : {}),
      ...(slotKey !== undefined ? { slotKey } : {}),
      ...(round !== undefined ? { round } : {}),
      ...(liveModel?.model !== undefined ? { model: liveModel.model } : {}),
      ...(liveModel?.thinking !== undefined ? { thinking: liveModel.thinking } : {}),
      isolated: workspaceMode !== "project",
      noMcp: permissionMode === "restricted",
    };
    let liveExecution: AgentLiveExecutionHandle | undefined;
    // ONE wall clock per child. The SDK host kills a child at `turnTimeoutMs * maxTurns`
    // whether or not anyone asked it to, so leaving that budget at its own default made
    // two independent deadlines race and the operator's failure text nondeterministic.
    // Here the declared fuse is the authority and the SDK budget is derived from it,
    // strictly above it — a backstop that cannot fire first (D4).
    const turnTimeoutMs = req.timeoutMs === undefined ? undefined : workflowSdkTurnTimeoutMs(req.timeoutMs, maxTurns);
    const executor = createExecutorFn({
      // `perCallModel ?? resolvedRoleModel ?? ctx.model`, collapsed into the one term
      // `resolveWorkflowTier` already computed. The parent model is reachable only
      // through `kind: "inherit"` — i.e. the call declared no tier, or declared one
      // that no layer assigns and the degradation was recorded.
      model: tier.kind === "resolved" ? tier.model : (ctx as { model?: unknown }).model,
      ...(tier.kind === "resolved" && tier.thinking !== undefined ? { thinkingLevel: tier.thinking } : {}),
      live,
      onLiveExecution: (execution) => {
        liveExecution = execution;
      },
      ...(req.maxToolCalls !== undefined ? { maxToolCalls: req.maxToolCalls } : {}),
      ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
      ...(evidenceDestinations !== undefined ? { reportsDir: evidenceDestinations.transcriptDir } : {}),
    });

    // 6. Execute through the boundary (same as task tool).
    // A per-call fuse aborts the child itself rather than abandoning it: a timeout
    // that only stops waiting would leave a child burning tokens with nothing left
    // to read its answer. The run-level signal still aborts everything.
    const callAbort = new AbortController();
    // Run cancellation and the per-call fuse share one child signal. Whichever source
    // aborts it first owns the durable outcome; the other source must not relabel it
    // while the executor unwinds.
    let abortOwner: "run" | "timeout" | undefined;
    const abortFromRun = (): void => {
      if (abortOwner !== undefined) return;
      abortOwner = "run";
      callAbort.abort(signal.reason);
    };
    if (signal.aborted) abortFromRun();
    else signal.addEventListener("abort", abortFromRun, { once: true });
    const timer =
      req.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (abortOwner !== undefined) return;
            abortOwner = "timeout";
            callAbort.abort(new Error(`workflow agent call exceeded its ${String(req.timeoutMs)} ms timeout`));
          }, req.timeoutMs);
    let boundary;
    try {
      boundary = await executeAgentRunBoundary({
        pi,
        ctx,
        request,
        executor,
        signal: callAbort.signal,
        // The fuse below is THIS module's, so the host can only report the cancellation
        // it observed — or return a late success after the fuse already fired. Finalize
        // both status and cause before the envelope is written.
        finalizeResult: (result) => {
          if (abortOwner !== "timeout") return result;
          const { text: _lateText, ...resultWithoutText } = result;
          return {
            ...resultWithoutText,
            status: "failed",
            reason: `Agent call exceeded its ${String(req.timeoutMs)} ms timeout and was aborted.`,
            failureCause: "call-timeout",
          };
        },
        ...(evidenceDestinations !== undefined ? { resultArtifactsDir: evidenceDestinations.resultArtifactsDir } : {}),
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", abortFromRun);
    }
    if (abortOwner === "timeout") {
      // Name the fuse. Without this the operator reads only the host's generic
      // abort reason and cannot tell a timeout from an operator cancellation.
      const message = `Agent call exceeded its ${String(req.timeoutMs)} ms timeout and was aborted.`;
      return {
        ok: false,
        status: "failed",
        // The fuse is a TRANSPORT failure: the child was aborted, not answered badly.
        failureCause: "call-timeout",
        summary: message,
        diagnostics: [...boundary.diagnostics, message],
        agent: agent.name,
        permissionMode,
        workspaceMode,
        readOnly: agent.readOnly,
        ...(req.label !== undefined ? { label: req.label } : {}),
        ...(boundary.executedModel !== undefined ? { executedModel: boundary.executedModel } : {}),
        // Same gate as the settled path below, for the same reason: the note is past
        // tense, and a call the fuse killed before kickoff has no child to speak of.
        // `executedModel` is set only after the child is prompted, so it is the one
        // honest proof of execution on every path — including this early return.
        ...(tier.kind === "inherit" && tier.fallback !== undefined && boundary.executedModel !== undefined
          ? { modelRoleFallback: tier.fallback }
          : {}),
        ...(boundary.childSession?.id !== undefined ? { childSessionId: boundary.childSession.id } : {}),
        ...(boundary.childTrace !== undefined ? { childTrace: boundary.childTrace } : {}),
        // Carried for the same reason the transcript is, and it is NOT cosmetic: a fresh
        // child that reports a session id and no result envelope makes evidence adoption
        // throw (`workflow-artifacts.ts`, "did not persist a result envelope"), which ends
        // the call by THROWING — past the retry loop, which only ever sees a returned
        // result. Dropping it here turned every artifact-backed timeout into an unretryable
        // run death, silently disabling the very option `attempts` exists to provide.
        ...(boundary.resultArtifact?.path !== undefined ? { resultArtifact: boundary.resultArtifact.path } : {}),
      };
    }
    if (req.workspaceHandle !== undefined) {
      options.workspaceManager?.resolve(req.workspaceHandle);
    }

    // 7. Fail-closed mapping: SDK host unavailable -> throw WorkflowAgentUnavailableError
    //
    // Keyed on the typed cause the host declares where it knows it, not on a substring of
    // English diagnostic prose. The two agreed on every path the moment the cause existed,
    // which is exactly why the prose check had to go: it made the machine-readable channel
    // decorative, and re-wording one diagnostic would silently downgrade a run-ending
    // failure into a blocked result the script could read as an answer.
    if (boundary.failureCause === "sdk-unavailable") {
      throw new WorkflowAgentUnavailableError(
        `${AGENT_SDK_UNAVAILABLE_HINT}: ${boundary.reason}`,
        boundary.diagnostics,
      );
    }

    // 8. Success / other outcomes -> map to WorkflowAgentResult
    // Round journal payload (REQ-009): the accumulated child-session tokens land on the live
    // row (applySessionStats); project them into the agent_end usage so the drill shows a
    // per-round token count. No usage on the row ⇒ omit (never a fabricated 0).
    const usage =
      slotRowId !== undefined && liveExecution !== undefined ? usageFromExecution(liveExecution) : undefined;
    // The host readback, or nothing. `unavailable` is carried through verbatim so the
    // evidence distinguishes "the peer told us" from "the peer had nothing to tell",
    // and neither is ever replaced by the selector this bridge asked for.
    const executedModel = boundary.executedModel;
    // An unassigned role is an INTENT to degrade; it becomes a DEGRADATION only once a
    // child actually RAN on the parent's model. The note is phrased in the past tense
    // ("the child inherited the parent session model"), so emitting it for a call that
    // never reached `createSession` — or that built a session and was cancelled before
    // the child was ever prompted — would put a claim about a child that never ran into
    // `agent_end`, the result envelope and the run-result artifact: invented execution
    // evidence in the surfaces this task exists to make trustworthy. `executedModel` is
    // set only after child kickoff (agent-sdk-host), so it is the honest gate; a created
    // -but-never-prompted session has an id and must not qualify.
    const degradationConfirmed =
      tier.kind === "inherit" && tier.fallback !== undefined && boundary.executedModel !== undefined;
    const result: WorkflowAgentResult = {
      ok: boundary.status === "completed",
      status: boundary.status as WorkflowAgentResult["status"],
      summary: boundary.reason,
      // Carried, never re-derived: the host declared the cause where it was known.
      ...(boundary.failureCause !== undefined ? { failureCause: boundary.failureCause } : {}),
      ...(boundary.text !== undefined ? { text: boundary.text } : {}),
      diagnostics: degradationConfirmed ? [tier.fallback!, ...boundary.diagnostics] : boundary.diagnostics,
      ...(boundary.evidence !== undefined ? { evidence: boundary.evidence } : {}),
      agent: agent.name,
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(boundary.childSession?.id !== undefined ? { childSessionId: boundary.childSession.id } : {}),
      ...(boundary.childTrace !== undefined ? { childTrace: boundary.childTrace } : {}),
      ...(boundary.resultArtifact?.path !== undefined ? { resultArtifact: boundary.resultArtifact.path } : {}),
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      // Display prefers a real readback over the request; the sentinel is evidence,
      // not a selector, so it stays out of the row and only enters `executedModel`.
      ...(executedModel !== undefined && executedModel !== EXECUTED_MODEL_UNAVAILABLE
        ? { model: executedModel }
        : liveModel?.model !== undefined
          ? { model: liveModel.model }
          : {}),
      ...(executedModel !== undefined ? { executedModel } : {}),
      ...(degradationConfirmed ? { modelRoleFallback: tier.fallback! } : {}),
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

/**
 * Which model this call runs on, decided before any child exists.
 *
 * Three outcomes, and the difference between them is the whole point of the tier
 * feature:
 *
 *  - `resolved` — a concrete model came out of the registry and reaches the child.
 *  - `inherit`  — nothing was declared, or a declared ROLE has no assignment in any
 *    layer. The child runs on the parent session model and, when a role was named,
 *    `fallback` records that in one sentence. Quiet fallback, loud record.
 *  - `refused`  — a CONCRETE `provider/id` selector did not resolve. A typo, a
 *    provider that is not configured, a model the host does not have. The call ends
 *    here with the selector quoted and zero child sessions.
 *
 * The asymmetry is deliberate and is the owner's decision (OD5): the package ships
 * no role assignments, so refusing an unassigned role would make every bundled agent
 * fail on a stock install; but a selector an author typed by hand is an instruction,
 * and silently running something else is exactly what this task exists to stop.
 */
type WorkflowTier =
  | {
      kind: "resolved";
      /** Where the tier came from — used only to phrase diagnostics. */
      origin: "call-model" | "call-role" | "frontmatter";
      selector: string;
      model: unknown;
      thinking?: ThinkingLevel;
      roleResolution: ModelRoleResolution;
    }
  | { kind: "inherit"; roleResolution: ModelRoleResolution; fallback?: string }
  | { kind: "refused"; message: string };

async function resolveWorkflowTier(input: {
  req: WorkflowAgentRequest;
  agent: AgentDefinition;
  modelRoles: ModelRolesState;
  resolveModelFn: WorkflowModelResolver;
}): Promise<WorkflowTier> {
  const { req, agent, modelRoles, resolveModelFn } = input;
  // Frontmatter preference is computed either way: it is what the request capsule,
  // the run-result artifact and the live row have always recorded, and dropping it
  // on the per-call paths would silently change three evidence surfaces.
  const frontmatterResolution = resolveAgentModelPreference(modelRoles, agent.model ?? []);

  if (req.model !== undefined) {
    const resolution = await resolveModelFn(req.model);
    if (!resolution.ok) {
      return refusal(`Per-call model ${JSON.stringify(req.model)} could not be used: ${resolution.message}`, req.model);
    }
    return {
      kind: "resolved",
      origin: "call-model",
      selector: resolution.selector,
      model: resolution.model,
      ...(resolution.thinking !== undefined ? { thinking: resolution.thinking } : {}),
      roleResolution: frontmatterResolution,
    };
  }

  if (req.modelRole !== undefined) {
    // `modelRole` is a NAME IN THE ROLES TABLE and never a provider selector (D4).
    // A slash means a concrete `provider/id` under the OD1 grammar, so a
    // slash-bearing `modelRole` is a category error, not an unassigned role — and
    // treating it as one would degrade it to the session model, i.e. silently run
    // something other than the model the author spelled out. That is the exact
    // fail-closed case OD5 keeps loud, so it refuses with the option to use instead.
    if (req.modelRole.includes("/")) {
      return refusal(
        `modelRole ${JSON.stringify(req.modelRole)} is not a role name: a "/" means a concrete ` +
          `provider/id selector, and modelRole only ever names a role in the model-roles table. ` +
          `Use \`model: ${JSON.stringify(req.modelRole)}\` to pin a concrete model, or name a bare ` +
          `role (one of: ${DEFAULT_MODEL_ROLES.join(", ")}).`,
        req.modelRole,
      );
    }
    // The DECLARED role only. Purpose resolution would answer a question the author
    // did not ask, and `modelRole: "smol"` would run whatever `agent` holds.
    const declared = resolveDeclaredModelRole(modelRoles, req.modelRole);
    if (declared.malformed !== undefined) {
      // Assigned but unparseable — a config typo, not an unassigned role. Degrading
      // it would run the parent's model under the requested tier's name and tell the
      // operator their role was "not assigned in any layer", which their own file
      // contradicts.
      return refusal(malformedRoleAssignmentNote(req.modelRole, "modelRole", declared.malformed), req.modelRole);
    }
    if (declared.assignment === undefined) {
      return {
        kind: "inherit",
        roleResolution: declared,
        fallback: unassignedRoleNote(req.modelRole, "modelRole", modelRoles),
      };
    }
    const selector = formatAssignment(declared.assignment);
    const resolution = await resolveModelFn(selector);
    if (!resolution.ok) {
      return refusal(
        `modelRole ${JSON.stringify(req.modelRole)} could not be used: it is assigned ` +
          `${JSON.stringify(selector)} by the ${declared.source} layer, but that ${resolution.message}`,
        selector,
      );
    }
    return {
      kind: "resolved",
      origin: "call-role",
      selector: resolution.selector,
      model: resolution.model,
      ...(resolution.thinking !== undefined ? { thinking: resolution.thinking } : {}),
      roleResolution: declared,
    };
  }

  const frontmatterSelector = agent.model?.[0];
  if (frontmatterResolution.malformed !== undefined) {
    // D3b softens an UNASSIGNED frontmatter role so a stock install still works. It
    // does not soften a broken roles file: no foreign operator has one, and the only
    // way to reach here is for this machine's config to name a selector it cannot parse.
    return refusal(
      malformedRoleAssignmentNote(
        frontmatterSelector ?? frontmatterResolution.role,
        `agent "${agent.name}" frontmatter model`,
        frontmatterResolution.malformed,
      ),
      frontmatterSelector,
    );
  }
  if (frontmatterResolution.assignment === undefined) {
    return {
      kind: "inherit",
      roleResolution: frontmatterResolution,
      ...(frontmatterSelector !== undefined
        ? { fallback: unassignedAgentTierNote(agent.name, frontmatterSelector, frontmatterResolution, modelRoles) }
        : {}),
    };
  }
  const selector = formatAssignment(frontmatterResolution.assignment);
  const resolution = await resolveModelFn(selector);
  if (!resolution.ok) {
    return refusal(
      `Agent "${agent.name}" frontmatter model ${JSON.stringify(frontmatterSelector ?? selector)} could not be used: ` +
        `it resolves to ${JSON.stringify(selector)} (${frontmatterResolution.source} layer), ` +
        `but that ${resolution.message}`,
      frontmatterSelector ?? selector,
    );
  }
  return {
    kind: "resolved",
    origin: "frontmatter",
    selector: resolution.selector,
    model: resolution.model,
    ...(resolution.thinking !== undefined ? { thinking: resolution.thinking } : {}),
    roleResolution: frontmatterResolution,
  };
}

function refusal(message: string, selector?: string): WorkflowTier {
  return { kind: "refused", message: `${message}${legacyRoleNamespaceHint(selector)}` };
}

/**
 * The one predictable way this refusal fires on an upgrade.
 *
 * Before tiers, the bundled agents wrote their tier as `pi/<role>`, and nothing read
 * it — `pi` was never a provider. An agent's FRONTMATTER in that namespace is now
 * repaired in `resolveAgentModelPreference`, because that spelling is the package's
 * own history and refusing it makes a stale catalog unusable. Everything else still
 * fails closed and reaches here: a per-call `model` / `modelRole` written today, a
 * roles-table entry the operator assigned by hand, or `pi/<not-a-role>`, where
 * "provider pi has no model X" alone tells them nothing about what to edit.
 */
function legacyRoleNamespaceHint(selector: string | undefined): string {
  if (selector === undefined || !selector.startsWith("pi/")) return "";
  const role = selector.slice("pi/".length);
  return (
    ` "pi/<role>" was the pre-tier role namespace and a slash now means a real provider: name the role ` +
    `where a role is accepted (\`modelRole: ${JSON.stringify(role)}\`, or an agent's frontmatter ` +
    `\`model: ${role}\`), or write a real provider/id here.`
  );
}

/** Increment and return the round for a slot row id (first call → 1). */
function nextRound(counter: Map<string, number>, rowId: string): number {
  const round = (counter.get(rowId) ?? 0) + 1;
  counter.set(rowId, round);
  return round;
}

/** Project the exact execution's accumulated child tokens, or omit when its slot was replaced. */
function usageFromExecution(execution: AgentLiveExecutionHandle): WorkflowUsage | undefined {
  const row = agentLiveStore.rowForExecution(execution);
  if (row?.tokenCount === undefined) return undefined;
  const { input, output } = row.tokenCount;
  return { input, output, totalTokens: input + output, costTotal: 0 };
}
