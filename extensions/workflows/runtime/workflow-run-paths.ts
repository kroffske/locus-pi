/**
 * Canonical project-local storage for workflow runs.
 *
 * Pi owns the top-level `.pi/` namespace. `locus-pi/` keeps this extension's
 * state distinct from other Pi extensions, and each run sits directly below
 * `workflows/` so the operator never has to discover a hidden runtime layer.
 */

import path from "node:path";

export const WORKFLOW_RUNTIME_DIRNAME = ".pi";
export const WORKFLOW_EXTENSION_DIRNAME = "locus-pi";
export const WORKFLOW_RUNS_DIRNAME = "workflows";

export function workflowsRootDir(projectRoot: string): string {
  return path.join(projectRoot, WORKFLOW_RUNTIME_DIRNAME, WORKFLOW_EXTENSION_DIRNAME, WORKFLOW_RUNS_DIRNAME);
}

export function workflowRunDir(projectRoot: string, runId: string): string {
  return path.join(workflowsRootDir(projectRoot), runId);
}

export function workflowJournalFile(runDir: string): string {
  return path.join(runDir, "journal.ndjson");
}
