/**
 * extensions/plan/mode-command.ts — the `/mode` grammar: show the current
 * behavioral mode, set it explicitly, or route a plan -> default change through
 * the same exit handoff `/plan exit` uses. A mode change is never implicit.
 */

import type { CommandArgs, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../_shared/host/pi-api.js";
import { getCommandText, getProjectRoot } from "../_shared/host/pi-api.js";
import { SETTINGS_HELP_PLACEMENT } from "../_shared/operator/widget-render.js";
import {
  type CycleMode,
  currentCycleMode,
  loadActiveModeState,
  MODE_CYCLE,
  modeStateForCycle,
  writeModeState,
} from "./mode-state.js";
import { splitFirstWord } from "./command-parser.js";
import { ensureModeAwareEditor, setModeStatus, setPlanOperatorBlock } from "./operator-surface.js";
import { modeChangeBlock, modeViewBlock, planExitBlock } from "./operator-ui.js";
import { runPlanExitDecision } from "./plan-exit-handoff.js";

/** Set the active mode, persist it, and update the status badge + input border. */
function applyMode(ctx: ExtensionContext, mode: CycleMode): CycleMode {
  const state = modeStateForCycle(mode);
  writeModeState(getProjectRoot(ctx), state);
  setModeStatus(ctx, state);
  return mode;
}

export async function handleModeCommand(
  args: CommandArgs,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  await ensureModeAwareEditor(ctx);
  const projectRoot = getProjectRoot(ctx);
  const [verb] = splitFirstWord(getCommandText(args));

  if (verb === "" || verb === "show") {
    const current = currentCycleMode(loadActiveModeState(projectRoot));
    setPlanOperatorBlock(ctx, modeViewBlock(current), SETTINGS_HELP_PLACEMENT);
    return;
  }

  if (verb === "plan" || verb === "default") {
    const current = currentCycleMode(loadActiveModeState(projectRoot));
    if (current === "plan" && verb === "default") {
      const action = await runPlanExitDecision(ctx, pi, projectRoot);
      setPlanOperatorBlock(ctx, planExitBlock(action));
      return;
    }
    const mode = applyMode(ctx, verb);
    setPlanOperatorBlock(ctx, modeChangeBlock(current, mode));
    return;
  }

  if (verb !== "") {
    setPlanOperatorBlock(ctx, {
      type: "WARN",
      subject: "Behavioral mode",
      primary: `Unknown mode '${verb}'.`,
      metadata: [`Supported: ${MODE_CYCLE.join(", ")}`],
      controls: ["Show current mode: /mode show", "Help: /mode [plan|default|show]"],
    });
    return;
  }
}
