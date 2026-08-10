/**
 * extensions/loop/continuation-launcher.ts — The one bounded-continuation
 * pipeline both loop triggers share.
 *
 * `/loop once …` and `loopControl {action:"once"}` both land here: it resolves
 * the source, writes the goal or workflow continuation artifact, and projects
 * the saved artifact into the tool result. Nothing is auto-dispatched; every
 * refusal fails closed through `unsupportedOnce`.
 */

import type { ExtensionAPI, ExtensionCommandContext, ToolResult } from "../_shared/host/pi-api.js";
import { errorResult, getProjectRoot, textResult } from "../_shared/host/pi-api.js";
import {
  buildGoalContinuationArtifact,
  loadGoalState,
  writeGoalContinuationArtifact,
} from "../_shared/project/goal-mode.js";
import {
  createWorkflowLoopContinuation,
  renderGoalLoopContinuationResult,
  renderLoopWorkflowContinuationResult,
} from "./loop-continuation.js";

export async function runLoopOnce(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  source: string | undefined,
  runId: string | undefined,
  prompt: string | undefined,
): Promise<ToolResult> {
  try {
    if (source === undefined) {
      return unsupportedOnce("missing source: use /loop once goal or /loop once workflow <runId>");
    }
    if (source === "review") {
      return unsupportedOnce("review continuation is not implemented");
    }

    const projectRoot = getProjectRoot(ctx);
    if (source === "goal") {
      const goalState = await loadGoalState(projectRoot);
      if (!goalState) return unsupportedOnce("no goal state exists; create a goal before using /loop once goal");
      if (goalState.goal.status === "complete" || goalState.goal.status === "dropped") {
        return unsupportedOnce(`goal is ${goalState.goal.status}; create a new goal before using /loop once goal`);
      }
      const artifact = buildGoalContinuationArtifact(
        projectRoot,
        goalState.goal.id,
        goalState.goal.objective,
        prompt ?? "",
      );
      const saved = await writeGoalContinuationArtifact(projectRoot, pi, artifact);
      const text = renderGoalLoopContinuationResult(saved);
      return textResult(text, {
        owner: "loop",
        source: "goal",
        sourceId: goalState.goal.id,
        sourceStatus: goalState.goal.status,
        path: saved.path,
        autoDispatch: saved.autoDispatch,
        status: saved.status,
        stopReason: saved.stopReason,
        createdAt: saved.createdAt,
        maxSteps: saved.maxSteps,
        prompt: saved.prompt,
        goal: goalState.goal,
        goalContinuation: saved,
        sourceMetadata: {
          goalId: goalState.goal.id,
          goalStatus: goalState.goal.status,
          objective: goalState.goal.objective,
        },
      });
    }

    if (source !== "workflow") {
      return unsupportedOnce(`unsupported loop source: ${source}`);
    }
    if (runId === undefined || runId.trim() === "") {
      return unsupportedOnce("workflow continuation requires /loop once workflow <runId>");
    }
    const result = await createWorkflowLoopContinuation(projectRoot, runId, prompt ?? "");
    const text = renderLoopWorkflowContinuationResult(result);
    return textResult(text, {
      owner: "loop",
      source: "workflow",
      sourceId: runId,
      path: result.artifact.path,
      autoDispatch: result.artifact.autoDispatch,
      status: result.artifact.status,
      stopReason: result.artifact.stopReason,
      createdAt: result.artifact.createdAt,
      maxSteps: result.artifact.maxSteps,
      prompt: result.artifact.prompt,
      runStatus: result.artifact.runStatus,
      sourceSummary: result.sourceSummary,
      workflowContinuation: result.artifact,
      sourceMetadata: {
        runId,
        runStatus: result.artifact.runStatus,
        sourcePath: result.artifact.sourcePath,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unexpected loop continuation failure";
    return unsupportedOnce(`${source ?? "loop"} continuation failed: ${reason}`);
  }
}

function unsupportedOnce(reason: string): ToolResult {
  return errorResult(
    [
      "Loop continuation is blocked.",
      reason,
      "Use /loop status, /loop once goal, or /loop once workflow <runId>.",
    ].join("\n"),
    {
      owner: "loop",
      source: "blocked",
      reason,
      supportedSources: ["goal", "workflow"],
    },
  );
}
