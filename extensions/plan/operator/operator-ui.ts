/**
 * extensions/plan/operator/operator-ui.ts — pure OperatorBlock builders for the
 * `/plan` and `/mode` surfaces: the saved-plan list and help, the open receipt,
 * the exit receipt, the mode view/change receipts, and the two blocks every
 * host input dialog can end in (cancelled, unsupported result). Sibling of
 * `goal-operator-ui.ts` and `prompt-shelf-ui.ts`; the ctx-bound writes that
 * render these blocks stay in `operator-surface.ts`.
 */

import type { OperatorBlock } from "../../_shared/operator/operator-ui.js";
import { type CycleMode, listPlanSlugs, MODE_CYCLE, userPlansDir } from "../mode/mode-state.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import type { PlanExitAction } from "../mode/plan-exit-handoff.js";

export function cancelledInputBlock(subject: string, reopenCommand: string): OperatorBlock {
  return {
    type: "RESULT",
    subject,
    primary: "Cancelled; no state or artifact was changed.",
    badges: [{ text: "CANCELLED", tone: "muted" }],
    controls: [`Reopen: ${reopenCommand}`],
  };
}

export function dialogFailureBlock(subject: string, reopenCommand: string, error: unknown): OperatorBlock {
  return {
    type: "ERROR",
    subject,
    primary: "The host input dialog returned an unsupported result.",
    metadata: [`reason: ${errorMessage(error)}`],
    hint: ["No state or artifact was changed."],
    controls: [`Retry: ${reopenCommand}`],
  };
}

export function planListBlock(projectRoot: string): OperatorBlock {
  const slugs = listPlanSlugs(projectRoot);
  const plansDir = userPlansDir(projectRoot);
  return {
    type: "VIEW",
    subject: "Saved plans",
    primary: slugs.length === 0 ? "No saved plans." : `${slugs.length} saved plan(s).`,
    body: slugs,
    metadata: [`directory: ${plansDir}`],
    controls: ["Open: /plan open <slug>", "Help: /plan help"],
  };
}

const PLAN_COMMAND_HELP = [
  "Usage:",
  "  /plan <request>    Enter plan mode with a new plan.",
  "  /plan              Prompt for a request, then enter plan mode.",
  "  /plan exit         Exit plan mode.",
  "  /plan list         List saved plans.",
  "  /plan open <slug>  Load a saved plan and re-arm mode.",
  "  /plan help         Show this usage.",
];

export function planHelpBlock(projectRoot: string): OperatorBlock {
  return {
    type: "VIEW",
    subject: "Plan help",
    primary: "Behavioral plan mode and saved-plan commands.",
    body: PLAN_COMMAND_HELP.slice(1),
    metadata: [`saved plans: ${listPlanSlugs(projectRoot).length}`],
    controls: ["Inspect library: /plan list"],
  };
}

export function planExitBlock(action: PlanExitAction): OperatorBlock {
  switch (action) {
    case "kept":
      return {
        type: "RESULT",
        subject: "Plan mode",
        primary: "Stayed in plan mode; no execution turn was queued.",
        badges: [{ text: "CANCELLED", tone: "muted" }],
        controls: ["Reopen exit choices: /plan exit"],
      };
    case "execute":
      return {
        type: "CHANGE",
        subject: "Behavioral mode",
        primary: "plan -> default; execution queued in this context.",
      };
    case "execute-fresh":
      return {
        type: "CHANGE",
        subject: "Behavioral mode",
        primary: "plan -> default; execution queued in a fresh context.",
      };
    case "tweak-execute":
      return {
        type: "CHANGE",
        subject: "Behavioral mode",
        primary: "plan -> default; amended plan queued in this context.",
      };
    default:
      return {
        type: "CHANGE",
        subject: "Behavioral mode",
        primary: "plan -> default.",
        hint: ["No execution turn was queued."],
      };
  }
}

export function modeLine(mode: CycleMode): string {
  return mode === "plan" ? "plan (planning framing; commands & scripts allowed)" : "default (normal execution)";
}

export function modeViewBlock(mode: CycleMode): OperatorBlock {
  return {
    type: "VIEW",
    subject: "Behavioral mode",
    primary: modeLine(mode),
    metadata: [`available: ${MODE_CYCLE.join(", ")}`],
    controls: ["Change explicitly: /mode plan | /mode default"],
  };
}

export function modeChangeBlock(from: CycleMode, to: CycleMode): OperatorBlock {
  if (from === to) {
    return {
      ...modeViewBlock(to),
      primary: `Mode remains ${modeLine(to)}.`,
    };
  }
  return {
    type: "CHANGE",
    subject: "Behavioral mode",
    primary: `${from} -> ${to}`,
    metadata: [modeLine(to)],
    controls: ["Inspect: /mode show"],
  };
}

/** Body lines shown inline in a typed /plan preview before the "+N more" affordance. */
const PLAN_PREVIEW_MAX_LINES = 8;

/**
 * Build the typed CHANGE receipt for loading a saved plan. The preview is
 * clamped before it reaches the shared renderer so the explicit open-path
 * affordance survives its viewport budget.
 */
export function planOpenBlock(slug: string, body: string, artifactPath: string): OperatorBlock {
  const bodyLines = body.replace(/\s+$/, "").split(/\r?\n/);
  const visible = bodyLines.slice(0, PLAN_PREVIEW_MAX_LINES);
  const hidden = bodyLines.length - visible.length;
  return {
    type: "CHANGE",
    subject: "Plan mode",
    primary: `Opened '${slug}'; behavioral plan mode is active.`,
    badges: [{ text: "PLAN", tone: "accent" }],
    body: visible,
    metadata: [`path: ${artifactPath}`],
    ...(hidden > 0 ? { hint: [`(+${hidden} more — open ${artifactPath})`] } : {}),
    controls: ["Exit or execute: /plan exit"],
  };
}
