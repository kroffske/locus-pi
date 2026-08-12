/**
 * Stable workflow outputs and cross-run coordination.
 *
 * Run evidence remains under the run id. This module owns the separate
 * project-relative user-output namespace, its single-root lease, primary-file
 * references, and atomic completed-item checkpoints.
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
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { assertWorkflowRunId, workflowExtensionRootDir } from "./workflow-run-layout.js";

const OUTPUT_COMPONENT_SOURCE = "[A-Za-z0-9][A-Za-z0-9._-]{0,199}";
const OUTPUT_COMPONENT = new RegExp(`^${OUTPUT_COMPONENT_SOURCE}$`, "u");
/** TypeBox-compatible grammar for the same confined path accepted by the runtime. */
export const WORKFLOW_OUTPUT_DIR_PATTERN = `^(?:${OUTPUT_COMPONENT_SOURCE})(?:/(?:${OUTPUT_COMPONENT_SOURCE}))*$`;
/** Shared aggregate bound for tool, command, and direct runtime callers. */
export const WORKFLOW_OUTPUT_DIR_MAX_CHARS = 400;
const ITEM_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const CHECKPOINT_SCHEMA = "locus-pi.workflow-checkpoint.v1" as const;
const LEASE_SCHEMA = "locus-pi.workflow-output-lease.v1" as const;
const LEASE_OWNER_READ_ATTEMPTS = 20;
const LEASE_OWNER_READ_RETRY_MS = 5;
const LEASE_OWNER_READ_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

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
  readonly leaseDir: string;
  readonly record: WorkflowLeaseRecord;
}

function defaultWorkflowOutputDir(projectRoot: string, workingDirectory: string, workflowBaseName: string): string {
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
  const relativeWorkingDirectory = path.relative(lexicalRoot, lexicalWorkingDirectory).split(path.sep).join("/");
  const prefix = relativeWorkingDirectory === "" ? "tmp" : `${relativeWorkingDirectory}/tmp`;
  if (OUTPUT_COMPONENT.test(workflowBaseName)) return `${prefix}/${workflowBaseName}`;
  const identity = createHash("sha256").update(workflowBaseName).digest("hex");
  return `${prefix}/by-workflow-name/${identity}`;
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
): WorkflowOutputDirectoryPath {
  const defaultPath = defaultWorkflowOutputDir(projectRoot, workingDirectory, workflowName);
  const relativePath = requested === undefined ? defaultPath : assertWorkflowOutputDirPath(requested);
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(root, ...relativePath.split("/"));
  if (!isWorkflowPathWithinRoot(root, absolutePath)) throw new Error("workflow outputDir escapes the project root");
  return { relativePath, absolutePath };
}

/** Resolve and create a confined project-relative output directory. */
export function resolveWorkflowOutputDirectory(
  projectRoot: string,
  requested: string | undefined,
  workflowName: string,
  workingDirectory: string,
  options: { create?: boolean } = {},
): WorkflowOutputDirectory {
  const { relativePath, absolutePath } = resolveWorkflowOutputDirectoryPath(
    projectRoot,
    requested,
    workflowName,
    workingDirectory,
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
  const leaseDir = path.join(stateDir, "lease");
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
      assertWorkflowStatePath(projectRoot, stateDir, leaseDir, "directory", false);
      mkdirSync(leaseDir);
      try {
        const ownerFile = path.join(leaseDir, "owner.json");
        assertWorkflowStatePath(projectRoot, stateDir, leaseDir, "directory", true);
        assertWorkflowStatePath(projectRoot, stateDir, ownerFile, "file", false);
        writeNewDurableJson(ownerFile, record, { syncParentDirectory: true });
      } catch (error) {
        // An owner may have won the mkdir-to-owner-write window. Leave its
        // lease intact so the outer EEXIST path can inspect it.
        if (!isNodeError(error, "EEXIST")) removeLeaseDirectory(projectRoot, stateDir, leaseDir);
        throw error;
      }
      return { projectRoot, stateDir, leaseDir, record };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const current = readLeaseRecordDuringAcquisition(projectRoot, stateDir, leaseDir);
      if (current === undefined) continue;
      const liveness = processLiveness(current.pid);
      if (liveness === "alive") {
        throw new Error(
          `workflow outputDir ${JSON.stringify(input.output.relativePath)} is owned by live run ${current.rootRunId} (pid ${current.pid}); stop that run or choose another outputDir`,
        );
      }
      if (liveness === "unverifiable") {
        throw new Error(
          `workflow outputDir ${JSON.stringify(input.output.relativePath)} has an unverifiable owner pid ${current.pid}; verify the process and remove ${leaseDir} only after proving it stopped`,
        );
      }
      const staleDir = path.join(stateDir, `lease-stale-${randomUUID()}`);
      assertWorkflowStatePath(projectRoot, stateDir, leaseDir, "directory", true);
      assertWorkflowStatePath(projectRoot, stateDir, staleDir, "directory", false);
      try {
        renameSync(leaseDir, staleDir);
      } catch (renameError) {
        if (isNodeError(renameError, "ENOENT")) continue;
        throw renameError;
      }
      removeLeaseDirectory(projectRoot, stateDir, staleDir);
    }
  }
  throw new Error(
    `workflow outputDir lease contention did not settle for ${JSON.stringify(input.output.relativePath)}`,
  );
}

export function assertWorkflowRootLease(lease: WorkflowRootLease): void {
  const current = readLeaseRecord(lease.projectRoot, lease.stateDir, lease.leaseDir);
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
  const ownerFile = path.join(lease.leaseDir, "owner.json");
  assertWorkflowStatePath(lease.projectRoot, lease.stateDir, ownerFile, "file", true);
  unlinkSync(ownerFile);
  assertWorkflowStatePath(lease.projectRoot, lease.stateDir, lease.leaseDir, "directory", true);
  rmdirSync(lease.leaseDir);
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
  return path.join(workflowExtensionRootDir(path.resolve(projectRoot)), "workflow-state", "v1", namespace);
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
    `workflow outputDir ${JSON.stringify(input.relativePath)} already has durable state; ` +
      "choose a new project-relative review namespace or resume the original run",
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

function readLeaseRecord(projectRoot: string, stateDir: string, leaseDir: string): WorkflowLeaseRecord {
  const file = path.join(leaseDir, "owner.json");
  let value: unknown;
  try {
    assertWorkflowStatePath(projectRoot, stateDir, leaseDir, "directory", true);
    assertWorkflowStatePath(projectRoot, stateDir, file, "file", true);
    value = readJson(file);
  } catch (error) {
    throw new Error(
      `workflow output lease owner is unreadable at ${file}; verify no writer is active before manual removal: ${String(error)}`,
    );
  }
  if (!isLeaseRecord(value)) {
    throw new Error(
      `workflow output lease owner is unverifiable at ${file}; verify no writer is active before removal`,
    );
  }
  return value;
}

/** A new owner creates its directory before owner.json; tolerate only that bounded window. */
function readLeaseRecordDuringAcquisition(
  projectRoot: string,
  stateDir: string,
  leaseDir: string,
): WorkflowLeaseRecord | undefined {
  let lastError: unknown;
  for (let attempt = 0; attempt < LEASE_OWNER_READ_ATTEMPTS; attempt += 1) {
    try {
      return readLeaseRecord(projectRoot, stateDir, leaseDir);
    } catch (error) {
      lastError = error;
      if (!assertWorkflowStatePath(projectRoot, stateDir, leaseDir, "directory", false)) return undefined;
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

function removeLeaseDirectory(projectRoot: string, stateDir: string, directory: string): void {
  const owner = path.join(directory, "owner.json");
  assertWorkflowStatePath(projectRoot, stateDir, directory, "directory", true);
  if (assertWorkflowStatePath(projectRoot, stateDir, owner, "file", false)) unlinkSync(owner);
  assertWorkflowStatePath(projectRoot, stateDir, directory, "directory", true);
  rmdirSync(directory);
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
