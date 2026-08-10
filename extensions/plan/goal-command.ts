/**
 * extensions/plan/goal-command.ts — the `/goal` grammar: inspect, create or
 * replace, pause/resume/drop/complete, budget, the bounded continuation
 * artifact, and the `/goal prompt` shelf alias. Every branch renders through
 * `goal-operator-ui.ts`; nothing here builds a block itself except the two
 * inline warnings its own parsing produces.
 */

import type { CommandArgs, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../_shared/host/pi-api.js";
import { getCommandText, getProjectRoot } from "../_shared/host/pi-api.js";
import { SETTINGS_HELP_PLACEMENT } from "../_shared/operator/widget-render.js";
import {
  type GoalOperationResult,
  completeGoalState,
  createOrReplaceGoalState,
  dropGoalState,
  goalContinuationPath,
  isBudgetLimited,
  loadGoalState,
  pauseGoalState,
  resumeGoalState,
  setGoalBudget,
  writeGoalContinuationArtifact,
  writeGoalState,
} from "../_shared/project/goal-mode.js";
import { parseBudget, parseContinuationInput, splitFirstWord } from "./command-parser.js";
import { setGoalOperatorBlock } from "./operator-surface.js";
import { emptyGoalStateBlock, goalHelpBlock, goalOperationBlock, goalStateBlock } from "./goal-operator-ui.js";
import { handlePromptShelf } from "./prompt-shelf-command.js";

export const COMMAND_HELP = [
  "Usage:",
  "- /goal <objective>                Create or replace active goal state.",
  "- /goal set <objective>            Same as /goal <objective>.",
  "- /goal show                       Show active goal state summary.",
  "- /goal pause                      Pause active goal.",
  "- /goal resume                     Resume paused goal.",
  "- /goal drop                       Mark active goal as dropped.",
  "- /goal complete                   Mark active goal as complete.",
  "- /goal continue                   Write a bounded next-step continuation prompt.",
  "- /goal budget <N|off>             Set token budget or clear budget limit.",
  "- /goal prompt <text>              Save old goal prompt shelf.",
  "- Add --task <task-id> with /goal prompt to keep task-backed artifact explicit.",
  "- /goal show | pause | resume | drop | complete | continue | budget",
].join("\n");

export async function handleGoalCommand(
  args: CommandArgs,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const projectRoot = getProjectRoot(ctx);
  const raw = getCommandText(args).trim();
  const [verb, rest] = splitFirstWord(raw);

  if (verb === "") {
    const state = await loadGoalState(projectRoot);
    setGoalOperatorBlock(
      ctx,
      state === null ? emptyGoalStateBlock() : goalStateBlock(state, { compact: ctx.mode !== "tui" }),
    );
    return;
  }
  if (verb === "help" || verb === "?") {
    setGoalOperatorBlock(
      ctx,
      goalHelpBlock(COMMAND_HELP.split(/\r?\n/u), { compact: ctx.mode !== "tui" }),
      SETTINGS_HELP_PLACEMENT,
    );
    return;
  }
  if (verb === "set") {
    await handleCreateGoal(rest, ctx, projectRoot, pi);
    return;
  }
  if (verb === "show") {
    const state = await loadGoalState(projectRoot);
    setGoalOperatorBlock(
      ctx,
      state === null ? emptyGoalStateBlock() : goalStateBlock(state, { compact: ctx.mode !== "tui" }),
    );
    return;
  }
  if (verb === "pause") {
    const result = await pauseGoalState(projectRoot, pi);
    setGoalOperatorBlock(ctx, goalOperationBlock(result, projectRoot, { compact: ctx.mode !== "tui" }));
    return;
  }
  if (verb === "resume") {
    const result = await resumeGoalState(projectRoot, pi);
    setGoalOperatorBlock(ctx, goalOperationBlock(result, projectRoot, { compact: ctx.mode !== "tui" }));
    return;
  }
  if (verb === "complete") {
    const result = await completeGoalState(projectRoot, pi);
    setGoalOperatorBlock(ctx, goalOperationBlock(result, projectRoot, { compact: ctx.mode !== "tui" }));
    return;
  }
  if (verb === "continue") {
    const result = await handleGoalContinue(projectRoot, rest, pi);
    setGoalOperatorBlock(ctx, goalOperationBlock(result, projectRoot, { compact: ctx.mode !== "tui" }));
    return;
  }
  if (verb === "drop") {
    const result = await dropGoalState(projectRoot, pi);
    setGoalOperatorBlock(ctx, goalOperationBlock(result, projectRoot, { compact: ctx.mode !== "tui" }));
    return;
  }
  if (verb === "budget") {
    const parsed = parseBudget(rest);
    if (!parsed.valid) {
      setGoalOperatorBlock(ctx, {
        type: "WARN",
        subject: "Goal state",
        primary: "Invalid token budget; state was not changed.",
        controls: ["Usage: /goal budget <N|off>", "Inspect: /goal"],
      });
      return;
    }
    const result = await setGoalBudget(projectRoot, pi, parsed.value);
    setGoalOperatorBlock(ctx, goalOperationBlock(result, projectRoot, { compact: ctx.mode !== "tui" }));
    return;
  }
  if (verb === "prompt") {
    await handleGoalPrompt(rest, projectRoot, ctx);
    return;
  }

  await handleCreateGoal(raw, ctx, projectRoot, pi);
}

async function handleCreateGoal(
  text: string,
  ctx: ExtensionContext,
  projectRoot: string,
  pi: ExtensionAPI,
): Promise<void> {
  const saved = await createOrReplaceGoalState(projectRoot, pi, text, undefined);
  if (
    saved.state &&
    saved.state.goal.status !== "active" &&
    saved.state.goal.tokenBudget !== undefined &&
    isBudgetLimited(saved.state, saved.state.goal)
  ) {
    saved.state.goal.status = "budget-limited";
    await writeGoalState(projectRoot, pi, saved.state);
  }
  setGoalOperatorBlock(ctx, goalOperationBlock(saved, projectRoot, { compact: ctx.mode !== "tui" }));
}

async function handleGoalContinue(projectRoot: string, raw: string, pi: ExtensionAPI): Promise<GoalOperationResult> {
  const state = await loadGoalState(projectRoot);
  if (!state) return { state: null, changed: false, message: "No goal to continue." };
  if (state.goal.status === "complete" || state.goal.status === "dropped") {
    return { state, changed: false, message: `Goal is ${state.goal.status}; continuation is disabled.` };
  }
  const result = buildGoalContinuation(state.goal.objective, raw, state.goal.id, projectRoot);
  const saved = await writeGoalContinuationArtifact(projectRoot, pi, result.continuation);
  return { state, changed: false, message: "Goal continuation saved.", continuation: saved };
}

function buildGoalContinuation(
  objective: string,
  raw: string,
  goalId: string,
  projectRoot: string,
): {
  prompt: string;
  nextStep: string;
  continuation: {
    version: 1;
    goalId: string;
    objective: string;
    path: string;
    prompt: string;
    autoDispatch: false;
    status: "manual";
    stopReason: string;
    createdAt: string;
    maxSteps: 1;
  };
} {
  const parsed = parseContinuationInput(raw);
  const nextStep = parsed.nextStep ?? "Choose one bounded next action and stop.";
  const lines = [
    "Task:",
    objective,
    "",
    "Draft goal:",
    `Continue ${goalId} with one bounded step only.`,
    "",
    "Intent:",
    parsed.summary ?? "Summarize the completion state and propose the next bounded step.",
    "",
    "Context:",
    "- Keep the next prompt short and action-oriented.",
    "- Do not auto-dispatch a child agent or model call.",
    "- Stop after one next step.",
    "",
    "Draft direction:",
    `- In scope: ${nextStep}`,
    "- Out of scope: multi-step plans, background dispatch, or hidden continuation.",
    "- Outcome type: prompt",
    "",
    "Expected result:",
    "- one bounded next prompt artifact",
    "",
    "Final result:",
    nextStep,
  ];
  const prompt = lines.join("\n");
  return {
    prompt,
    nextStep,
    continuation: {
      version: 1,
      goalId,
      objective,
      path: goalContinuationPath(projectRoot),
      prompt,
      autoDispatch: false,
      status: "manual",
      stopReason: "continuation is a bounded next prompt artifact, not auto-dispatch",
      createdAt: new Date().toISOString(),
      maxSteps: 1,
    },
  };
}

async function handleGoalPrompt(raw: string, projectRoot: string, ctx: ExtensionContext): Promise<void> {
  await handlePromptShelf("goal", raw, projectRoot, ctx);
}
