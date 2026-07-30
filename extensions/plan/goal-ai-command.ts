/**
 * extensions/plan/goal-ai-command.ts — the `/goal-ai` grammar: collect the
 * request (inline or through one host dialog), resolve the goal prompt-shelf
 * target, run one replacement-session draft, and save the draft as a goal
 * prompt. It never executes the draft.
 */

import type { ExtensionCommandContext, ExtensionContext, CommandArgs } from "../_shared/host/pi-api.js";
import { getCommandText, getProjectRoot } from "../_shared/host/pi-api.js";
import { runGoalAiDraftSession } from "../_shared/goal-ai-draft.js";
import { requestOperatorInput } from "../_shared/operator/operator-input.js";
import { setOperatorWidget } from "../_shared/operator/widget-render.js";
import { errorMessage } from "../_shared/host/error-text.js";
import {
  PromptCommandTargetError,
  resolvePromptCommandTarget,
  writePromptCommand,
} from "../_shared/project/prompt-command-store.js";
import { parsePromptCommandInput } from "./command-parser.js";
import { setGoalOperatorBlock } from "./operator-surface.js";
import { cancelledInputBlock, dialogFailureBlock } from "./operator-ui.js";

export async function handleGoalAiCommand(args: CommandArgs, ctx: ExtensionContext): Promise<void> {
  let parsed = parsePromptCommandInput(getCommandText(args));
  if (parsed.prompt === "") {
    let input: Awaited<ReturnType<typeof requestOperatorInput>>;
    try {
      input = await requestOperatorInput(ctx, {
        kind: "editor",
        title: "[INPUT] Goal AI request — describe prompt outcome",
        prefill: "",
      });
    } catch (error) {
      setOperatorWidget(ctx, "goal", dialogFailureBlock("Goal AI request", "/goal-ai", error), {
        placement: "aboveEditor",
      });
      return;
    }
    if (input.status === "unavailable") {
      setOperatorWidget(
        ctx,
        "goal",
        {
          type: "WARN",
          subject: "Goal AI request",
          primary: "Interactive input is unavailable in this host mode.",
          hint: ["Provide the request directly: /goal-ai [--task <task-id>] <request>"],
        },
        { placement: "aboveEditor" },
      );
      return;
    }
    if (input.status === "cancelled") {
      setOperatorWidget(ctx, "goal", cancelledInputBlock("Goal AI request", "/goal-ai"), { placement: "aboveEditor" });
      return;
    }
    const request = input.value.trim();
    if (request === "") {
      setOperatorWidget(
        ctx,
        "goal",
        {
          type: "WARN",
          subject: "Goal AI request",
          primary: "The request cannot be empty.",
          controls: ["Reopen: /goal-ai"],
        },
        { placement: "aboveEditor" },
      );
      return;
    }
    parsed = { ...parsed, prompt: request };
  }

  const projectRoot = getProjectRoot(ctx);
  const target = resolveGoalAiTargetOrRenderError(projectRoot, parsed.target, ctx);
  if (target === undefined) return;

  setOperatorWidget(
    ctx,
    "goal",
    {
      type: "RUN",
      subject: "Goal AI draft",
      primary: "Drafting one Locus Prompt Draft in a replacement session.",
      metadata: [`target: ${target.target}`],
    },
    { placement: "aboveEditor" },
  );
  const result = await runGoalAiDraftSession(ctx as ExtensionCommandContext, parsed.prompt);
  const renderCtx = result.renderContext ?? ctx;
  if (result.status !== "completed" || result.draft === undefined) {
    setOperatorWidget(
      renderCtx,
      "goal",
      {
        type: result.status === "cancelled" ? "WARN" : "ERROR",
        subject: "Goal AI draft",
        primary: `Draft ${result.status}: ${result.reason}`,
        metadata: [
          `target: ${target.target}`,
          "artifact: not written",
          ...(result.childSessionId === undefined ? [] : [`childSessionId: ${result.childSessionId}`]),
        ],
        controls: ["Retry: /goal-ai <request>"],
      },
      { placement: "aboveEditor" },
    );
    return;
  }

  writePromptCommand(target, result.draft);
  setOperatorWidget(
    renderCtx,
    "goal",
    {
      type: "RESULT",
      subject: "Goal AI draft",
      primary: "Draft saved as a goal prompt; it was not executed.",
      metadata: [
        `target: ${target.target}`,
        `kind: ${target.kind}`,
        promptCommandPathLine(target),
        ...(result.childSessionId === undefined ? [] : [`childSessionId: ${result.childSessionId}`]),
      ],
      controls: ["Continue explicitly: /goal continue"],
    },
    { placement: "aboveEditor" },
  );
}

function resolveGoalAiTargetOrRenderError(
  projectRoot: string,
  selector: { type: "project" } | { type: "task"; taskId: string },
  ctx: ExtensionContext,
) {
  try {
    return resolvePromptCommandTarget(projectRoot, "goal", selector);
  } catch (error) {
    const target = selector.type === "task" ? `task:${selector.taskId}` : "project-local";
    if (error instanceof PromptCommandTargetError) {
      setGoalOperatorBlock(ctx, {
        type: "ERROR",
        subject: "Goal AI target",
        primary: error.message,
        metadata: [`target: ${target}`, "kind: goal", "artifact: not written"],
        hint: ["No project-local fallback was used because the task target was explicit."],
      });
      return undefined;
    }
    setGoalOperatorBlock(ctx, {
      type: "ERROR",
      subject: "Goal AI target",
      primary: "Target resolution failed unexpectedly; no artifact was written.",
      body: [`error: ${errorMessage(error)}`],
      metadata: [`target: ${target}`, "kind: goal"],
      controls: ["Retry: /goal-ai <request>"],
    });
    return undefined;
  }
}

type PromptCommandTarget = ReturnType<typeof resolvePromptCommandTarget>;

function promptCommandPathLine(target: PromptCommandTarget): string {
  return `path: ${compactPromptCommandPath(target)}`;
}

function compactPromptCommandPath(target: PromptCommandTarget): string {
  if (!target.target.startsWith("task:")) return target.displayPath;
  const artifactPath = /\/artifacts\/[^/]+$/u.exec(target.displayPath)?.[0];
  if (artifactPath === undefined) return target.displayPath;
  const taskId = target.target.slice("task:".length);
  return `.tasks/${taskId}${artifactPath}`;
}
