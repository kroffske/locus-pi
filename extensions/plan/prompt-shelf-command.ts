/**
 * extensions/plan/prompt-shelf-command.ts — the ctx-bound half of the prompt
 * shelf: resolve one command's target, read or write the artifact, and render
 * exactly one block per outcome. Parsing stays pure in `command-parser.ts` and
 * block construction in `prompt-shelf-ui.ts`.
 */

import type { CommandArgs, ExtensionContext } from "../_shared/host/pi-api.js";
import { getCommandText, getProjectRoot } from "../_shared/host/pi-api.js";
import {
  PromptCommandTargetError,
  readPromptCommand,
  resolvePromptCommandTarget,
  writePromptCommand,
} from "../_shared/project/prompt-command-store.js";
import { parsePromptShelfCommand, type PromptShelfKind, type PromptShelfTarget } from "./command-parser.js";
import { setPromptShelfOperatorBlock } from "./operator-surface.js";
import {
  promptShelfBodyBlock,
  promptShelfChangeBlock,
  promptShelfErrorBlock,
  promptShelfSummaryBlock,
  promptShelfWarningBlock,
} from "./prompt-shelf-ui.js";

export async function handlePromptCommand(
  kind: Exclude<PromptShelfKind, "goal">,
  args: CommandArgs,
  ctx: ExtensionContext,
): Promise<void> {
  const projectRoot = getProjectRoot(ctx);
  await handlePromptShelf(kind, getCommandText(args), projectRoot, ctx);
}

export async function handlePromptShelf(
  kind: PromptShelfKind,
  raw: string,
  projectRoot: string,
  ctx: ExtensionContext,
): Promise<void> {
  const parsed = parsePromptShelfCommand(raw);
  if (parsed.action.kind === "invalid") {
    setPromptShelfOperatorBlock(
      ctx,
      kind,
      promptShelfWarningBlock(kind, `Invalid prompt shelf command: ${parsed.action.message}.`, parsed.targetLabel, [
        "No artifact was read or written.",
      ]),
      "aboveEditor",
    );
    return;
  }

  let target: PromptShelfTarget;
  try {
    target = resolvePromptCommandTarget(projectRoot, kind, parsed.target) as PromptShelfTarget;
  } catch (error) {
    if (error instanceof PromptCommandTargetError) {
      setPromptShelfOperatorBlock(
        ctx,
        kind,
        promptShelfWarningBlock(kind, `${kind} prompt not saved.`, parsed.targetLabel, [
          "The explicit prompt shelf target could not be resolved.",
          error.message,
          "No project-local fallback was used.",
        ]),
        "aboveEditor",
      );
      return;
    }
    setPromptShelfOperatorBlock(ctx, kind, promptShelfErrorBlock(kind, error, parsed.targetLabel), "aboveEditor");
    return;
  }

  try {
    if (parsed.action.kind === "summary") {
      setPromptShelfOperatorBlock(ctx, kind, promptShelfSummaryBlock(kind, target, readPromptCommand(target)));
      return;
    }
    if (parsed.action.kind === "show") {
      setPromptShelfOperatorBlock(
        ctx,
        kind,
        promptShelfBodyBlock(kind, target, readPromptCommand(target), { compact: ctx.mode !== "tui" }),
      );
      return;
    }
    writePromptCommand(target, parsed.action.prompt);
    setPromptShelfOperatorBlock(ctx, kind, promptShelfChangeBlock(kind, target, parsed.action.source), "aboveEditor");
  } catch (error) {
    setPromptShelfOperatorBlock(ctx, kind, promptShelfErrorBlock(kind, error, parsed.targetLabel), "aboveEditor");
  }
}
