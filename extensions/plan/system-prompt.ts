/**
 * extensions/plan/system-prompt.ts — what this extension adds to the agent's
 * system prompt at `before_agent_start`: the active goal context, then the
 * behavioral plan-mode framing. v2 plan mode is BEHAVIORAL: it injects a
 * planning framing, it does NOT block tools.
 */

import { goalInjectionText, loadGoalState, shouldInjectGoalContext } from "../_shared/project/goal-mode.js";
import { isInPlanMode, loadActiveModeState, planModeInjectionText } from "./mode-state.js";

function appendSystemBlock(systemPrompt: string, block: string): string {
  return systemPrompt.trim() === "" ? block : `${systemPrompt}\n\n${block}`;
}

/**
 * Build the system prompt this extension wants for the next turn, or undefined
 * when it has nothing to add and the host prompt must be left alone.
 */
export async function injectPlanContext(projectRoot: string, original: string): Promise<string | undefined> {
  let systemPrompt = original;

  const goalState = await loadGoalState(projectRoot);
  if (shouldInjectGoalContext(goalState) && goalState) {
    systemPrompt = appendSystemBlock(systemPrompt, goalInjectionText(goalState));
  }

  // v2 plan mode is BEHAVIORAL: inject a planning framing, do NOT block tools.
  const modeState = loadActiveModeState(projectRoot);
  if (isInPlanMode(modeState)) {
    systemPrompt = appendSystemBlock(systemPrompt, planModeInjectionText(modeState));
  }

  if (systemPrompt === original) return undefined;
  return systemPrompt;
}
