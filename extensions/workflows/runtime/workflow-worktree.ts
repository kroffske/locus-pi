import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { workflowRunDir } from "./workflow-run-paths.js";

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
  const baseDir = options.baseDir ?? path.join(workflowRunDir(options.projectRoot, options.runId), "worktrees");
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
