/**
 * extensions/plan/plan-command.ts — the `/plan` grammar: list, help, exit,
 * open <slug>, the bare interactive prompt, and entering plan mode for an
 * explicit request. Owns the one draft-session pipeline both entry paths share.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandArgs, ExtensionAPI, ExtensionCommandContext } from "../_shared/host/pi-api.js";
import { getCommandText, getProjectRoot } from "../_shared/host/pi-api.js";
import { runPlanDraftSession } from "./goal-ai-draft.js";
import { requestOperatorInput } from "../_shared/operator/operator-input.js";
import { SETTINGS_HELP_PLACEMENT } from "../_shared/operator/widget-render.js";
import {
  clearModeState,
  isInPlanMode,
  listPlanSlugs,
  loadActiveModeState,
  loadModeState,
  planArtifactPath,
  planSlug,
  slugify,
  writeModeState,
} from "./mode-state.js";
import { splitFirstWord } from "./command-parser.js";
import { ensureModeAwareEditor, setModeStatus, setPlanOperatorBlock } from "./operator-surface.js";
import {
  cancelledInputBlock,
  dialogFailureBlock,
  planExitBlock,
  planHelpBlock,
  planListBlock,
  planOpenBlock,
} from "./operator-ui.js";
import { runPlanExitDecision } from "./plan-exit-handoff.js";

export async function handlePlanCommand(
  args: CommandArgs,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  await ensureModeAwareEditor(ctx);
  const projectRoot = getProjectRoot(ctx);
  const rawText = getCommandText(args).trim();
  const [verb, rest] = splitFirstWord(rawText);

  const activeState = loadActiveModeState(projectRoot);
  if (activeState === null) {
    const rawState = loadModeState(projectRoot);
    if (rawState !== null && rawState.mode !== null) {
      clearModeState(projectRoot);
    }
  }

  if (verb === "list") {
    setPlanOperatorBlock(ctx, planListBlock(projectRoot), SETTINGS_HELP_PLACEMENT);
    return;
  }

  if (verb === "help" || verb === "?") {
    setPlanOperatorBlock(ctx, planHelpBlock(projectRoot), SETTINGS_HELP_PLACEMENT);
    return;
  }

  if (verb === "exit") {
    const current = loadModeState(projectRoot);
    if (current !== null && isInPlanMode(current)) {
      const action = await runPlanExitDecision(ctx, pi, projectRoot);
      setPlanOperatorBlock(ctx, planExitBlock(action));
    } else {
      clearModeState(projectRoot);
      setModeStatus(ctx, null);
      setPlanOperatorBlock(ctx, {
        type: "VIEW",
        subject: "Plan mode",
        primary: "Already in default mode.",
        controls: ["Enter: /plan"],
      });
    }
    return;
  }

  if (verb === "open") {
    const slug = slugify(rest.trim());
    if (!slug || rest.trim() === "") {
      setPlanOperatorBlock(ctx, {
        type: "WARN",
        subject: "Plan open",
        primary: "A saved-plan slug is required.",
        hint: ["Usage: /plan open <slug>"],
        controls: ["Inspect library: /plan list"],
      });
      return;
    }
    const artifactPath = planArtifactPath(projectRoot, slug);
    if (!existsSync(artifactPath)) {
      const available = listPlanSlugs(projectRoot);
      setPlanOperatorBlock(ctx, {
        type: "WARN",
        subject: "Plan open",
        primary: `Plan not found: ${slug}`,
        body: available.length === 0 ? ["No saved plans are available."] : available,
        controls: ["Inspect library: /plan list"],
      });
      return;
    }
    const content = readFileSync(artifactPath, "utf8");
    writeModeState(projectRoot, {
      version: 1,
      mode: "plan",
      slug,
      activeArtifactPath: artifactPath,
      enteredAt: new Date().toISOString(),
      status: "active",
    });
    setModeStatus(ctx, loadModeState(projectRoot));
    setPlanOperatorBlock(ctx, planOpenBlock(slug, content, artifactPath));
    return;
  }

  if (verb === "") {
    let input: Awaited<ReturnType<typeof requestOperatorInput>>;
    try {
      input = await requestOperatorInput(ctx, {
        kind: "input",
        title: "[INPUT] Plan request — desired end state",
        placeholder: "Describe the state the plan should make true",
      });
    } catch (error) {
      setPlanOperatorBlock(ctx, dialogFailureBlock("Plan request", "/plan", error));
      return;
    }
    if (input.status === "unavailable") {
      setPlanOperatorBlock(ctx, {
        type: "WARN",
        subject: "Plan request",
        primary: "Interactive input is unavailable in this host mode.",
        hint: ["Provide the request directly: /plan <request>"],
        controls: ["Help: /plan help"],
      });
      return;
    }
    if (input.status === "cancelled") {
      setPlanOperatorBlock(ctx, cancelledInputBlock("Plan request", "/plan"));
      return;
    }
    const request = input.value.trim();
    if (request === "") {
      setPlanOperatorBlock(ctx, {
        type: "WARN",
        subject: "Plan request",
        primary: "The request cannot be empty.",
        controls: ["Reopen: /plan", "Help: /plan help"],
      });
      return;
    }
    await enterPlanModeWithRequest(request, ctx, pi, projectRoot);
    return;
  }

  await enterPlanModeWithRequest(rawText, ctx, pi, projectRoot);
}

/**
 * Enter plan mode for an explicit request: confirm-replace an active plan, run the
 * draft session, persist the artifact + mode state. Shared by the direct `/plan
 * <request>` path and the bare-`/plan` interactive-prompt path.
 */
async function enterPlanModeWithRequest(
  request: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  projectRoot: string,
): Promise<void> {
  const existing = loadModeState(projectRoot);
  if (existing !== null && isInPlanMode(existing)) {
    const confirmed = await ctx.ui.confirm(
      `Replace active plan '${existing.slug}'?`,
      "Entering a new plan will replace the active plan-mode reference.",
    );
    if (!confirmed) {
      setPlanOperatorBlock(ctx, {
        type: "RESULT",
        subject: "Plan request",
        primary: `Kept active plan '${existing.slug}'; no replacement was started.`,
        badges: [{ text: "CANCELLED", tone: "muted" }],
        controls: ["Exit first: /plan exit"],
      });
      return;
    }
  }

  const slug = planSlug(request);
  const artifactPath = planArtifactPath(projectRoot, slug);
  setPlanOperatorBlock(ctx, {
    type: "RUN",
    subject: "Plan draft",
    primary: "Authoring one plan in a replacement session.",
    metadata: [`slug: ${slug}`],
  });
  const result = await runPlanDraftSession(ctx, request);
  const renderCtx = result.renderContext ?? ctx;

  if (result.status === "blocked") {
    setPlanOperatorBlock(renderCtx, {
      type: "ERROR",
      subject: "Plan draft",
      primary: `Plan mode is blocked: ${result.reason}`,
      metadata: [
        "artifact: not written",
        ...(result.childSessionId === undefined ? [] : [`childSessionId: ${result.childSessionId}`]),
      ],
      controls: ["Retry after host recovery: /plan <request>"],
    });
    return;
  }

  const draft = result.draft;
  const completed = result.status === "completed" && draft !== undefined;
  const artifactContent =
    draft ?? ["# Draft plan unavailable", "", `Plan draft session ${result.status}.`, result.reason].join("\n");
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${artifactContent.trimEnd()}\n`, "utf8");

  writeModeState(projectRoot, {
    version: 1,
    mode: "plan",
    slug,
    activeArtifactPath: artifactPath,
    enteredAt: new Date().toISOString(),
    status: completed ? "active" : "draft",
  });
  setModeStatus(renderCtx, loadModeState(projectRoot));
  setPlanOperatorBlock(
    renderCtx,
    completed
      ? {
          type: "RESULT",
          subject: "Plan draft",
          primary: "Plan saved; behavioral plan mode is active.",
          badges: [{ text: "PLAN", tone: "accent" }],
          metadata: [
            `slug: ${slug}`,
            `path: ${artifactPath}`,
            ...(result.childSessionId === undefined ? [] : [`childSessionId: ${result.childSessionId}`]),
          ],
          controls: ["Exit or execute: /plan exit"],
        }
      : {
          type: "WARN",
          subject: "Plan draft",
          primary: `Draft session ${result.status}: ${result.reason}`,
          metadata: [
            `stub path: ${artifactPath}`,
            `slug: ${slug}`,
            ...(result.childSessionId === undefined ? [] : [`childSessionId: ${result.childSessionId}`]),
          ],
          hint: ["A diagnostic stub was saved; it is not a completed plan."],
          controls: ["Retry: /plan <request>"],
        },
  );
}
