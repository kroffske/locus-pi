/**
 * extensions/plan/plan-exit-handoff.ts — the plan -> execution handoff (T-D).
 *
 * On leaving plan mode with a composed plan, ask the user what to do with it.
 * The "ask the user with options" primitive is the built-in ctx.ui.select; we
 * drive it from extension code (no LLM-callable tool needed for this flow).
 * Shared by `/plan exit` and `/mode default`.
 */

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "../_shared/host/pi-api.js";
import { requestOperatorInput } from "../_shared/operator/operator-input.js";
import { clearModeState, loadModeState } from "../_shared/mode-state.js";
import { setModeStatus } from "./operator-surface.js";

export type PlanExitAction = "plain-exit" | "kept" | "execute" | "execute-fresh" | "tweak-execute";

const PLAN_EXIT_TITLE = "Plan ready — what next?";
const PLAN_EXIT_EXECUTE = "Execute the plan (this context)";
const PLAN_EXIT_FRESH = "Execute with a fresh context (reset)";
const PLAN_EXIT_TWEAK = "Tweak, then execute";
const PLAN_EXIT_KEEP = "Keep planning";

/** Build the message that carries the saved plan into the execution turn. */
function planExecutionPrompt(content: string, amendment?: string): string {
  const lines = [
    "Execute the following plan in this project. Implement it fully — do not just re-plan or restate it.",
    "",
    "<plan>",
    content.trim(),
    "</plan>",
  ];
  if (amendment !== undefined && amendment.trim() !== "") {
    lines.push("", "Apply this amendment before executing:", amendment.trim());
  }
  lines.push("", "Begin now.");
  return lines.join("\n");
}

/**
 * On leaving plan mode, offer four ways to act on the composed plan via the
 * built-in ctx.ui.select. Degrades to a plain exit (the previous behavior) when
 * there is no composed plan artifact or no interactive UI (headless/print mode).
 */
export async function runPlanExitDecision(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  projectRoot: string,
): Promise<PlanExitAction> {
  const state = loadModeState(projectRoot);
  const artifactPath = state?.activeArtifactPath;
  const hasArtifact = typeof artifactPath === "string" && existsSync(artifactPath);

  if (ctx.hasUI !== true || !hasArtifact) {
    clearModeState(projectRoot);
    setModeStatus(ctx, null);
    return "plain-exit";
  }

  const content = readFileSync(artifactPath, "utf8");
  const choice = await ctx.ui.select(PLAN_EXIT_TITLE, [
    PLAN_EXIT_EXECUTE,
    PLAN_EXIT_FRESH,
    PLAN_EXIT_TWEAK,
    PLAN_EXIT_KEEP,
  ]);
  const picked = typeof choice === "string" ? choice : choice?.value;

  // Dismissed (Esc), empty, or "Keep planning" -> stay in plan mode untouched.
  if (!picked || picked === PLAN_EXIT_KEEP) return "kept";

  if (picked === PLAN_EXIT_FRESH) {
    clearModeState(projectRoot);
    setModeStatus(ctx, null);
    await ctx.newSession?.({
      withSession: async (fresh) => {
        await fresh.sendUserMessage?.(planExecutionPrompt(content), { deliverAs: "followUp" });
      },
    });
    return "execute-fresh";
  }

  let amendment: string | undefined;
  if (picked === PLAN_EXIT_TWEAK) {
    const input = await requestOperatorInput(ctx, {
      kind: "input",
      title: "[INPUT] Plan amendment",
      placeholder: "e.g. skip step 3; use Y instead of X",
    });
    if (input.status !== "submitted" || input.value.trim() === "") return "kept";
    amendment = input.value;
  }

  clearModeState(projectRoot);
  setModeStatus(ctx, null);
  await pi.sendUserMessage(planExecutionPrompt(content, amendment), { deliverAs: "followUp" });
  return picked === PLAN_EXIT_TWEAK ? "tweak-execute" : "execute";
}
