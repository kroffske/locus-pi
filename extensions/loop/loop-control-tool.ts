/**
 * extensions/loop/loop-control-tool.ts — The `loopControl` tool.
 *
 * Carries its own TypeBox params, the status projection it is the only caller
 * of, and the fail-closed refusal for the legacy auto-run actions. The `once`
 * path is delegated to the shared continuation launcher so the tool and the
 * `/loop` command cannot drift apart.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext, ToolResult } from "../_shared/pi-api.js";
import { errorResult, getProjectRoot, textResult } from "../_shared/pi-api.js";
import { validateParams } from "../_shared/validation.js";
import { readLoopStatus, renderLoopStatus } from "../_shared/loop-continuation.js";
import { runLoopOnce } from "./continuation-launcher.js";
import { unsupportedLoopText } from "./operator-ui.js";

const LoopControlParams = Type.Object({
  action: Type.Union(
    [Type.Literal("status"), Type.Literal("once"), Type.Literal("start"), Type.Literal("stop"), Type.Literal("until")],
    { description: "Loop action" },
  ),
  source: Type.Optional(
    Type.Union([Type.Literal("goal"), Type.Literal("workflow"), Type.Literal("review")], {
      description: "Continuation source for once",
    }),
  ),
  runId: Type.Optional(Type.String({ description: "Workflow run id for source=workflow", maxLength: 200 })),
  prompt: Type.Optional(Type.String({ description: "Optional bounded continuation focus", maxLength: 4000 })),
});

export function registerLoopControlTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "loopControl",
    description:
      "Bounded loop continuation controller. Supports status and one manual once path; unsupported legacy actions fail closed.",
    parameters: LoopControlParams,
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(LoopControlParams, params);
      if (!valid.ok) return valid.result;
      if (valid.value.action === "status") {
        return await runLoopStatus(ctx);
      }
      if (valid.value.action === "once") {
        return await runLoopOnce(pi, ctx, valid.value.source, valid.value.runId, valid.value.prompt);
      }
      return unsupportedAction(valid.value.action);
    },
  });
}

async function runLoopStatus(ctx: ExtensionCommandContext): Promise<ToolResult> {
  const report = await readLoopStatus(getProjectRoot(ctx));
  return textResult(renderLoopStatus(report), {
    owner: "loop",
    mode: report.mode,
    sources: report.sources,
    ...(report.recommendedSource !== undefined ? { recommendedSource: report.recommendedSource } : {}),
    ...(report.recommendedSourceId !== undefined ? { recommendedSourceId: report.recommendedSourceId } : {}),
  });
}

function unsupportedAction(action: string): ToolResult {
  return errorResult(unsupportedLoopText(action), {
    owner: "loop",
    requestedAction: action,
    supportedActions: ["status", "once"],
    supportedSources: ["goal", "workflow"],
  });
}
