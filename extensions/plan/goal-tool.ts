/**
 * extensions/plan/goal-tool.ts — the model-callable `goal` tool: its TypeBox
 * params, the read/write approval split, and the one tool-result shape each
 * goal transition reports. The command surface renders blocks; this surface
 * only ever returns tool results.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { errorResult, getProjectRoot, textResult } from "../_shared/host/pi-api.js";
import {
  type GoalOperationResult,
  completeGoalState,
  createOrReplaceGoalState,
  dropGoalState,
  goalCompletionAuditPath,
  goalStatePath,
  loadGoalState,
  resumeGoalState,
} from "../_shared/project/goal-mode.js";
import { validateParams } from "../_shared/host/validation.js";

const GoalToolParams = Type.Object({
  op: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("get"),
      Type.Literal("complete"),
      Type.Literal("resume"),
      Type.Literal("drop"),
    ],
    { description: "Goal tool operation" },
  ),
  objective: Type.Optional(Type.String({ description: "Goal objective for op=create", minLength: 1, maxLength: 8000 })),
  token_budget: Type.Optional(Type.Integer({ description: "Token budget for op=create", minimum: 1 })),
});

function goalToolApproval(args: unknown) {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  return record.op === "get" ? "read" : "write";
}

export function registerGoalTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "goal",
    description: "Manage local Locus goal state from models.",
    parameters: GoalToolParams,
    approval: goalToolApproval,
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(GoalToolParams, params);
      if (!valid.ok) return valid.result;

      const projectRoot = getProjectRoot(ctx);
      if (valid.value.op === "get") {
        const state = await loadGoalState(projectRoot);
        if (!state) return errorResult("No active goal state.");
        return textResult(JSON.stringify(state, null, 2), {
          goalStateSource: "local-file",
          path: goalStatePath(projectRoot),
        });
      }

      if (valid.value.op === "create") {
        if (valid.value.objective === undefined || valid.value.objective.trim().length === 0) {
          return errorResult("Goal create requires objective.");
        }
        const saved = await createOrReplaceGoalState(projectRoot, pi, valid.value.objective, valid.value.token_budget);
        if (saved.error) return errorResult(saved.error);
        if (!saved.state) return errorResult("Failed to create goal state.");
        return textResult(saved.message, {
          goal: saved.state.goal,
          path: goalStatePath(projectRoot),
          objective: saved.state.goal.objective,
          status: saved.state.goal.status,
          tokenBudget: saved.state.goal.tokenBudget,
        });
      }

      if (valid.value.op === "resume") {
        const result = await resumeGoalState(projectRoot, pi);
        return runGoalToolTransition(projectRoot, result);
      }
      if (valid.value.op === "drop") {
        const result = await dropGoalState(projectRoot, pi);
        return runGoalToolTransition(projectRoot, result);
      }
      const result = await completeGoalState(projectRoot, pi);
      return runGoalToolTransition(projectRoot, result);
    },
  });
}

async function runGoalToolTransition(projectRoot: string, result: GoalOperationResult) {
  if (result.error)
    return errorResult(result.error, {
      goal: result.state?.goal ?? null,
      path: result.state ? goalStatePath(projectRoot) : undefined,
    });
  if (!result.state) return errorResult("No active goal state.", { path: goalStatePath(projectRoot) });
  return textResult(result.message, {
    goal: result.state.goal,
    path: goalStatePath(projectRoot),
    ...(result.completionAudit !== undefined
      ? { completionAudit: result.completionAudit, completionAuditPath: goalCompletionAuditPath(projectRoot) }
      : {}),
  });
}
