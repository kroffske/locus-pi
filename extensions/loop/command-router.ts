/**
 * extensions/loop/command-router.ts — The `/loop` grammar and dispatch.
 *
 * Routes the four parsed intents (bare input dialog, help, status, one bounded
 * `once`) onto the continuation launcher and the operator surface, and owns the
 * bare-`/loop` dialog loop that re-asks with the operator's own text until the
 * source parses. Text → intent lives in `command-parser.ts`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../_shared/pi-api.js";
import { getCommandText, getProjectRoot } from "../_shared/pi-api.js";
import { registerCommandWithUiLifecycle } from "../_shared/command-ui.js";
import { requestOperatorInput } from "../_shared/operator-input.js";
import { SETTINGS_HELP_PLACEMENT } from "../_shared/widget-render.js";
import { readLoopStatus, renderLoopStatus } from "../_shared/loop-continuation.js";
import { parseLoopCommand, parseLoopInput } from "./command-parser.js";
import { runLoopOnce } from "./continuation-launcher.js";
import {
  cancelledLoopBlock,
  loopHelpBlock,
  loopStatusBlock,
  loopWarningBlock,
  unsupportedLoopText,
} from "./operator-ui.js";
import { clearLoopStatus, presentLoopBlock, presentLoopResult } from "./operator-surface.js";

export function registerLoopCommand(pi: ExtensionAPI): void {
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
      description: "Prepare one bounded continuation, inspect status, or show help.",
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
          const report = await readLoopStatus(getProjectRoot(ctx));
          clearLoopStatus(ctx);
          presentLoopBlock(ctx, loopStatusBlock(renderLoopStatus(report)), SETTINGS_HELP_PLACEMENT);
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
        metadata: [`reason: ${dialogErrorMessage(error)}`],
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

function dialogErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
