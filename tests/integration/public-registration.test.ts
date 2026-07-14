import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURATED_PACKAGE_WORKFLOW_NAMES } from "../../extensions/_shared/workflow-runner.js";

interface PackageJson {
  files: string[];
  license: string;
  pi: { extensions: string[] };
  repository: { url: string };
}

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
      "llm-smoke",
      "requirements-grill",
    ]);
  });

  it("binds the MIT package to the clean repository identity", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository.url).toBe("git+https://github.com/kroffske/locus-pi-oss.git");
  });
});
