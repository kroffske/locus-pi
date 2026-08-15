import type { ExtensionAPI, ExtensionCommandContext } from "../../_shared/host/pi-api.js";
import { getProjectRoot, getWorkingDirectory } from "../../_shared/host/pi-api.js";
import { setOperatorWidget } from "../../_shared/operator/widget-render.js";
import { parseRunCommand, workflowRunRecoveryUsage } from "../command-parser.js";
import {
  preflightWorkflowCommandTarget,
  isOneShotCommandMode,
  workflowCommandIdleBlock,
  workflowFreshLaunchPolicyError,
} from "../launch-guard.js";
import { workflowNotFoundBlock, workflowRunConflictBlock, workflowWarningBlock } from "../operator-ui.js";
import { WORKFLOW_INPUT_MAX_CHARS } from "../runtime/workflow-runtime.js";
import type { WorkflowCommandLauncher } from "../workflow-command-launcher.js";
import { persistCommandWorkflowRejection, type WorkflowTranscriptRejectionCode } from "./receipts.js";

export async function handleWorkflowRunCommand(
  rawText: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  commandLauncher: WorkflowCommandLauncher,
): Promise<boolean> {
  const parsed = parseRunCommand(rawText.trimStart());
  if (parsed === null) return false;
  const reject = async (code: WorkflowTranscriptRejectionCode, text: string): Promise<true> => {
    await persistCommandWorkflowRejection(pi, ctx, { code, text, target: parsed.scriptRef });
    return true;
  };

  if (parsed.missingResumeId === true) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock("Missing run id after --resume.", `Retry: ${workflowRunRecoveryUsage(parsed)}`),
    );
    return reject("missing_resume_id", "Workflow not started: missing run id after --resume.");
  }
  if (parsed.missingOutputDir === true) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        "Missing project-relative path after --output-dir.",
        `Retry: ${workflowRunRecoveryUsage(parsed)}`,
      ),
    );
    return reject("missing_output_dir", "Workflow not started: missing project-relative path after --output-dir.");
  }
  if (parsed.input !== undefined && parsed.input.length > WORKFLOW_INPUT_MAX_CHARS) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        `Workflow input exceeds the ${WORKFLOW_INPUT_MAX_CHARS}-character limit.`,
        "Retry with a shorter semantic request.",
      ),
    );
    return reject(
      "input_too_long",
      `Workflow not started: input exceeds the ${WORKFLOW_INPUT_MAX_CHARS}-character limit.`,
    );
  }
  const idleBlock = workflowCommandIdleBlock(ctx);
  if (idleBlock !== undefined) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        idleBlock,
        "Recovery: wait for the current response to finish, then retry the same /workflows run command.",
      ),
    );
    return true;
  }

  const scriptRef = parsed.scriptRef;
  const projectRoot = getProjectRoot(ctx);
  const targetPreflight = preflightWorkflowCommandTarget(scriptRef, projectRoot, getWorkingDirectory(ctx));
  if (targetPreflight.status === "not-found") {
    setOperatorWidget(ctx, "workflows", workflowNotFoundBlock(scriptRef));
    return reject("workflow_not_found", `Workflow not found: ${scriptRef}`);
  }
  if (targetPreflight.status === "group-only") {
    const message = `Workflow namespace ${JSON.stringify(targetPreflight.workflowName)} is group-only; choose a child workflow.`;
    setOperatorWidget(ctx, "workflows", workflowWarningBlock(message, "Retry with /workflows run <group>/<child>."));
    return reject("workflow_group_only", `Workflow not started: ${message}`);
  }
  const target = targetPreflight.status === "resolved" ? targetPreflight.target : undefined;
  if (target !== undefined) {
    const launchPolicyError = workflowFreshLaunchPolicyError({
      target,
      projectRoot,
      ...(parsed.outputDir === undefined ? {} : { outputDir: parsed.outputDir }),
      ...(parsed.resumeFromRunId === undefined ? {} : { resumeFromRunId: parsed.resumeFromRunId }),
    });
    if (launchPolicyError !== undefined) {
      setOperatorWidget(ctx, "workflows", workflowWarningBlock(launchPolicyError, workflowRunRecoveryUsage(parsed)));
      return reject("launch_policy_refused", `Workflow not started: ${launchPolicyError}`);
    }
  }

  const launched = commandLauncher.launch({
    ctx,
    scriptRef,
    ...(targetPreflight.status === "runner-durable-failure" ? { targetKind: targetPreflight.targetKind } : {}),
    ...(target === undefined ? {} : { target }),
    ...(parsed.input === undefined ? {} : { input: parsed.input }),
    ...(parsed.outputDir === undefined ? {} : { outputDir: parsed.outputDir }),
    ...(parsed.resumeFromRunId === undefined ? {} : { resumeFromRunId: parsed.resumeFromRunId }),
    ...(ctx.waitForIdle === undefined ? {} : { waitForIdle: () => ctx.waitForIdle!() }),
  });
  if (launched.status === "started") {
    if (isOneShotCommandMode(ctx)) await commandLauncher.awaitActive();
    return true;
  }
  if (launched.status === "busy") {
    setOperatorWidget(ctx, "workflows", workflowRunConflictBlock(launched.owner));
    return reject("workflow_run_busy", `Workflow not started: another workflow run is active (${launched.owner}).`);
  }
  setOperatorWidget(
    ctx,
    "workflows",
    workflowWarningBlock(
      "Workflow not started: this extension session has already shut down.",
      "Recovery: wait for Pi to finish reloading, then retry the same /workflows run command.",
    ),
  );
  return reject("session_stale", "Workflow not started: this extension session has already shut down.");
}
