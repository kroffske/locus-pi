import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BETA_ENV_VAR } from "../../../extensions/_shared/host/beta-gate.js";
import type { ExtensionFactory } from "../../../extensions/_shared/host/pi-api.js";
import { createHarness } from "../../test-harness.js";
import { defaultExtensionManifests, root, topLevelCommands } from "../helpers/package-contract.js";

/**
 * Every manifest is checked here, beta tier included, so the wildcard opt-in is set for the
 * duration: what this contract owns is that a registered surface equals the declared one, not
 * whether a beta extension registers at all. That second question belongs to beta-gate.test.ts.
 */
let previousEnv: string | undefined;

beforeEach(() => {
  previousEnv = process.env[BETA_ENV_VAR];
  process.env[BETA_ENV_VAR] = "all";
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env[BETA_ENV_VAR];
  else process.env[BETA_ENV_VAR] = previousEnv;
});

describe("extension runtime registration contract", () => {
  it("keeps runtime slash-command registration aligned with extension manifests", async () => {
    for (const { id, manifestPath, manifest } of defaultExtensionManifests()) {
      const entrypoint = `./extensions/${id}/index.ts`;
      const module = (await import(pathToFileURL(path.join(root, entrypoint)).href)) as { default: ExtensionFactory };
      const harness = createHarness();
      await module.default(harness.pi);
      expect([...harness.commands.keys()].sort(), `runtime commands differ from ${manifestPath}`).toEqual(
        topLevelCommands(manifest.provides.commands),
      );
      expect([...harness.tools.keys()].sort(), `runtime tools differ from ${manifestPath}`).toEqual(
        [...manifest.provides.tools].sort(),
      );
    }
  });
});
