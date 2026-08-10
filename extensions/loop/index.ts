/**
 * extensions/loop/index.ts — Extension entrypoint.
 *
 * Registers the `loopControl` tool (./loop-control-tool.js) and the `/loop`
 * command (./command-router.js), and hangs the loop status contribution off the
 * transient-UI lifecycle so a cleared `loop` widget takes the status with it.
 * Every surface those two render lives in a submodule.
 */

import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { registerTransientUiCleanup } from "../_shared/operator/command-ui.js";
import { registerLoopCommand } from "./command-router.js";
import { registerLoopControlTool } from "./loop-control-tool.js";
import { clearLoopOperatorStatus } from "./operator-surface.js";

export default function loop(pi: ExtensionAPI): void {
  registerTransientUiCleanup(pi, "loop", (ctx) => clearLoopOperatorStatus(ctx));

  registerLoopControlTool(pi);
  registerLoopCommand(pi);
}
