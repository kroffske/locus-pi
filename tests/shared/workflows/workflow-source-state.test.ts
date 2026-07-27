import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowSourceStateReader } from "../../../extensions/_shared/workflow-worktree.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

describe("workflow source-state fingerprints", () => {
  it("is deterministic and detects staged, unstaged, and untracked byte changes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-workflow-source-state-"));
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "source-state@example.test");
    git(root, "config", "user.name", "Source State Test");
    writeFileSync(path.join(root, "tracked.txt"), "base\n", "utf8");
    git(root, "add", "tracked.txt");
    git(root, "commit", "--quiet", "-m", "base");

    const reader = createWorkflowSourceStateReader(root);
    const clean = reader.capture();
    expect(reader.capture()).toEqual(clean);
    expect(clean.status).toEqual([]);

    writeFileSync(path.join(root, "tracked.txt"), "unstaged\n", "utf8");
    const unstaged = reader.capture();
    expect(unstaged.fingerprint).not.toBe(clean.fingerprint);
    expect(unstaged.worktreeFingerprint).not.toBe(clean.worktreeFingerprint);

    git(root, "add", "tracked.txt");
    const staged = reader.capture();
    expect(staged.fingerprint).not.toBe(unstaged.fingerprint);
    expect(staged.indexFingerprint).not.toBe(unstaged.indexFingerprint);

    writeFileSync(path.join(root, "untracked.txt"), "first\n", "utf8");
    const untrackedFirst = reader.capture();
    writeFileSync(path.join(root, "untracked.txt"), "second\n", "utf8");
    const untrackedSecond = reader.capture();
    expect(untrackedSecond.status).toEqual(untrackedFirst.status);
    expect(untrackedSecond.fingerprint).not.toBe(untrackedFirst.fingerprint);
  });

  it("distinguishes successive unstaged submodule HEAD positions", () => {
    const source = mkdtempSync(path.join(tmpdir(), "locus-workflow-submodule-source-"));
    git(source, "init", "--quiet");
    git(source, "config", "user.email", "source-state@example.test");
    git(source, "config", "user.name", "Source State Test");
    writeFileSync(path.join(source, "tracked.txt"), "base\n", "utf8");
    git(source, "add", "tracked.txt");
    git(source, "commit", "--quiet", "-m", "base");

    const root = mkdtempSync(path.join(tmpdir(), "locus-workflow-source-state-parent-"));
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "source-state@example.test");
    git(root, "config", "user.name", "Source State Test");
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", source, "vendor/module");
    git(root, "commit", "--quiet", "-am", "add submodule");

    const reader = createWorkflowSourceStateReader(root);
    const clean = reader.capture();
    const checkout = path.join(root, "vendor", "module");
    git(checkout, "config", "user.email", "source-state@example.test");
    git(checkout, "config", "user.name", "Source State Test");

    writeFileSync(path.join(checkout, "tracked.txt"), "recorded-head dirty first\n", "utf8");
    const recordedHeadDirtyFirst = reader.capture();
    writeFileSync(path.join(checkout, "tracked.txt"), "recorded-head dirty second\n", "utf8");
    const recordedHeadDirtySecond = reader.capture();

    expect(recordedHeadDirtySecond.status).toEqual(recordedHeadDirtyFirst.status);
    expect(recordedHeadDirtySecond.worktreeFingerprint).not.toBe(recordedHeadDirtyFirst.worktreeFingerprint);
    expect(recordedHeadDirtySecond.fingerprint).not.toBe(recordedHeadDirtyFirst.fingerprint);

    git(checkout, "checkout", "--", "tracked.txt");
    writeFileSync(path.join(checkout, "tracked.txt"), "first move\n", "utf8");
    git(checkout, "add", "tracked.txt");
    git(checkout, "commit", "--quiet", "-m", "first move");
    const firstMove = reader.capture();

    writeFileSync(path.join(checkout, "tracked.txt"), "second move\n", "utf8");
    git(checkout, "add", "tracked.txt");
    git(checkout, "commit", "--quiet", "-m", "second move");
    const secondMove = reader.capture();

    expect(firstMove.status).toEqual(secondMove.status);
    expect(firstMove.indexFingerprint).toBe(secondMove.indexFingerprint);
    expect(firstMove.worktreeFingerprint).not.toBe(clean.worktreeFingerprint);
    expect(secondMove.worktreeFingerprint).not.toBe(firstMove.worktreeFingerprint);
    expect(secondMove.fingerprint).not.toBe(firstMove.fingerprint);

    writeFileSync(path.join(checkout, "tracked.txt"), "dirty first\n", "utf8");
    const dirtyFirst = reader.capture();
    writeFileSync(path.join(checkout, "tracked.txt"), "dirty second\n", "utf8");
    const dirtySecond = reader.capture();

    expect(dirtySecond.head).toBe(dirtyFirst.head);
    expect(dirtySecond.status).toEqual(dirtyFirst.status);
    expect(dirtySecond.worktreeFingerprint).not.toBe(dirtyFirst.worktreeFingerprint);
    expect(dirtySecond.fingerprint).not.toBe(dirtyFirst.fingerprint);
  });
});
