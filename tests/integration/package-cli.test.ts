/**
 * The published CLI, exercised the way an installed package runs it: plain `node bin/locus-pi` in a
 * copy that contains only published files. `doctor` reports the installed extension surface and must
 * agree with `/devext doctor`, which reads the same module — the two used to answer from different
 * sources and disagreed.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface PackageJson {
  name: string;
  version: string;
  pi: { extensions: string[] };
}

const root = process.cwd();
const sourcePackage = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
const INVENTORY_MODULE = "extensions/devext-doctor/package-inventory.mjs";

function extensionDirectory(entrypoint: string): string {
  return entrypoint.replace("./extensions/", "").replace("/index.ts", "");
}

/**
 * A package copy holding what `doctor` reads: the CLI, the inventory module, `package.json`, and each
 * declared entrypoint beside its real manifest. `mutate` breaks one thing to exercise a fault path.
 */
function createPackageCopy(mutate: (temporaryRoot: string) => void = () => {}): string {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "locus-pi-cli-"));
  mkdirSync(path.join(temporaryRoot, "bin"), { recursive: true });
  copyFileSync(path.join(root, "bin/locus-pi"), path.join(temporaryRoot, "bin/locus-pi"));
  mkdirSync(path.join(temporaryRoot, path.dirname(INVENTORY_MODULE)), { recursive: true });
  copyFileSync(path.join(root, INVENTORY_MODULE), path.join(temporaryRoot, INVENTORY_MODULE));

  for (const entrypoint of sourcePackage.pi.extensions) {
    const target = path.join(temporaryRoot, entrypoint);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "fixture");
    const manifest = `extensions/${extensionDirectory(entrypoint)}/manifest.json`;
    copyFileSync(path.join(root, manifest), path.join(temporaryRoot, manifest));
  }

  writeFileSync(path.join(temporaryRoot, "package.json"), `${JSON.stringify(sourcePackage)}\n`);
  mutate(temporaryRoot);
  return temporaryRoot;
}

function runDoctor(temporaryRoot: string) {
  return spawnSync(process.execPath, [path.join(temporaryRoot, "bin/locus-pi"), "doctor"], {
    cwd: temporaryRoot,
    encoding: "utf8",
  });
}

describe("package CLI", () => {
  it("returns success and describes every declared extension in a package copy", () => {
    const temporaryRoot = createPackageCopy();
    try {
      const result = runDoctor(temporaryRoot);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`declared entrypoints: ${sourcePackage.pi.extensions.length}`);
      expect(result.stdout).toMatch(
        /- ok: \.\/extensions\/agents\/index\.ts — agents \(risk=high, ownership=locus-specific\)/u,
      );
      expect(result.stdout).toContain("./extensions/status-line/index.ts");
      expect(result.stdout).toMatch(/^risk: .*low=/mu);
      expect(result.stdout).toMatch(/^ownership: .*locus-specific=/mu);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("reports the installed surface only, with no migration history", () => {
    const temporaryRoot = createPackageCopy();
    try {
      const result = runDoctor(temporaryRoot);

      // The superseded hand-maintained table published deleted demos and backlog counters as if
      // they were evidence about the installed package.
      for (const historical of [
        "session-state-demo",
        "lifecycle-trace",
        "tools-ast-grep",
        "omp-owned-to-import",
        "split-required",
        "redesign-later",
      ]) {
        expect(result.stdout).not.toContain(historical);
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("returns failure and names a missing extension in a package copy", () => {
    const missingExtension = sourcePackage.pi.extensions.at(-1);
    if (missingExtension === undefined) throw new Error("package declares no Pi extensions");
    const temporaryRoot = createPackageCopy((copy) => rmSync(path.join(copy, missingExtension)));
    try {
      const result = runDoctor(temporaryRoot);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`- missing-entrypoint: ${missingExtension}`);
      expect(result.stdout).toContain("- ok:");
      expect(result.stderr).toContain(`${missingExtension}: declared entrypoint is missing`);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails closed with a diagnostic when a manifest cannot be read", () => {
    const temporaryRoot = createPackageCopy((copy) =>
      writeFileSync(path.join(copy, "extensions/agents/manifest.json"), "{ not json"),
    );
    try {
      const result = runDoctor(temporaryRoot);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("- unreadable-manifest: ./extensions/agents/index.ts");
      expect(result.stderr).toContain("extensions/agents/manifest.json: is not valid JSON");
      expect(result.stderr).not.toMatch(/^\s+at /mu);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
