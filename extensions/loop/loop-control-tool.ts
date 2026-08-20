/**
 * extensions/loop/loop-control-tool.ts — The canonical `loop` tool.
 *
 * Carries its own TypeBox params, the status projection it is the only caller
 * of, and the fail-closed refusal for the legacy auto-run actions. The `once`
 * path is delegated to the shared continuation launcher so the tool and the
 * `/loop` command cannot drift apart.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { validateParams } from "../_shared/host/validation.js";
import { runLoopOnce } from "./continuation-launcher.js";
import type { LoopController, LoopSource } from "./loop-controller.js";

const LoopControlParams = Type.Object({
  action: Type.Union(
    [Type.Literal("status"), Type.Literal("once"), Type.Literal("start"), Type.Literal("stop"), Type.Literal("until")],
    { description: "Loop action" },
  ),
  source: Type.Optional(
    Type.Union([Type.Literal("goal"), Type.Literal("workflow")], {
      description: "Continuation source",
    }),
  ),
  runId: Type.Optional(Type.String({ description: "Workflow run id for source=workflow", maxLength: 200 })),
  prompt: Type.Optional(Type.String({ description: "Optional bounded continuation focus", maxLength: 4000 })),
  condition: Type.Optional(Type.String({ description: "Model-evaluated stop condition for until", maxLength: 4000 })),
  maxIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  maxDurationMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
  reason: Type.Optional(Type.String({ description: "Stop reason", maxLength: 500 })),
});

export function registerLoopControlTool(pi: ExtensionAPI, controller: LoopController): void {
  pi.registerTool({
    name: "loop",
    description:
      "Start, stop, inspect, or run one bounded goal/workflow continuation loop with hard iteration and duration limits.",
    parameters: LoopControlParams,
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(LoopControlParams, params);
      if (!valid.ok) return valid.result;
      if (valid.value.action === "status") return controller.status(ctx);
      if (valid.value.action === "stop") return controller.stop(ctx, valid.value.reason);
      if (valid.value.action === "once") {
        return await runLoopOnce(pi, ctx, valid.value.source, valid.value.runId, valid.value.prompt);
      }
      return controller.start(
        ctx,
        {
          action: valid.value.action,
          source: (valid.value.source ?? "goal") as LoopSource,
          ...(valid.value.runId ? { runId: valid.value.runId } : {}),
          ...(valid.value.prompt ? { prompt: valid.value.prompt } : {}),
          ...(valid.value.condition ? { condition: valid.value.condition } : {}),
          ...(valid.value.maxIterations ? { maxIterations: valid.value.maxIterations } : {}),
          ...(valid.value.maxDurationMinutes ? { maxDurationMinutes: valid.value.maxDurationMinutes } : {}),
        },
        "tool",
      );
    },
  });
}
