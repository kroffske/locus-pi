import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { evaluatePullRequestPolicy } from "../../scripts/check-pull-request-policy.js";
import { candidateFiles } from "../../scripts/check-public-repository.js";
import { evaluateReleaseMetadata } from "../../scripts/check-release-metadata.js";

const execFileAsync = promisify(execFile);

const releaseHeading = "# Changelog\n\n## [0.3.0] - 2026-07-16\n";

describe("repository pull-request policy", () => {
  it("accepts a task branch into dev when release-relevant changes include a changelog entry", () => {
    expect(
      evaluatePullRequestPolicy({
        baseRef: "dev",
        headRef: "codex/example",
        changedFiles: ["extensions/plan/index.ts", "CHANGELOG.md"],
        baseVersion: "0.2.0",
        headVersion: "0.2.0",
        headChangelog: releaseHeading,
      }),
    ).toEqual([]);
  });

  it("rejects release-relevant task work without a changelog update", () => {
    expect(
      evaluatePullRequestPolicy({
        baseRef: "dev",
        headRef: "codex/example",
        changedFiles: ["docs/README.md"],
        baseVersion: "0.2.0",
        headVersion: "0.2.0",
        headChangelog: releaseHeading,
      }),
    ).toContain("release-relevant changes into dev must update CHANGELOG.md");
  });

  it("rejects feature branches that target main directly", () => {
    expect(
      evaluatePullRequestPolicy({
        baseRef: "main",
        headRef: "codex/example",
        changedFiles: ["package.json", "CHANGELOG.md"],
        baseVersion: "0.2.0",
        headVersion: "0.3.0",
        headChangelog: releaseHeading,
      }),
    ).toContain("main accepts only the release pull request from dev");
  });

  it("requires a version bump for the dev to main release pull request", () => {
    expect(
      evaluatePullRequestPolicy({
        baseRef: "main",
        headRef: "dev",
        changedFiles: ["CHANGELOG.md"],
        baseVersion: "0.2.0",
        headVersion: "0.2.0",
        headChangelog: releaseHeading,
      }),
    ).toContain("release pull request must bump package version above 0.2.0");
  });

  it("rejects a release version lower than main", () => {
    expect(
      evaluatePullRequestPolicy({
        baseRef: "main",
        headRef: "dev",
        changedFiles: ["package.json", "CHANGELOG.md"],
        baseVersion: "0.3.0",
        headVersion: "0.2.0",
        headChangelog: "# Changelog\n\n## [0.2.0] - 2026-07-16\n",
      }),
    ).toContain("release pull request must bump package version above 0.3.0");
  });

  it("accepts a versioned dev to main release pull request", () => {
    expect(
      evaluatePullRequestPolicy({
        baseRef: "main",
        headRef: "dev",
        changedFiles: ["package.json", "CHANGELOG.md"],
        baseVersion: "0.2.0",
        headVersion: "0.3.0",
        headChangelog: releaseHeading,
      }),
    ).toEqual([]);
  });
});

describe("release metadata", () => {
  it("accepts a package version with a matching changelog heading and tag", () => {
    expect(evaluateReleaseMetadata({ version: "0.3.0", changelog: releaseHeading, tagName: "v0.3.0" })).toEqual([]);
  });

  it("rejects a tag that does not match the package version", () => {
    expect(evaluateReleaseMetadata({ version: "0.3.0", changelog: releaseHeading, tagName: "v0.2.0" })).toContain(
      "tag v0.2.0 does not match package version 0.3.0",
    );
  });
});

describe("public repository candidates", () => {
  it("keeps every repository allowlist entry file-exact", async () => {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), "public-repository.json"), "utf8")) as {
      repositoryFiles: string[];
    };

    for (const relativePath of manifest.repositoryFiles) {
      const entry = await lstat(path.join(process.cwd(), relativePath));
      expect(entry.isFile(), relativePath).toBe(true);
      expect(entry.isSymbolicLink(), relativePath).toBe(false);
    }
  });

  it("excludes tracked files deleted from the working tree", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "locus-public-repository-"));
    try {
      await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
      await writeFile(path.join(directory, "kept.txt"), "kept\n", "utf8");
      await writeFile(path.join(directory, "deleted.txt"), "deleted\n", "utf8");
      await execFileAsync("git", ["add", "kept.txt", "deleted.txt"], { cwd: directory });
      await unlink(path.join(directory, "deleted.txt"));

      await expect(candidateFiles(directory)).resolves.toEqual(["kept.txt"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a fallback symlink without terminating an importing process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "locus-public-repository-"));
    try {
      const outside = path.join(directory, "outside");
      const source = path.join(directory, "source");
      await mkdir(outside);
      await mkdir(source);
      await symlink(outside, path.join(source, "escape"));

      await expect(candidateFiles(source)).rejects.toThrow(/Symlink rejected/u);
      expect(true).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
