/**
 * extensions/loop/command-router.ts — The `/loop` grammar and dispatch.
 *
 * Routes the four parsed intents (bare input dialog, help, status, one bounded
 * `once`) onto the continuation launcher and the operator surface, and owns the
 * bare-`/loop` dialog loop that re-asks with the operator's own text until the
 * source parses. Text → intent lives in `command-parser.ts`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../_shared/host/pi-api.js";
import { getCommandText, getProjectRoot } from "../_shared/host/pi-api.js";
import { registerCommandWithUiLifecycle } from "../_shared/operator/command-ui.js";
import { requestOperatorInput } from "../_shared/operator/operator-input.js";
import { SETTINGS_HELP_PLACEMENT } from "../_shared/operator/widget-render.js";
import { readLoopStatus, renderLoopStatus } from "./loop-continuation.js";
import { errorMessage } from "../_shared/host/error-text.js";
import { parseLoopCommand, parseLoopInput } from "./command-parser.js";
import { runLoopOnce } from "./continuation-launcher.js";
import type { LoopController } from "./loop-controller.js";
import {
  cancelledLoopBlock,
  loopHelpBlock,
  loopStatusBlock,
  loopWarningBlock,
  unsupportedLoopText,
} from "./operator-ui.js";
import { clearLoopStatus, presentLoopBlock, presentLoopResult } from "./operator-surface.js";

export function registerLoopCommand(pi: ExtensionAPI, controller: LoopController): void {
  registerCommandWithUiLifecycle(
    pi,
    {
      command: "loop",
      group: "loop",
      surfaces: ["transient-widget", "status", "blocking-prompt", "artifact-write"],
      transientWidgets: ["loop"],
      transientStatuses: ["loop"],
    },
    {
      description: "Start, stop, inspect, or run one bounded continuation loop.",
      handler: async (args, ctx) => {
        const raw = getCommandText(args).trim();
        const parsed = parseLoopCommand(raw);
        if (parsed.action === "input") {
          await handleLoopInput(pi, ctx);
          return;
        }
        if (parsed.action === "help") {
          clearLoopStatus(ctx);
          presentLoopBlock(ctx, loopHelpBlock(), SETTINGS_HELP_PLACEMENT);
          return;
        }
        if (parsed.action === "status") {
          const result = await controller.status(ctx);
          const text = result.content.find((part) => part.type === "text")?.text ?? "Loop status unavailable.";
          clearLoopStatus(ctx);
          presentLoopBlock(ctx, loopStatusBlock(text), SETTINGS_HELP_PLACEMENT);
          return;
        }
        if (parsed.action === "stop") {
          presentLoopResult(ctx, await controller.stop(ctx, parsed.reason));
          return;
        }
        if (parsed.action === "start" || parsed.action === "until") {
          const request =
            parsed.action === "start"
              ? {
                  action: parsed.action,
                  source: parsed.source,
                  ...(parsed.runId ? { runId: parsed.runId } : {}),
                  ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
                }
              : {
                  action: parsed.action,
                  source: parsed.source,
                  ...(parsed.runId ? { runId: parsed.runId } : {}),
                  ...(parsed.condition ? { condition: parsed.condition } : {}),
                };
          const result = await controller.start(ctx, request, "command");
          presentLoopResult(ctx, result);
          return;
        }
        if (parsed.action === "once") {
          const result = await runLoopOnce(pi, ctx, parsed.source, parsed.runId, parsed.prompt);
          presentLoopResult(ctx, result);
          return;
        }
        clearLoopStatus(ctx);
        presentLoopBlock(ctx, loopWarningBlock(unsupportedLoopText(parsed.value)));
      },
    },
  );
}

async function handleLoopInput(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  let prefill = "goal ";
  let title = "[INPUT] Loop — goal [focus] | workflow <runId> [focus]";

  while (true) {
    let input: Awaited<ReturnType<typeof requestOperatorInput>>;
    try {
      input = await requestOperatorInput(ctx, {
        kind: "editor",
        title,
        prefill,
      });
    } catch (error) {
      clearLoopStatus(ctx);
      presentLoopBlock(ctx, {
        type: "ERROR",
        subject: "Loop input",
        primary: "The host input dialog returned an unsupported result.",
        metadata: [`reason: ${errorMessage(error)}`],
        hint: ["No continuation artifact was created."],
        controls: ["Use explicit syntax: /loop once goal [focus]", "Help: /loop help"],
      });
      return;
    }
    if (input.status === "unavailable") {
      clearLoopStatus(ctx);
      presentLoopBlock(ctx, {
        type: "WARN",
        subject: "Loop continuation",
        primary: "Interactive input is unavailable in this host mode.",
        hint: ["Use /loop once goal [focus] or /loop once workflow <runId> [focus]."],
        controls: ["Help: /loop help"],
      });
      return;
    }
    if (input.status === "cancelled") {
      clearLoopStatus(ctx);
      presentLoopBlock(ctx, cancelledLoopBlock());
      return;
    }

    const parsed = parseLoopInput(input.value);
    if (!parsed.ok) {
      prefill = input.value;
      title = `[WARN] Loop continuation — ${parsed.reason}`;
      continue;
    }

    presentLoopBlock(ctx, {
      type: "RUN",
      subject: "Loop continuation",
      primary:
        parsed.source === "goal"
          ? "Preparing one bounded goal continuation."
          : `Preparing one bounded workflow continuation for ${parsed.runId}.`,
      metadata: ["maxSteps: 1", "autoDispatch: false"],
    });
    const result = await runLoopOnce(
      pi,
      ctx,
      parsed.source,
      parsed.source === "workflow" ? parsed.runId : undefined,
      parsed.prompt,
    );
    presentLoopResult(ctx, result);
    return;
  }
}
