/**
 * Durable workflow result persistence.
 *
 * Workflow scripts are trusted JavaScript and may return values JSON cannot
 * represent. The rules that decide what a result means — JSON detachment,
 * disposition, classification and formatting — are owned by the fs-free
 * `workflow-outcome.ts`; this module owns the run-local files those rules feed:
 * `runtime/result.json` and the verbatim `outputs/workflow-result.md`.
 */

import path from "node:path";
import {
  ensureWorkflowDirectoryNoSymlink,
  workflowRunOutputsDir,
  workflowRunRuntimeDir,
  writeWorkflowRunFile,
} from "./workflow-run-layout.js";
import { WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE, safeErrorMessage, serializeJson } from "./workflow-outcome.js";

/**
 * The rules half stays importable through this module so a caller that needs
 * both meaning and storage keeps one import. A caller that needs only the rules
 * should import `./workflow-outcome.js` directly.
 */
export {
  WORKFLOW_FINALIZATION_ERROR_MAX_CHARS,
  WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE,
  WORKFLOW_RESULT_NOT_JSON_SAFE,
  classifyWorkflowReturnedFailure,
  formatWorkflowFailureSummary,
  formatWorkflowResultDetail,
  formatWorkflowResultSummary,
  isWorkflowResultDiagnostic,
  isWorkflowResultExplicitFailure,
  prepareWorkflowResult,
  projectWorkflowDisposition,
  workflowDispositionForCompletion,
  workflowFinalizationError,
} from "./workflow-outcome.js";
export type {
  PreparedWorkflowResult,
  WorkflowCancellationReason,
  WorkflowDisposition,
  WorkflowDispositionProjection,
  WorkflowDispositionStatus,
  WorkflowFinalizationError,
  WorkflowFinalizationStage,
  WorkflowProjectedStatus,
  WorkflowResultDiagnosticSentinel,
  WorkflowReturnedFailure,
  WorkflowReturnedFailureKind,
  WorkflowReturnedFailureStatus,
} from "./workflow-outcome.js";

export const WORKFLOW_RESULT_WRITE_FAILED = "WORKFLOW_RESULT_WRITE_FAILED";

export type WorkflowResultPersistence =
  | { ok: true; path: string }
  | {
      ok: false;
      path: string;
      code: typeof WORKFLOW_RESULT_ENVELOPE_NOT_JSON_SAFE | typeof WORKFLOW_RESULT_WRITE_FAILED;
      message: string;
    };

/**
 * The run's terminal text, kept verbatim in its own file.
 *
 * Every live surface for a finished run is bounded on purpose: the chat digest
 * caps a line at 160 characters because it enters model context, and the
 * progress panel clips to the terminal width. A run whose result IS prose — a
 * review, a plan, an answer — therefore had no readable copy anywhere except a
 * one-line JSON string inside `runtime/result.json`. This file is that readable
 * copy under `outputs/`, and
 * it is what `/workflows result` opens.
 */
export function workflowResultTextFile(runDir: string): string {
  return path.join(workflowRunOutputsDir(runDir), "workflow-result.md");
}

/**
 * The verbatim text of a terminal result, or undefined when the result is not
 * text. A structured result is left to `runtime/result.json`, which already pretty-prints
 * it; inventing a prose rendering for it would be a guess, not evidence.
 */
export function workflowResultText(result: unknown): string | undefined {
  if (typeof result !== "string") return undefined;
  return result.trim() === "" ? undefined : result;
}

/** Return undefined on write failure; the runner promotes that to failed finalization. */
export function writeWorkflowResultText(runDir: string, result: unknown): string | undefined {
  const text = workflowResultText(result);
  if (text === undefined) return undefined;
  const resultTextPath = workflowResultTextFile(runDir);
  try {
    ensureWorkflowDirectoryNoSymlink(runDir, path.dirname(resultTextPath));
    writeWorkflowRunFile(runDir, resultTextPath, text.endsWith("\n") ? text : `${text}\n`);
    return resultTextPath;
  } catch {
    return undefined;
  }
}

export function workflowResultFile(runDir: string): string {
  return path.join(workflowRunRuntimeDir(runDir), "result.json");
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
    ensureWorkflowDirectoryNoSymlink(runDir, path.dirname(resultPath));
    writeWorkflowRunFile(runDir, resultPath, `${serialized.json}\n`);
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
