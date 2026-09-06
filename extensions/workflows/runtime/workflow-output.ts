/**
 * Stable workflow outputs and cross-run coordination.
 *
 * Run evidence remains under the run id. This module owns the separate
 * project-relative user-output namespace, its workspace-local single-root
 * lease, primary-file references, and atomic completed-item checkpoints.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  assertWorkflowRunId,
  workflowRunDir,
  workflowRootDir,
  WORKFLOW_PLANS_DIRNAME,
  WORKFLOW_ROOT_DIRNAME,
  WORKFLOW_WORKSPACES_DIRNAME,
} from "./workflow-run-layout.js";

const OUTPUT_COMPONENT_SOURCE = "[A-Za-z0-9][A-Za-z0-9._-]{0,199}";
const OUTPUT_COMPONENT = new RegExp(`^${OUTPUT_COMPONENT_SOURCE}$`, "u");
const WORKFLOW_LEGACY_WORKSPACES_RELATIVE_ROOT = [WORKFLOW_ROOT_DIRNAME, WORKFLOW_PLANS_DIRNAME].join("/");
const WORKFLOW_WORKSPACES_RELATIVE_ROOT = [WORKFLOW_ROOT_DIRNAME, WORKFLOW_WORKSPACES_DIRNAME].join("/");
/** TypeBox-compatible grammar for the same confined path accepted by the runtime. */
export const WORKFLOW_OUTPUT_DIR_PATTERN =
  `^(?:(?:${OUTPUT_COMPONENT_SOURCE})(?:/(?:${OUTPUT_COMPONENT_SOURCE}))*|` +
  `\\${WORKFLOW_ROOT_DIRNAME}/(?:${WORKFLOW_WORKSPACES_DIRNAME}|${WORKFLOW_PLANS_DIRNAME})/` +
  `(?:${OUTPUT_COMPONENT_SOURCE}))$`;
/** Shared aggregate bound for tool, command, and direct runtime callers. */
export const WORKFLOW_OUTPUT_DIR_MAX_CHARS = 400;
export const WORKFLOW_RUN_NAME_MAX_CHARS = 200;
export const WORKFLOW_RUN_NAME_PATTERN = `^${OUTPUT_COMPONENT_SOURCE}$`;
const ITEM_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const CHECKPOINT_SCHEMA = "locus-pi.workflow-checkpoint.v1" as const;
const LEASE_SCHEMA = "locus-pi.workflow-output-lease.v1" as const;
export const WORKFLOW_OUTPUT_LOCK_FILE = ".locus-pi-workflow.lock";
const LEASE_OWNER_READ_ATTEMPTS = 20;
const LEASE_OWNER_READ_RETRY_MS = 5;
const LEASE_OWNER_READ_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const WORKFLOW_WORKSPACE_RUNS_MARKER = "<!-- locus-pi:workflow-workspace-runs:v1 -->";
const WORKFLOW_WORKSPACE_RUNS_HEADER =
  `${WORKFLOW_WORKSPACE_RUNS_MARKER}\n# Связанные запуски workflow\n\n` +
  `Статусы и история находятся в папках групп; этот файл содержит только ссылки.\n\n`;

class InvalidJsonContentError extends Error {}
class UnstableJsonReadError extends Error {}

export interface WorkflowOutputDirectory {
  /** Project-relative path, with `/` separators. */
  relativePath: string;
  /** Absolute path exposed to filesystem-capable children. */
  absolutePath: string;
  /** Canonical physical target after confined creation. Host coordination only. */
  physicalPath: string;
  /** Canonical project-relative physical identity used for leases and checkpoints. */
  identity: string;
}

/** Host-only source workspace proof used by operator-handoff continuation. */
export interface WorkflowWorkspaceReuseBinding {
  relativePath: string;
  absolutePath: string;
  physicalPath: string;
  physicalIdentity: string;
  explicit: boolean;
}

export interface WorkflowPrimaryFileReference {
  relativePath: string;
  absolutePath: string;
  sha256: string;
  bytes: number;
}

export interface WorkflowCheckpointIdentity {
  parentScriptSha256: string;
  childScriptSha256: string;
  outputDir: string;
  itemKey: string;
}

export interface WorkflowCompletedCheckpoint extends WorkflowCheckpointIdentity {
  schema: typeof CHECKPOINT_SCHEMA;
  status: "completed";
  childRunId: string;
  completedAt: string;
  primaryFile?: WorkflowPrimaryFileReference;
}

interface WorkflowLeaseRecord {
  schema: typeof LEASE_SCHEMA;
  rootRunId: string;
  outputDir: string;
  pid: number;
  fencingToken: string;
  acquiredAt: string;
}

/** Opaque host-only context. Workflow source never receives this object. */
export interface WorkflowRootLease {
  readonly projectRoot: string;
  readonly stateDir: string;
  readonly workspaceDir: string;
  readonly lockFile: string;
  readonly record: WorkflowLeaseRecord;
}

function defaultWorkflowOutputDir(
  projectRoot: string,
  workingDirectory: string,
  workflowName: string,
  runId: string | undefined,
): string {
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalWorkingDirectory = path.resolve(workingDirectory);
  if (!isWorkflowPathWithinRoot(lexicalRoot, lexicalWorkingDirectory)) {
    throw new Error("workflow working directory must be inside the project root");
  }
  let physicalRoot: string;
  let physicalWorkingDirectory: string;
  try {
    physicalRoot = realpathSync(lexicalRoot);
    physicalWorkingDirectory = realpathSync(lexicalWorkingDirectory);
  } catch (error) {
    throw new Error(`workflow working directory physical identity is unavailable: ${String(error)}`);
  }
  if (!isWorkflowPathWithinRoot(physicalRoot, physicalWorkingDirectory)) {
    throw new Error("workflow working directory physical target escapes the project root");
  }
  const workspaceRunId = assertWorkflowRunId(runId);
  const workflowSlug = workflowName.replaceAll("/", "-");
  const readableLeaf = `${workspaceRunId}-${workflowSlug}`;
  const leaf = OUTPUT_COMPONENT.test(readableLeaf)
    ? readableLeaf
    : `${workspaceRunId}-workflow-${createHash("sha256").update(workflowName).digest("hex")}`;
  return `${WORKFLOW_WORKSPACES_RELATIVE_ROOT}/${leaf}`;
}

export interface WorkflowOutputDirectoryPath {
  /** Project-relative path, with `/` separators. */
  relativePath: string;
  /** Absolute lexical path under the project root. */
  absolutePath: string;
}

/** Resolve a confined project-relative output path without touching the filesystem. */
export function resolveWorkflowOutputDirectoryPath(
  projectRoot: string,
  requested: string | undefined,
  workflowName: string,
  workingDirectory: string,
  options: { runId?: string } = {},
): WorkflowOutputDirectoryPath {
  const relativePath =
    requested === undefined
      ? defaultWorkflowOutputDir(projectRoot, workingDirectory, workflowName, options.runId)
      : assertWorkflowOutputDirPath(normalizeRequestedOutputDir(projectRoot, workingDirectory, requested));
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(root, ...relativePath.split("/"));
  if (!isWorkflowPathWithinRoot(root, absolutePath)) throw new Error("workflow outputDir escapes the project root");
  return { relativePath, absolutePath };
}

function workflowWorkspaceLeaf(runName: unknown): string {
  if (typeof runName !== "string" || !OUTPUT_COMPONENT.test(runName)) {
    throw new Error("workflow runName must be one safe folder name");
  }
  return runName;
}

/**
 * Select one named workspace without moving its physical target.
 *
 * Existing legacy workspaces stay under `.locus-pi/plans/`, preserving the
 * physical identity that owns their checkpoint namespace. A name present in
 * both roots is ambiguous and fails before workflow code can run.
 */
export function resolveNamedWorkflowWorkspacePath(projectRoot: string, runName: unknown): string {
  const leaf = workflowWorkspaceLeaf(runName);
  const root = path.resolve(projectRoot);
  const currentRelativePath = `${WORKFLOW_WORKSPACES_RELATIVE_ROOT}/${leaf}`;
  const legacyRelativePath = `${WORKFLOW_LEGACY_WORKSPACES_RELATIVE_ROOT}/${leaf}`;
  const currentPath = path.resolve(root, ...currentRelativePath.split("/"));
  const legacyPath = path.resolve(root, ...legacyRelativePath.split("/"));
  const currentExists = lstatSync(currentPath, { throwIfNoEntry: false }) !== undefined;
  const legacyExists = lstatSync(legacyPath, { throwIfNoEntry: false }) !== undefined;
  if (currentExists && legacyExists) {
    throw new Error(
      `workflow runName ${JSON.stringify(leaf)} is ambiguous: both ${currentRelativePath} and ${legacyRelativePath} exist`,
    );
  }
  return legacyExists ? legacyRelativePath : currentRelativePath;
}

/** Validate one run name without selecting or touching either workspace root. */
export function assertWorkflowRunName(runName: unknown): string {
  return workflowWorkspaceLeaf(runName);
}

/** True only for the retired workspace namespace; callers must never create it. */
export function isLegacyWorkflowWorkspacePath(relativePath: string): boolean {
  return relativePath.startsWith(`${WORKFLOW_LEGACY_WORKSPACES_RELATIVE_ROOT}/`);
}

function normalizeRequestedOutputDir(projectRoot: string, workingDirectory: string, requested: string): string {
  if (typeof requested !== "string") {
    throw new Error("workflow outputDir must be a non-empty trimmed path");
  }
  if (requested.length > WORKFLOW_OUTPUT_DIR_MAX_CHARS) {
    throw new Error(`workflow outputDir exceeds ${WORKFLOW_OUTPUT_DIR_MAX_CHARS} characters`);
  }
  const project = path.resolve(projectRoot);
  let absolute: string | undefined;
  if (path.isAbsolute(requested) || path.win32.isAbsolute(requested)) {
    absolute = path.resolve(requested);
  } else if (requested === "." || requested.startsWith("./") || requested.startsWith("../")) {
    absolute = path.resolve(workingDirectory, requested);
  }
  if (absolute === undefined) return requested;
  if (!isWorkflowPathWithinRoot(project, absolute) || absolute === project) {
    throw new Error("workflow outputDir escapes the project root");
  }
  return path.relative(project, absolute).split(path.sep).join("/");
}

/** Resolve and create a confined project-relative output directory. */
export function resolveWorkflowOutputDirectory(
  projectRoot: string,
  requested: string | undefined,
  workflowName: string,
  workingDirectory: string,
  options: { create?: boolean; runId?: string } = {},
): WorkflowOutputDirectory {
  const { relativePath, absolutePath } = resolveWorkflowOutputDirectoryPath(
    projectRoot,
    requested,
    workflowName,
    workingDirectory,
    options.runId === undefined ? {} : { runId: options.runId },
  );
  const root = path.resolve(projectRoot);
  if (options.create === false) assertExistingDirectoryWithoutSymlinks(root, absolutePath);
  else ensureDirectoryWithoutSymlinks(root, absolutePath);
  let physicalRoot: string;
  let physicalPath: string;
  try {
    physicalRoot = realpathSync(root);
    physicalPath = realpathSync(absolutePath);
  } catch (error) {
    throw new Error(`workflow outputDir physical identity is unavailable: ${String(error)}`);
  }
  if (!isWorkflowPathWithinRoot(physicalRoot, physicalPath)) {
    throw new Error("workflow outputDir physical target escapes the project root");
  }
  const identity = path.relative(physicalRoot, physicalPath).split(path.sep).join("/");
  if (identity === "") throw new Error("workflow outputDir must not resolve to the project root");
  return { relativePath, absolutePath, physicalPath, identity };
}

/** Resolve a previously verified workspace without reclassifying it as public outputDir. */
export function resolveWorkflowOutputDirectoryForReuse(
  projectRoot: string,
  binding: WorkflowWorkspaceReuseBinding,
  options: { create?: boolean } = {},
): WorkflowOutputDirectory {
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(root, ...binding.relativePath.split("/"));
  const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
  if (relativePath === "" || relativePath !== binding.relativePath || !isWorkflowPathWithinRoot(root, absolutePath)) {
    throw new Error("workflow reused workspace identity is not project-relative");
  }
  if (path.resolve(binding.absolutePath) !== absolutePath) {
    throw new Error("workflow reused workspace lexical identity changed");
  }
  if (options.create === false) assertExistingDirectoryWithoutSymlinks(root, absolutePath);
  else ensureDirectoryWithoutSymlinks(root, absolutePath);
  let physicalRoot: string;
  let physicalPath: string;
  try {
    physicalRoot = realpathSync(root);
    physicalPath = realpathSync(absolutePath);
  } catch (error) {
    throw new Error(`workflow reused workspace physical identity is unavailable: ${String(error)}`);
  }
  const identity = path.relative(physicalRoot, physicalPath).split(path.sep).join("/");
  if (!isWorkflowPathWithinRoot(physicalRoot, physicalPath) || identity !== binding.physicalIdentity) {
    throw new Error("workflow reused workspace physical identity changed");
  }
  if (physicalPath !== binding.physicalPath) {
    throw new Error("workflow reused workspace physical target changed");
  }
  return { relativePath, absolutePath, physicalPath, identity };
}

/** Preserve an existing regular workspace file or create it empty without following symlinks. */
export function ensureWorkflowWorkspaceFile(output: WorkflowOutputDirectory, relativeFile: string): string {
  const normalized = assertRelativeOutputPath(relativeFile, "workspace file");
  const absolutePath = path.resolve(output.absolutePath, ...normalized.split("/"));
  if (!isWorkflowPathWithinRoot(output.absolutePath, absolutePath)) {
    throw new Error("workflow workspace file escapes outputDir");
  }

  let fd: number;
  try {
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    try {
      fd = openSync(
        absolutePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o666,
      );
    } catch (createError) {
      if (!isNodeError(createError, "EEXIST")) throw createError;
      fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
  }

  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`workflow workspace file is not a regular file: ${normalized}`);
    const physicalWorkspace = realpathSync(output.absolutePath);
    if (physicalWorkspace !== output.physicalPath) {
      throw new Error("workflow workspace changed while its input file was being opened");
    }
    const selected = lstatSync(absolutePath);
    const physicalFile = realpathSync(absolutePath);
    if (
      selected.isSymbolicLink() ||
      !selected.isFile() ||
      opened.dev !== selected.dev ||
      opened.ino !== selected.ino ||
      !isWorkflowPathWithinRoot(output.physicalPath, physicalFile)
    ) {
      throw new Error(`workflow workspace file changed while it was being opened: ${normalized}`);
    }
  } finally {
    closeSync(fd);
  }
  return absolutePath;
}

export function assertWorkflowItemKey(key: string): string {
  if (typeof key !== "string" || !ITEM_KEY.test(key)) {
    throw new Error(
      "workflow child key must be 1-200 characters using letters, numbers, dot, underscore, colon, or hyphen",
    );
  }
  return key;
}

export function assertUniqueWorkflowItemKeys(keys: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const key of keys) {
    assertWorkflowItemKey(key);
    if (seen.has(key)) throw new Error(`workflow child key is duplicated: ${JSON.stringify(key)}`);
    seen.add(key);
  }
  return Object.freeze([...keys]);
}

/** Validate a regular, non-empty, non-symlink file inside the workflow workspace. */
export function referenceWorkflowPrimaryFile(
  output: WorkflowOutputDirectory,
  relativeFile: string,
): WorkflowPrimaryFileReference {
  const normalized = assertRelativeOutputPath(relativeFile, "primary file");
  const absolutePath = path.resolve(output.absolutePath, ...normalized.split("/"));
  if (!isWorkflowPathWithinRoot(output.absolutePath, absolutePath)) {
    throw new Error("workflow primary file escapes outputDir");
  }
  assertExistingPathWithoutSymlinks(output.absolutePath, absolutePath);
  const fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assertOpenedPrimaryFileIdentity(output, absolutePath, stat);
    if (!stat.isFile()) throw new Error(`workflow primary file is not a regular file: ${normalized}`);
    if (stat.size < 1) throw new Error(`workflow primary file is empty: ${normalized}`);
    const bytes = readFileSync(fd);
    return {
      relativePath: normalized,
      absolutePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    };
  } finally {
    closeSync(fd);
  }
}

/** Re-read a checkpointed primary file and return a current safe reference. */
export function revalidateWorkflowPrimaryFile(
  output: WorkflowOutputDirectory,
  expected: WorkflowPrimaryFileReference,
): WorkflowPrimaryFileReference {
  const current = referenceWorkflowPrimaryFile(output, expected.relativePath);
  if (current.sha256 !== expected.sha256 || current.bytes !== expected.bytes) {
    throw new Error(`workflow primary file changed since checkpoint: ${expected.relativePath}`);
  }
  return current;
}

/** Atomically acquire exclusive ownership of one workflow workspace. */
export function acquireWorkflowRootLease(input: {
  projectRoot: string;
  output: WorkflowOutputDirectory;
  rootRunId: string;
}): WorkflowRootLease {
  const projectRoot = path.resolve(input.projectRoot);
  const stateDir = workflowOutputStateDir(projectRoot, input.output.identity);
  ensureDirectoryWithoutSymlinks(projectRoot, stateDir);
  assertWorkflowStatePath(projectRoot, stateDir, stateDir, "directory", true);
  const workspaceDir = input.output.absolutePath;
  const lockFile = path.join(workspaceDir, WORKFLOW_OUTPUT_LOCK_FILE);
  const record: WorkflowLeaseRecord = {
    schema: LEASE_SCHEMA,
    rootRunId: input.rootRunId,
    outputDir: input.output.relativePath,
    pid: process.pid,
    fencingToken: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      assertWorkflowStatePath(projectRoot, workspaceDir, lockFile, "file", false);
      try {
        writeNewDurableJson(lockFile, record, { syncParentDirectory: true });
      } catch (error) {
        // An owner may have won the create-to-write window. Leave its lock
        // intact so the outer EEXIST path can inspect it.
        if (!isNodeError(error, "EEXIST")) removeLeaseFile(projectRoot, workspaceDir, lockFile);
        throw error;
      }
      return { projectRoot, stateDir, workspaceDir, lockFile, record };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const current = readLeaseRecordDuringAcquisition(projectRoot, workspaceDir, lockFile);
      if (current === undefined) continue;
      const liveness = processLiveness(current.pid);
      if (liveness === "alive") {
        throw new Error(
          `workflow outputDir ${JSON.stringify(input.output.relativePath)} is owned by live run ${current.rootRunId} (pid ${current.pid}); stop that run or choose another outputDir`,
        );
      }
      if (liveness === "unverifiable") {
        throw new Error(
          `workflow outputDir ${JSON.stringify(input.output.relativePath)} has an unverifiable owner pid ${current.pid}; verify the process and remove ${lockFile} only after proving it stopped`,
        );
      }
      const staleFile = `${lockFile}.stale-${randomUUID()}`;
      assertWorkflowStatePath(projectRoot, workspaceDir, lockFile, "file", true);
      assertWorkflowStatePath(projectRoot, workspaceDir, staleFile, "file", false);
      try {
        renameSync(lockFile, staleFile);
      } catch (renameError) {
        if (isNodeError(renameError, "ENOENT")) continue;
        throw renameError;
      }
      removeLeaseFile(projectRoot, workspaceDir, staleFile);
    }
  }
  throw new Error(
    `workflow outputDir lease contention did not settle for ${JSON.stringify(input.output.relativePath)}`,
  );
}

export function assertWorkflowRootLease(lease: WorkflowRootLease): void {
  const current = readLeaseRecord(lease.projectRoot, lease.workspaceDir, lease.lockFile);
  if (
    current.fencingToken !== lease.record.fencingToken ||
    current.rootRunId !== lease.record.rootRunId ||
    current.pid !== lease.record.pid
  ) {
    throw new Error(`workflow output lease fencing token is stale for ${JSON.stringify(lease.record.outputDir)}`);
  }
}

export function releaseWorkflowRootLease(lease: WorkflowRootLease): void {
  assertWorkflowRootLease(lease);
  removeLeaseFile(lease.projectRoot, lease.workspaceDir, lease.lockFile);
}

/** Runtime-owned atomic backlinks. Never replace a pre-existing user document. */
export function writeWorkflowWorkspaceRunLink(
  lease: WorkflowRootLease,
  groupDir: string,
  storageRootRunId: string,
): void {
  assertWorkflowRootLease(lease);
  const file = path.join(lease.workspaceDir, ".workflow-runs.md");
  const href = path.relative(lease.workspaceDir, groupDir).split(path.sep).map(encodeURIComponent).join("/");
  const line = `- [Группа ${assertWorkflowRunId(storageRootRunId)}](${href}/README.md).\n`;
  const exists = assertWorkflowStatePath(lease.projectRoot, lease.workspaceDir, file, "file", false);
  const previous = exists ? readFileSync(file, "utf8") : WORKFLOW_WORKSPACE_RUNS_HEADER;
  if (exists && !previous.startsWith(WORKFLOW_WORKSPACE_RUNS_MARKER + "\n")) {
    throw new Error(`Reserved workflow workspace file already exists: ${file}`);
  }
  if (!validWorkflowWorkspaceRunLinks(previous, lease.projectRoot, lease.workspaceDir)) {
    throw Object.assign(new Error(`Workflow backlink file requires recovery before it can be updated: ${file}`), {
      code: "WORKFLOW_NAVIGATION_RECOVERY_REQUIRED",
    });
  }
  if (previous.split("\n").includes(line.trimEnd())) return;
  assertWorkflowRootLease(lease);
  replaceWorkflowWorkspaceTextFile(lease, file, previous + line);
}

function validWorkflowWorkspaceRunLinks(text: string, projectRoot: string, workspaceDir: string): boolean {
  if (!text.startsWith(WORKFLOW_WORKSPACE_RUNS_HEADER) || !text.endsWith("\n")) return false;
  const links = text.slice(WORKFLOW_WORKSPACE_RUNS_HEADER.length).split("\n").filter(Boolean);
  const groups = new Set<string>();
  for (const link of links) {
    const match = /^- \[Группа ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\]\(([^\r\n()]+)\/README\.md\)\.$/u.exec(link);
    if (match === null || groups.has(match[1]!)) return false;
    const groupId = match[1]!;
    const expectedHref = path
      .relative(workspaceDir, workflowRunDir(projectRoot, groupId))
      .split(path.sep)
      .map(encodeURIComponent)
      .join("/");
    if (match[2] !== expectedHref) return false;
    groups.add(groupId);
  }
  return true;
}

function replaceWorkflowWorkspaceTextFile(lease: WorkflowRootLease, file: string, text: string): void {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  assertWorkflowStatePath(lease.projectRoot, lease.workspaceDir, temporary, "file", false);
  let created = false;
  try {
    writeNewDurableText(temporary, text);
    created = true;
    assertWorkflowRootLease(lease);
    assertWorkflowStatePath(lease.projectRoot, lease.workspaceDir, temporary, "file", true);
    assertWorkflowStatePath(lease.projectRoot, lease.workspaceDir, file, "file", false);
    renameSync(temporary, file);
    created = false;
    fsyncDirectory(path.dirname(file));
  } finally {
    if (created && assertWorkflowStatePath(lease.projectRoot, lease.workspaceDir, temporary, "file", false)) {
      unlinkSync(temporary);
    }
  }
}

export function readWorkflowCompletedCheckpoint(
  lease: WorkflowRootLease,
  identity: WorkflowCheckpointIdentity,
): WorkflowCompletedCheckpoint | undefined {
  assertWorkflowRootLease(lease);
  const file = checkpointFile(lease, identity);
  if (!assertCheckpointPath(lease, file, false)) return undefined;
  let value: unknown;
  try {
    value = readJson(file);
  } catch (error) {
    if (!(error instanceof InvalidJsonContentError)) throw error;
    quarantineWorkflowCheckpoint(lease, file);
    return undefined;
  }
  if (!isCompletedCheckpoint(value) || !sameCheckpointIdentity(value, identity)) {
    quarantineWorkflowCheckpoint(lease, file);
    return undefined;
  }
  assertWorkflowRootLease(lease);
  return value;
}

export function commitWorkflowCompletedCheckpoint(
  lease: WorkflowRootLease,
  input: WorkflowCheckpointIdentity & {
    childRunId: string;
    primaryFile?: WorkflowPrimaryFileReference;
  },
): WorkflowCompletedCheckpoint {
  assertWorkflowRootLease(lease);
  const childRunId = assertWorkflowRunId(input.childRunId);
  const record: WorkflowCompletedCheckpoint = {
    schema: CHECKPOINT_SCHEMA,
    status: "completed",
    parentScriptSha256: input.parentScriptSha256,
    childScriptSha256: input.childScriptSha256,
    outputDir: input.outputDir,
    itemKey: input.itemKey,
    childRunId,
    completedAt: new Date().toISOString(),
    ...(input.primaryFile === undefined ? {} : { primaryFile: input.primaryFile }),
  };
  const file = checkpointFile(lease, input);
  ensureDirectoryWithoutSymlinks(lease.projectRoot, path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  assertCheckpointPath(lease, temporary, false);
  writeNewDurableJson(temporary, record);
  assertWorkflowRootLease(lease);
  assertCheckpointPath(lease, temporary, true);
  assertCheckpointPath(lease, file, false);
  renameSync(temporary, file);
  fsyncDirectory(path.dirname(file));
  return record;
}

export function workflowOutputStateDir(projectRoot: string, canonicalOutputIdentity: string): string {
  const namespace = createHash("sha256").update(canonicalOutputIdentity).digest("hex");
  return path.join(workflowRootDir(path.resolve(projectRoot)), "workflow-state", "v1", namespace);
}

/**
 * Fresh semantic targets must not inherit any prior durable state in a named
 * namespace. This is intentionally opt-in: ordinary workflows retain their
 * historical default/retry behavior, while an owner can reject unsafe fresh
 * reuse before acquiring a lease or reading checkpoints.
 */
export function assertFreshWorkflowOutputNamespace(input: {
  projectRoot: string;
  output: WorkflowOutputDirectory;
}): void {
  assertFreshWorkflowOutputNamespaceIdentity({
    projectRoot: input.projectRoot,
    relativePath: input.output.relativePath,
    identity: input.output.identity,
  });
}

/** Check fresh-owner durable state from a lexical candidate without creating it. */
export function assertFreshWorkflowOutputNamespacePath(input: {
  projectRoot: string;
  output: WorkflowOutputDirectoryPath;
}): void {
  const projectRoot = path.resolve(input.projectRoot);
  const physicalRoot = realpathSync(projectRoot);
  const physicalPath = resolveWorkflowOutputPhysicalPathWithoutCreation(
    projectRoot,
    physicalRoot,
    input.output.absolutePath,
  );
  const identity = path.relative(physicalRoot, physicalPath).split(path.sep).join("/");
  if (identity === "" || identity.startsWith("../") || path.isAbsolute(identity)) {
    throw new Error("workflow outputDir physical target escapes the project root");
  }
  assertFreshWorkflowOutputNamespaceIdentity({
    projectRoot,
    relativePath: input.output.relativePath,
    identity,
  });
}

function assertFreshWorkflowOutputNamespaceIdentity(input: {
  projectRoot: string;
  relativePath: string;
  identity: string;
}): void {
  const projectRoot = path.resolve(input.projectRoot);
  const stateDir = workflowOutputStateDir(projectRoot, input.identity);
  const state = lstatSync(stateDir, { throwIfNoEntry: false });
  if (state === undefined) return;
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error(`workflow outputDir state namespace is not a regular directory: ${stateDir}`);
  }
  const physicalRoot = realpathSync(projectRoot);
  const physicalState = realpathSync(stateDir);
  if (!isWorkflowPathWithinRoot(physicalRoot, physicalState)) {
    throw new Error(`workflow outputDir state namespace escapes the project root: ${stateDir}`);
  }
  throw new Error(
    `workflow workspace ${JSON.stringify(input.relativePath)} already has durable post-code-review state; ` +
      "choose a new --run-name or --output-dir, or resume the original run",
  );
}

function resolveWorkflowOutputPhysicalPathWithoutCreation(
  projectRoot: string,
  physicalRoot: string,
  absolutePath: string,
): string {
  const relative = path.relative(projectRoot, absolutePath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("workflow outputDir escapes the project root");
  }
  let lexicalCurrent = projectRoot;
  let physicalCurrent = physicalRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    lexicalCurrent = path.join(lexicalCurrent, part);
    const stat = lstatSync(lexicalCurrent, { throwIfNoEntry: false });
    if (stat === undefined) {
      return path.join(physicalCurrent, path.basename(lexicalCurrent), path.relative(lexicalCurrent, absolutePath));
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`workflow outputDir is not a regular directory: ${lexicalCurrent}`);
    }
    physicalCurrent = realpathSync(lexicalCurrent);
    if (!isWorkflowPathWithinRoot(physicalRoot, physicalCurrent)) {
      throw new Error("workflow outputDir physical target escapes the project root");
    }
  }
  return physicalCurrent;
}

function checkpointFile(lease: WorkflowRootLease, identity: WorkflowCheckpointIdentity): string {
  assertWorkflowItemKey(identity.itemKey);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([identity.parentScriptSha256, identity.childScriptSha256, identity.outputDir, identity.itemKey]),
    )
    .digest("hex");
  return path.join(lease.stateDir, "checkpoints", `${digest}.json`);
}

type WorkflowStateLeafKind = "file" | "directory";

/** Prove a state path's complete lexical and physical ancestor chain. */
function assertWorkflowStatePath(
  projectRoot: string,
  stateDir: string,
  target: string,
  leafKind: WorkflowStateLeafKind,
  mustExist: boolean,
): boolean {
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalStateDir = path.resolve(stateDir);
  const lexicalFile = path.resolve(target);
  if (!isWorkflowPathWithinRoot(lexicalRoot, lexicalStateDir)) {
    throw new Error("workflow state directory escapes the project root");
  }
  if (!isWorkflowPathWithinRoot(lexicalStateDir, lexicalFile)) {
    throw new Error("workflow state path escapes the leased state directory");
  }

  const rootStat = lstatSync(lexicalRoot, { throwIfNoEntry: false });
  if (rootStat === undefined) {
    throw new Error("workflow state project root is not a regular directory");
  }
  const physicalRoot = realpathSync(lexicalRoot);
  const physicalRootStat = lstatSync(physicalRoot, { throwIfNoEntry: false });
  if (physicalRootStat === undefined || physicalRootStat.isSymbolicLink() || !physicalRootStat.isDirectory()) {
    throw new Error("workflow state project root is not a regular directory");
  }
  const relative = path.relative(lexicalRoot, lexicalFile);
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length === 0) throw new Error("workflow state path must name a leaf");

  let current = lexicalRoot;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const isLeaf = index === parts.length - 1;
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) {
      if (mustExist) throw new Error(`workflow state path is missing: ${current}`);
      return false;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`workflow state path contains a symlink: ${current}`);
    }
    const leafIsWrongType = leafKind === "file" ? !stat.isFile() : !stat.isDirectory();
    if (isLeaf ? leafIsWrongType : !stat.isDirectory()) {
      throw new Error(
        isLeaf
          ? `workflow state path is not a regular ${leafKind}: ${current}`
          : `workflow state path ancestor is not a directory: ${current}`,
      );
    }
    const physicalCurrent = realpathSync(current);
    if (!isWorkflowPathWithinRoot(physicalRoot, physicalCurrent)) {
      throw new Error(`workflow state path escapes the physical project root: ${current}`);
    }
  }
  return true;
}

/**
 * Prove the checkpoint path remains inside the leased project/state namespace.
 * `readJson()` protects the leaf descriptor; this proof protects every path
 * component before any existence probe, open, or quarantine rename.
 */
function assertCheckpointPath(lease: WorkflowRootLease, file: string, mustExist: boolean): boolean {
  return assertWorkflowStatePath(lease.projectRoot, lease.stateDir, file, "file", mustExist);
}

function assertRelativeOutputPath(value: unknown, label = "outputDir"): string {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    throw new Error(`workflow ${label} must be a non-empty trimmed path`);
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`workflow ${label} must be project-relative`);
  }
  if (value.includes("\\")) throw new Error(`workflow ${label} must use forward-slash separators`);
  const parts = value.split("/");
  if (parts.some((part) => !OUTPUT_COMPONENT.test(part))) {
    throw new Error(`workflow ${label} contains an unsafe path component: ${JSON.stringify(value)}`);
  }
  return parts.join("/");
}

/** Validate the complete public outputDir value contract before filesystem access. */
export function assertWorkflowOutputDirPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("workflow outputDir must be a non-empty trimmed path");
  }
  if (value.length > WORKFLOW_OUTPUT_DIR_MAX_CHARS) {
    throw new Error(`workflow outputDir exceeds ${WORKFLOW_OUTPUT_DIR_MAX_CHARS} characters`);
  }
  const workspaceRoot = [WORKFLOW_WORKSPACES_RELATIVE_ROOT, WORKFLOW_LEGACY_WORKSPACES_RELATIVE_ROOT].find(
    (candidate) => value.startsWith(`${candidate}/`),
  );
  if (workspaceRoot !== undefined) {
    const workspaceName = value.slice(workspaceRoot.length + 1);
    if (!OUTPUT_COMPONENT.test(workspaceName)) {
      throw new Error(`workflow outputDir contains an unsafe workspace path component: ${JSON.stringify(value)}`);
    }
    return value;
  }
  return assertRelativeOutputPath(value);
}

/**
 * Validate a physical workspace identity persisted by the runtime.
 *
 * This is deliberately separate from the public `outputDir` grammar: default
 * workspaces inherit verified working-directory components, which may contain
 * spaces or exceed the caller-facing 400-character bound. Physical
 * containment is proved by the resolver before persistence and again by
 * resume/continuation code; this parser only preserves the project-relative
 * representation and rejects path syntax that could escape that proof.
 */
export function assertWorkflowPhysicalWorkspaceIdentity(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new Error("workflow workspace physical identity must be a non-empty project-relative path");
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error("workflow workspace physical identity must be project-relative");
  }
  if (value.includes("\\") || value.includes("\0")) {
    throw new Error("workflow workspace physical identity contains an unsafe path component");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`workflow workspace physical identity contains an unsafe path component: ${JSON.stringify(value)}`);
  }
  return parts.join("/");
}

function ensureDirectoryWithoutSymlinks(root: string, target: string): void {
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`workflow output path contains a symlink: ${current}`);
      if (!stat.isDirectory()) throw new Error(`workflow output path component is not a directory: ${current}`);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      try {
        mkdirSync(current);
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) throw new Error(`workflow output path contains a symlink: ${current}`);
        if (!stat.isDirectory()) throw new Error(`workflow output path component is not a directory: ${current}`);
      }
    }
  }
}

function assertExistingPathWithoutSymlinks(root: string, target: string): void {
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`workflow primary file path contains a symlink: ${current}`);
  }
}

function assertExistingDirectoryWithoutSymlinks(root: string, target: string): void {
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) throw new Error(`workflow outputDir physical identity is unavailable: ${current}`);
    if (stat.isSymbolicLink()) throw new Error(`workflow output path contains a symlink: ${current}`);
    if (!stat.isDirectory()) throw new Error(`workflow output path component is not a directory: ${current}`);
  }
}

function assertOpenedPrimaryFileIdentity(
  output: WorkflowOutputDirectory,
  absolutePath: string,
  opened: ReturnType<typeof fstatSync>,
): void {
  const physicalWorkspace = realpathSync(output.absolutePath);
  if (physicalWorkspace !== output.physicalPath) {
    throw new Error("workflow primary file workspace changed while it was being opened");
  }
  const physicalFile = realpathSync(absolutePath);
  if (!isWorkflowPathWithinRoot(output.physicalPath, physicalFile)) {
    throw new Error("workflow primary file escapes the physical outputDir");
  }
  const selected = lstatSync(absolutePath);
  if (selected.isSymbolicLink() || !selected.isFile() || opened.dev !== selected.dev || opened.ino !== selected.ino) {
    throw new Error(`workflow primary file changed while it was being opened: ${absolutePath}`);
  }
}

function readLeaseRecord(projectRoot: string, workspaceDir: string, lockFile: string): WorkflowLeaseRecord {
  let value: unknown;
  try {
    assertWorkflowStatePath(projectRoot, workspaceDir, lockFile, "file", true);
    value = readJson(lockFile);
  } catch (error) {
    throw new Error(
      `workflow output lease owner is unreadable at ${lockFile}; verify no writer is active before manual removal: ${String(error)}`,
    );
  }
  if (!isLeaseRecord(value)) {
    throw new Error(
      `workflow output lease owner is unverifiable at ${lockFile}; verify no writer is active before removal`,
    );
  }
  return value;
}

/** A new owner creates its lock before durable JSON is complete; tolerate only that bounded window. */
function readLeaseRecordDuringAcquisition(
  projectRoot: string,
  workspaceDir: string,
  lockFile: string,
): WorkflowLeaseRecord | undefined {
  let lastError: unknown;
  for (let attempt = 0; attempt < LEASE_OWNER_READ_ATTEMPTS; attempt += 1) {
    try {
      return readLeaseRecord(projectRoot, workspaceDir, lockFile);
    } catch (error) {
      lastError = error;
      if (!assertWorkflowStatePath(projectRoot, workspaceDir, lockFile, "file", false)) return undefined;
      if (attempt + 1 < LEASE_OWNER_READ_ATTEMPTS) {
        Atomics.wait(LEASE_OWNER_READ_WAIT, 0, 0, LEASE_OWNER_READ_RETRY_MS);
      }
    }
  }
  throw lastError;
}

function quarantineWorkflowCheckpoint(lease: WorkflowRootLease, file: string): void {
  assertWorkflowRootLease(lease);
  assertCheckpointPath(lease, file, true);
  const stale = `${file}.stale-${randomUUID()}`;
  assertCheckpointPath(lease, stale, false);
  try {
    renameSync(file, stale);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  fsyncDirectory(path.dirname(file));
}

function processLiveness(pid: number): "alive" | "dead" | "unverifiable" {
  if (!Number.isSafeInteger(pid) || pid < 1) return "unverifiable";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return "dead";
    return "unverifiable";
  }
}

function removeLeaseFile(projectRoot: string, workspaceDir: string, lockFile: string): void {
  if (assertWorkflowStatePath(projectRoot, workspaceDir, lockFile, "file", false)) unlinkSync(lockFile);
}

function writeNewDurableJson(file: string, value: unknown, options: { syncParentDirectory?: boolean } = {}): void {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (options.syncParentDirectory) fsyncDirectory(path.dirname(file));
}

function writeNewDurableText(file: string, text: string): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readJson(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`JSON state path is not a regular file: ${file}`);
    if (before.size > 1024 * 1024) throw new InvalidJsonContentError(`JSON state file exceeds 1 MiB: ${file}`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) {
        throw new UnstableJsonReadError(`JSON state file changed during read: ${file}`);
      }
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new UnstableJsonReadError(`JSON state file changed during read: ${file}`);
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new InvalidJsonContentError(
        `JSON state file contains invalid JSON: ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

function isLeaseRecord(value: unknown): value is WorkflowLeaseRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<WorkflowLeaseRecord>;
  return (
    record.schema === LEASE_SCHEMA &&
    typeof record.rootRunId === "string" &&
    typeof record.outputDir === "string" &&
    Number.isSafeInteger(record.pid) &&
    typeof record.fencingToken === "string" &&
    typeof record.acquiredAt === "string"
  );
}

function isCompletedCheckpoint(value: unknown): value is WorkflowCompletedCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<WorkflowCompletedCheckpoint>;
  let childRunId: string;
  try {
    childRunId = assertWorkflowRunId(record.childRunId);
  } catch {
    return false;
  }
  return (
    record.schema === CHECKPOINT_SCHEMA &&
    record.status === "completed" &&
    typeof record.parentScriptSha256 === "string" &&
    typeof record.childScriptSha256 === "string" &&
    typeof record.outputDir === "string" &&
    typeof record.itemKey === "string" &&
    record.childRunId === childRunId &&
    typeof record.completedAt === "string" &&
    (record.primaryFile === undefined || isPrimaryFileReference(record.primaryFile))
  );
}

function isPrimaryFileReference(value: unknown): value is WorkflowPrimaryFileReference {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<WorkflowPrimaryFileReference>;
  return (
    typeof record.relativePath === "string" &&
    typeof record.absolutePath === "string" &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(record.sha256) &&
    Number.isSafeInteger(record.bytes) &&
    (record.bytes ?? 0) > 0
  );
}

function sameCheckpointIdentity(
  checkpoint: WorkflowCompletedCheckpoint,
  identity: WorkflowCheckpointIdentity,
): boolean {
  return (
    checkpoint.parentScriptSha256 === identity.parentScriptSha256 &&
    checkpoint.childScriptSha256 === identity.childScriptSha256 &&
    checkpoint.outputDir === identity.outputDir &&
    checkpoint.itemKey === identity.itemKey
  );
}

export function isWorkflowPathWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
