import { describe, expect, it } from "vitest";
import { loadExtensionAgentCatalog } from "../../../extensions/agents/catalog.js";
import { extensionIdFromEntrypoint, pkg } from "../helpers/package-contract.js";

describe("extension agent catalog contract", () => {
  it("publishes one resolvable dedicated agent for every default extension", () => {
    const extensionIds = pkg.pi.extensions.map(extensionIdFromEntrypoint);
    const entries = loadExtensionAgentCatalog();
    expect(entries.map((entry) => entry.extensionId).sort()).toEqual([...extensionIds].sort());
    for (const entry of entries) {
      expect(pkg.files).toContain(entry.profilePath);
      expect(pkg.files).toContain(entry.manifestPath);
      expect(entry.description.length).toBeLessThanOrEqual(96);
    }
  });
});
