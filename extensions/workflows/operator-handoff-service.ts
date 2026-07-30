import type { ExtensionContext } from "../_shared/pi-api.js";
import { getProjectRoot, getWorkingDirectory } from "../_shared/pi-api.js";
import {
  assertWorkflowHandoffContinuationEligibility,
  claimWorkflowOperatorHandoff,
  projectWorkflowHandoffState,
  readCurrentWorkflowScriptIdentity,
  readPersistedWorkflowOperatorHandoff,
  releaseWorkflowHandoffClaim,
  workflowContinuationForHandoff,
  type WorkflowOperatorHandoffEnvelope,
} from "./runtime/workflow-handoff.js";
import { listWorkflowRunIds } from "./runtime/workflow-journal.js";
import { resolveWorkflowTarget } from "./runtime/workflow-runner.js";
import { errorMessage } from "../_shared/error-text.js";
import type {
  ActionableWorkflowHandoff,
  WorkflowHandoffLaunchResult,
  WorkflowHandoffScanItem,
} from "./operator-handoff-controller.js";
import type { WorkflowCommandLauncher } from "./workflow-command-launcher.js";

export interface WorkflowOperatorHandoffService {
  scan(projectRoot: string): WorkflowHandoffScanItem[];
  read(projectRoot: string, runId: string): ActionableWorkflowHandoff | { message: string } | undefined;
  launch(item: ActionableWorkflowHandoff, answer: string, ctx: ExtensionContext): Promise<WorkflowHandoffLaunchResult>;
}

export function createWorkflowOperatorHandoffService(
  launcher: Pick<WorkflowCommandLauncher, "launch">,
): WorkflowOperatorHandoffService {
  return {
    scan(projectRoot) {
      const items: WorkflowHandoffScanItem[] = [];
      for (const runId of listWorkflowRunIds(projectRoot)) {
        const read = readPersistedWorkflowOperatorHandoff(projectRoot, runId);
        if (read.status === "absent") continue;
        if (read.status === "invalid") {
          items.push({ status: "invalid", runId, message: read.message });
          continue;
        }
        try {
          const state = projectWorkflowHandoffState(projectRoot, read.handoff);
          switch (state.status) {
            case "pending":
            case "retryable":
              items.push({ status: "actionable", handoff: actionableWorkflowHandoff(read.handoff) });
              break;
            case "running":
              items.push({
                status: "nonactionable",
                runId,
                message:
                  state.childRunId === undefined
                    ? "Workflow continuation is starting."
                    : `Workflow continuation ${state.childRunId} is still running.`,
              });
              break;
            case "resolved":
              items.push({
                status: "nonactionable",
                runId,
                message: `Workflow handoff was resolved by continuation ${state.childRunId}.`,
              });
              break;
            default:
              assertNever(state);
          }
        } catch (error) {
          items.push({ status: "invalid", runId, message: errorMessage(error) });
        }
      }
      return items;
    },
    read(projectRoot, runId) {
      const read = readPersistedWorkflowOperatorHandoff(projectRoot, runId);
      if (read.status === "absent") return undefined;
      if (read.status === "invalid") return { message: read.message };
      try {
        const state = projectWorkflowHandoffState(projectRoot, read.handoff);
        if (state.status === "running") {
          return {
            message:
              state.childRunId === undefined
                ? "Workflow continuation is starting."
                : `Workflow continuation ${state.childRunId} is still running.`,
          };
        }
        if (state.status === "resolved") {
          return { message: `Workflow handoff was resolved by continuation ${state.childRunId}.` };
        }
        return actionableWorkflowHandoff(read.handoff);
      } catch (error) {
        return { message: errorMessage(error) };
      }
    },
    async launch(item, answer, ctx) {
      const handoff = item.value;
      let target;
      try {
        target = resolveWorkflowTarget({ script: handoff.target.ref }, getProjectRoot(ctx), getWorkingDirectory(ctx));
        assertWorkflowHandoffContinuationEligibility(handoff, {
          target,
          scriptIdentity: readCurrentWorkflowScriptIdentity(target.path),
        });
      } catch (error) {
        return { status: "invalid", message: errorMessage(error) };
      }
      const claimed = claimWorkflowOperatorHandoff(getProjectRoot(ctx), handoff);
      if (claimed.status !== "claimed") {
        return {
          status: claimed.status === "active" ? "busy" : "invalid",
          message: claimed.message,
        };
      }
      const waitForIdle = contextIdleWaiter(ctx);
      let launched;
      try {
        launched = launcher.launch({
          ctx,
          scriptRef: handoff.target.ref,
          target,
          input: answer,
          continuation: workflowContinuationForHandoff(handoff),
          operatorHandoffClaim: claimed.claim,
          ...(waitForIdle === undefined ? {} : { waitForIdle }),
        });
      } catch (error) {
        const launchFailure = `Workflow continuation launch failed before start: ${errorMessage(error)}`;
        const releaseFailure = releaseUnboundClaim(claimed.claim, launchFailure);
        return releaseFailure ?? { status: "failed", message: launchFailure };
      }
      if (launched.status === "started") return launched;
      const releaseFailure = releaseUnboundClaim(claimed.claim, "Workflow continuation did not start.");
      if (releaseFailure !== undefined) return releaseFailure;
      return launched.status === "busy"
        ? { status: "busy", message: `Workflow ${launched.owner} is still running or stopping.` }
        : { status: "failed", message: "Workflow continuation did not start because this extension session is stale." };
    },
  };
}

function releaseUnboundClaim(
  claim: Parameters<typeof releaseWorkflowHandoffClaim>[0],
  launchFailure: string,
): { status: "failed"; message: string } | undefined {
  try {
    if (releaseWorkflowHandoffClaim(claim)) return undefined;
    return {
      status: "failed",
      message: `${launchFailure} Its unbound claim was already absent when release was attempted.`,
    };
  } catch (error) {
    return {
      status: "failed",
      message: `${launchFailure} Its unbound claim could not be released: ${errorMessage(error)}`,
    };
  }
}

function actionableWorkflowHandoff(handoff: WorkflowOperatorHandoffEnvelope): ActionableWorkflowHandoff {
  return {
    runId: handoff.originRunId,
    title: handoff.title,
    questions: handoff.questions,
    value: handoff,
  };
}

function contextIdleWaiter(ctx: ExtensionContext): (() => Promise<void>) | undefined {
  const waitForIdle = (ctx as ExtensionContext & { waitForIdle?: () => Promise<void> }).waitForIdle;
  return typeof waitForIdle === "function" ? () => waitForIdle.call(ctx) : undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled workflow handoff state: ${String(value)}`);
}
