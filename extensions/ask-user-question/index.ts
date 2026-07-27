/**
 * extensions/ask-user-question/index.ts — Extension entrypoint.
 *
 * Registers the OMP-compatible `ask` tool and its `askUserQuestion`
 * compatibility alias (./ask-tool.js). The question flow, the prompt surfaces
 * that collect an answer, and every string they render live in submodules;
 * this file owns nothing but the registration.
 */

import type { ExtensionAPI } from "../_shared/pi-api.js";
import { registerAskTools } from "./ask-tool.js";

export default function askUserQuestion(pi: ExtensionAPI): void {
  registerAskTools(pi);
}
