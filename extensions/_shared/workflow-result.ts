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

type JsonSerialization =
  | { ok: true; json: string }
  | { ok: false; message: string };

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
  return unresolvedRows.length === 0
    ? summary
    : `${summary} · unresolved: ${unresolvedRows.join(", ")}`;
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
  const json = serialized.ok
    ? serialized.json
    : JSON.stringify(resultDiagnostic(serialized.message), null, 2);
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
  return record.kind === "workflow_result_diagnostic"
    && record.code === WORKFLOW_RESULT_NOT_JSON_SAFE
    && typeof record.message === "string";
}

function serializeJson(value: unknown): JsonSerialization {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined) return { ok: false, message: "top-level value is undefined or otherwise has no JSON representation" };
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
  return [...new Set(rows
    .filter((row): row is string => typeof row === "string")
    .map((row) => row.replace(/\s+/gu, " ").trim())
    .filter((row) => row !== ""))]
    .sort();
}
