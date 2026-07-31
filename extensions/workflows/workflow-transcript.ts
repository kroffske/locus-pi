import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionMessage,
} from "../_shared/host/pi-api.js";
import { formatDuration } from "../_shared/agent-runtime/agent-live-panel.js";
import type { RunWorkflowScriptResult } from "./runtime/workflow-runner.js";
import type { WorkflowJournalLine } from "./runtime/workflow-runtime.js";
import { formatWorkflowFailureDiagnosticLines } from "./runtime/workflow-failure.js";
import { projectWorkflowDisposition, type WorkflowDispositionProjection } from "./runtime/workflow-result.js";
import { notifyOperator } from "../_shared/operator/operator-notify.js";

/**
 * One custom message type carries both run-boundary records. The name says what
 * the block is (one workflow run) instead of when it was emitted; `details
 * .eventKind` separates the opening banner from the closing digest. It stays a
 * single declared surface: the manifest lists one customType, not two.
 */
export const WORKFLOW_RUN_CUSTOM_TYPE = "locus-workflow-run";
const TRANSCRIPT_AGENT_ROW_LIMIT = 20;
const TRANSCRIPT_LINE_MAX_CHARS = 160;
const TRANSCRIPT_RULE_WIDTH = 64;
const TRANSCRIPT_ANSWER_MAX_CHARS = 96;

export type WorkflowTranscriptSurfaceMode = "command" | "tool";

export interface WorkflowTranscriptAnnouncement {
  eventKind: "workflow_start";
  runId: string;
  text: string;
}

export interface WorkflowTranscriptCompletion {
  eventKind: "workflow_end";
  runId: string;
  digest: string;
  lineCount: number;
}

export interface WorkflowTranscriptOptions {
  /** Semantic run input. On a continuation run this is the operator's answer. */
  input?: string;
}

export interface WorkflowTranscript {
  /** Returns the run-boundary banner for surfaces that can publish one. */
  start(runId: string, runDir?: string): WorkflowTranscriptAnnouncement | undefined;
  event(line: WorkflowJournalLine): void;
  finish(res: RunWorkflowScriptResult): WorkflowTranscriptCompletion;
}

interface PendingAgentRow {
  index: number;
  agent: string;
  label: string;
  replayed: boolean;
}

/**
 * Buffer lifecycle safely for the current Pi surface. Neither command nor tool
 * mode sends messages from inside the run loop. Tool mode returns the digest in
 * its native result; command mode publishes an idle-checked start banner and,
 * after the run settles, one post-idle digest.
 *
 * Each agent occupies one row for the whole run: the row is written when the
 * agent starts and rewritten in place when it ends. An agent whose end never
 * arrives keeps an explicit evidence-missing row and is never silently folded
 * into a success.
 */
export function createWorkflowTranscript(
  ctx: ExtensionContext,
  targetLabel: string,
  surface: WorkflowTranscriptSurfaceMode,
  options: WorkflowTranscriptOptions = {},
): WorkflowTranscript {
  const safeTarget = safeTranscriptTarget(targetLabel);
  let startedAt: number | undefined;
  let announced = false;
  let agentRowCount = 0;
  let currentPhase: string | undefined;
  let replaySourceRunId: string | undefined;
  let lastJournalError: string | undefined;
  let completion: WorkflowTranscriptCompletion | undefined;
  const bodyLines: string[] = [];
  const pendingAgents = new Map<string, PendingAgentRow>();
  const pushLine = (content: string): number => {
    bodyLines.push(compactTranscriptText(content));
    return bodyLines.length - 1;
  };
  return {
    start(id, runDir) {
      if (announced) return undefined;
      announced = true;
      startedAt = Date.now();
      return {
        eventKind: "workflow_start",
        runId: id,
        text: [
          workflowRunRule(safeTarget, id, "started", startedAt),
          "● workflow started · live progress in the panel below · /ps opens the agent fleet",
          ...(runDir === undefined ? [] : [`runDir: ${runDir}`]),
        ].join("\n"),
      };
    },
    event(line) {
      // The runtime states the replay source once, on its own resume log line.
      // Capturing it here is what lets every replayed row name its source run
      // instead of the anonymous "a recorded run" the digest used to print.
      if (line.resumeFromRunId !== undefined && line.resumeFromRunId !== "") replaySourceRunId = line.resumeFromRunId;
      if (line.kind === "phase") {
        const phase = (line.phase ?? "").trim();
        if (phase !== "") currentPhase = compactTranscriptText(phase);
        return;
      }
      if (line.kind === "agent_start" || line.kind === "agent_end") {
        recordAgentRow(line);
        if (surface === "command") {
          for (const warning of line.evidenceWarnings ?? []) {
            if (warning.trim() !== "")
              notifyOperator(ctx, `⚠ agent evidence · ${compactTranscriptText(warning)}`, "warning");
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
      // An agent that started and never ended must not disappear into a green
      // run: its row states outright that the evidence is missing.
      for (const [, pending] of pendingAgents) {
        bodyLines[pending.index] = compactTranscriptText(
          `■ agent ${pending.agent} started${
            pending.label !== "" ? ` — ${pending.label}` : ""
          } — no end recorded (evidence missing)`,
        );
      }
      pendingAgents.clear();
      const disposition = projectWorkflowDisposition(
        {
          ok: res.ok,
          result: res.result,
          ...(res.error !== undefined ? { error: res.error } : {}),
          ...(res.disposition !== undefined ? { disposition: res.disposition } : {}),
        },
        lastJournalError,
      );
      // A failed run reused recorded evidence just as much as a successful one,
      // and a model reading only the last line must not have to infer it from
      // the per-agent markers above — which the row cap can drop.
      const replayedPart =
        replayedCount > 0 ? [`${replayedCount} replayed from ${replaySourceLabel(res.resumeFromRunId)}`] : [];
      // The terminal marker already says "awaiting operator"; the shared summary
      // repeats it for surfaces that have no marker. Saying it twice in one line
      // is exactly the duplication this digest exists to remove.
      const summary = disposition.summary.startsWith("awaiting operator · ")
        ? disposition.summary.slice("awaiting operator · ".length)
        : disposition.summary;
      const parts = [
        formatWorkflowTerminalLifecycle(safeTarget, disposition),
        compactTranscriptText(summary),
        ...((disposition.status === "completed" || disposition.status === "awaiting_operator") && agentCount > 0
          ? [`${agentCount} agent${agentCount === 1 ? "" : "s"}`]
          : []),
        ...replayedPart,
      ];
      if (disposition.status === "awaiting_operator") {
        bodyLines.push(...formatOperatorWaitBlock(res, currentPhase));
      }
      pushLine([...parts, ...(elapsed !== "" ? [elapsed] : [])].join(" · "));
      // A failed run leaves the transcript with the actionable diagnostic: where
      // it broke, which evidence proves it, and one copyable repair request. These
      // lines skip the 160-char compaction — a truncated path or repair request
      // would be unusable, and the diagnostic is already bounded at its source.
      // The summary above is capped at 160 characters because this digest enters
      // model context. A run whose result is prose therefore has to say where the
      // unabridged text is, and which command shows it — otherwise the operator
      // is left with a sentence fragment and no way forward. A failed run that
      // still produced text needs it just as much as a clean one.
      if (res.resultTextPath !== undefined && res.resultTextPath !== "") {
        bodyLines.push(firstTranscriptLine(`result: ${res.resultTextPath}`));
        bodyLines.push(firstTranscriptLine(`read the full result: /workflows result ${shortWorkflowRunId(res.runId)}`));
      } else if (disposition.status !== "completed") {
        // A run that ended badly and produced NO prose result — a script that
        // returned a structured `{ok:false}` is the common case — used to leave
        // the operator with a 160-character sentence fragment and a journal path.
        // The reason it failed is in the structured result, so this names the one
        // command that prints it. `/workflows result` deliberately refuses a
        // non-prose result, so pointing there would send them to a dead end.
        bodyLines.push(firstTranscriptLine(`read the full reason: /workflows status ${shortWorkflowRunId(res.runId)}`));
      }
      if (res.failureDiagnostic !== undefined) {
        for (const line of formatWorkflowFailureDiagnosticLines(res.failureDiagnostic, { repairRequest: true })) {
          bodyLines.push(firstTranscriptLine(line));
        }
      } else if (res.runDir !== undefined && res.runDir !== "") {
        bodyLines.push(firstTranscriptLine(`journal: ${path.join(res.runDir, "journal.ndjson")}`));
      }
      const headerLines = [
        workflowRunRule(safeTarget, res.runId, terminalStamp(disposition.status), Date.now()),
        ...formatContinuationLine(res, options.input),
      ];
      completion = {
        eventKind: "workflow_end",
        runId: res.runId,
        digest: [...headerLines, ...bodyLines].join("\n"),
        lineCount: bodyLines.length,
      };
      return completion;
    },
  };

  function recordAgentRow(line: WorkflowJournalLine): void {
    const key = agentRowKey(line);
    const agent = compactTranscriptText(line.agent ?? "agent");
    const label = line.label === undefined ? "" : compactTranscriptText(line.label);
    const replayed = line.replayed === true;
    if (line.kind === "agent_start") {
      if (agentRowCount >= TRANSCRIPT_AGENT_ROW_LIMIT) return;
      agentRowCount += 1;
      const index = pushLine(formatWorkflowAgentLifecycle(line, replaySourceRunId));
      pendingAgents.set(key, { index, agent, label, replayed });
      return;
    }
    const pending = pendingAgents.get(key);
    if (pending !== undefined) {
      // One row per agent: the started row becomes the finished row in place, so
      // the reader never meets the same agent twice.
      bodyLines[pending.index] = compactTranscriptText(formatWorkflowAgentLifecycle(line, replaySourceRunId));
      pendingAgents.delete(key);
      return;
    }
    if (agentRowCount >= TRANSCRIPT_AGENT_ROW_LIMIT) return;
    agentRowCount += 1;
    pushLine(formatWorkflowAgentLifecycle(line, replaySourceRunId));
  }
}

/**
 * Stable identity for one concrete agent attempt. `callId` is runtime-owned and
 * unique per attempt; the fallback keeps a loop's rounds in separate rows rather
 * than collapsing a retry onto its predecessor.
 */
function agentRowKey(line: WorkflowJournalLine): string {
  if (line.callId !== undefined && line.callId !== "") return `call:${line.callId}`;
  return `slot:${line.agent ?? ""}|${line.label ?? ""}|${line.slotKey ?? ""}|${line.round ?? ""}`;
}

function replaySourceLabel(resumeFromRunId: string | undefined): string {
  if (resumeFromRunId === undefined || resumeFromRunId === "") return "a recorded run";
  return `run #${shortWorkflowRunId(resumeFromRunId)}`;
}

/**
 * The run boundary the operator asked for: a rule that opens every block, names
 * the workflow, its run, and when the block was written. Two runs in one
 * scrollback are therefore self-separating without any styling, which this
 * surface does not have.
 */
function workflowRunRule(target: string, runId: string, stamp: string, at: number): string {
  const head = `── workflow ${target} · run #${shortWorkflowRunId(runId)} · ${stamp} ${clockStamp(at)} `;
  const fill = Math.max(3, TRANSCRIPT_RULE_WIDTH - head.length);
  return `${head}${"─".repeat(fill)}`;
}

function terminalStamp(status: WorkflowDispositionProjection["status"]): string {
  switch (status) {
    case "completed":
      return "finished";
    case "awaiting_operator":
      return "paused";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "ended";
  }
}

function clockStamp(at: number): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function shortWorkflowRunId(runId: string): string {
  const compact = runId.replace(/[^a-zA-Z0-9]/gu, "");
  if (compact === "") return runId;
  return compact.slice(-4);
}

/**
 * A continuation run is legible on its own: it names the run it continues and
 * the answer that unblocked it. The questions stay in the source run's block,
 * which is directly above this one in the same scrollback.
 */
function formatContinuationLine(res: RunWorkflowScriptResult, input: string | undefined): string[] {
  const originRunId = res.continuation?.originRunId;
  if (originRunId === undefined || originRunId === "") return [];
  const answer = (input ?? "").trim();
  const answerPart = answer === "" ? "" : ` · operator answered: "${compactTranscriptText(truncateAnswer(answer))}"`;
  return [firstTranscriptLine(`↳ continues run #${shortWorkflowRunId(originRunId)}${answerPart}`)];
}

function truncateAnswer(value: string): string {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length <= TRANSCRIPT_ANSWER_MAX_CHARS ? line : `${line.slice(0, TRANSCRIPT_ANSWER_MAX_CHARS - 3)}...`;
}

/**
 * The moment a human is blocking the run gets its own block: blank lines, an
 * indent, and the vocabulary's only upper-case phrase. This surface has no
 * colour, so weight has to come from structure.
 *
 * Attribution is what the envelope actually records. It carries no asking-agent
 * field, so the block names the stage that was current at the gate and the tool
 * that opened it, and never guesses an agent from adjacency.
 */
function formatOperatorWaitBlock(res: RunWorkflowScriptResult, currentPhase: string | undefined): string[] {
  const handoff = res.operatorHandoff;
  if (handoff === undefined) return [];
  const lines = ["", `◐ WAITING FOR OPERATOR — ${compactTranscriptText(handoff.title)}`];
  const context = [
    ...(currentPhase !== undefined ? [`asked during stage "${currentPhase}"`] : []),
    "via awaitOperator",
  ];
  lines.push(`   ${context.join(" · ")}`);
  for (const [index, question] of handoff.questions.entries()) {
    lines.push(`   Q${index + 1}: ${compactTranscriptText(question.prompt)}`);
  }
  lines.push(`   answer: pending — reply in Pi to continue (handoff #${shortWorkflowRunId(handoff.originRunId)})`);
  lines.push("");
  return lines;
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
 *
 * Replayed work carries its own marker rather than a success glyph plus a
 * suffix: a reader scanning the left column must not read recorded evidence as
 * work this run performed.
 */
function formatWorkflowAgentLifecycle(line: WorkflowJournalLine, replaySourceRunId?: string): string {
  const agent = compactTranscriptText(line.agent ?? "agent");
  const label = line.label === undefined ? "" : compactTranscriptText(line.label);
  const labelPart = label !== "" ? ` — ${label}` : "";
  const replayed = line.replayed === true;
  const replayedFrom = replayed ? ` from ${replaySourceLabel(line.resumeFromRunId ?? replaySourceRunId)}` : "";
  if (line.kind === "agent_start") {
    return `● agent ${agent} started${replayed ? " (replay)" : ""}${labelPart}`;
  }
  const elapsed = formatDuration(line.durationMs);
  const elapsedPart = elapsed !== "" ? ` · ${elapsed}` : "";
  if (replayed) {
    return `↻ agent ${agent} replayed${replayedFrom}${elapsedPart}${labelPart}`;
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
  return `${lifecycle.marker} agent ${agent} ${lifecycle.verb}${elapsedPart}${labelPart}`;
}

/**
 * Publish the run-boundary banner at launch. The command path has just proven
 * `ctx.isIdle()`, but the operator can submit a prompt between that check and
 * the first journal event, so the check is repeated synchronously immediately
 * before the send: Pi routes `sendMessage` to `agent.steer()` while streaming,
 * despite `triggerTurn:false`. A busy session simply gets no banner — the live
 * widget still shows the run — and never a steered parent agent.
 */
export function announceCommandWorkflowStart(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  announcement: WorkflowTranscriptAnnouncement,
  isCurrent: () => boolean = () => true,
): boolean {
  if (!isCurrent()) return false;
  if (typeof ctx.isIdle !== "function" || !ctx.isIdle()) return false;
  if (typeof pi.sendMessage !== "function") return false;
  const message: ExtensionMessage = {
    customType: WORKFLOW_RUN_CUSTOM_TYPE,
    content: announcement.text,
    display: true,
    details: { eventKind: announcement.eventKind, runId: announcement.runId },
  };
  try {
    // No await between the idle check above and this call.
    void pi.sendMessage(message, { triggerTurn: false });
    return true;
  } catch {
    return false;
  }
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
    customType: WORKFLOW_RUN_CUSTOM_TYPE,
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
  if (isCurrent()) notifyOperator(ctx, message, "warning");
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
