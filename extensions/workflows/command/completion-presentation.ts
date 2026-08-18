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
  const ref = packageTaskRef(res, safeTarget);
  if (ref === undefined || res.workspaceDir === undefined || res.workspaceDir === "") return {};
  const primaryFile = res.primaryFile?.absolutePath;
  if (primaryFile === undefined || primaryFile === "") return {};
  if (path.basename(primaryFile) === "planning-blocker.md") {
    return {
      nextAction: `Planning failed closed. Read ${primaryFile}, edit the task statement or the planning files it names, then rerun ${ref} on the same workspace; the run never waits for an operator answer mid-run.`,
    };
  }
  if (ref === "task-via-script") {
    const generatedScript = path.join(res.workspaceDir, "implement.workflow.mjs");
    return {
      generatedRunCommand: `/workflows run ${formatWorkflowCommandToken(generatedScript)}`,
      nextAction: `After the owner reads ${generatedScript} and explicitly approves it, run it by that explicit path; rendering is not approval to run.`,
    };
  }
  const stepFiles = path.join(res.workspaceDir, "step-<n>.md");
  return {
    nextAction: `After the owner reviews and explicitly approves the plan, implement ${primaryFile} using the ${stepFiles} files, one task/implement run per step file, giving each run only the step id such as S1.`,
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

function packageTaskRef(res: RunWorkflowScriptResult, safeTarget: string): "task/plan" | "task-via-script" | undefined {
  const ref = res.target !== undefined ? (res.target.source === "package" ? res.target.ref : undefined) : safeTarget;
  return ref === "task/plan" || ref === "task-via-script" ? ref : undefined;
}
