import path from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ThemeLike } from "../../_shared/host/pi-api.js";
import { formatWorkflowCommandToken } from "../command-parser.js";
import { WORKFLOW_RESULT_CUSTOM_TYPE, WORKFLOW_RUN_CUSTOM_TYPE } from "./receipts.js";
import type { RunWorkflowScriptResult } from "../runtime/workflow-runner.js";

export interface WorkflowCompletionPresentation {
  generatedRunCommand?: string;
  nextAction?: string;
}

/** Package-specific human continuation, derived from existing run evidence. */
export function workflowCompletionPresentation(
  res: RunWorkflowScriptResult,
  safeTarget: string,
): WorkflowCompletionPresentation {
  if (!isPackagePlanResult(res, safeTarget) || res.workspaceDir === undefined || res.workspaceDir === "") return {};
  const generatedScript = path.join(res.workspaceDir, "execute.workflow.mjs");
  const generatedRunCommand = `/workflows run ${formatWorkflowCommandToken(generatedScript)}`;
  const primaryFile = res.primaryFile?.absolutePath;
  if (primaryFile === undefined || primaryFile === "") return { generatedRunCommand };
  const stepsFile = path.join(res.workspaceDir, "steps.md");
  return {
    generatedRunCommand,
    nextAction: `After the owner reviews and explicitly approves the plan, implement ${primaryFile} using ${stepsFile}, one task/implement run per exact step.`,
  };
}

/** Replace Pi's raw custom-message fallback with distinct operator cards. */
export function registerWorkflowTranscriptRenderers(pi: ExtensionAPI): void {
  if (pi.registerMessageRenderer === undefined) return;
  pi.registerMessageRenderer(WORKFLOW_RUN_CUSTOM_TYPE, (message, { outputPad }, theme) => {
    if (typeof message.content !== "string") return undefined;
    const title = workflowRunTitle(message.details?.eventKind);
    return workflowTranscriptCard(title, message.content, outputPad, theme);
  });
  pi.registerMessageRenderer(WORKFLOW_RESULT_CUSTOM_TYPE, (message, { outputPad }, theme) => {
    if (typeof message.content !== "string") return undefined;
    const savedPath = detailText(message.details?.primaryFilePath) ?? detailText(message.details?.resultTextPath);
    const nextAction = detailText(message.details?.nextAction);
    return workflowTranscriptCard(
      savedPath === undefined ? "Workflow result" : `Workflow result (${savedPath})`,
      message.content,
      outputPad,
      theme,
      nextAction === undefined ? undefined : { title: "Next action (after review and approval)", text: nextAction },
    );
  });
}

function workflowRunTitle(eventKind: unknown): string {
  if (eventKind === "workflow_start") return "Workflow started";
  if (eventKind === "workflow_rejected") return "Workflow rejected";
  if (eventKind === "workflow_end") return "Workflow finished";
  return "Workflow run";
}

function workflowTranscriptCard(
  title: string,
  content: string,
  outputPad: number,
  theme: ThemeLike,
  footer?: { title: string; text: string },
): Box {
  const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
  const footerText = footer === undefined ? "" : `\n\n${theme.fg("accent", theme.bold(footer.title))}\n${footer.text}`;
  box.addChild(new Text(`${theme.fg("accent", theme.bold(title))}\n${content}${footerText}`, 0, 0));
  return box;
}

function detailText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

function isPackagePlanResult(res: RunWorkflowScriptResult, safeTarget: string): boolean {
  if (res.target !== undefined) return res.target.source === "package" && res.target.ref === "task/plan";
  return safeTarget === "task/plan";
}
