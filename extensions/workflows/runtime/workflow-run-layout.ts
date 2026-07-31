/**
 * workflow-run-layout.ts — the complete path and confinement contract for one workflow run.
 *
 * Everything a workflow run produces lives under
 * `<projectRoot>/.pi/locus-pi/workflows/<runId>/`. This module owns the split
 * between three directories that are addressed by name:
 *
 *   - `workspace/` — the run's WORKING DIRECTORY. Its path is handed to the workflow
 *     script (`dsl.runWorkspaceDir()`) and spelled out to every child agent, and the
 *     runtime never writes, renames or numbers anything in it. A file an agent
 *     called `plan.md` is `plan.md` here, which is the whole point: the question
 *     text a workflow prints may name a path, and that path has to exist.
 *   - `outputs/` — the human-readable documents and exact terminal answer the
 *     runtime materializes when the run finishes.
 *   - `runtime/` — journal, replay, result envelope, script snapshot and exact
 *     evidence. Humans can inspect it, but no file there is a deliverable.
 *
 * This module also owns path discipline for the artifact store: the run id must
 * be a safe component and no element below the physical project root may be a
 * symlink. Checks happen before creation, so a symlinked `.pi` receives nothing.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const WORKFLOW_RUNTIME_DIRNAME = ".pi";
export const WORKFLOW_EXTENSION_DIRNAME = "locus-pi";
export const WORKFLOW_RUNS_DIRNAME = "workflows";
export const WORKFLOW_RUN_OUTPUTS_DIRNAME = "outputs";
export const WORKFLOW_RUN_WORKSPACE_DIRNAME = "workspace";
export const WORKFLOW_RUN_RUNTIME_DIRNAME = "runtime";
export const WORKFLOW_RUN_ARTIFACTS_DIRNAME = "artifacts";
export const WORKFLOW_RUN_JOURNAL_FILENAME = "journal.ndjson";
export const WORKFLOW_SAFE_COMPONENT_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";

export const WORKFLOW_RUN_WORKSPACE_DIRECTORY = WORKFLOW_RUN_WORKSPACE_DIRNAME;

const WORKFLOW_RUN_COMPONENT_REGEX = new RegExp(WORKFLOW_SAFE_COMPONENT_PATTERN, "u");

export function workflowsRootDir(projectRoot: string): string {
  return path.join(projectRoot, WORKFLOW_RUNTIME_DIRNAME, WORKFLOW_EXTENSION_DIRNAME, WORKFLOW_RUNS_DIRNAME);
}

export function workflowRunDir(projectRoot: string, runId: string): string {
  return path.join(workflowsRootDir(projectRoot), runId);
}

export function workflowRunOutputsDir(runDir: string): string {
  return path.join(runDir, WORKFLOW_RUN_OUTPUTS_DIRNAME);
}

export function workflowRunWorkspaceDir(runDir: string): string {
  return path.join(runDir, WORKFLOW_RUN_WORKSPACE_DIRNAME);
}

export function workflowRunRuntimeDir(runDir: string): string {
  return path.join(runDir, WORKFLOW_RUN_RUNTIME_DIRNAME);
}

export function workflowRunArtifactsDir(runDir: string): string {
  return path.join(workflowRunRuntimeDir(runDir), WORKFLOW_RUN_ARTIFACTS_DIRNAME);
}

export function workflowJournalFile(runDir: string): string {
  return path.join(workflowRunRuntimeDir(runDir), WORKFLOW_RUN_JOURNAL_FILENAME);
}

/** Read one regular file without following a replaced run directory or file symlink. */
export function readWorkflowRunFile(runDir: string, filePath: string): Buffer {
  assertWorkflowRunFilePath(runDir, filePath, true);
  return readFileSync(filePath);
}

export function readWorkflowRunTextFile(runDir: string, filePath: string): string {
  return readWorkflowRunFile(runDir, filePath).toString("utf8");
}

/** Write one regular run-owned file after rechecking the full path immediately before I/O. */
export function writeWorkflowRunFile(
  runDir: string,
  filePath: string,
  bytes: string | NodeJS.ArrayBufferView,
  options: { exclusive?: boolean } = {},
): void {
  assertWorkflowRunFilePath(runDir, filePath, false);
  writeFileSync(filePath, bytes, { flag: options.exclusive === true ? "wx" : "w" });
}

export function appendWorkflowRunTextFile(runDir: string, filePath: string, text: string): void {
  assertWorkflowRunFilePath(runDir, filePath, false);
  appendFileSync(filePath, text, "utf8");
}

export function chmodWorkflowRunFile(runDir: string, filePath: string, mode: number): void {
  assertWorkflowRunFilePath(runDir, filePath, true);
  chmodSync(filePath, mode);
}

export function renameWorkflowRunFile(runDir: string, sourcePath: string, destinationPath: string): void {
  assertWorkflowRunFilePath(runDir, sourcePath, true);
  assertWorkflowRunFilePath(runDir, destinationPath, false);
  renameSync(sourcePath, destinationPath);
}

export function removeWorkflowRunFile(runDir: string, filePath: string): void {
  assertWorkflowRunFilePath(runDir, filePath, true);
  unlinkSync(filePath);
}

/** Create the canonical run root. Throws before creation through an unsafe chain. */
export function ensureWorkflowRunDir(projectRoot: string, runId: string): string {
  const runDir = ensureCanonicalRunDirectory(projectRoot, runId);
  for (const dirname of [WORKFLOW_RUN_OUTPUTS_DIRNAME, WORKFLOW_RUN_WORKSPACE_DIRNAME, WORKFLOW_RUN_RUNTIME_DIRNAME]) {
    ensureCanonicalRunSubdirectory(projectRoot, runId, dirname);
  }
  return runDir;
}

export function ensureWorkflowRunWorkspaceDir(projectRoot: string, runId: string): string {
  return ensureCanonicalRunSubdirectory(projectRoot, runId, WORKFLOW_RUN_WORKSPACE_DIRNAME);
}

export function ensureWorkflowRunOutputsDir(projectRoot: string, runId: string): string {
  return ensureCanonicalRunSubdirectory(projectRoot, runId, WORKFLOW_RUN_OUTPUTS_DIRNAME);
}

export function ensureWorkflowRunRuntimeDir(projectRoot: string, runId: string): string {
  return ensureCanonicalRunSubdirectory(projectRoot, runId, WORKFLOW_RUN_RUNTIME_DIRNAME);
}

function ensureCanonicalRunSubdirectory(projectRoot: string, runId: string, dirname: string): string {
  const runDir = ensureCanonicalRunDirectory(projectRoot, runId);
  const target = path.join(runDir, dirname);
  const lexicalProjectRoot = path.resolve(projectRoot);
  const physicalProjectRoot = realpathSync(lexicalProjectRoot);
  const physicalTarget = path.join(physicalProjectRoot, path.relative(lexicalProjectRoot, target));
  assertExistingChainIsRegular(physicalProjectRoot, physicalTarget);
  ensureWorkflowDirectoryNoSymlink(runDir, target);
  return target;
}

/** Create a confined directory and prove no existing or created component is a symlink. */
export function ensureWorkflowDirectoryNoSymlink(root: string, directory: string): void {
  const lexicalRoot = path.resolve(root);
  const lexicalDirectory = path.resolve(directory);
  const relative = path.relative(lexicalRoot, lexicalDirectory);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workflow directory escapes its run root.");
  }
  if (existsSync(lexicalRoot) && lstatSync(lexicalRoot).isSymbolicLink()) {
    throw new Error("Workflow run root must not be a symlink.");
  }
  mkdirSync(lexicalDirectory, { recursive: true });
  assertExistingChainIsRegular(lexicalRoot, lexicalDirectory);
}

function ensureCanonicalRunDirectory(projectRoot: string, runId: string): string {
  if (!WORKFLOW_RUN_COMPONENT_REGEX.test(runId)) {
    throw new Error(`Invalid workflow run id for run directory: ${JSON.stringify(runId)}`);
  }
  const physicalProjectRoot = realpathSync(path.resolve(projectRoot));
  const rootStat = lstatSync(physicalProjectRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Workflow run project root is not a regular directory.");
  }
  const target = workflowRunDir(physicalProjectRoot, runId);
  assertExistingChainIsRegular(physicalProjectRoot, target);
  ensureWorkflowDirectoryNoSymlink(physicalProjectRoot, target);
  return workflowRunDir(path.resolve(projectRoot), runId);
}

/** Recheck every existing component. Missing intermediate directories are never created here. */
function assertWorkflowRunFilePath(runDir: string, filePath: string, mustExist: boolean): void {
  const lexicalRunDir = path.resolve(runDir);
  const lexicalFile = path.resolve(filePath);
  const relative = path.relative(lexicalRunDir, lexicalFile);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workflow file escapes its run root.");
  }
  const rootStat = lstatSync(lexicalRunDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Workflow run root is not a regular non-symlink directory.");
  }
  const parts = relative.split(path.sep).filter(Boolean);
  let current = lexicalRunDir;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const isLeaf = index === parts.length - 1;
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) {
      if (!isLeaf || mustExist) throw new Error(`Workflow run path is missing: ${current}`);
      return;
    }
    if (stat.isSymbolicLink() || (isLeaf ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Workflow run path is unsafe: ${current}`);
    }
  }
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
