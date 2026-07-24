import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("agent live store across Pi entrypoints", () => {
  it("shares v4 execution and cancellation authority across real moduleCache:false entrypoints without adopting v3", async () => {
    const producerPath = path.resolve("tests/fixtures/extensions/shared-store-producer.ts");
    const consumerPath = path.resolve("tests/fixtures/extensions/shared-store-consumer.ts");
    const harnessUrl = pathToFileURL(path.resolve("tests/test-harness.ts")).href;
    const script = `
const runtimeGlobal = globalThis;
const v3Key = Symbol.for("locus-pi.agent-live-store.v3");
const v4Key = Symbol.for("locus-pi.agent-live-store.v4");
const installedV3 = Object.freeze({ version: 3, store: { marker: "must remain untouched" } });
Object.defineProperty(runtimeGlobal, v3Key, {
  value: installedV3,
  enumerable: false,
  configurable: false,
  writable: false,
});
const v3ValueBefore = runtimeGlobal[v3Key];
const v3DescriptorBefore = Object.getOwnPropertyDescriptor(runtimeGlobal, v3Key);
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const path = (await import("node:path")).default;
const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");
const { createHarness } = await import(${JSON.stringify(harnessUrl)});
const producerPath = ${JSON.stringify(producerPath)};
const consumerPath = ${JSON.stringify(consumerPath)};
const harness = createHarness();
const check = (condition, message) => { if (!condition) throw new Error(message); };
const loadEntrypoints = async () => {
  const loaded = await discoverAndLoadExtensions(
    [producerPath, consumerPath],
    process.cwd(),
    mkdtempSync(path.join(tmpdir(), "locus-pi-empty-agent-dir-")),
  );
  check(loaded.errors.length === 0, "loader errors: " + JSON.stringify(loaded.errors));
  return loaded;
};
const command = (loaded, extensionPath, name) => {
  const handler = loaded.extensions.find((extension) => extension.resolvedPath === extensionPath)?.commands.get(name)?.handler;
  check(typeof handler === "function", "missing " + name);
  return handler;
};
const firstLoad = await loadEntrypoints();
const firstV4Slot = runtimeGlobal[v4Key];
const firstStore = firstV4Slot?.store;
check(firstV4Slot?.version === 4 && firstStore !== undefined, "first v4 slot missing");
await command(firstLoad, producerPath, "test-produce-shared-row")("", harness.ctx);
await command(firstLoad, consumerPath, "test-consume-shared-row")("", harness.ctx);
check(harness.widgets.get("shared-store-proof") === "shared execution and cancellation authority", "forward authority failed");
check(harness.widgets.get("shared-store-cancel") === "producer cancellation reached", "forward cancel failed");
const secondLoad = await loadEntrypoints();
const secondV4Slot = runtimeGlobal[v4Key];
check(secondV4Slot === firstV4Slot, "v4 slot identity changed across discovery");
check(secondV4Slot?.store === firstStore, "v4 store identity changed across discovery");
await command(secondLoad, consumerPath, "test-consumer-produce-shared-row")("", harness.ctx);
await command(secondLoad, producerPath, "test-producer-consume-shared-row")("", harness.ctx);
check(harness.widgets.get("shared-store-reverse-proof") === "consumer execution reached producer", "reverse authority failed");
check(harness.widgets.get("shared-store-reverse-cancel") === "consumer cancellation reached", "reverse cancel failed");
const v3DescriptorAfter = Object.getOwnPropertyDescriptor(runtimeGlobal, v3Key);
check(runtimeGlobal[v3Key] === v3ValueBefore, "v3 value changed");
check(v3DescriptorAfter?.value === v3DescriptorBefore?.value, "v3 descriptor value changed");
check(v3DescriptorAfter?.configurable === false && v3DescriptorAfter?.writable === false, "v3 descriptor weakened");
const v4Slot = runtimeGlobal[v4Key];
check(v4Slot?.version === 4, "v4 slot missing");
check(v4Slot?.store !== installedV3.store, "v3 store was adopted");
process.stdout.write(JSON.stringify({
  ok: true,
  loads: 2,
  forward: harness.widgets.get("shared-store-proof"),
  reverse: harness.widgets.get("shared-store-reverse-proof"),
  v3Configurable: v3DescriptorBefore?.configurable,
  v3Writable: v3DescriptorBefore?.writable,
  v4Version: v4Slot?.version,
  sameSlot: secondV4Slot === firstV4Slot,
  sameStore: secondV4Slot?.store === firstStore,
}) + "\\n");
`;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const proof = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

    expect(proof).toEqual({
      ok: true,
      loads: 2,
      forward: "shared execution and cancellation authority",
      reverse: "consumer execution reached producer",
      v3Configurable: false,
      v3Writable: false,
      v4Version: 4,
      sameSlot: true,
      sameStore: true,
    });
  });
});
