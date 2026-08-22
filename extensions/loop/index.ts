/**
 * extensions/loop/index.ts — Extension entrypoint.
 *
 * Registers the `loop` tool (./loop-control-tool.js) and the `/loop`
 * command (./command-router.js), and hangs the loop status contribution off the
 * transient-UI lifecycle so a cleared `loop` widget takes the status with it.
 * Every surface those two render lives in a submodule.
 *
 * Beta tier (manifest.json#tier): the default export registers nothing until the
 * project enables `loop` — see ../_shared/host/beta-gate.js. `registerLoop` is the
 * whole extension and is what tests drive, so no test asserts through the switch.
 */

import { betaEnabled } from "../_shared/host/beta-gate.js";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { registerTransientUiCleanup } from "../_shared/operator/command-ui.js";
import { registerLoopCommand } from "./command-router.js";
import { registerLoopControlTool } from "./loop-control-tool.js";
import { createLoopController } from "./loop-controller.js";
import { clearLoopOperatorStatus } from "./operator-surface.js";

export default function loop(pi: ExtensionAPI): void {
  if (!betaEnabled("loop")) return;
  registerLoop(pi);
}

export function registerLoop(pi: ExtensionAPI): void {
  registerTransientUiCleanup(pi, "loop", (ctx) => clearLoopOperatorStatus(ctx));
  const controller = createLoopController(pi);
  registerLoopControlTool(pi, controller);
  registerLoopCommand(pi, controller);
  pi.on("agent_settled", async (_event, ctx) => {
    await controller.handleAgentSettled(ctx);
  });
}
