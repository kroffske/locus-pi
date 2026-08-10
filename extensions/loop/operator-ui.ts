/**
 * extensions/loop/operator-ui.ts — Pure operator blocks for the loop surface.
 *
 * Every block `/loop` can render — status, help, cancelled input, blocked
 * continuation — plus the one text formatter the tool and the command share for
 * an unsupported action. No Pi handle, no `ExtensionContext`, no I/O: the
 * context-bound writes live in `operator-surface.ts`.
 */

import type { OperatorBlock } from "../_shared/operator/operator-ui.js";

export function unsupportedLoopText(action: string): string {
  return [
    `Unsupported loop action: ${action}`,
    "Use /loop status or /loop once goal | /loop once workflow <runId>.",
    "Legacy auto-run actions remain disabled.",
  ].join("\n");
}

export function loopStatusBlock(text: string): OperatorBlock {
  const [primary = "status unavailable", ...body] = text.split(/\r?\n/u);
  return {
    type: "VIEW",
    subject: "Loop status",
    primary,
    body,
    controls: ["Prepare one continuation: /loop", "Help: /loop help"],
  };
}

export function loopHelpBlock(): OperatorBlock {
  return {
    type: "VIEW",
    subject: "Loop help",
    primary: "One manual continuation per submit; no auto-repeat.",
    body: [
      "/loop — enter source and optional focus",
      "/loop status — inspect eligible sources",
      "/loop once goal [focus]",
      "/loop once workflow <runId> [focus]",
    ],
    metadata: ["Supported sources: goal, workflow", "maxSteps: 1", "autoDispatch: false"],
  };
}

export function cancelledLoopBlock(): OperatorBlock {
  return {
    type: "RESULT",
    subject: "Loop input",
    primary: "Cancelled; no continuation was created.",
    badges: [{ text: "CANCELLED", tone: "muted" }],
    controls: ["Reopen: /loop"],
  };
}

export function loopWarningBlock(text: string): OperatorBlock {
  const [primary = "Loop continuation is blocked.", ...body] = text.split(/\r?\n/u);
  return {
    type: "WARN",
    subject: "Loop continuation",
    primary,
    body,
    controls: ["Inspect eligibility: /loop status", "Help: /loop help"],
  };
}
