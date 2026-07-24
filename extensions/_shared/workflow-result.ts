/**
 * JSON-safe workflow result boundary.
 *
 * Workflow scripts are trusted JavaScript and may return values JSON cannot
 * represent. This module is the single owner for normalization, semantic main
 * projection, bounded raw detail, and result.json persistence.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const WORKFLOW_RESULT_NOT_JSON_SAFE = "WORKFLOW_RESULT_NOT_JSON_SAFE";
export const WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE = "WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE";
export const WORKFLOW_RESULT_WRITE_FAILED = "WORKFLOW_RESULT_WRITE_FAILED";

export type WorkflowDispositionStatus = "completed" | "awaiting_operator" | "cancelled" | "failed";
export type WorkflowCancellationReason = "operator_stop" | "session_shutdown" | "aborted";
export type WorkflowProjectedStatus = WorkflowDispositionStatus | "unknown";

export type WorkflowDisposition =
  | { status: "completed" }
  | { status: "awaiting_operator"; detail: string }
  | { status: "cancelled"; reason: WorkflowCancellationReason }
  | { status: "failed" };

export interface WorkflowDispositionProjection {
  status: WorkflowProjectedStatus;
  summary: string;
}

export interface WorkflowResultDiagnosticSentinel {
  kind: "workflow_result_diagnostic";
  code: typeof WORKFLOW_RESULT_NOT_JSON_SAFE;
  message: string;
}

export interface PreparedWorkflowResult {
  value: unknown;
  diagnostic?: WorkflowResultDiagnosticSentinel;
}

export type WorkflowResultPersistence =
  | { ok: true; path: string }
  | {
      ok: false;
      path: string;
      code: typeof WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE | typeof WORKFLOW_RESULT_WRITE_FAILED;
      message: string;
    };

type JsonSerialization = { ok: true; json: string } | { ok: false; message: string };

export function workflowResultFile(runDir: string): string {
  return path.join(runDir, "result.json");
}

/**
 * Convert one script result into a detached JSON value. Unsupported values get
 * an explicit JSON-safe sentinel; no raw or guessed replacement is fabricated.
 */
export function prepareWorkflowResult(value: unknown): PreparedWorkflowResult {
  const serialized = serializeJson(value);
  if (!serialized.ok) {
    const diagnostic = resultDiagnostic(serialized.message);
    return { value: diagnostic, diagnostic };
  }
  try {
    return { value: JSON.parse(serialized.json) as unknown };
  } catch (error) {
    const diagnostic = resultDiagnostic(`serialized result could not be parsed: ${safeErrorMessage(error)}`);
    return { value: diagnostic, diagnostic };
  }
}

/** Main-surface projection. Never traverses the original script object directly. */
export function formatWorkflowResultSummary(value: unknown): string {
  const prepared = prepareWorkflowResult(value).value;
  if (isWorkflowResultDiagnostic(prepared)) return "result unavailable";
  return workflowResultSummaryFromPrepared(prepared) ?? "completed";
}

/**
 * Decide one new run's durable terminal disposition. The runner calls this
 * after every other evidence owner has had a chance to turn `ok` false.
 */
export function workflowDispositionForCompletion(input: {
  ok: boolean;
  aborted: boolean;
  abortReason?: unknown;
  awaitOperatorReason?: string;
}): WorkflowDisposition {
  if (input.aborted) return { status: "cancelled", reason: workflowCancellationReason(input.abortReason) };
  if (!input.ok) return { status: "failed" };
  const detail = boundedDispositionDetail(input.awaitOperatorReason);
  if (input.awaitOperatorReason !== undefined && detail === undefined) return { status: "failed" };
  if (detail !== undefined) return { status: "awaiting_operator", detail };
  return { status: "completed" };
}

/**
 * Read-side lifecycle projection. A missing disposition is a legacy envelope
 * and retains the old `ok` interpretation. A present but malformed/future
 * disposition fails closed as `unknown`.
 */
export function projectWorkflowDisposition(
  input: {
    ok: boolean;
    result: unknown;
    error?: string;
    disposition?: unknown;
  },
  fallbackError?: string,
): WorkflowDispositionProjection {
  const disposition =
    input.disposition === undefined ? legacyWorkflowDisposition(input.ok) : parseWorkflowDisposition(input.disposition);
  if (disposition === undefined || !dispositionMatchesOk(disposition, input.ok)) {
    return { status: "unknown", summary: "unknown workflow disposition" };
  }
  switch (disposition.status) {
    case "completed":
      return { status: disposition.status, summary: formatWorkflowResultSummary(input.result) };
    case "awaiting_operator":
      return { status: disposition.status, summary: `awaiting operator · ${disposition.detail}` };
    case "cancelled":
      return { status: disposition.status, summary: formatWorkflowCancellationSummary(disposition.reason) };
    case "failed":
      return {
        status: disposition.status,
        summary: formatWorkflowFailureSummary(input.result, input.error, fallbackError),
      };
    default:
      return assertNever(disposition);
  }
}

/** Failure-surface projection. Technical transport/runtime error wins; otherwise
 *  preserve the detached script summary and exact unresolved requirement ids. */
export function formatWorkflowFailureSummary(value: unknown, technicalError?: string, fallbackError?: string): string {
  const technical = nonEmptyString(technicalError);
  if (technical !== undefined) return technical;
  const prepared = prepareWorkflowResult(value).value;
  const semantic = isWorkflowResultDiagnostic(prepared)
    ? "Workflow result unavailable"
    : workflowResultSummaryFromPrepared(prepared);
  const summary = semantic ?? nonEmptyString(fallbackError) ?? "Workflow execution failed.";
  const unresolvedRows = unresolvedRequirementIds(prepared);
  return unresolvedRows.length === 0 ? summary : `${summary} · unresolved: ${unresolvedRows.join(", ")}`;
}

/** A detached script result may explicitly reject or mark partial its domain outcome.
 *  Absence/non-boolean `ok` without `partial:true` keeps legacy success semantics. */
export function isWorkflowResultExplicitFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.ok === false || record.partial === true;
}

/** Bounded raw JSON for explicit status/detail views. Main surfaces must not call this. */
export function formatWorkflowResultDetail(value: unknown, maxChars = 2000): string {
  const prepared = prepareWorkflowResult(value);
  const serialized = serializeJson(prepared.value);
  const json = serialized.ok ? serialized.json : JSON.stringify(resultDiagnostic(serialized.message), null, 2);
  const limit = Math.max(1, Math.floor(maxChars));
  if (json.length <= limit) return json;
  const suffix = "… [truncated; full result in result.json]";
  if (limit <= suffix.length) return suffix.slice(0, limit);
  return `${json.slice(0, limit - suffix.length)}${suffix}`;
}

/** Persist one already-normalized run envelope and report failures to the caller. */
export function writeWorkflowResultJson(runDir: string, payload: unknown): WorkflowResultPersistence {
  const resultPath = workflowResultFile(runDir);
  const serialized = serializeJson(payload);
  if (!serialized.ok) {
    return {
      ok: false,
      path: resultPath,
      code: WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE,
      message: `Workflow result envelope was not persisted: ${serialized.message}`,
    };
  }
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(resultPath, `${serialized.json}\n`, "utf8");
    return { ok: true, path: resultPath };
  } catch (error) {
    return {
      ok: false,
      path: resultPath,
      code: WORKFLOW_RESULT_WRITE_FAILED,
      message: `Workflow result was not persisted: ${safeErrorMessage(error)}`,
    };
  }
}

export function isWorkflowResultDiagnostic(value: unknown): value is WorkflowResultDiagnosticSentinel {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "workflow_result_diagnostic" &&
    record.code === WORKFLOW_RESULT_NOT_JSON_SAFE &&
    typeof record.message === "string"
  );
}

function parseWorkflowDisposition(value: unknown): WorkflowDisposition | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.status === "completed" || record.status === "failed") {
    return keys.length === 1 && keys[0] === "status" ? { status: record.status } : undefined;
  }
  if (record.status === "awaiting_operator") {
    const detail = boundedDispositionDetail(record.detail);
    return keys.length === 2 && keys[0] === "detail" && keys[1] === "status" && detail !== undefined
      ? { status: record.status, detail }
      : undefined;
  }
  if (record.status === "cancelled") {
    const reason = workflowCancellationReasonFromPersisted(record.reason);
    return keys.length === 2 && keys[0] === "reason" && keys[1] === "status" && reason !== undefined
      ? { status: record.status, reason }
      : undefined;
  }
  return undefined;
}

function legacyWorkflowDisposition(ok: boolean): WorkflowDisposition {
  return ok ? { status: "completed" } : { status: "failed" };
}

function dispositionMatchesOk(disposition: WorkflowDisposition, ok: boolean): boolean {
  switch (disposition.status) {
    case "completed":
    case "awaiting_operator":
      return ok;
    case "cancelled":
    case "failed":
      return !ok;
    default:
      return assertNever(disposition);
  }
}

function workflowCancellationReason(value: unknown): WorkflowCancellationReason {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const kind = (value as Record<string, unknown>).kind;
    if (kind === "operator_stop" || kind === "session_shutdown") return kind;
  }
  return "aborted";
}

function workflowCancellationReasonFromPersisted(value: unknown): WorkflowCancellationReason | undefined {
  return value === "operator_stop" || value === "session_shutdown" || value === "aborted" ? value : undefined;
}

function formatWorkflowCancellationSummary(reason: WorkflowCancellationReason): string {
  switch (reason) {
    case "operator_stop":
      return "cancelled by operator";
    case "session_shutdown":
      return "cancelled (session shutdown)";
    case "aborted":
      return "cancelled";
    default:
      return assertNever(reason);
  }
}

function boundedDispositionDetail(value: unknown): string | undefined {
  const detail = nonEmptyString(value);
  if (detail === undefined || detail.length > 200) return undefined;
  return detail;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled workflow disposition: ${String(value)}`);
}

function serializeJson(value: unknown): JsonSerialization {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined)
      return { ok: false, message: "top-level value is undefined or otherwise has no JSON representation" };
    return { ok: true, json };
  } catch (error) {
    return { ok: false, message: safeErrorMessage(error) };
  }
}

function resultDiagnostic(reason: string): WorkflowResultDiagnosticSentinel {
  return {
    kind: "workflow_result_diagnostic",
    code: WORKFLOW_RESULT_NOT_JSON_SAFE,
    message: `Workflow result is unavailable because it is not JSON-safe: ${reason}`,
  };
}

function safeErrorMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const compact = message.replace(/\s+/gu, " ").trim();
    return compact === "" ? "unknown error" : compact.slice(0, 240);
  } catch {
    return "unknown error";
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/gu, " ").trim();
  return trimmed === "" ? undefined : trimmed;
}

function semanticScalar(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  if (text !== undefined) return text;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function workflowResultSummaryFromPrepared(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const summary = nonEmptyString(record.summary);
    if (summary !== undefined) return summary;
    const verdict = semanticScalar(record.verdict);
    if (verdict !== undefined) return verdict;
  }
  return nonEmptyString(value);
}

function unresolvedRequirementIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const rows = (value as Record<string, unknown>).unresolvedRows;
  if (!Array.isArray(rows)) return [];
  return [
    ...new Set(
      rows
        .filter((row): row is string => typeof row === "string")
        .map((row) => row.replace(/\s+/gu, " ").trim())
        .filter((row) => row !== ""),
    ),
  ].sort();
}
