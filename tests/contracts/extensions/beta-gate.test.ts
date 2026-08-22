import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BETA_ENV_VAR } from "../../../extensions/_shared/host/beta-gate.js";
import type { ExtensionFactory } from "../../../extensions/_shared/host/pi-api.js";
import { createHarness, type Harness } from "../../test-harness.js";
import { defaultExtensionManifests, root, topLevelCommands } from "../helpers/package-contract.js";

/**
 * What a beta tier means, asserted against the entrypoints themselves.
 *
 * This is the manifest-driven half of the contract: which extensions are beta comes from
 * `tier` in each manifest and the entrypoint list comes from `package.json#pi.extensions`, so
 * moving an extension between tiers needs no edit here. The other half — that Pi's own loader
 * really does load a disabled beta entrypoint and receive nothing from it — is proven against
 * the installed host in tests/contracts/host/selective-package-loading.test.ts.
 *
 * Both of the gate's sources are neutralized before each case and one is then set by hand: the
 * environment variable is saved and restored, and the working directory becomes a fresh empty
 * one so that a `.locus-pi/config.json` in the developer's own checkout cannot enable a beta
 * extension underneath the assertions.
 */
const manifests = defaultExtensionManifests();
const temporaryRoots: string[] = [];
let previousEnv: string | undefined;
let previousCwd: string;

beforeEach(() => {
  previousEnv = process.env[BETA_ENV_VAR];
  delete process.env[BETA_ENV_VAR];
  previousCwd = process.cwd();
  const neutral = mkdtempSync(path.join(tmpdir(), "locus-pi-beta-contract-"));
  temporaryRoots.push(neutral);
  process.chdir(neutral);
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousEnv === undefined) delete process.env[BETA_ENV_VAR];
  else process.env[BETA_ENV_VAR] = previousEnv;
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** The extension exactly as Pi activates it: the default export of the declared entrypoint. */
async function activate(id: string): Promise<Harness> {
  const module = (await import(pathToFileURL(path.join(root, `extensions/${id}/index.ts`)).href)) as {
    default: ExtensionFactory;
  };
  const harness = createHarness();
  await module.default(harness.pi);
  return harness;
}

function registeredHooks(harness: Harness): string[] {
  return [...harness.handlers].filter(([, handlers]) => handlers.length > 0).map(([event]) => String(event));
}

describe("beta tier gate contract", () => {
  it("declares at least one extension in each tier", () => {
    expect(manifests.filter(({ manifest }) => manifest.tier === "beta").length).toBeGreaterThan(0);
    expect(manifests.filter(({ manifest }) => manifest.tier === "default").length).toBeGreaterThan(0);
  });

  it("registers nothing for a beta extension while nothing enables it", async () => {
    for (const { id, manifest } of manifests) {
      if (manifest.tier !== "beta") continue;
      const harness = await activate(id);
      expect([...harness.tools.keys()], `${id} registered tools while disabled`).toEqual([]);
      expect([...harness.commands.keys()], `${id} registered commands while disabled`).toEqual([]);
      expect(registeredHooks(harness), `${id} registered hooks while disabled`).toEqual([]);
    }
  });

  it("registers the whole declared surface once the environment enables the id", async () => {
    for (const { id, manifestPath, manifest } of manifests) {
      if (manifest.tier !== "beta") continue;
      process.env[BETA_ENV_VAR] = id;
      const harness = await activate(id);
      expect([...harness.tools.keys()].sort(), `tools differ from ${manifestPath}`).toEqual(
        [...manifest.provides.tools].sort(),
      );
      expect([...harness.commands.keys()].sort(), `commands differ from ${manifestPath}`).toEqual(
        topLevelCommands(manifest.provides.commands),
      );
      expect(registeredHooks(harness).sort(), `hooks differ from ${manifestPath}`).toEqual(
        [...manifest.provides.hooks].sort(),
      );
    }
  });

  it("enables every beta extension at once for the wildcard", async () => {
    process.env[BETA_ENV_VAR] = "all";
    for (const { id, manifest } of manifests) {
      if (manifest.tier !== "beta") continue;
      const harness = await activate(id);
      expect(harness.tools.size + harness.commands.size, `${id} registered nothing under the wildcard`).toBeGreaterThan(
        0,
      );
    }
  });

  /**
   * The counterpart claim: a default-tier extension needs no opt-in and asks for none. Only
   * that it registers is asserted here; runtime-registration.test.ts owns the exact surface,
   * and status-line declares no tool or command to see.
   */
  it("registers a default-tier extension with no opt-in at all", async () => {
    for (const { id, manifest } of manifests) {
      if (manifest.tier !== "default") continue;
      if (manifest.provides.tools.length + manifest.provides.commands.length === 0) continue;
      const harness = await activate(id);
      expect(harness.tools.size + harness.commands.size, `${id} registered nothing without an opt-in`).toBeGreaterThan(
        0,
      );
    }
  });
});
