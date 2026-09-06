/**
 * extensions/loop/loop-continuation.ts — What `/loop` and the `loop` tool know about
 * their two continuation sources.
 *
 * Reports which source (goal, workflow, review) can produce a bounded next prompt
 * and renders that report. Nothing here auto-dispatches; workflow continuations
 * are returned inline, never saved or run.
 *
 * The workflow side reads run persistence through `workflows/run-read.js` — the
 * read-only facade — rather than the workflow journal directly, so the loop holds
 * no handle on the journal's sink or its live-row retention.
 */

import path from "node:path";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import {
  goalContinuationPath,
  loadGoalState,
  renderGoalContinuationArtifact,
  type GoalContinuationArtifact,
} from "../_shared/project/goal-mode.js";
import {
  readWorkflowRunSummary,
  resolveWorkflowRunDir,
  resolveWorkflowRunId,
  workflowRunsRootDir,
  type WorkflowRunSummary,
} from "../workflows/run/run-read.js";
import { runtimeStateDir } from "../_shared/host/files.js";

export type LoopSourceKind = "goal" | "workflow" | "review";
export type LoopSourceAvailability = "available" | "blocked" | "missing" | "unsupported";
export type LoopMode = "idle" | "manual" | "blocked";

export interface LoopStatusSourceReport {
  source: LoopSourceKind;
  availability: LoopSourceAvailability;
  reason: string;
  id?: string;
  status?: string;
  path?: string;
  summary?: string;
}

export interface LoopStatusReport {
  mode: LoopMode;
  sources: LoopStatusSourceReport[];
  recommendedSource?: Exclude<LoopSourceKind, "review">;
  recommendedSourceId?: string;
}

export interface LoopWorkflowContinuation {
  version: 1;
  source: "workflow";
  runId: string;
  runStatus: string;
  sourcePath: string;
  prompt: string;
  autoDispatch: false;
  status: "manual";
  stopReason: string;
  createdAt: string;
  maxSteps: 1;
  sourceSummary: string;
}

const LOOP_STOP_REASON = "continuation is a bounded next prompt artifact, not auto-dispatch";
const WORKFLOW_LOOP_STOP_REASON = "workflow continuation is a bounded next prompt, not auto-dispatch";
const LOOP_STATUS_LINE_WIDTH = 80;
const LOOP_STATUS_ID_WIDTH = 20;

export function loopRootPath(projectRoot: string): string {
  return path.join(runtimeStateDir(projectRoot), "loop");
}

export async function readLoopStatus(projectRoot: string): Promise<LoopStatusReport> {
  const sources: LoopStatusSourceReport[] = [];
  const goalState = await loadGoalState(projectRoot);
  const goalSource = await resolveGoalSource(projectRoot, goalState);
  sources.push(goalSource);

  const workflowSource = await resolveWorkflowSource(projectRoot);
  sources.push(workflowSource);

  sources.push({
    source: "review",
    availability: "unsupported",
    reason: "review continuation is not implemented",
  });

  const recommended = sources.find((source) => source.availability === "available" && source.source !== "review");
  const blocked = sources.some((source) => source.availability === "blocked");
  const mode: LoopMode = recommended !== undefined ? "manual" : blocked ? "blocked" : "idle";

  return {
    mode,
    sources,
    ...(recommended !== undefined && recommended.source !== "review" ? { recommendedSource: recommended.source } : {}),
    ...(recommended?.id !== undefined ? { recommendedSourceId: recommended.id } : {}),
  };
}

export function renderLoopStatus(report: LoopStatusReport): string {
  return [
    "Loop continuation",
    `status: ${report.mode}`,
    ...report.sources.map(renderLoopSourceStatus),
    renderLoopNextStep(report),
  ]
    .map(boundStatusLine)
    .join("\n");
}

export function renderLoopSourceStatus(source: LoopStatusSourceReport): string {
  const fields = [`${source.source}: ${source.availability}`];
  if (source.id !== undefined)
    fields.push(
      `${source.source === "workflow" ? "run" : "id"}=${shortenStatusValue(source.id, LOOP_STATUS_ID_WIDTH)}`,
    );
  if (source.status !== undefined) fields.push(`state=${shortenStatusValue(source.status, 14)}`);
  fields.push(renderLoopSourceHint(source));
  return boundStatusLine(fields.join(" | "));
}

function renderLoopNextStep(report: LoopStatusReport): string {
  if (report.recommendedSource === "goal") return "next: /loop once goal";
  if (report.recommendedSource === "workflow") {
    const runId = report.recommendedSourceId;
    if (runId === undefined) return "next: /loop once workflow <runId>";
    if (runId.length <= 36) return `next: /loop once workflow ${runId}`;
    return "next: /loop once workflow <runId> (full id in details)";
  }
  return "next: /goal create <objective> or /workflows run <name>";
}

function renderLoopSourceHint(source: LoopStatusSourceReport): string {
  if (source.source === "review") return "not implemented";
  if (source.source === "goal") {
    if (source.availability === "available") return "once goal";
    if (source.availability === "missing") return "create goal";
    if (source.availability === "blocked") return "create new goal";
    return "not available";
  }
  if (source.availability === "available") return "once workflow";
  if (source.availability === "missing") return "run workflow";
  if (source.availability === "blocked") return "wait for metadata";
  return "not available";
}

function shortenStatusValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const suffixLength = Math.min(6, Math.max(2, Math.floor((maxLength - 3) / 3)));
  const prefixLength = maxLength - suffixLength - 3;
  return `${value.slice(0, prefixLength)}...${value.slice(-suffixLength)}`;
}

function boundStatusLine(line: string): string {
  if (line.length <= LOOP_STATUS_LINE_WIDTH) return line;
  return `${line.slice(0, LOOP_STATUS_LINE_WIDTH - 3)}...`;
}

export async function createWorkflowLoopContinuation(
  projectRoot: string,
  runId: string,
  rawPrompt: string,
): Promise<LoopWorkflowContinuation> {
  const summary = await loadWorkflowContinuationSummary(projectRoot, runId);
  const prompt = buildWorkflowContinuationPrompt(runId, summary, rawPrompt);
  const continuation: LoopWorkflowContinuation = {
    version: 1,
    source: "workflow",
    runId,
    runStatus: summary.status,
    sourcePath: resolveWorkflowRunDir(projectRoot, runId),
    prompt,
    autoDispatch: false,
    status: "manual",
    stopReason: WORKFLOW_LOOP_STOP_REASON,
    createdAt: new Date().toISOString(),
    maxSteps: 1,
    sourceSummary: renderWorkflowSummary(summary),
  };

  return continuation;
}

export function renderLoopWorkflowContinuationResult(continuation: LoopWorkflowContinuation): string {
  return [
    "Loop continuation ready.",
    "source: workflow",
    ...renderLoopWorkflowContinuationMetadata(continuation),
    "sourceSummary:",
    ...boundLoopMetadataLines(continuation.sourceSummary.split(/\r?\n/u)),
    "prompt:",
    continuation.prompt,
  ].join("\n");
}

export function renderGoalLoopContinuationResult(goalArtifact: GoalContinuationArtifact): string {
  return ["Loop continuation saved.", `source: goal`, renderGoalContinuationArtifact(goalArtifact)].join("\n");
}

function renderLoopWorkflowContinuationMetadata(continuation: LoopWorkflowContinuation): string[] {
  return boundLoopMetadataLines([
    `runId: ${continuation.runId}`,
    `runStatus: ${continuation.runStatus}`,
    `autoDispatch: ${continuation.autoDispatch}`,
    `status: ${continuation.status}`,
    `createdAt: ${continuation.createdAt}`,
    `maxSteps: ${continuation.maxSteps}`,
  ]);
}

function boundLoopMetadataLines(lines: string[]): string[] {
  return lines.map((line) => {
    if (line.length <= 80) return line;
    return `${line.slice(0, 77)}...`;
  });
}

async function resolveGoalSource(
  projectRoot: string,
  goalState: Awaited<ReturnType<typeof loadGoalState>>,
): Promise<LoopStatusSourceReport> {
  if (!goalState) {
    return { source: "goal", availability: "missing", reason: "no saved goal state" };
  }

  const { goal } = goalState;
  const status = goal.status;
  if (status === "complete" || status === "dropped") {
    return {
      source: "goal",
      availability: "blocked",
      reason: `goal is ${status}; create a new goal before continuing`,
      id: goal.id,
      status,
      path: goalContinuationPath(projectRoot),
    };
  }

  return {
    source: "goal",
    availability: "available",
    reason: "/goal continue is available for the active goal",
    id: goal.id,
    status,
    path: goalContinuationPath(projectRoot),
  };
}

async function resolveWorkflowSource(projectRoot: string): Promise<LoopStatusSourceReport> {
  const latest = resolveWorkflowRunId(projectRoot, "latest");
  if (latest.status === "not-found") {
    return {
      source: "workflow",
      availability: "missing",
      reason: `no workflow run metadata found under ${workflowRunsRootDir(projectRoot)}`,
    };
  }
  if (latest.status === "ambiguous") {
    return {
      source: "workflow",
      availability: "blocked",
      reason: `latest workflow run is ambiguous across ${latest.matched} executions; use an exact runId`,
    };
  }
  if (latest.status === "legacy") {
    return {
      source: "workflow",
      availability: "blocked",
      reason: latest.message,
      id: latest.runId,
    };
  }
  const latestRunId = latest.runId;

  const summary = readWorkflowRunSummary(projectRoot, latestRunId);
  const hasMetadata = summary.hasJournal === true || summary.hasResult;
  if (!hasMetadata) {
    return {
      source: "workflow",
      availability: "blocked",
      reason: "workflow run folder exists but has no journal/result metadata yet",
      id: latestRunId,
      status: summary.status,
      path: resolveWorkflowRunDir(projectRoot, latestRunId),
    };
  }

  return {
    source: "workflow",
    availability: "available",
    reason: "workflow run metadata is available for /loop once workflow <runId>",
    id: latestRunId,
    status: summary.status,
    path: resolveWorkflowRunDir(projectRoot, latestRunId),
    summary: renderWorkflowSummary(summary),
  };
}

async function loadWorkflowContinuationSummary(projectRoot: string, runId: string): Promise<WorkflowRunSummary> {
  const summary = readWorkflowRunSummary(projectRoot, runId);
  if (summary.hasJournal !== true && !summary.hasResult) {
    throw new Error(`No workflow metadata found for run ${runId}.`);
  }
  return summary;
}

function buildWorkflowContinuationPrompt(runId: string, summary: WorkflowRunSummary, rawPrompt: string): string {
  const trimmed = rawPrompt.trim();
  const parts =
    trimmed === ""
      ? []
      : trimmed
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
  const summaryNote = parts[0] ?? `Summarize workflow ${runId} and propose one bounded follow-up step.`;
  const nextStep = parts[1] ?? "Choose one bounded workflow follow-up and stop.";

  return [
    "Task:",
    `Workflow run ${runId}`,
    "",
    "Draft goal:",
    `Continue workflow ${runId} with one bounded step only.`,
    "",
    "Intent:",
    summaryNote,
    "",
    "Context:",
    `- Run status: ${summary.status}`,
    `- Last phase: ${summary.phase ?? "none"}`,
    `- Agents started: ${summary.agentsStarted}`,
    `- Agents ended: ${summary.agentsEnded}`,
    `- Errors: ${summary.errors}`,
    `- Has result: ${summary.hasResult ? "yes" : "no"}`,
    "- Keep the next prompt short and action-oriented.",
    "- Do not auto-dispatch a child agent or model call.",
    "- Stop after one next step.",
    "",
    "Draft direction:",
    `- In scope: ${nextStep}`,
    "- Out of scope: multi-step plans, background dispatch, or hidden continuation.",
    "- Outcome type: prompt",
    "",
    "Expected result:",
    "- one bounded continuation prompt",
    "",
    "Final result:",
    nextStep,
  ].join("\n");
}

function renderWorkflowSummary(summary: WorkflowRunSummary): string {
  return [
    `status: ${summary.status}`,
    `phase: ${summary.phase ?? "none"}`,
    `agentsStarted: ${summary.agentsStarted}`,
    `agentsEnded: ${summary.agentsEnded}`,
    `errors: ${summary.errors}`,
    `lastKind: ${summary.lastKind ?? "none"}`,
    `lastTs: ${summary.lastTs ?? "none"}`,
    `hasResult: ${summary.hasResult}`,
  ].join("\n");
}
