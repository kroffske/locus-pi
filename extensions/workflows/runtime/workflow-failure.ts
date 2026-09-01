/**
 * workflow-failure.ts — Operator-actionable diagnostics for one failed run.
 *
 * A failed run used to surface only the raw thrown sentence (`review inventory
 * has no C<n> coverage headings`), which reads as "the workflow is broken"
 * without saying which stage rejected what, which script owns that contract, or
 * where the evidence sits on disk. This module owns the single projection every
 * failure surface renders — live widget, tool result, operator block, and the
 * persisted `result.json` — plus one copyable repair request an operator can
 * paste into a coding agent verbatim.
 *
 * It states only what the run proved: an absent stage, script, or answer
 * artifact is omitted instead of guessed.
 */

import path from "node:path";
import { workflowRunArtifactsDir } from "./workflow-run-layout.js";
import type { WorkflowJournalLine } from "./workflow-runtime.js";

/** Who failed: trusted script contract vs. the runtime/host around it. */
export type WorkflowFailureOrigin = "script" | "runtime";

export interface WorkflowFailureDiagnostic {
  origin: WorkflowFailureOrigin;
  /** Compacted failure sentence — the thrown message, never a guess. */
  message: string;
  /** Last `phase()` the run reached before failing, when it declared one. */
  stage?: string;
  /** Workflow the operator asked for (`review`, `./x.workflow.mjs`). */
  workflow?: string;
  /** Author-owned script path; project-relative when it lives inside the root. */
  scriptPath?: string;
  /** Failing stage's agent answer, when the run persisted one. */
  evidencePath?: string;
  /** Always present: the run's own journal is written before anything can fail. */
  journalPath: string;
  /** One-line request an operator can copy into a coding agent unchanged. */
  repairRequest: string;
}

export interface BuildWorkflowFailureDiagnosticInput {
  projectRoot: string;
  runDir: string;
  /** The run's journal file, owned by the runtime layout (never guessed here). */
  journalPath: string;
  journal: readonly WorkflowJournalLine[];
  origin?: WorkflowFailureOrigin;
  error?: string;
  target?: { ref?: string };
  scriptIdentity?: { sourcePath?: string };
  artifacts?: readonly { kind: string; stage?: string; relativePath: string }[];
}

const MAX_DIAGNOSTIC_MESSAGE_CHARS = 240;
const MAX_REPAIR_REQUEST_CHARS = 1000;

/**
 * Project one failed run into its actionable diagnostic. Called from the
 * runner's single terminal path, so every failure route gets the same shape.
 */
export function buildWorkflowFailureDiagnostic(input: BuildWorkflowFailureDiagnosticInput): WorkflowFailureDiagnostic {
  const origin = input.origin ?? "runtime";
  const message = compactMessage(input.error) ?? "Workflow execution failed without a reported error.";
  const stage = lastReachedStage(input.journal);
  const workflow = compactMessage(input.target?.ref);
  const scriptPath = relativizePath(input.projectRoot, input.scriptIdentity?.sourcePath);
  const evidencePath = failingAnswerPath(input.projectRoot, input.runDir, input.artifacts ?? [], stage);
  const journalPath = relativizePath(input.projectRoot, input.journalPath) ?? input.journalPath;
  return {
    origin,
    message,
    ...(stage === undefined ? {} : { stage }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(evidencePath === undefined ? {} : { evidencePath }),
    journalPath,
    repairRequest: buildRepairRequest({ origin, message, stage, workflow, scriptPath, evidencePath, journalPath }),
  };
}

/**
 * Reader-facing lines under the failure verdict.
 *
 * `repairRequest: true` appends the whole request as ONE line, for surfaces that
 * wrap text and can be selected (chat message, tool result, operator block). The
 * width-clamped live widget omits it: a truncated repair request is not copyable,
 * so the widget shows pointers only and the message surfaces carry the text.
 */
export function formatWorkflowFailureDiagnosticLines(
  diagnostic: WorkflowFailureDiagnostic,
  options: { repairRequest?: boolean } = {},
): string[] {
  const head = [
    diagnostic.stage === undefined ? undefined : `stage: ${diagnostic.stage}`,
    diagnostic.scriptPath === undefined ? undefined : `script: ${diagnostic.scriptPath}`,
  ].filter((part): part is string => part !== undefined);
  return [
    ...(head.length === 0 ? [] : [head.join(" · ")]),
    ...(diagnostic.evidencePath === undefined ? [] : [`answer: ${diagnostic.evidencePath}`]),
    `journal: ${diagnostic.journalPath}`,
    ...(options.repairRequest === true ? [`copy: ${diagnostic.repairRequest}`] : []),
  ];
}

/** Validated read of a persisted diagnostic; unknown shapes fail closed. */
export function parseWorkflowFailureDiagnostic(value: unknown): WorkflowFailureDiagnostic | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const origin = record.origin === "script" || record.origin === "runtime" ? record.origin : undefined;
  const message = nonEmptyString(record.message);
  const journalPath = nonEmptyString(record.journalPath);
  const repairRequest = nonEmptyString(record.repairRequest);
  if (origin === undefined || message === undefined || journalPath === undefined || repairRequest === undefined) {
    return undefined;
  }
  const stage = nonEmptyString(record.stage);
  const workflow = nonEmptyString(record.workflow);
  const scriptPath = nonEmptyString(record.scriptPath);
  const evidencePath = nonEmptyString(record.evidencePath);
  return {
    origin,
    message,
    ...(stage === undefined ? {} : { stage }),
    ...(workflow === undefined ? {} : { workflow }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(evidencePath === undefined ? {} : { evidencePath }),
    journalPath,
    repairRequest,
  };
}

function buildRepairRequest(parts: {
  origin: WorkflowFailureOrigin;
  message: string;
  stage: string | undefined;
  workflow: string | undefined;
  scriptPath: string | undefined;
  evidencePath: string | undefined;
  journalPath: string;
}): string {
  const subject = parts.workflow === undefined ? "this workflow" : `the "${parts.workflow}" workflow`;
  const where = parts.stage === undefined ? "" : ` at stage "${parts.stage}"`;
  const lead =
    parts.origin === "script"
      ? `Fix ${subject}: its script rejected the run${where} — ${parts.message}`
      : `Diagnose ${subject}: the workflow runtime failed${where} — ${parts.message}`;
  const sentences = [
    `${stripTrailingPeriod(lead)}.`,
    parts.scriptPath === undefined ? undefined : `Script: ${parts.scriptPath}.`,
    parts.evidencePath === undefined ? undefined : `Failing stage answer: ${parts.evidencePath}.`,
    `Run journal: ${parts.journalPath}.`,
  ].filter((sentence): sentence is string => sentence !== undefined);
  return truncateText(sentences.join(" "), MAX_REPAIR_REQUEST_CHARS);
}

function lastReachedStage(journal: readonly WorkflowJournalLine[]): string | undefined {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const line = journal[index];
    if (line?.kind !== "phase") continue;
    const stage = nonEmptyString(line.phase);
    if (stage !== undefined) return stage;
  }
  return undefined;
}

/**
 * The answer the failing stage produced, when the run persisted one. Prefers an
 * answer recorded for the failing stage and otherwise falls back to the newest
 * answer — a script that validates a handoff fails right after receiving it.
 */
function failingAnswerPath(
  projectRoot: string,
  runDir: string,
  artifacts: readonly { kind: string; stage?: string; relativePath: string }[],
  stage: string | undefined,
): string | undefined {
  const answers = artifacts.filter((record) => record.kind === "answer");
  const forStage = stage === undefined ? [] : answers.filter((record) => record.stage === stage);
  const record = forStage.at(-1) ?? answers.at(-1);
  if (record === undefined) return undefined;
  // `relativePath` is written relative to the artifacts directory, not to the
  // run directory. Joining it onto `runDir` printed a pointer that resolves to
  // nothing, so the operator's first move after a failure hit a missing file.
  return relativizePath(projectRoot, path.join(workflowRunArtifactsDir(runDir), record.relativePath));
}

/** Project-relative when the path is inside the root; the absolute path otherwise. */
function relativizePath(projectRoot: string, target: string | undefined): string | undefined {
  const absolute = nonEmptyString(target);
  if (absolute === undefined) return undefined;
  const relative = path.relative(projectRoot, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return absolute;
  return relative;
}

function compactMessage(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text === undefined ? undefined : truncateText(text, MAX_DIAGNOSTIC_MESSAGE_CHARS);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/gu, " ").trim();
  return trimmed === "" ? undefined : trimmed;
}

function stripTrailingPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;
}
