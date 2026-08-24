/**
 * extensions/plan/index.ts — Extension entrypoint.
 *
 * Registers the model-callable `goal` tool and the five commands this extension
 * owns (`/plan`, `/mode`, `/goal`, `/goal-ai`, `/review`, `/todos`), plus the two
 * lifecycle hooks they need: the session-start reset of plan mode and the
 * system-prompt injection. Command registration and dispatch live in
 * `command-router.js`; every command body, block builder and parser lives in a
 * submodule.
 *
 * Beta tier (manifest.json#tier): the default export registers nothing until the
 * project enables `plan` — see ../_shared/host/beta-gate.js. `registerPlan` is the
 * whole extension and is what tests drive, so no test asserts through the switch.
 */

import { betaEnabled } from "../_shared/host/beta-gate.js";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { getProjectRoot } from "../_shared/host/pi-api.js";
import { clearModeState } from "./mode/mode-state.js";
import { registerPlanCommands } from "./command/command-router.js";
import { registerGoalTool } from "./goal/goal-tool.js";
import { ensureModeAwareEditor, setModeStatus } from "./operator/operator-surface.js";
import { injectPlanContext } from "./mode/system-prompt.js";

export default function plan(pi: ExtensionAPI): void {
  if (!betaEnabled("plan")) return;
  registerPlan(pi);
}

export function registerPlan(pi: ExtensionAPI): void {
  registerPlanCommands(pi);
  registerGoalTool(pi);

  pi.on("session_start", async (_event, ctx) => {
    // Plan mode is session-explicit. A previous crash/restart/reload must not
    // silently arm planning for the next workflow or ordinary user turn.
    clearModeState(getProjectRoot(ctx));
    await ensureModeAwareEditor(ctx);
    setModeStatus(ctx, null);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const systemPrompt = await injectPlanContext(getProjectRoot(ctx), _event.systemPrompt ?? "");
    if (systemPrompt === undefined) return;
    return { systemPrompt };
  });
}
