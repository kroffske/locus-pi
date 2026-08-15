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

function createPackageCopy(removeExtension?: string): string {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "locus-pi-cli-"));
  mkdirSync(path.join(temporaryRoot, "bin"), { recursive: true });
  copyFileSync(path.join(root, "bin/locus-pi"), path.join(temporaryRoot, "bin/locus-pi"));

  for (const extensionPath of sourcePackage.pi.extensions) {
    const target = path.join(temporaryRoot, extensionPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "fixture");
  }
  if (removeExtension !== undefined) rmSync(path.join(temporaryRoot, removeExtension));

  writeFileSync(path.join(temporaryRoot, "package.json"), `${JSON.stringify(sourcePackage)}\n`);
  return temporaryRoot;
}

function runDoctor(temporaryRoot: string) {
  return spawnSync(process.execPath, [path.join(temporaryRoot, "bin/locus-pi"), "doctor"], {
    cwd: temporaryRoot,
    encoding: "utf8",
  });
}

describe("package CLI", () => {
  it("returns success when every declared extension exists in a package copy", () => {
    const temporaryRoot = createPackageCopy();
    try {
      const result = runDoctor(temporaryRoot);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`pi extensions: ${sourcePackage.pi.extensions.length}`);
      expect(result.stdout).not.toContain("missing:");
      expect(result.stdout).toMatch(/- ok: \.\/extensions\/agents\/index\.ts/u);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("returns failure and reports missing extensions in a package copy", () => {
    const missingExtension = sourcePackage.pi.extensions.at(-1);
    if (missingExtension === undefined) throw new Error("package declares no Pi extensions");
    const temporaryRoot = createPackageCopy(missingExtension);
    try {
      const result = runDoctor(temporaryRoot);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`- missing: ${missingExtension}`);
      expect(result.stdout).toContain("- ok:");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
