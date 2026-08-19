import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../extensions/_shared/host/pi-api.js";
import { createHarness } from "../../test-harness.js";
import { type ExtensionManifest, pkg, root, topLevelCommands } from "../helpers/package-contract.js";

describe("extension runtime registration contract", () => {
  it("keeps runtime slash-command registration aligned with extension manifests", async () => {
    for (const entrypoint of pkg.pi.extensions) {
      const manifestPath = path.join(root, path.dirname(entrypoint), "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
      const module = (await import(pathToFileURL(path.join(root, entrypoint)).href)) as { default: ExtensionFactory };
      const harness = createHarness();
      await module.default(harness.pi);
      expect([...harness.commands.keys()].sort(), `runtime commands differ from ${manifestPath}`).toEqual(
        topLevelCommands(manifest.provides.commands),
      );
    }
  });
});
