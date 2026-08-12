import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkflowWorktree,
  createWorkflowWorkspaceManager,
} from "../../../extensions/workflows/runtime/workflow-worktree.js";

function repository() {
  const root = mkdtempSync(path.join(tmpdir(), "locus-workflow-workspace-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(path.join(root, ".gitignore"), ".pi/\n", "utf8");
  writeFileSync(path.join(root, "file.txt"), "one\n", "utf8");
  execFileSync("git", ["add", ".gitignore", "file.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "first"], { cwd: root });
  const first = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  writeFileSync(path.join(root, "file.txt"), "two\n", "utf8");
  execFileSync("git", ["commit", "-qam", "second"], { cwd: root });
  const second = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { root, first, second };
}

describe("workflow runtime-owned workspace", () => {
  it("allocates one opaque handle at the requested commit and resolves it repeatedly", () => {
    const repo = repository();
    const manager = createWorkflowWorkspaceManager({
      projectRoot: repo.root,
      runId: "review-fix",
    });

    const handle = manager.allocate("accepted fixes", repo.first);
    const first = manager.resolve(handle);
    const second = manager.resolve(handle);

    expect(handle).toBe("workflow-workspace:1");
    expect(second).toEqual(first);
    expect(first.head).toBe(repo.first);
    expect(first.originalHead).toBe(repo.second);
    expect(first.path).not.toBe(repo.root);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: first.path, encoding: "utf8" }).trim()).toBe(repo.first);
    expect(manager.evidence()).toEqual([first]);
  });

  it("rejects unknown handles without accepting model-reported paths", () => {
    const repo = repository();
    const manager = createWorkflowWorkspaceManager({
      projectRoot: repo.root,
      runId: "review-fix",
    });

    expect(() => manager.resolve("/tmp/model-reported-worktree")).toThrow("Unknown workflow workspace handle");
  });

  it("fails if the original checkout or retained workspace HEAD changes", () => {
    const repo = repository();
    const manager = createWorkflowWorkspaceManager({
      projectRoot: repo.root,
      runId: "review-fix",
    });
    const handle = manager.allocate("accepted fixes", repo.first);
    writeFileSync(path.join(repo.root, "file.txt"), "mutated original\n", "utf8");

    expect(() => manager.resolve(handle)).toThrow("original checkout changed");

    execFileSync("git", ["checkout", "--", "file.txt"], { cwd: repo.root });
    const workspace = manager.resolve(handle);
    execFileSync("git", ["commit", "--allow-empty", "-qm", "unexpected"], {
      cwd: workspace.path,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    expect(() => manager.resolve(handle)).toThrow("workspace HEAD changed");
  });

  it("rejects a symlinked run worktree base before Git can write outside", () => {
    const repo = repository();
    const outside = mkdtempSync(path.join(tmpdir(), "locus-workflow-worktree-outside-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");
    const runtime = path.join(repo.root, ".pi", "locus-pi", "runs", "run-escape", "runtime");
    mkdirSync(runtime, { recursive: true });
    symlinkSync(outside, path.join(runtime, "worktrees"), "dir");

    expect(() =>
      createWorkflowWorktree({ projectRoot: repo.root, runId: "run-escape", safeCallId: "agent-1" }),
    ).toThrow(/symlink|unsafe/u);
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(path.join(runtime, "worktrees"), { force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects an override base outside the run root before Git can write", () => {
    const repo = repository();
    const outside = mkdtempSync(path.join(tmpdir(), "locus-workflow-worktree-override-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");

    expect(() =>
      createWorkflowWorktree({
        projectRoot: repo.root,
        runId: "run-override",
        safeCallId: "agent-1",
        baseDir: outside,
      }),
    ).toThrow(/escapes its run root/u);
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects a symlinked worktree target before Git can replace it", () => {
    const repo = repository();
    const outside = mkdtempSync(path.join(tmpdir(), "locus-workflow-worktree-target-"));
    const sentinel = path.join(outside, "sentinel.txt");
    writeFileSync(sentinel, "do-not-touch\n", "utf8");
    const baseDir = path.join(repo.root, ".pi", "locus-pi", "runs", "run-target", "runtime", "worktrees");
    mkdirSync(baseDir, { recursive: true });
    symlinkSync(outside, path.join(baseDir, "agent-1"), "dir");

    expect(() =>
      createWorkflowWorktree({ projectRoot: repo.root, runId: "run-target", safeCallId: "agent-1" }),
    ).toThrow(/symlink|unsafe/u);
    expect(readFileSync(sentinel, "utf8")).toBe("do-not-touch\n");

    rmSync(path.join(baseDir, "agent-1"), { force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
