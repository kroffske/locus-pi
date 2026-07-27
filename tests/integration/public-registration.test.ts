import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURATED_PACKAGE_WORKFLOW_NAMES } from "../../extensions/_shared/workflow-runner.js";

interface PackageJson {
  files: string[];
  license: string;
  pi: { extensions: string[] };
  repository: { url: string };
}

interface ExtensionManifest {
  docsPath: string;
  sourceAuditPath: string | null;
  tests: string[];
}

const sourceAuditUrlPrefix = "https://github.com/kroffske/locus-pi/blob/main/";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;

describe("public registration contract", () => {
  it("declares the ten supported active entrypoints", () => {
    expect(pkg.pi.extensions).toEqual([
      "./extensions/agents/index.ts",
      "./extensions/ask-user-question/index.ts",
      "./extensions/ast-structural-edit/index.ts",
      "./extensions/devext-doctor/index.ts",
      "./extensions/loop/index.ts",
      "./extensions/model/index.ts",
      "./extensions/plan/index.ts",
      "./extensions/security-gate/index.ts",
      "./extensions/todo-context/index.ts",
      "./extensions/workflows/index.ts",
    ]);
    expect(pkg.files.some((file) => file.startsWith("extensions/beta/"))).toBe(false);
  });

  it("declares exactly the curated Package workflows", () => {
    expect([...CURATED_PACKAGE_WORKFLOW_NAMES]).toEqual([
      "live-smoke",
      "plan",
      "plan-implement",
      "requirements-grill",
      "review",
      "review-fix",
    ]);
  });

  it("keeps manifest documentation and test evidence resolvable", () => {
    for (const entrypoint of pkg.pi.extensions) {
      const manifestPath = path.join(root, path.dirname(entrypoint), "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;

      expect(existsSync(path.join(root, manifest.docsPath)), `missing docsPath from ${manifestPath}`).toBe(true);
      for (const testPath of manifest.tests) {
        expect(existsSync(path.join(root, testPath)), `missing test from ${manifestPath}: ${testPath}`).toBe(true);
      }

      if (manifest.sourceAuditPath !== null) {
        expect(manifest.sourceAuditPath.startsWith(sourceAuditUrlPrefix), manifestPath).toBe(true);
        const repositoryPath = manifest.sourceAuditPath.slice(sourceAuditUrlPrefix.length);
        expect(existsSync(path.join(root, repositoryPath)), `missing source audit from ${manifestPath}`).toBe(true);
      }
    }
  });

  it("binds the MIT package to the clean repository identity", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository.url).toBe("git+https://github.com/kroffske/locus-pi.git");
  });
});
