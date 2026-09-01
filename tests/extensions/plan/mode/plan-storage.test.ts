import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  legacyPlanLibraryDir,
  listPlanSlugs,
  normalizeRemote,
  planArtifactPath,
  planLibraryDir,
  planSlug,
  preparePlanLibrary,
  projectSlug,
} from "../../../../extensions/plan/mode/plan-storage.js";

const tempRoots: string[] = [];
let legacyHome: string;

beforeEach(() => {
  legacyHome = makeTemp("plan-storage-home-");
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTemp(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function projectRoot(): string {
  const root = makeTemp("plan-storage-project-");
  execFileSync("git", ["-C", root, "init", "--quiet"], { stdio: "pipe" });
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/TestOrg/TestRepo.git"], {
    stdio: "pipe",
  });
  return root;
}

function env(): NodeJS.ProcessEnv {
  return { LOCUS_PI_HOME: legacyHome };
}

function writePlan(directory: string, name: string, body: string): string {
  mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${name}.md`);
  writeFileSync(filePath, body, "utf8");
  return filePath;
}

describe("plan storage paths", () => {
  it("normalizes SSH, authenticated HTTPS, and mixed-case origins to one key", () => {
    expect(normalizeRemote("git@github.com:Org/Repo.git")).toBe("github.com/org/repo");
    expect(normalizeRemote("https://user:pw@GitHub.com/Org/Repo.git")).toBe("github.com/org/repo");
  });

  it("uses one project slug for SSH and HTTPS forms of the same origin", () => {
    const ssh = makeTemp("plan-storage-ssh-");
    const https = makeTemp("plan-storage-https-");
    execFileSync("git", ["-C", ssh, "init", "--quiet"], { stdio: "pipe" });
    execFileSync("git", ["-C", ssh, "remote", "add", "origin", "git@github.com:TestOrg/TestRepo.git"]);
    execFileSync("git", ["-C", https, "init", "--quiet"], { stdio: "pipe" });
    execFileSync("git", ["-C", https, "remote", "add", "origin", "https://github.com/TestOrg/TestRepo.git"]);

    expect(projectSlug(ssh)).toBe(projectSlug(https));
  });

  it("uses stable distinct realpath keys for directories without a remote", () => {
    const first = makeTemp("plan-storage-no-remote-a-");
    const second = makeTemp("plan-storage-no-remote-b-");
    expect(projectSlug(first)).toBe(projectSlug(first));
    expect(projectSlug(first)).not.toBe(projectSlug(second));
    expect(projectSlug(first)).toMatch(/-[0-9a-f]{12}$/);
  });

  it("keeps current plans checkout-local and applies the home override only to legacy input", () => {
    const root = projectRoot();
    expect(planLibraryDir(root)).toBe(path.join(root, ".locus-pi", "plans"));
    expect(planArtifactPath(root, "my-plan")).toBe(path.join(root, ".locus-pi", "plans", "my-plan.md"));
    expect(legacyPlanLibraryDir(root, env())).toContain(legacyHome);
  });

  it("lists current Markdown plan slugs newest-name first and ignores other files", () => {
    const root = projectRoot();
    writePlan(planLibraryDir(root), "alpha", "# Alpha\n");
    writePlan(planLibraryDir(root), "gamma", "# Gamma\n");
    writeFileSync(path.join(planLibraryDir(root), "README.txt"), "not a plan", "utf8");
    expect(listPlanSlugs(root)).toEqual(["gamma", "alpha"]);
  });

  it("builds a bounded filesystem-safe slug from the request's first line", () => {
    const slug = planSlug("Add read-only mode: spec/impl\nIgnore this line", new Date(Date.UTC(2026, 5, 30)));
    const body = planSlug("A".repeat(100), new Date(Date.UTC(2026, 5, 30))).split("-20260630-")[0] ?? "";
    expect(slug).toMatch(/^add-read-only-mode-spec-impl-20260630-[0-9a-z]{4}$/);
    expect(body.length).toBeLessThanOrEqual(48);
    expect(planSlug("", new Date(Date.UTC(2026, 5, 30)))).toMatch(/^plan-20260630-/);
  });
});

describe("preparePlanLibrary", () => {
  it("copies legacy-only Markdown files atomically and leaves legacy bytes untouched", () => {
    const root = projectRoot();
    const legacy = legacyPlanLibraryDir(root, env());
    const legacyPath = writePlan(legacy, "alpha", "# Alpha\n");

    const result = preparePlanLibrary(root, env());

    expect(result).toEqual({ directory: planLibraryDir(root), migrated: 1 });
    expect(readFileSync(path.join(planLibraryDir(root), "alpha.md"), "utf8")).toBe("# Alpha\n");
    expect(readFileSync(legacyPath, "utf8")).toBe("# Alpha\n");
    expect(readdirSync(planLibraryDir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("accepts identical overlap and keeps current-only plans", () => {
    const root = projectRoot();
    writePlan(legacyPlanLibraryDir(root, env()), "shared", "same\n");
    writePlan(planLibraryDir(root), "shared", "same\n");
    writePlan(planLibraryDir(root), "current-only", "new\n");

    expect(preparePlanLibrary(root, env()).migrated).toBe(0);
    expect(listPlanSlugs(root)).toEqual(["shared", "current-only"]);
  });

  it("rejects every different overlap before copying any legacy-only file", () => {
    const root = projectRoot();
    const legacy = legacyPlanLibraryDir(root, env());
    writePlan(legacy, "a-copy-candidate", "copy me\n");
    writePlan(legacy, "z-conflict", "legacy\n");
    writePlan(planLibraryDir(root), "z-conflict", "current\n");

    expect(() => preparePlanLibrary(root, env())).toThrow(/current and legacy files differ: z-conflict\.md/);
    expect(readFileSync(path.join(planLibraryDir(root), "z-conflict.md"), "utf8")).toBe("current\n");
    expect(() => readFileSync(path.join(planLibraryDir(root), "a-copy-candidate.md"))).toThrow();
  });

  it("rejects a legacy Markdown symlink during pre-scan before copying regular files", () => {
    const root = projectRoot();
    const legacy = legacyPlanLibraryDir(root, env());
    writePlan(legacy, "a-copy-candidate", "copy me\n");
    const target = writePlan(legacy, "target", "target\n");
    symlinkSync(target, path.join(legacy, "z-linked.md"));

    expect(() => preparePlanLibrary(root, env())).toThrow(/legacy Markdown entry must be a regular file/);
    expect(() => readFileSync(path.join(planLibraryDir(root), "a-copy-candidate.md"))).toThrow();
  });

  it("rejects a symlink in the current library path chain before migration writes", () => {
    const root = projectRoot();
    const outside = makeTemp("plan-storage-current-outside-");
    writePlan(legacyPlanLibraryDir(root, env()), "alpha", "# Alpha\n");
    symlinkSync(outside, path.join(root, ".locus-pi"));

    expect(() => preparePlanLibrary(root, env())).toThrow(/current library path component must not be a symlink/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects a symlink in the legacy library path chain before scanning it", () => {
    const root = projectRoot();
    const legacy = legacyPlanLibraryDir(root, env());
    const outside = makeTemp("plan-storage-legacy-outside-");
    mkdirSync(path.join(legacyHome, ".pi"), { recursive: true });
    symlinkSync(outside, path.join(legacyHome, ".pi", "locus-pi"));
    writePlan(legacy, "alpha", "# Alpha\n");

    expect(() => preparePlanLibrary(root, env())).toThrow(/legacy library path component must not be a symlink/);
    expect(() => readFileSync(planArtifactPath(root, "alpha"))).toThrow();
  });

  it("rejects a non-regular legacy Markdown entry before copying regular files", () => {
    const root = projectRoot();
    const legacy = legacyPlanLibraryDir(root, env());
    writePlan(legacy, "a-copy-candidate", "copy me\n");
    mkdirSync(path.join(legacy, "z-directory.md"));

    expect(() => preparePlanLibrary(root, env())).toThrow(/legacy Markdown entry must be a regular file/);
    expect(() => readFileSync(path.join(planLibraryDir(root), "a-copy-candidate.md"))).toThrow();
  });

  it("continues safely from an identical prefix left by a partial earlier attempt", () => {
    const root = projectRoot();
    const legacy = legacyPlanLibraryDir(root, env());
    writePlan(legacy, "alpha", "# Alpha\n");
    writePlan(legacy, "beta", "# Beta\n");
    writePlan(planLibraryDir(root), "alpha", "# Alpha\n");

    expect(preparePlanLibrary(root, env()).migrated).toBe(1);
    expect(readFileSync(path.join(planLibraryDir(root), "beta.md"), "utf8")).toBe("# Beta\n");
    expect(preparePlanLibrary(root, env()).migrated).toBe(0);
  });

  it("uses the project-local library when no legacy library exists", () => {
    const root = projectRoot();
    writePlan(planLibraryDir(root), "local", "# Local\n");

    expect(preparePlanLibrary(root, env())).toEqual({ directory: planLibraryDir(root), migrated: 0 });
    expect(listPlanSlugs(root)).toEqual(["local"]);
  });
});
