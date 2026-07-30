/**
 * extensions/workflows/index.ts — Extension entrypoint.
 *
 * Registers the `workflow` tool (./workflow-tool.js) and the `/workflows`
 * command plus its flat `/workflow-*` aliases (./command-router.js). Owns only
 * the per-session wiring those two need: the live progress panels, the
 * completed-run bookkeeping, the command launcher, and the operator handoff
 * controller. Every surface it renders lives in a submodule.
 */

import type { ExtensionAPI, ExtensionContext } from "../_shared/pi-api.js";
import { getProjectRoot, getWorkingDirectory, setTextWidget } from "../_shared/pi-api.js";
import { pinTransientUiKey, registerTransientUiCleanup, unpinTransientUiKey } from "../_shared/command-ui.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  pruneCompletedWorkflowRunLiveRows,
  resetWorkflowLiveExecutions,
} from "./runtime/workflow-journal.js";
import { setOperatorWidget } from "../_shared/widget-render.js";
import { registerWorkflowCommands } from "./command-router.js";
import { WorkflowOperatorHandoffController, type WorkflowHandoffPumpResult } from "./operator-handoff-controller.js";
import { createWorkflowOperatorHandoffService } from "./operator-handoff-service.js";
import {
  clearWorkflowRunStatus,
  clearWorkflowWidget,
  presentWorkflowHandoffPumpResult,
  setWorkflowEventStatus,
  setWorkflowLaunchStatus,
} from "./operator-surface.js";
import { buildWorkflowResultBlock, errorMessage, workflowBackgroundFailureBlock } from "./operator-ui.js";
import {
  WORKFLOW_LIVE_WIDGET_KEY,
  installWorkflowProgress,
  renderAgentLiveRowsText,
  type WorkflowProgressComponent,
} from "./progress-widget.js";
import { createWorkflowCommandLauncher } from "./workflow-command-launcher.js";
import { registerWorkflowTool } from "./workflow-tool.js";
import {
  announceCommandWorkflowStart,
  createWorkflowTranscript,
  persistCommandWorkflowTranscript,
} from "./workflow-transcript.js";

export default function workflows(pi: ExtensionAPI): void {
  const completedRunIds = new Set<string>();
  const sessionPanels = new Set<WorkflowProgressComponent>();
  let completionProjectRoot = process.cwd();
  let completionWorkingDirectory = completionProjectRoot;
  const rememberCompletionContext = (ctx: ExtensionContext): void => {
    completionProjectRoot = getProjectRoot(ctx);
    completionWorkingDirectory = getWorkingDirectory(ctx);
  };
  const disposePanel = (panel: WorkflowProgressComponent): void => {
    panel.dispose();
    sessionPanels.delete(panel);
  };
  const disposeSessionPanels = (): void => {
    for (const panel of sessionPanels) panel.dispose();
    sessionPanels.clear();
  };
  let handoffController: WorkflowOperatorHandoffController;
  const observeHandoffPump = (ctx: ExtensionContext, start: () => Promise<WorkflowHandoffPumpResult>): void => {
    void Promise.resolve()
      .then(start)
      .then((result) => {
        if (result.status === "invalid" || result.status === "failed") {
          presentWorkflowHandoffPumpResult(ctx, result);
        }
      })
      .catch((error) => {
        presentWorkflowHandoffPumpResult(ctx, {
          status: "invalid",
          message: `Workflow handoff pump failed: ${errorMessage(error)}`,
        });
      });
  };
  const commandLauncher = createWorkflowCommandLauncher({
    pi,
    createObserver(request, preparation) {
      clearWorkflowWidget(request.ctx, WORKFLOW_LIVE_WIDGET_KEY);
      setWorkflowLaunchStatus(request.ctx, request.target?.kind ?? "script", request.target?.ref ?? request.scriptRef);
      if (preparation.hasUI) pinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
      let panel: WorkflowProgressComponent | undefined;
      const cleanupPanel = (): void => {
        if (panel !== undefined) disposePanel(panel);
      };
      const transcript = createWorkflowTranscript(request.ctx, request.scriptRef, "command", {
        ...(request.input === undefined ? {} : { input: request.input }),
      });
      return {
        onRunStart(runId) {
          const announcement = transcript.start(runId);
          // The run boundary is published while the session is still idle from
          // the launch check; a busy session gets no banner rather than a
          // steered parent agent.
          if (announcement !== undefined) announceCommandWorkflowStart(pi, request.ctx, announcement);
          if (preparation.hasUI && !panel) {
            panel = installWorkflowProgress(request.ctx, WORKFLOW_LIVE_WIDGET_KEY, request.scriptRef, runId, {
              scope: "workflow",
              declaredStages: preparation.declaredStages,
            });
            sessionPanels.add(panel);
          }
        },
        onEvent(line) {
          applyWorkflowJournalLineToAgentLiveStore(line, getProjectRoot(request.ctx));
          if (preparation.hasUI) panel?.push(line);
          else setTextWidget(request.ctx, "workflows", renderAgentLiveRowsText());
          transcript.event(line);
          setWorkflowEventStatus(request.ctx, line);
        },
        async onResult(result, isCurrent) {
          completedRunIds.add(result.runId);
          const transcriptCompletion = transcript.finish(result);
          if (preparation.hasUI && panel) {
            panel.finish(result);
            cleanupPanel();
          } else {
            setOperatorWidget(request.ctx, "workflows", buildWorkflowResultBlock(result, request.ctx.mode !== "tui"));
          }
          await persistCommandWorkflowTranscript(pi, request.ctx, transcriptCompletion, isCurrent);
        },
        onError(error) {
          cleanupPanel();
          setOperatorWidget(request.ctx, "workflows", workflowBackgroundFailureBlock(error));
        },
        onFinally() {
          cleanupPanel();
          if (preparation.hasUI) unpinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
        },
        onRejected() {
          if (preparation.hasUI) unpinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
        },
      };
    },
    onTerminal(request, isCurrent) {
      observeHandoffPump(request.ctx, async () => {
        if (!isCurrent()) return { status: "stale" };
        try {
          await request.waitForIdle?.();
        } catch {
          return { status: "busy" };
        }
        return handoffController.pumpAfterActive(request.ctx, { isCurrent });
      });
    },
  });
  const handoffService = createWorkflowOperatorHandoffService(commandLauncher);
  handoffController = new WorkflowOperatorHandoffController({
    scan: handoffService.scan,
    read: handoffService.read,
    launch: handoffService.launch,
  });
  const cleanupCompletedRuns = (_ctx: ExtensionContext): boolean => {
    if (completedRunIds.size === 0) return false;
    for (const runId of completedRunIds) pruneCompletedWorkflowRunLiveRows(runId);
    completedRunIds.clear();
    return true;
  };
  const cleanupCompletedSurface = (ctx: ExtensionContext): void => {
    if (commandLauncher.hasActiveCommandRun()) return;
    if (cleanupCompletedRuns(ctx)) clearWorkflowWidget(ctx, WORKFLOW_LIVE_WIDGET_KEY);
    clearWorkflowRunStatus(ctx);
  };
  const cleanupTransientSurface = (ctx: ExtensionContext): void => {
    if (commandLauncher.hasActiveCommandRun()) return;
    cleanupCompletedRuns(ctx);
    clearWorkflowRunStatus(ctx);
  };
  const pumpCurrentHandoffs = (
    ctx: ExtensionContext,
    options: { explicit?: boolean; runId?: string; answer?: string } = {},
  ): Promise<WorkflowHandoffPumpResult> => {
    const lease = commandLauncher.currentLease(ctx);
    if (lease === undefined) return Promise.resolve({ status: "stale" });
    return handoffController.pump(ctx, {
      ...options,
      isCurrent: () => commandLauncher.isCurrent(lease),
    });
  };
  registerTransientUiCleanup(pi, "workflows", cleanupTransientSurface);
  registerTransientUiCleanup(pi, WORKFLOW_LIVE_WIDGET_KEY, cleanupTransientSurface);
  pi.on("turn_end", (_event, ctx) => cleanupCompletedSurface(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    observeHandoffPump(ctx, () => pumpCurrentHandoffs(ctx));
  });
  pi.on("session_start", (_event, ctx) => {
    resetWorkflowLiveExecutions();
    disposeSessionPanels();
    rememberCompletionContext(ctx);
    commandLauncher.startSession(ctx);
    handoffController.startSession();
    observeHandoffPump(ctx, () => pumpCurrentHandoffs(ctx));
  });
  pi.on("session_shutdown", (_event, _ctx) => {
    resetWorkflowLiveExecutions();
    handoffController.shutdown();
    disposeSessionPanels();
    commandLauncher.shutdown();
    unpinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
  });

  registerWorkflowTool(pi, {
    commandLauncher,
    onRunCompleted: (runId) => completedRunIds.add(runId),
  });

  registerWorkflowCommands(pi, {
    commandLauncher,
    pumpCurrentHandoffs,
    rememberCompletionContext,
    completionContext: () => ({
      projectRoot: completionProjectRoot,
      workingDirectory: completionWorkingDirectory,
    }),
    actionableRunIds: (projectRoot) => handoffController.eligibleRunIds(projectRoot),
  });
}
