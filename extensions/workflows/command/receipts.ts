import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionMessage,
} from "../../_shared/host/pi-api.js";
import { notifyOperator } from "../../_shared/operator/operator-notify.js";
import type { WorkflowProjectedStatus } from "../runtime/workflow-result.js";

export const WORKFLOW_RUN_CUSTOM_TYPE = "locus-workflow-run";
export const WORKFLOW_RESULT_CUSTOM_TYPE = "locus-workflow-result";

export type WorkflowTranscriptRejectionCode =
  | "missing_resume_id"
  | "missing_output_dir"
  | "input_too_long"
  | "workflow_not_found"
  | "launch_policy_refused"
  | "workflow_run_busy"
  | "runner_prestart_failed"
  | "session_stale";

export interface WorkflowTranscriptRejection {
  code: WorkflowTranscriptRejectionCode;
  text: string;
  target?: string;
}

export interface WorkflowTranscriptAnnouncement {
  eventKind: "workflow_start";
  runId: string;
  text: string;
  runDir: string;
  journalPath: string;
  resultPath: string;
}

export interface WorkflowTranscriptCompletion {
  eventKind: "workflow_end";
  runId: string;
  workflowStatus: WorkflowProjectedStatus;
  runDir: string;
  journalPath: string;
  resultPath: string;
  resultPersisted: boolean;
  digest: string;
  lineCount: number;
  resultText?: string;
  resultTextPath?: string;
}

export function announceCommandWorkflowStart(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  announcement: WorkflowTranscriptAnnouncement,
  isCurrent: () => boolean = () => true,
): boolean {
  if (!isCurrent()) return false;
  if (!contextIsIdle(ctx)) return false;
  if (typeof pi.sendMessage !== "function") return false;
  const message: ExtensionMessage = {
    customType: WORKFLOW_RUN_CUSTOM_TYPE,
    content: announcement.text,
    display: true,
    details: {
      eventKind: announcement.eventKind,
      runId: announcement.runId,
      runDir: announcement.runDir,
      journalPath: announcement.journalPath,
      resultPath: announcement.resultPath,
    },
  };
  try {
    void Promise.resolve(pi.sendMessage(message, { triggerTurn: false })).catch(() => {
      notifyWhenCurrent(ctx, isCurrent, "Workflow start receipt was not published: pi.sendMessage failed.");
    });
    return true;
  } catch {
    return false;
  }
}

export async function persistCommandWorkflowRejection(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rejection: WorkflowTranscriptRejection,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!isCurrent()) return false;
  // Pi turns a custom message into steering while a parent response streams.
  // The receipt owner, not each caller, must prove append safety immediately
  // before sendMessage so late background failures cannot bypass the guard.
  if (!contextIsIdle(ctx)) return false;
  if (typeof pi.sendMessage !== "function") return false;
  try {
    if (!isCurrent()) return false;
    await pi.sendMessage(
      {
        customType: WORKFLOW_RUN_CUSTOM_TYPE,
        content: rejection.text,
        display: true,
        details: {
          eventKind: "workflow_rejected",
          code: rejection.code,
          ...(rejection.target === undefined ? {} : { target: rejection.target }),
        },
      },
      { triggerTurn: false },
    );
    return true;
  } catch {
    return false;
  }
}

export async function persistCommandWorkflowTranscript(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  completion: WorkflowTranscriptCompletion,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!isCurrent()) return false;
  // One-shot print/json commands stay idle for their whole background run, so
  // their terminal receipt never waits on unrelated host activity. Interactive
  // hosts retain the idle barrier to avoid steering a streaming parent.
  if (!contextIsIdle(ctx)) {
    if (typeof ctx.waitForIdle !== "function") {
      notifyWhenCurrent(ctx, isCurrent, "Workflow transcript was not persisted: ctx.waitForIdle is unavailable.");
      return false;
    }
    try {
      await ctx.waitForIdle();
    } catch {
      notifyWhenCurrent(ctx, isCurrent, "Workflow transcript was not persisted: waiting for Pi idle state failed.");
      return false;
    }
    if (!isCurrent()) return false;
    if (!contextIsIdle(ctx)) {
      notifyWhenCurrent(ctx, isCurrent, "Workflow transcript was not persisted: Pi did not settle to idle.");
      return false;
    }
  }
  if (typeof pi.sendMessage !== "function") {
    notifyWhenCurrent(ctx, isCurrent, "Workflow transcript was not persisted: pi.sendMessage is unavailable.");
    return false;
  }
  const message: ExtensionMessage = {
    customType: WORKFLOW_RUN_CUSTOM_TYPE,
    content: completion.digest,
    display: true,
    details: {
      eventKind: completion.eventKind,
      runId: completion.runId,
      workflowStatus: completion.workflowStatus,
      runDir: completion.runDir,
      journalPath: completion.journalPath,
      resultPath: completion.resultPath,
      resultPersisted: completion.resultPersisted,
      lineCount: completion.lineCount,
      ...(completion.resultTextPath === undefined ? {} : { resultTextPath: completion.resultTextPath }),
    },
  };
  try {
    if (!isCurrent()) return false;
    const pendingMessages: Array<Promise<void>> = [];
    if (completion.resultText !== undefined) {
      pendingMessages.push(
        Promise.resolve(
          pi.sendMessage(
            {
              customType: WORKFLOW_RESULT_CUSTOM_TYPE,
              content: completion.resultText,
              display: true,
              details: {
                eventKind: "workflow_result",
                runId: completion.runId,
                ...(completion.resultTextPath === undefined ? {} : { resultTextPath: completion.resultTextPath }),
              },
            },
            { triggerTurn: false },
          ),
        ),
      );
    }
    // Pi emits each idle custom-message event synchronously. Queue exact result
    // first and the authoritative terminal receipt last so headless stdin may
    // close on workflow_end without racing the prose result.
    pendingMessages.push(Promise.resolve(pi.sendMessage(message, { triggerTurn: false })));
    await Promise.all(pendingMessages);
    return true;
  } catch {
    notifyWhenCurrent(ctx, isCurrent, "Workflow transcript was not persisted: pi.sendMessage failed.");
    return false;
  }
}

function contextIsIdle(ctx: ExtensionContext): boolean {
  try {
    return typeof ctx.isIdle === "function" && ctx.isIdle();
  } catch {
    return false;
  }
}

function notifyWhenCurrent(ctx: ExtensionContext, isCurrent: () => boolean, message: string): void {
  if (isCurrent()) notifyOperator(ctx, message, "warning");
}
