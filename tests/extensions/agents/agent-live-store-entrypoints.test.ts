import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { agentLiveStore } from "../../../extensions/_shared/agent-sdk-host.js";
import type { ExtensionCommandContext } from "../../../extensions/_shared/pi-api.js";
import { createHarness } from "../../test-harness.js";

afterEach(() => agentLiveStore.reset());

describe("agent live store across Pi entrypoints", () => {
  it("shares rows when Pi loads each entrypoint through a fresh jiti module cache", async () => {
    const producerPath = path.resolve("tests/fixtures/extensions/shared-store-producer.ts");
    const consumerPath = path.resolve("tests/fixtures/extensions/shared-store-consumer.ts");
    const loaded = await discoverAndLoadExtensions(
      [producerPath, consumerPath],
      process.cwd(),
      mkdtempSync(path.join(tmpdir(), "locus-pi-empty-agent-dir-")),
    );
    expect(loaded.errors).toEqual([]);
    const producer = loaded.extensions.find((extension) => extension.resolvedPath === producerPath);
    const consumer = loaded.extensions.find((extension) => extension.resolvedPath === consumerPath);
    const produce = producer?.commands.get("test-produce-shared-row")?.handler as unknown as
      ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
    const consume = consumer?.commands.get("test-consume-shared-row")?.handler as unknown as
      ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
    const h = createHarness();

    expect(produce).toBeDefined();
    expect(consume).toBeDefined();
    await produce?.("", h.ctx as ExtensionCommandContext);
    await consume?.("", h.ctx as ExtensionCommandContext);

    expect(h.widgets.get("shared-store-proof")).toBe("shared row visible");
  });
});
