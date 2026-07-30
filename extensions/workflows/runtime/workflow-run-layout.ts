/**
 * workflow-run-layout.ts — the two directories a person opens inside one run.
 *
 * Everything a workflow run produces lives under
 * `<projectRoot>/.locus/runtime/workflows/<runId>/`. This module owns the split
 * between the two halves of that directory that are addressed by name:
 *
 *   - `files/` — the run's WORKING DIRECTORY. Its path is handed to the workflow
 *     script (`dsl.runFilesDir()`) and spelled out to every child agent, and the
 *     runtime never writes, renames or numbers anything in it. A file an agent
 *     called `plan.md` is `plan.md` here, which is the whole point: the question
 *     text a workflow prints may name a path, and that path has to exist.
 *   - `logs/` — the ordered execution JOURNAL, written by
 *     `workflow-run-report.ts` when the run finishes. Ordinal prefixes belong
 *     here and only here, because "what happened when" is a property of the
 *     journal, not of the files an agent chose to name.
 *
 * The rest of the run directory (journal.ndjson, replay.ndjson, result.json,
 * the script snapshot, `artifacts/`) stays machine-owned and is documented in
 * `docs/runtime/workflow-run-storage.md`.
 *
 * Path discipline matches the artifact store's: the run id must be a safe
 * component and no element of the chain below the physical project root may be
 * a symlink — checked BEFORE anything is created, so a symlinked `.locus` can
 * never have even an empty directory made through it.
 */

import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { ensureWorkflowDirectoryNoSymlink, WORKFLOW_ARTIFACT_COMPONENT_PATTERN } from "./workflow-artifacts.js";
import { workflowRunDir } from "./workflow-journal.js";

export const WORKFLOW_RUN_FILES_DIRNAME = "files";
export const WORKFLOW_RUN_LOGS_DIRNAME = "logs";

const WORKFLOW_RUN_COMPONENT_REGEX = new RegExp(WORKFLOW_ARTIFACT_COMPONENT_PATTERN, "u");

/** Where agent-written files land, under their own names. Derivation only; nothing is created. */
export function workflowRunFilesDir(projectRoot: string, runId: string): string {
  return path.join(workflowRunDir(projectRoot, runId), WORKFLOW_RUN_FILES_DIRNAME);
}

/** Where the ordered run journal is written. Derivation only; nothing is created. */
export function workflowRunLogsDir(projectRoot: string, runId: string): string {
  return path.join(workflowRunDir(projectRoot, runId), WORKFLOW_RUN_LOGS_DIRNAME);
}

/** Create the run working directory and return its physical path. Throws on an unsafe chain. */
export function ensureWorkflowRunFilesDir(projectRoot: string, runId: string): string {
  return ensureCanonicalRunSubdirectory(projectRoot, runId, WORKFLOW_RUN_FILES_DIRNAME);
}

/** Create the run logs directory and return its physical path. Throws on an unsafe chain. */
export function ensureWorkflowRunLogsDir(projectRoot: string, runId: string): string {
  return ensureCanonicalRunSubdirectory(projectRoot, runId, WORKFLOW_RUN_LOGS_DIRNAME);
}

function ensureCanonicalRunSubdirectory(projectRoot: string, runId: string, dirname: string): string {
  if (!WORKFLOW_RUN_COMPONENT_REGEX.test(runId)) {
    throw new Error(`Invalid workflow run id for run directory: ${JSON.stringify(runId)}`);
  }
  const physicalProjectRoot = realpathSync(path.resolve(projectRoot));
  const rootStat = lstatSync(physicalProjectRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Workflow run project root is not a regular directory.");
  }
  const target = path.join(workflowRunDir(physicalProjectRoot, runId), dirname);
  assertExistingChainIsRegular(physicalProjectRoot, target);
  ensureWorkflowDirectoryNoSymlink(physicalProjectRoot, target);
  return target;
}

/** Refuse an unsafe component that already exists, before any mkdir can create through it. */
function assertExistingChainIsRegular(root: string, target: string): void {
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return; // Missing components are created below, inside the same guard.
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Workflow run path is unsafe: ${current}`);
    }
  }
}
