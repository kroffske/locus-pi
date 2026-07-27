import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Stats } from "node:fs";

const MAX_SOURCE_STATE_BYTES = 64 * 1024 * 1024;
const SOURCE_STATE_CHUNK_BYTES = 64 * 1024;

export interface WorkflowSourceState {
  schema: "locus.workflow-source-state.v1";
  fingerprint: string;
  head: string;
  indexFingerprint: string;
  worktreeFingerprint: string;
  status: string[];
}

export interface WorkflowSourceStateReader {
  capture(): WorkflowSourceState;
}

export function createWorkflowSourceStateReader(projectRoot: string): WorkflowSourceStateReader {
  let repoRoot: string | undefined;
  return {
    capture() {
      repoRoot ??= resolveGitRepoRoot(projectRoot);
      const head = gitOutput(repoRoot, ["rev-parse", "HEAD"]);
      const indexBytes = gitBuffer(repoRoot, ["ls-files", "--stage", "-z"]);
      const indexFingerprint = digest(indexBytes);
      const worktreeHash = createHash("sha256");
      const statusBytes = gitBuffer(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      updateFramed(worktreeHash, statusBytes);
      const changedPaths = sourceStatePaths(repoRoot);
      let hashedBytes = 0;
      for (const relativePath of changedPaths) {
        assertConfinedGitPath(relativePath);
        updateFramed(worktreeHash, Buffer.from(relativePath, "utf8"));
        const absolutePath = path.join(repoRoot, relativePath);
        const stat = lstatIfPresent(absolutePath);
        if (stat === undefined) {
          updateFramed(worktreeHash, Buffer.from("deleted", "utf8"));
          continue;
        }
        updateFramed(worktreeHash, Buffer.from(`mode:${stat.mode}`, "utf8"));
        if (stat.isSymbolicLink()) {
          updateFramed(worktreeHash, Buffer.from(`symlink:${readlinkSync(absolutePath)}`, "utf8"));
          continue;
        }
        if (stat.isDirectory() && isGitlink(repoRoot, relativePath)) {
          hashedBytes += hashNestedGitWorktree(worktreeHash, absolutePath, MAX_SOURCE_STATE_BYTES - hashedBytes);
          continue;
        }
        if (!stat.isFile()) {
          updateFramed(worktreeHash, Buffer.from(`non-file:${stat.mode}`, "utf8"));
          continue;
        }
        hashedBytes += hashFile(worktreeHash, absolutePath, MAX_SOURCE_STATE_BYTES - hashedBytes);
      }
      const worktreeFingerprint = worktreeHash.digest("hex");
      const status = nulFields(statusBytes);
      const fingerprint = digest(Buffer.from(`${head}\0${indexFingerprint}\0${worktreeFingerprint}`, "utf8"));
      return {
        schema: "locus.workflow-source-state.v1",
        fingerprint,
        head,
        indexFingerprint,
        worktreeFingerprint,
        status,
      };
    },
  };
}

export interface WorkflowWorktreeInfo {
  id: string;
  path: string;
}

export interface WorkflowWorktreeOptions {
  projectRoot: string;
  runId: string;
  safeCallId: string;
  ref?: string;
  baseDir?: string;
}

export function createWorkflowWorktree(options: WorkflowWorktreeOptions): WorkflowWorktreeInfo {
  const repoRoot = resolveGitRepoRoot(options.projectRoot);
  const baseDir =
    options.baseDir ?? path.join(options.projectRoot, ".locus", "runtime", "workflows", options.runId, "worktrees");
  mkdirSync(baseDir, { recursive: true });
  const id = safePathSegment(options.safeCallId);
  const target = path.join(baseDir, id);
  try {
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", target, options.ref ?? "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create git worktree at ${target}: ${message}`);
  }
  if (!existsSync(target)) {
    throw new Error(`Failed to create git worktree at ${target}: target directory was not created.`);
  }
  return { id, path: target };
}

export interface WorkflowWorkspaceEvidence {
  handle: string;
  id: string;
  path: string;
  head: string;
  sourceRef: string;
  originalRepoRoot: string;
  originalHead: string;
}

export interface WorkflowWorkspaceManager {
  allocate(label: string, ref: string): string;
  resolve(handle: string): WorkflowWorkspaceEvidence;
  evidence(): WorkflowWorkspaceEvidence[];
}

export interface WorkflowWorkspaceManagerOptions {
  projectRoot: string;
  runId: string;
}

export function createWorkflowWorkspaceManager(options: WorkflowWorkspaceManagerOptions): WorkflowWorkspaceManager {
  let originalState: { repoRoot: string; head: string; status: string } | undefined;
  const workspaces = new Map<string, WorkflowWorkspaceEvidence>();
  let counter = 0;

  function ensureOriginalState(): { repoRoot: string; head: string; status: string } {
    if (originalState !== undefined) return originalState;
    const repoRoot = resolveGitRepoRoot(options.projectRoot);
    originalState = {
      repoRoot,
      head: gitOutput(repoRoot, ["rev-parse", "HEAD"]),
      status: gitOutput(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    };
    return originalState;
  }

  function verifyOriginalCheckout(): void {
    const original = ensureOriginalState();
    const currentHead = gitOutput(original.repoRoot, ["rev-parse", "HEAD"]);
    const currentStatus = gitOutput(original.repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (currentHead !== original.head || currentStatus !== original.status) {
      throw new Error(
        `Workflow workspace safety check failed: original checkout changed (expected HEAD ${original.head}).`,
      );
    }
  }

  function verifyWorkspace(workspace: WorkflowWorkspaceEvidence): WorkflowWorkspaceEvidence {
    verifyOriginalCheckout();
    if (!existsSync(workspace.path)) {
      throw new Error(`Workflow workspace handle is stale: ${workspace.handle}`);
    }
    const physicalPath = realpathSync(workspace.path);
    if (physicalPath !== workspace.path) {
      throw new Error(`Workflow workspace realpath changed: ${workspace.handle}`);
    }
    const currentHead = gitOutput(workspace.path, ["rev-parse", "HEAD"]);
    if (currentHead !== workspace.head) {
      throw new Error(
        `Workflow workspace HEAD changed for ${workspace.handle}: expected ${workspace.head}, got ${currentHead}`,
      );
    }
    return { ...workspace };
  }

  return {
    allocate(label, ref) {
      verifyOriginalCheckout();
      const original = ensureOriginalState();
      const sourceRef = ref.trim();
      if (sourceRef === "") throw new Error("Workflow workspace ref is required.");
      const head = gitOutput(original.repoRoot, ["rev-parse", "--verify", `${sourceRef}^{commit}`]);
      const ordinal = ++counter;
      const worktree = createWorkflowWorktree({
        projectRoot: original.repoRoot,
        runId: options.runId,
        safeCallId: `${ordinal}-${label}`,
        ref: head,
      });
      const physicalPath = realpathSync(worktree.path);
      const handle = `workflow-workspace:${ordinal}`;
      const workspace: WorkflowWorkspaceEvidence = {
        handle,
        id: worktree.id,
        path: physicalPath,
        head,
        sourceRef,
        originalRepoRoot: original.repoRoot,
        originalHead: original.head,
      };
      workspaces.set(handle, workspace);
      verifyWorkspace(workspace);
      return handle;
    },
    resolve(handle) {
      const workspace = workspaces.get(handle);
      if (workspace === undefined) {
        throw new Error(`Unknown workflow workspace handle: ${handle}`);
      }
      return verifyWorkspace(workspace);
    },
    evidence() {
      return [...workspaces.values()].map((workspace) => verifyWorkspace(workspace));
    },
  };
}

export function safePathSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned === "" ? "worktree" : cleaned.slice(0, 64);
}

export function resolveGitRepoRoot(projectRoot: string): string {
  try {
    const top = execFileSync("git", ["-C", projectRoot, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (top === "") throw new Error("empty git toplevel response");
    return top;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Project root is not a git repository: ${message}`);
  }
}

function gitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Git command failed in ${cwd}: git ${args.join(" ")}: ${message}`);
  }
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "buffer",
      maxBuffer: MAX_SOURCE_STATE_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Git command failed in ${cwd}: git ${args.join(" ")}: ${message}`);
  }
}

function nulFields(bytes: Buffer): string[] {
  const fields = bytes.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isGitlink(repoRoot: string, relativePath: string): boolean {
  const staged = gitBuffer(repoRoot, ["ls-files", "--stage", "-z", "--", relativePath]).toString("utf8");
  return staged.startsWith("160000 ");
}

function hashNestedGitWorktree(hash: ReturnType<typeof createHash>, repoRoot: string, remainingBytes: number): number {
  const head = gitOutput(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  const indexBytes = gitBuffer(repoRoot, ["ls-files", "--stage", "-z"]);
  const statusBytes = gitBuffer(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  updateFramed(hash, Buffer.from(`gitlink-head:${head}`, "utf8"));
  updateFramed(hash, indexBytes);
  updateFramed(hash, statusBytes);

  const changedPaths = sourceStatePaths(repoRoot);
  let hashedBytes = 0;
  for (const relativePath of changedPaths) {
    assertConfinedGitPath(relativePath);
    updateFramed(hash, Buffer.from(relativePath, "utf8"));
    const absolutePath = path.join(repoRoot, relativePath);
    const stat = lstatIfPresent(absolutePath);
    if (stat === undefined) {
      updateFramed(hash, Buffer.from("deleted", "utf8"));
      continue;
    }
    updateFramed(hash, Buffer.from(`mode:${stat.mode}`, "utf8"));
    if (stat.isSymbolicLink()) {
      updateFramed(hash, Buffer.from(`symlink:${readlinkSync(absolutePath)}`, "utf8"));
      continue;
    }
    if (stat.isDirectory() && isGitlink(repoRoot, relativePath)) {
      hashedBytes += hashNestedGitWorktree(hash, absolutePath, remainingBytes - hashedBytes);
      continue;
    }
    if (!stat.isFile()) {
      updateFramed(hash, Buffer.from(`non-file:${stat.mode}`, "utf8"));
      continue;
    }
    hashedBytes += hashFile(hash, absolutePath, remainingBytes - hashedBytes);
  }
  return hashedBytes;
}

function sourceStatePaths(repoRoot: string): string[] {
  const changedPaths = nulFields(
    gitBuffer(repoRoot, ["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z"]),
  );
  const gitlinks = nulFields(gitBuffer(repoRoot, ["ls-files", "--stage", "-z"])).flatMap((entry) => {
    const match = /^160000 [0-9a-f]+ [0-3]\t(.+)$/u.exec(entry);
    return match === null ? [] : [match[1]!];
  });
  return [...new Set([...changedPaths, ...gitlinks])].sort(compareUtf8);
}

function assertConfinedGitPath(relativePath: string): void {
  if (relativePath === "" || path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
    throw new Error(`Git returned an unsafe source-state path: ${relativePath}`);
  }
}

function hashFile(hash: ReturnType<typeof createHash>, filePath: string, remainingBytes: number): number {
  const fd = openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(SOURCE_STATE_CHUNK_BYTES);
  let total = 0;
  try {
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > remainingBytes) {
        throw new Error(`Workflow source state exceeds ${MAX_SOURCE_STATE_BYTES} bytes of changed content.`);
      }
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return total;
}

function updateFramed(hash: ReturnType<typeof createHash>, bytes: Buffer): void {
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lstatIfPresent(filePath: string): Stats | undefined {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
