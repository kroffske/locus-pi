import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface WorkflowWorktreeInfo {
  id: string;
  path: string;
}

export interface WorkflowWorktreeOptions {
  projectRoot: string;
  runId: string;
  safeCallId: string;
  baseDir?: string;
}

export function createWorkflowWorktree(options: WorkflowWorktreeOptions): WorkflowWorktreeInfo {
  const repoRoot = resolveGitRepoRoot(options.projectRoot);
  const baseDir = options.baseDir ?? path.join(options.projectRoot, ".locus", "runtime", "workflows", options.runId, "worktrees");
  mkdirSync(baseDir, { recursive: true });
  const id = safePathSegment(options.safeCallId);
  const target = path.join(baseDir, id);
  try {
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", target, "HEAD"], {
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

export function safePathSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
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
