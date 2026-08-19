import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultExtensionManifests,
  extensionDocs,
  featureDependencyGraph,
  parseExtensionRows,
  pkg,
  root,
} from "../helpers/package-contract.js";

describe("extension reference contract", () => {
  it("keeps the compact extension reference aligned with manifests and source imports", () => {
    const manifests = defaultExtensionManifests();
    const extensionIds = manifests.map(({ id }) => id);
    const rows = parseExtensionRows(extensionDocs);
    expect([...rows.keys()].sort()).toEqual([...extensionIds].sort());
    for (const { id, manifestPath, manifest } of manifests) {
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
