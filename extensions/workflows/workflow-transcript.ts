import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionMessage } from "../_shared/pi-api.js";
import { formatDuration } from "../_shared/agent-live-panel.js";
import type { RunWorkflowScriptResult } from "../_shared/workflow-runner.js";
import type { WorkflowJournalLine } from "../_shared/workflow-runtime.js";
import { formatWorkflowFailureDiagnosticLines } from "../_shared/workflow-failure.js";
import { projectWorkflowDisposition, type WorkflowDispositionProjection } from "../_shared/workflow-result.js";

export const WORKFLOW_EVENT_CUSTOM_TYPE = "locus-workflow-event";
const TRANSCRIPT_AGENT_EVENT_LIMIT = 20;
const TRANSCRIPT_LINE_MAX_CHARS = 160;

export type WorkflowTranscriptSurfaceMode = "command" | "tool";

export interface WorkflowTranscriptCompletion {
  eventKind: "workflow_end";
  runId: string;
  digest: string;
  lineCount: number;
}

export interface WorkflowTranscript {
  start(runId: string): void;
  event(line: WorkflowJournalLine): void;
  finish(res: RunWorkflowScriptResult): WorkflowTranscriptCompletion;
}

/**
 * Buffer lifecycle safely for the current Pi surface. Neither command nor tool
 * mode sends messages while the workflow is active. Tool mode returns the
 * digest in its native result; command mode persists it separately only after
 * waitForIdle plus a final idle check.
 */
export function createWorkflowTranscript(
  ctx: ExtensionContext,
  targetLabel: string,
  surface: WorkflowTranscriptSurfaceMode,
): WorkflowTranscript {
  const safeTarget = safeTranscriptTarget(targetLabel);
  let startedAt: number | undefined;
  let announced = false;
  let agentEventCount = 0;
  let lastJournalError: string | undefined;
  let completion: WorkflowTranscriptCompletion | undefined;
  const digestLines: string[] = [];
  const recordLifecycle = (content: string): void => {
    const boundedContent = compactTranscriptText(content);
    digestLines.push(boundedContent);
  };
  return {
    start(runId) {
      if (announced) return;
      announced = true;
      startedAt = Date.now();
      recordLifecycle(`● workflow ${safeTarget} started`);
    },
    event(line) {
      if (line.kind === "agent_start" || line.kind === "agent_end") {
        if (agentEventCount < TRANSCRIPT_AGENT_EVENT_LIMIT) {
          agentEventCount += 1;
          recordLifecycle(formatWorkflowAgentLifecycle(line));
        }
        if (surface === "command") {
          for (const warning of line.evidenceWarnings ?? []) {
            if (warning.trim() !== "")
              notifyFallback(ctx, `⚠ agent evidence · ${compactTranscriptText(warning)}`, "warning");
          }
        }
      } else if (line.kind === "error") {
        // Journal errors may be intermediate or duplicated by the final result.
        // Retain only the latest bounded text as fallback for one final
        // workflow_end record.
        lastJournalError = compactTranscriptText(line.message ?? "unknown error");
      }
    },
    finish(res) {
      if (completion !== undefined) return completion;
      if (!announced) this.start(res.runId);
      const elapsed = startedAt === undefined ? "" : formatDuration(Math.max(0, Date.now() - startedAt));
      const agentCount = res.journal.filter((line) => line.kind === "agent_end").length;
      // This digest is the one workflow surface that enters LLM context, so a
      // replayed run has to declare itself here too — otherwise the model reads
      // recorded evidence as if the work had just been done.
      const replayedCount = res.journal.filter((line) => line.kind === "agent_end" && line.replayed === true).length;
      // A failed run reused recorded evidence just as much as a successful one,
      // and a model reading only the last line must not have to infer it from
      // the per-agent markers above — which the 20-event cap can drop.
      const replayedPart = replayedCount > 0 ? [`${replayedCount} replayed from a recorded run`] : [];
      const disposition = projectWorkflowDisposition(
        {
          ok: res.ok,
          result: res.result,
          ...(res.error !== undefined ? { error: res.error } : {}),
          ...(res.disposition !== undefined ? { disposition: res.disposition } : {}),
        },
        lastJournalError,
      );
      const parts = [
        formatWorkflowTerminalLifecycle(safeTarget, disposition),
        compactTranscriptText(disposition.summary),
        ...((disposition.status === "completed" || disposition.status === "awaiting_operator") && agentCount > 0
          ? [`${agentCount} agent${agentCount === 1 ? "" : "s"}`]
          : []),
        ...replayedPart,
      ];
      recordLifecycle([...parts, ...(elapsed !== "" ? [elapsed] : [])].join(" · "));
      // A failed run leaves the transcript with the actionable diagnostic: where
      // it broke, which evidence proves it, and one copyable repair request. These
      // lines skip the 160-char compaction — a truncated path or repair request
      // would be unusable, and the diagnostic is already bounded at its source.
      if (res.failureDiagnostic !== undefined) {
        for (const line of formatWorkflowFailureDiagnosticLines(res.failureDiagnostic, { repairRequest: true })) {
          digestLines.push(firstTranscriptLine(line));
        }
      }
      completion = {
        eventKind: "workflow_end",
        runId: res.runId,
        digest: [`Workflow lifecycle (eventKind=workflow_end):`, ...digestLines].join("\n"),
        lineCount: digestLines.length,
      };
      return completion;
    },
  };
}

function formatWorkflowTerminalLifecycle(target: string, disposition: WorkflowDispositionProjection): string {
  switch (disposition.status) {
    case "completed":
      return `✓ workflow ${target} finished`;
    case "awaiting_operator":
      return `◐ workflow ${target} awaiting operator`;
    case "cancelled":
      return `⊘ workflow ${target} cancelled`;
    case "failed":
      return `✗ workflow ${target} failed`;
    case "unknown":
      return `■ workflow ${target} ended (unknown disposition)`;
    default:
      return assertNever(disposition.status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled workflow disposition status: ${String(value)}`);
}

/**
 * Workflow journal identity stays stable when the visible fleet collapses a
 * parent row in favour of its SDK child. Petnames belong to that live row only;
 * the durable digest uses catalog agent + label and cannot invent a second name.
 */
function formatWorkflowAgentLifecycle(line: WorkflowJournalLine): string {
  const agent = compactTranscriptText(line.agent ?? "agent");
  const label = line.label === undefined ? "" : compactTranscriptText(line.label);
  const replayed = line.replayed === true ? " [replayed]" : "";
  if (line.kind === "agent_start") {
    return `● agent ${agent} started${replayed}${label !== "" ? ` — ${label}` : ""}`;
  }
  const status = line.status ?? "unknown";
  const lifecycle =
    status === "completed"
      ? { marker: "✓", verb: "finished" }
      : status === "cancelled"
        ? { marker: "⊘", verb: "cancelled" }
        : status === "failed" || status === "blocked"
          ? { marker: "✗", verb: status === "blocked" ? "blocked" : "failed" }
          : { marker: "■", verb: `ended (${compactTranscriptText(status)})` };
  const elapsed = formatDuration(line.durationMs);
  return `${lifecycle.marker} agent ${agent} ${lifecycle.verb}${replayed}${elapsed !== "" ? ` · ${elapsed}` : ""}${label !== "" ? ` — ${label}` : ""}`;
}

/**
 * Persist one command digest only after Pi reports the parent session idle.
 * `waitForIdle()` followed immediately by `isIdle()` and `sendMessage()` has no
 * intervening await, so the host's synchronous sendCustomMessage branch sees
 * the same settled state and appends instead of steering.
 */
export async function persistCommandWorkflowTranscript(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  completion: WorkflowTranscriptCompletion,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!isCurrent()) return false;
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
  if (typeof ctx.isIdle !== "function" || !ctx.isIdle()) {
    notifyWhenCurrent(ctx, isCurrent, "Workflow transcript was not persisted: Pi did not settle to idle.");
    return false;
  }
  if (typeof pi.sendMessage !== "function") {
    notifyWhenCurrent(ctx, isCurrent, "Workflow transcript was not persisted: pi.sendMessage is unavailable.");
    return false;
  }
  const message: ExtensionMessage = {
    customType: WORKFLOW_EVENT_CUSTOM_TYPE,
    content: completion.digest,
    display: true,
    details: { eventKind: completion.eventKind, runId: completion.runId, lineCount: completion.lineCount },
  };
  try {
    if (!isCurrent()) return false;
    // No await between the final idle check and this call. Pi 0.82.0 chooses
    // append-vs-steer synchronously inside sendCustomMessage.
    const pending = pi.sendMessage(message, { triggerTurn: false });
    if (pending !== undefined) await pending;
    return true;
  } catch {
    notifyWhenCurrent(ctx, isCurrent, "Workflow transcript was not persisted: pi.sendMessage failed.");
    return false;
  }
}

function notifyWhenCurrent(ctx: ExtensionContext, isCurrent: () => boolean, message: string): void {
  if (isCurrent()) notifyFallback(ctx, message, "warning");
}

/** Main status omits agent transport markers already represented by the fleet. */
export function renderMainWorkflowStatus(line: WorkflowJournalLine): string | undefined {
  if (line.kind === "phase") return `[phase] ${line.phase ?? ""}`;
  if (line.kind === "agent_start") return undefined;
  if (line.kind === "agent_end") {
    const warnings = line.evidenceWarnings?.filter((warning) => warning.trim() !== "") ?? [];
    if (warnings.length > 0) return `warning: ${warnings.join("; ")}`;
    if (line.status !== undefined && line.status !== "completed") return `agent ${line.agent ?? ""} ${line.status}`;
    return undefined;
  }
  if (line.kind === "log") {
    const label = line.source === "script" ? "script" : line.source === "runtime" ? "runtime" : "journal";
    return `[${label}] ${line.message ?? ""}`;
  }
  if (line.kind === "error") return `[error] ${line.message ?? ""}`;
  return `[${line.kind}]`;
}

function notifyFallback(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // A partial UI host still retains journal/result artifacts.
  }
}

function safeTranscriptTarget(value: string): string {
  if (path.isAbsolute(value)) return path.basename(value);
  if (path.win32.isAbsolute(value)) return path.win32.basename(value);
  return compactTranscriptText(value);
}

function compactTranscriptText(value: string): string {
  const line = firstTranscriptLine(value);
  return line.length <= TRANSCRIPT_LINE_MAX_CHARS ? line : `${line.slice(0, TRANSCRIPT_LINE_MAX_CHARS - 3)}...`;
}

function firstTranscriptLine(value: string): string {
  return (value.split(/\r?\n/u, 1)[0] ?? "").trim();
}
