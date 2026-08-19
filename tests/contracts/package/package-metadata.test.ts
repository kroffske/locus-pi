import { describe, expect, it } from "vitest";
import { pkg } from "../helpers/package-contract.js";

describe("package metadata contract", () => {
  it("declares the eleven supported active entrypoints", () => {
    expect(pkg.pi.extensions).toEqual([
      "./extensions/agents/index.ts",
      "./extensions/ask-user-question/index.ts",
      "./extensions/ast-structural-edit/index.ts",
      "./extensions/devext-doctor/index.ts",
      "./extensions/loop/index.ts",
      "./extensions/model/index.ts",
      "./extensions/plan/index.ts",
      "./extensions/security-gate/index.ts",
      "./extensions/status-line/index.ts",
      "./extensions/todo-context/index.ts",
      "./extensions/workflows/index.ts",
    ]);
    expect(pkg.files.some((file) => file.startsWith("extensions/beta/"))).toBe(false);
  });

  it("binds the MIT package to the clean repository identity", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository.url).toBe("git+https://github.com/kroffske/locus-pi.git");
  });
});
