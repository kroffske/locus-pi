import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ExtensionManifest,
  extensionDocs,
  extensionIdFromEntrypoint,
  featureDependencyGraph,
  parseExtensionRows,
  pkg,
  root,
} from "../helpers/package-contract.js";

describe("extension reference contract", () => {
  it("keeps the compact extension reference aligned with manifests and source imports", () => {
    const extensionIds = pkg.pi.extensions.map(extensionIdFromEntrypoint);
    const rows = parseExtensionRows(extensionDocs);
    expect([...rows.keys()].sort()).toEqual([...extensionIds].sort());
    for (const [index, entrypoint] of pkg.pi.extensions.entries()) {
      const id = extensionIds[index]!;
      const manifestPath = path.join(root, path.dirname(entrypoint), "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
      expect(rows.get(id)).toEqual({
        tools: manifest.provides.tools,
        commands: manifest.provides.commands,
        hooks: manifest.provides.hooks,
        risk: manifest.risk,
        manual: manifest.docsPath,
      });
      expect(existsSync(path.join(root, manifest.docsPath)), manifest.docsPath).toBe(true);
      expect(pkg.files).toContain(manifest.docsPath);
      expect(manifest.sourceAuditPath).toBeNull();
      for (const testPath of manifest.tests)
        expect(existsSync(path.join(root, testPath)), `missing test from ${manifestPath}: ${testPath}`).toBe(true);
    }
    const sourceGraph = featureDependencyGraph(extensionIds);
    expect([...sourceGraph].filter(([, dependencies]) => dependencies.length > 0)).toEqual([
      ["agents", ["workflows"]],
      ["loop", ["workflows"]],
    ]);
    expect(extensionDocs).toContain("`agents → workflows`");
    expect(extensionDocs).toContain("`loop → workflows/run-read.ts`");
  });
});
