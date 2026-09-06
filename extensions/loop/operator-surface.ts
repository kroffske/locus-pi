/**
 * extensions/loop/operator-surface.ts — The loop extension's context-bound
 * operator surface.
 *
 * Owns the `loop` widget key and the `loop.manual` status lane: the block
 * render with its placement, the status clear both the command and the
 * transient-UI cleanup need, and the one wording a settled continuation gets.
 * Pure block construction stays in `operator-ui.ts`.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
  CustomUiComponent,
  ExtensionCommandContext,
  ExtensionContext,
  ToolResult,
} from "../_shared/host/pi-api.js";
import { clearOperatorStatus, setOperatorStatus } from "../_shared/operator/operator-status.js";
import type { OperatorBlock } from "../_shared/operator/operator-ui.js";
import { LIVE_WORK_PLACEMENT, setOperatorWidget } from "../_shared/operator/widget-render.js";
import { loopWarningBlock } from "./operator-ui.js";

const LOOP_STATUS_ID = "loop.manual";

/** Drop the loop status contribution only; the widget lifecycle owns the rest. */
export function clearLoopOperatorStatus(ctx: ExtensionContext): void {
  clearOperatorStatus(ctx, LOOP_STATUS_ID);
}

export function clearLoopStatus(ctx: ExtensionCommandContext): void {
  ctx.ui.setStatus("loop", undefined);
  clearOperatorStatus(ctx, LOOP_STATUS_ID);
}

export function presentLoopResult(ctx: ExtensionCommandContext, result: ToolResult): void {
  if (result.isError === true) {
    clearLoopStatus(ctx);
    presentLoopBlock(ctx, loopWarningBlock(firstResultText(result)));
    return;
  }

  const details = result.details ?? {};
  const source = typeof details.source === "string" ? details.source : "continuation";
  setOperatorStatus(ctx, {
    id: LOOP_STATUS_ID,
    lane: "activity",
    priority: 40,
    wide: `LOOP manual: ${source}`,
    compact: `LOOP: ${source}`,
    narrow: "LOOP",
  });
  if (source === "workflow") {
    presentInlineWorkflowContinuation(ctx, firstResultText(result));
    return;
  }
  presentLoopBlock(ctx, {
    type: "RESULT",
    subject: "Loop continuation",
    primary: "One bounded continuation is ready; it was not auto-dispatched.",
    badges: [{ text: source.toUpperCase(), tone: "accent" }],
    metadata: [
      ...(typeof details.sourceId === "string" ? [`sourceId: ${details.sourceId}`] : []),
      ...(typeof details.path === "string" ? [`path: ${details.path}`] : []),
      `maxSteps: ${String(details.maxSteps ?? 1)}`,
      `autoDispatch: ${String(details.autoDispatch ?? false)}`,
    ],
    controls: ["Inspect: /loop status"],
  });
}

function presentInlineWorkflowContinuation(ctx: ExtensionCommandContext, text: string): void {
  const content = `[RESULT] Loop continuation [WORKFLOW]\n${text}`;
  ctx.ui.setWidget("loop", () => new InlineWorkflowContinuationWidget(content), {
    placement: LIVE_WORK_PLACEMENT,
  });
}

class InlineWorkflowContinuationWidget implements CustomUiComponent {
  constructor(private readonly content: string) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    return this.content.split(/\r?\n/u).flatMap((line) => wrapTextWithAnsi(line, safeWidth));
  }

  invalidate(): void {
    // Content is immutable and rendered directly from the continuation result.
  }
}

export function presentLoopBlock(
  ctx: ExtensionCommandContext,
  block: OperatorBlock,
  placement: "aboveEditor" | "belowEditor" = "aboveEditor",
): void {
  setOperatorWidget(ctx, "loop", block, { placement });
}

function firstResultText(result: ToolResult): string {
  return result.content.find((part) => part.type === "text")?.text ?? "Loop continuation is blocked.";
}
