/**
 * workflow-run-layout.ts — the complete path and confinement contract for one workflow run.
 *
 * Automatic evidence for one workflow run lives under
 * `<projectRoot>/.locus-pi/runs/<runId>/`. This module owns the split
 * between two directories that are addressed by name:
 *
 *   - `outputs/` — the human-readable documents and exact terminal answer the
 *     runtime materializes when the run finishes.
 *   - `runtime/` — journal, replay, result envelope, script snapshot and exact
 *     evidence. Humans can inspect it, but no file there is a deliverable.
 *
 * Fresh workflow workspaces live separately under
 * `<projectRoot>/.locus-pi/plans/`; workflow-output owns their selected leaf
 * and confinement while this module owns the shared storage components.
 *
 * This module also owns path discipline for the artifact store: the run id must
 * be a safe component and no element below the physical project root may be a
 * symlink. Checks happen before creation, so a symlinked `.locus-pi` receives nothing.
 */

import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import path from "node:path";

export const WORKFLOW_ROOT_DIRNAME = ".locus-pi";
export const WORKFLOW_RUNS_DIRNAME = "runs";
export const WORKFLOW_PLANS_DIRNAME = "plans";
export const WORKFLOW_LEGACY_ROOT_DIRNAME = ".pi";
export const WORKFLOW_LEGACY_EXTENSION_DIRNAME = "locus-pi";
export const WORKFLOW_LEGACY_RUNS_DIRNAMES = ["runs", "workflows"] as const;
export const WORKFLOW_RUN_OUTPUTS_DIRNAME = "outputs";
export const WORKFLOW_RUN_RUNTIME_DIRNAME = "runtime";
export const WORKFLOW_RUN_ARTIFACTS_DIRNAME = "artifacts";
export const WORKFLOW_RUN_JOURNAL_FILENAME = "journal.ndjson";
export const WORKFLOW_SAFE_COMPONENT_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
export const WORKFLOW_RUN_STORAGE_PATTERN = ".locus-pi/runs/<runId>/";
export const WORKFLOW_PLANS_STORAGE_PREFIX = ".locus-pi/plans/";

const WORKFLOW_RUN_COMPONENT_REGEX = new RegExp(WORKFLOW_SAFE_COMPONENT_PATTERN, "u");
const TASK_WORKSPACE_TARGET_NAMES = new Set(["task/draft", "task/plan"]);

/** One owner for the Package task workflows that create or reuse planning evidence. */
export function isTaskWorkspaceName(workflowName: string): boolean {
  return TASK_WORKSPACE_TARGET_NAMES.has(workflowName);
}

export function workflowRootDir(projectRoot: string): string {
  return path.join(projectRoot, WORKFLOW_ROOT_DIRNAME);
}

export function workflowRunsRootDir(projectRoot: string): string {
  return path.join(workflowRootDir(projectRoot), WORKFLOW_RUNS_DIRNAME);
}

/** Validate one run id before it can select any run-owned filesystem evidence. */
export function assertWorkflowRunId(runId: unknown): string {
  if (typeof runId !== "string" || !WORKFLOW_RUN_COMPONENT_REGEX.test(runId)) {
    throw new Error(`Invalid workflow run id: ${workflowRunIdDescription(runId)}`);
  }
  return runId;
}

export function workflowRunDir(projectRoot: string, runId: string): string {
  return workflowRunDirectoryWithin(workflowRunsRootDir(projectRoot), runId);
}

export function workflowLegacyRunDir(projectRoot: string, runId: string, dirname: string = "runs"): string {
  const legacyRoot = path.join(projectRoot, WORKFLOW_LEGACY_ROOT_DIRNAME, WORKFLOW_LEGACY_EXTENSION_DIRNAME, dirname);
  return workflowRunDirectoryWithin(legacyRoot, runId);
}

/** Return a migration message without reading or mutating retired run evidence. */
export function workflowLegacyRunMigrationMessage(projectRoot: string, runId: string): string | undefined {
  try {
    assertWorkflowRunId(runId);
    const lexicalProjectRoot = path.resolve(projectRoot);
    const physicalProjectRoot = realpathSync(lexicalProjectRoot);
    for (const dirname of WORKFLOW_LEGACY_RUNS_DIRNAMES) {
      const legacyRunDir = workflowLegacyRunDir(lexicalProjectRoot, runId, dirname);
      const expectedPhysicalLegacyRunDir = workflowLegacyRunDir(physicalProjectRoot, runId, dirname);
      assertExistingChainIsRegular(physicalProjectRoot, expectedPhysicalLegacyRunDir);
      const legacyStat = lstatSync(legacyRunDir, { throwIfNoEntry: false });
      if (legacyStat === undefined || legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) continue;
      if (realpathSync(legacyRunDir) !== expectedPhysicalLegacyRunDir) continue;
      return (
        `Workflow run ${runId} uses the retired storage location ${legacyRunDir}. ` +
        `This version reads only ${workflowRunDir(projectRoot, runId)}; inspect or remove the old local evidence manually.`
      );
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function workflowRunOutputsDir(runDir: string): string {
  return path.join(runDir, WORKFLOW_RUN_OUTPUTS_DIRNAME);
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

/** Return one validated file directly below a run's runtime evidence directory. */
export function workflowRunRuntimeFile(runDir: string, fileName: string): string {
  if (!WORKFLOW_RUN_COMPONENT_REGEX.test(fileName)) {
    throw new Error(`Invalid workflow runtime file name: ${JSON.stringify(fileName)}`);
  }
  const filePath = path.join(workflowRunRuntimeDir(runDir), fileName);
  assertWorkflowRunFilePath(runDir, filePath, false);
  return filePath;
}

/** Read one regular file without following a replaced run directory or file symlink. */
export function readWorkflowRunFile(runDir: string, filePath: string): Buffer {
  assertWorkflowRunFilePath(runDir, filePath, true);
  const descriptor = openWorkflowRunFile(runDir, filePath, constants.O_RDONLY);
  try {
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function readWorkflowRunTextFile(runDir: string, filePath: string): string {
  return readWorkflowRunFile(runDir, filePath).toString("utf8");
}

/** Write one regular run-owned file after rechecking the full path immediately before I/O. */
export function writeWorkflowRunFile(
  runDir: string,
  filePath: string,
  bytes: string | NodeJS.ArrayBufferView,
  options: { durable?: boolean; exclusive?: boolean } = {},
): void {
  assertWorkflowRunFilePath(runDir, filePath, false);
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (options.exclusive === true ? constants.O_EXCL : 0);
  const descriptor = openSync(filePath, flags, 0o666);
  try {
    verifyOpenedWorkflowRunFile(runDir, filePath, descriptor);
    if (options.exclusive !== true) ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, bytes);
    if (options.durable === true) fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function appendWorkflowRunTextFile(runDir: string, filePath: string, text: string): void {
  assertWorkflowRunFilePath(runDir, filePath, false);
  const descriptor = openSync(
    filePath,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o666,
  );
  try {
    verifyOpenedWorkflowRunFile(runDir, filePath, descriptor);
    appendFileSync(descriptor, text, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

export function chmodWorkflowRunFile(runDir: string, filePath: string, mode: number): void {
  assertWorkflowRunFilePath(runDir, filePath, true);
  const descriptor = openWorkflowRunFile(runDir, filePath, constants.O_RDONLY);
  try {
    fchmodSync(descriptor, mode);
  } finally {
    closeSync(descriptor);
  }
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

/** Check one run-owned path without letting an unsafe ancestor read as "missing". */
export function workflowRunFileExists(runDir: string, filePath: string): boolean {
  try {
    return assertWorkflowRunFilePath(runDir, filePath, false);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/** Return one run-owned file's modification time after central path validation. */
export function workflowRunFileMtimeMs(runDir: string, filePath: string): number | undefined {
  if (!assertWorkflowRunFilePath(runDir, filePath, false)) return undefined;
  const stat = lstatSync(filePath, { throwIfNoEntry: false });
  return stat?.mtimeMs;
}

/** List only the canonical physical runs root; unsafe evidence roots are rejected. */
export function readWorkflowRunsDirectory(projectRoot: string): Dirent[] {
  const runsRoot = assertCanonicalWorkflowRunsRoot(projectRoot);
  return readdirSync(runsRoot, { withFileTypes: true });
}

/** Create the canonical run root. Throws before creation through an unsafe chain. */
export function ensureWorkflowRunDir(projectRoot: string, runId: string): string {
  const runDir = ensureCanonicalRunDirectory(projectRoot, runId);
  for (const dirname of [WORKFLOW_RUN_OUTPUTS_DIRNAME, WORKFLOW_RUN_RUNTIME_DIRNAME]) {
    ensureCanonicalRunSubdirectory(projectRoot, runId, dirname);
  }
  return runDir;
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
  const layout = workflowRunLayoutFromBoundaryRoot(lexicalRoot);
  if (layout !== undefined) assertCanonicalWorkflowRunDirectory(layout);
  mkdirSync(lexicalDirectory, { recursive: true });
  assertExistingChainIsRegular(lexicalRoot, lexicalDirectory);
}

/** Validate one run-owned directory before an external tool receives its path. */
export function assertWorkflowRunDirectoryPath(runDir: string, directory: string, mustExist: boolean): boolean {
  const lexicalRunDir = path.resolve(runDir);
  const lexicalDirectory = path.resolve(directory);
  const relative = path.relative(lexicalRunDir, lexicalDirectory);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workflow run directory escapes its run root.");
  }
  const layout = workflowRunLayoutFromBoundaryRoot(lexicalRunDir);
  if (layout === undefined) throw new Error("Workflow run directory is not canonical workflow evidence.");
  const physicalRunDir = assertCanonicalWorkflowRunDirectory(layout);
  let current = lexicalRunDir;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) {
      if (mustExist) throw new Error(`Workflow run directory is missing: ${current}`);
      return false;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Workflow run directory is unsafe: ${current}`);
    }
    const physicalCurrent = realpathSync(current);
    if (!isContainedPath(physicalRunDir, physicalCurrent)) {
      throw new Error(`Workflow run directory escapes its physical run root: ${current}`);
    }
  }
  return true;
}

function ensureCanonicalRunDirectory(projectRoot: string, runId: string): string {
  assertWorkflowRunId(runId);
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

/** Defense in depth: safe-component validation and root containment remain separate proofs. */
function workflowRunDirectoryWithin(root: string, runId: string): string {
  const safeRunId = assertWorkflowRunId(runId);
  const runDir = path.join(root, safeRunId);
  const relative = path.relative(path.resolve(root), path.resolve(runDir));
  if (relative !== safeRunId || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Workflow run directory escapes its storage root.");
  }
  return runDir;
}

/** Recheck every existing component. Missing intermediate directories are never created here. */
function assertWorkflowRunFilePath(runDir: string, filePath: string, mustExist: boolean): boolean {
  const lexicalRunDir = path.resolve(runDir);
  const lexicalFile = path.resolve(filePath);
  const relative = path.relative(lexicalRunDir, lexicalFile);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workflow file escapes its run root.");
  }
  const layout = workflowRunLayoutFromBoundaryRoot(lexicalRunDir);
  if (layout === undefined) {
    throw new Error("Workflow run root is not inside the canonical workflow evidence layout.");
  }
  const physicalRunDir = assertCanonicalWorkflowRunDirectory(layout);
  assertExistingChainIsRegular(layout.lexicalRunDir, lexicalRunDir);
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
      // Read-side existence probes are deliberately best-effort when a run is
      // only partially persisted. A missing intermediate directory (for
      // example `runtime/` after an interrupted setup) is still a normal
      // "not present" answer; callers that require the file pass `mustExist`
      // and retain the hard failure. Every ancestor above this point has
      // already passed the non-symlink and physical-containment checks, so a
      // symlink or escape cannot be downgraded to false.
      if (mustExist) throw new Error(`Workflow run path is missing: ${current}`);
      const physicalParent = realpathSync(path.dirname(current));
      if (!isContainedPath(physicalRunDir, physicalParent)) {
        throw new Error(`Workflow run path escapes its physical run root: ${current}`);
      }
      return false;
    }
    if (stat.isSymbolicLink() || (isLeaf ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(`Workflow run path is unsafe: ${current}`);
    }
  }
  const physicalFile = realpathSync(lexicalFile);
  if (!isContainedPath(physicalRunDir, physicalFile)) {
    throw new Error(`Workflow run path escapes its physical run root: ${lexicalFile}`);
  }
  return true;
}

function openWorkflowRunFile(runDir: string, filePath: string, flags: number): number {
  const descriptor = openSync(filePath, flags | constants.O_NOFOLLOW);
  try {
    verifyOpenedWorkflowRunFile(runDir, filePath, descriptor);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyOpenedWorkflowRunFile(runDir: string, filePath: string, descriptor: number): void {
  assertWorkflowRunFilePath(runDir, filePath, true);
  const opened = fstatSync(descriptor);
  const selected = lstatSync(filePath);
  if (!opened.isFile() || opened.dev !== selected.dev || opened.ino !== selected.ino) {
    throw new Error(`Workflow run file changed while it was being opened: ${filePath}`);
  }
}

interface WorkflowRunLayout {
  lexicalProjectRoot: string;
  lexicalRunDir: string;
  runId: string;
}

function workflowRunLayoutFromBoundaryRoot(boundaryRoot: string): WorkflowRunLayout | undefined {
  const lexicalBoundaryRoot = path.resolve(boundaryRoot);
  let candidate = lexicalBoundaryRoot;
  for (;;) {
    const runsRoot = path.dirname(candidate);
    const workflowRoot = path.dirname(runsRoot);
    if (path.basename(runsRoot) === WORKFLOW_RUNS_DIRNAME && path.basename(workflowRoot) === WORKFLOW_ROOT_DIRNAME) {
      const runId = path.basename(candidate);
      assertWorkflowRunId(runId);
      const lexicalProjectRoot = path.dirname(workflowRoot);
      if (workflowRunDir(lexicalProjectRoot, runId) !== candidate) {
        throw new Error("Workflow run directory does not match the canonical evidence layout.");
      }
      return { lexicalProjectRoot, lexicalRunDir: candidate, runId };
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

function assertCanonicalWorkflowRunsRoot(projectRoot: string): string {
  const lexicalProjectRoot = path.resolve(projectRoot);
  const physicalProjectRoot = realpathSync(lexicalProjectRoot);
  const projectStat = lstatSync(physicalProjectRoot);
  if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
    throw new Error("Workflow run project root is not a regular directory.");
  }
  const lexicalRunsRoot = workflowRunsRootDir(lexicalProjectRoot);
  const expectedPhysicalRunsRoot = workflowRunsRootDir(physicalProjectRoot);
  assertExistingChainIsRegular(physicalProjectRoot, expectedPhysicalRunsRoot);
  const physicalRunsRoot = realpathSync(lexicalRunsRoot);
  if (physicalRunsRoot !== expectedPhysicalRunsRoot) {
    throw new Error("Workflow runs root escapes the canonical physical project root.");
  }
  return lexicalRunsRoot;
}

function assertCanonicalWorkflowRunDirectory(layout: WorkflowRunLayout): string {
  const lexicalRunsRoot = assertCanonicalWorkflowRunsRoot(layout.lexicalProjectRoot);
  const physicalRunsRoot = realpathSync(lexicalRunsRoot);
  const expectedPhysicalRunDir = workflowRunDirectoryWithin(physicalRunsRoot, layout.runId);
  assertExistingChainIsRegular(physicalRunsRoot, expectedPhysicalRunDir);
  const physicalRunDir = realpathSync(layout.lexicalRunDir);
  if (physicalRunDir !== expectedPhysicalRunDir) {
    throw new Error("Workflow run root escapes the canonical physical runs root.");
  }
  return physicalRunDir;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function workflowRunIdDescription(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return `<${typeof value}>`;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
