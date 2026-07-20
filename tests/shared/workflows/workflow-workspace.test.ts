import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowWorkspaceManager } from "../../../extensions/_shared/workflow-worktree.js";

function repository() {
  const root = mkdtempSync(path.join(tmpdir(), "locus-workflow-workspace-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(path.join(root, ".gitignore"), ".locus/\n", "utf8");
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
});
