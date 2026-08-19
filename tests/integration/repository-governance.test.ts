import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { evaluatePullRequestPolicy } from "../../scripts/check-pull-request-policy.js";
import { candidateFiles, publicRepositoryManifestProblems } from "../../scripts/check-public-repository.js";
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
        changedFiles: ["docs/getting-started.md"],
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

// The manifest is the only description of the public surface, so a reference it
// carries that resolves to nothing silently narrows or widens what gets
// published. Each case below is a manifest a reviewer could plausibly write.
describe("public repository manifest", () => {
  const BASE_REPOSITORY_FILES = ["docs/guide.md", "public-repository.json"];
  const fixtureRoots: string[] = [];

  afterEach(async () => {
    for (const root of fixtureRoots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("accepts a manifest whose every reference resolves to a real file", async () => {
    await expect(publicRepositoryManifestProblems(await manifestFixture())).resolves.toEqual([]);
  });

  it("accepts an exclude that actually removes a selected file", async () => {
    const root = await manifestFixture({ excludeFiles: ["lib/kept.ts"] });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([]);
  });

  it("rejects an allowlist entry with no file behind it", async () => {
    const root = await manifestFixture({ repositoryFiles: [...BASE_REPOSITORY_FILES, "docs/absent.md"] });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([
      expect.objectContaining({
        field: "repositoryFiles[2]",
        value: "docs/absent.md",
        reason: "names docs/absent.md, which does not exist in the working tree",
      }),
    ]);
  });

  it("rejects an exclude that removes nothing from the selection", async () => {
    const root = await manifestFixture({ excludeFiles: ["docs/other.md"] });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([
      expect.objectContaining({
        field: "excludeFiles[0]",
        value: "docs/other.md",
        reason: 'removes nothing, because docs/other.md is not selected by package.json#files or "repositoryFiles"',
      }),
    ]);
  });

  it("rejects an exclude that names no file at all, on both counts", async () => {
    const root = await manifestFixture({ excludeFiles: ["docs/absent.md"] });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([
      expect.objectContaining({
        field: "excludeFiles[0]",
        reason: "names docs/absent.md, which does not exist in the working tree",
      }),
      expect.objectContaining({
        field: "excludeFiles[0]",
        reason: 'removes nothing, because docs/absent.md is not selected by package.json#files or "repositoryFiles"',
      }),
    ]);
  });

  it("rejects a repeated allowlist entry", async () => {
    const root = await manifestFixture({ repositoryFiles: [...BASE_REPOSITORY_FILES, "docs/guide.md"] });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([
      expect.objectContaining({ field: "repositoryFiles[2]", reason: "repeats repositoryFiles[0]" }),
    ]);
  });

  it("rejects two entries that name one file on a case-insensitive filesystem", async () => {
    const root = await manifestFixture({ repositoryFiles: [...BASE_REPOSITORY_FILES, "docs/GUIDE.md"] });

    // Whether docs/GUIDE.md also resolves on disk depends on the filesystem, so
    // only the case collision itself is asserted here.
    await expect(publicRepositoryManifestProblems(root)).resolves.toContainEqual(
      expect.objectContaining({
        field: "repositoryFiles[2]",
        reason: "collides with repositoryFiles[0] (docs/guide.md) on a case-insensitive filesystem",
      }),
    );
  });

  it("rejects a spelling that aliases an entry already listed", async () => {
    const root = await manifestFixture({ repositoryFiles: [...BASE_REPOSITORY_FILES, "./docs/guide.md"] });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([
      expect.objectContaining({
        field: "repositoryFiles[2]",
        value: "./docs/guide.md",
        remedy: 'write the entry as "docs/guide.md" in public-repository.json',
      }),
    ]);
  });

  it("rejects an empty path segment, which npm and git spell differently", async () => {
    const root = await manifestFixture({ repositoryFiles: [...BASE_REPOSITORY_FILES, "docs//guide.md"] });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([
      expect.objectContaining({
        field: "repositoryFiles[2]",
        remedy: 'write the entry as "docs/guide.md" in public-repository.json',
      }),
    ]);
  });

  it("rejects an entry that traverses outside the repository", async () => {
    const root = await manifestFixture({ repositoryFiles: [...BASE_REPOSITORY_FILES, "../outside.md"] });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([
      expect.objectContaining({
        field: "repositoryFiles[2]",
        value: "../outside.md",
        reason: "traverses outside the repository with a .. segment",
      }),
    ]);
  });

  it("rejects a symlink used as an allowlist shortcut", async () => {
    const root = await manifestFixture({
      repositoryFiles: [...BASE_REPOSITORY_FILES, "docs/link.md"],
      links: [{ at: "docs/link.md", target: "guide.md" }],
    });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([
      expect.objectContaining({
        field: "repositoryFiles[2]",
        value: "docs/link.md",
        reason: "resolves through the symlink docs/link.md",
      }),
    ]);
  });

  it("rejects a file reached through a symlinked directory", async () => {
    const root = await manifestFixture({
      repositoryFiles: [...BASE_REPOSITORY_FILES, "linked/guide.md"],
      links: [{ at: "linked", target: "docs" }],
    });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([
      expect.objectContaining({
        field: "repositoryFiles[2]",
        value: "linked/guide.md",
        reason: "resolves through the symlink linked",
      }),
    ]);
  });

  it("rejects a directory, because the public surface is materialized file by file", async () => {
    const root = await manifestFixture({ repositoryFiles: [...BASE_REPOSITORY_FILES, "docs"] });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([
      expect.objectContaining({ field: "repositoryFiles[2]", value: "docs", reason: "is not a regular file" }),
    ]);
  });

  it("rejects an inventory the manifest no longer produces", async () => {
    const root = await manifestFixture({ inventory: ["docs/guide.md", "package.json", "public-repository-files.txt"] });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([
      expect.objectContaining({
        field: "generatedInventory",
        value: "lib/kept.ts",
        reason: "is selected by public-repository.json but absent from public-repository-files.txt",
      }),
      expect.objectContaining({
        field: "generatedInventory",
        value: "public-repository.json",
        reason: "is selected by public-repository.json but absent from public-repository-files.txt",
      }),
    ]);
  });

  it("rejects an inventory destination that does not exist", async () => {
    const root = await manifestFixture({ generatedInventory: "absent-inventory.txt", withoutInventory: true });

    await expect(publicRepositoryManifestProblems(root)).resolves.toEqual([
      expect.objectContaining({
        field: "generatedInventory",
        value: "absent-inventory.txt",
        reason: "names absent-inventory.txt, which does not exist in the working tree",
      }),
    ]);
  });

  it("round-trips through the materializer into a checkout with no git state", async () => {
    const source = await manifestFixture();
    const destination = path.join(await mkdtemp(path.join(tmpdir(), "locus-public-materialized-")), "public");
    fixtureRoots.push(path.dirname(destination));
    const scripts = path.join(process.cwd(), "scripts");

    const materialized = await runScript(path.join(scripts, "materialize-public-repository.ts"), source, [destination]);
    expect(materialized).toContain("Materialized 5 files");

    const verified = await runScript(path.join(scripts, "check-public-repository.ts"), destination, []);
    expect(verified).toContain("Public repository inventory verified: 5 files");
  }, 30_000);

  interface FixtureOptions {
    repositoryFiles?: string[];
    excludeFiles?: string[];
    generatedInventory?: string;
    inventory?: string[];
    withoutInventory?: boolean;
    links?: { at: string; target: string }[];
  }

  async function manifestFixture(options: FixtureOptions = {}): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "locus-public-manifest-"));
    fixtureRoots.push(root);
    await mkdir(path.join(root, "docs"));
    await mkdir(path.join(root, "lib"));
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n", "utf8");
    await writeFile(path.join(root, "docs", "other.md"), "# Other\n", "utf8");
    await writeFile(path.join(root, "lib", "kept.ts"), "export const kept = true;\n", "utf8");

    const packageFiles = ["lib/kept.ts"];
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ name: "fixture", private: true, files: packageFiles }, null, 2)}\n`,
      "utf8",
    );

    const manifest = {
      packageFiles: "package.json#files",
      repositoryFiles: options.repositoryFiles ?? BASE_REPOSITORY_FILES,
      excludeFiles: options.excludeFiles ?? [],
      generatedInventory: options.generatedInventory ?? "public-repository-files.txt",
    };
    await writeFile(path.join(root, "public-repository.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    if (!options.withoutInventory) {
      const inventory = options.inventory ?? materializedInventory(packageFiles, manifest);
      await writeFile(path.join(root, manifest.generatedInventory), `${inventory.join("\n")}\n`, "utf8");
    }
    for (const link of options.links ?? []) await symlink(link.target, path.join(root, link.at));
    return root;
  }
});

/** The selection the materializer produces, restated so fixtures stay honest. */
function materializedInventory(
  packageFiles: string[],
  manifest: { repositoryFiles: string[]; excludeFiles: string[]; generatedInventory: string },
): string[] {
  const selected = new Set([...packageFiles, "package.json", ...manifest.repositoryFiles]);
  for (const excluded of manifest.excludeFiles) selected.delete(excluded);
  selected.add(manifest.generatedInventory);
  return [...selected].sort();
}

async function runScript(scriptPath: string, cwd: string, args: string[]): Promise<string> {
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const { stdout } = await execFileAsync(process.execPath, ["--import", pathToFileURL(tsx).href, scriptPath, ...args], {
    cwd,
    encoding: "utf8",
  });
  return stdout;
}
