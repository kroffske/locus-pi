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
import { workflowExtensionRootDir } from "./workflow-run-layout.js";

const OUTPUT_COMPONENT_SOURCE = "[A-Za-z0-9][A-Za-z0-9._-]{0,199}";
const OUTPUT_COMPONENT = new RegExp(`^${OUTPUT_COMPONENT_SOURCE}$`, "u");
/** TypeBox-compatible grammar for the same confined path accepted by the runtime. */
export const WORKFLOW_OUTPUT_DIR_PATTERN = `^(?:${OUTPUT_COMPONENT_SOURCE})(?:/(?:${OUTPUT_COMPONENT_SOURCE}))*$`;
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

/** Resolve and create a confined project-relative output directory. */
export function resolveWorkflowOutputDirectory(
  projectRoot: string,
  requested: string | undefined,
  workflowName: string,
  workingDirectory: string,
): WorkflowOutputDirectory {
  const defaultPath = defaultWorkflowOutputDir(projectRoot, workingDirectory, workflowName);
  const relativePath = requested === undefined ? defaultPath : assertRelativeOutputPath(requested);
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(root, ...relativePath.split("/"));
  if (!isWorkflowPathWithinRoot(root, absolutePath)) throw new Error("workflow outputDir escapes the project root");
  ensureDirectoryWithoutSymlinks(root, absolutePath);
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
      mkdirSync(leaseDir);
      try {
        writeNewDurableJson(path.join(leaseDir, "owner.json"), record, { syncParentDirectory: true });
      } catch (error) {
        removeLeaseDirectory(leaseDir);
        throw error;
      }
      return { projectRoot, stateDir, leaseDir, record };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const current = readLeaseRecordDuringAcquisition(leaseDir);
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
      try {
        renameSync(leaseDir, staleDir);
      } catch (renameError) {
        if (isNodeError(renameError, "ENOENT")) continue;
        throw renameError;
      }
      removeLeaseDirectory(staleDir);
    }
  }
  throw new Error(
    `workflow outputDir lease contention did not settle for ${JSON.stringify(input.output.relativePath)}`,
  );
}

export function assertWorkflowRootLease(lease: WorkflowRootLease): void {
  const current = readLeaseRecord(lease.leaseDir);
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
  unlinkSync(path.join(lease.leaseDir, "owner.json"));
  rmdirSync(lease.leaseDir);
}

export function readWorkflowCompletedCheckpoint(
  lease: WorkflowRootLease,
  identity: WorkflowCheckpointIdentity,
): WorkflowCompletedCheckpoint | undefined {
  assertWorkflowRootLease(lease);
  const file = checkpointFile(lease, identity);
  if (!existsSync(file)) return undefined;
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
  const record: WorkflowCompletedCheckpoint = {
    schema: CHECKPOINT_SCHEMA,
    status: "completed",
    parentScriptSha256: input.parentScriptSha256,
    childScriptSha256: input.childScriptSha256,
    outputDir: input.outputDir,
    itemKey: input.itemKey,
    childRunId: input.childRunId,
    completedAt: new Date().toISOString(),
    ...(input.primaryFile === undefined ? {} : { primaryFile: input.primaryFile }),
  };
  const file = checkpointFile(lease, input);
  ensureDirectoryWithoutSymlinks(lease.projectRoot, path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeNewDurableJson(temporary, record);
  assertWorkflowRootLease(lease);
  renameSync(temporary, file);
  fsyncDirectory(path.dirname(file));
  return record;
}

export function workflowOutputStateDir(projectRoot: string, canonicalOutputIdentity: string): string {
  const namespace = createHash("sha256").update(canonicalOutputIdentity).digest("hex");
  return path.join(workflowExtensionRootDir(path.resolve(projectRoot)), "workflow-state", "v1", namespace);
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

function assertRelativeOutputPath(value: string, label = "outputDir"): string {
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

function readLeaseRecord(leaseDir: string): WorkflowLeaseRecord {
  const file = path.join(leaseDir, "owner.json");
  let value: unknown;
  try {
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
function readLeaseRecordDuringAcquisition(leaseDir: string): WorkflowLeaseRecord | undefined {
  let lastError: unknown;
  for (let attempt = 0; attempt < LEASE_OWNER_READ_ATTEMPTS; attempt += 1) {
    try {
      return readLeaseRecord(leaseDir);
    } catch (error) {
      lastError = error;
      if (!existsSync(leaseDir)) return undefined;
      if (attempt + 1 < LEASE_OWNER_READ_ATTEMPTS) {
        Atomics.wait(LEASE_OWNER_READ_WAIT, 0, 0, LEASE_OWNER_READ_RETRY_MS);
      }
    }
  }
  throw lastError;
}

function quarantineWorkflowCheckpoint(lease: WorkflowRootLease, file: string): void {
  assertWorkflowRootLease(lease);
  const stale = `${file}.stale-${randomUUID()}`;
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

function removeLeaseDirectory(directory: string): void {
  const owner = path.join(directory, "owner.json");
  if (existsSync(owner)) unlinkSync(owner);
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
  return (
    record.schema === CHECKPOINT_SCHEMA &&
    record.status === "completed" &&
    typeof record.parentScriptSha256 === "string" &&
    typeof record.childScriptSha256 === "string" &&
    typeof record.outputDir === "string" &&
    typeof record.itemKey === "string" &&
    typeof record.childRunId === "string" &&
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
