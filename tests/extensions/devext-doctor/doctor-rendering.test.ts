/**
 * What `/devext doctor` puts on screen, in both projections it ships.
 *
 * The command reads the installed package at render time, so these assertions are written against
 * `package.json#pi.extensions` rather than against a transcribed expected list — a twelfth entrypoint
 * must change the rendered count without any edit here or in the extension.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import devextDoctor from "../../../extensions/devext-doctor/index.js";
import type { ExtensionCommandContext } from "../../../extensions/_shared/host/pi-api.js";
import { createHarness } from "../../test-harness.js";

const declaredCount = (
  JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { pi: { extensions: string[] } }
).pi.extensions.length;

async function renderDoctor(mode: "tui" | "rpc"): Promise<string> {
  const h = createHarness(undefined, { mode });
  devextDoctor(h.pi);
  await h.commands.get("devext")!.handler("doctor", h.ctx as ExtensionCommandContext);
  const rendered = h.widgets.get("devext-doctor") ?? "";
  if (rendered !== "") return rendered;
  // RPC mode renders string-array payloads rather than a terminal component.
  return (h.widgetPayloads.get("devext-doctor") as string[] | undefined)?.join("\n") ?? "";
}

describe("/devext doctor rendering", () => {
  it("reports the declared entrypoint count and a healthy package in TUI mode", async () => {
    const rendered = await renderDoctor("tui");

    expect(rendered).toContain("[VIEW] Extension doctor");
    expect(rendered).toContain(`${declaredCount} declared entrypoint(s)`);
    expect(rendered).toContain("every entrypoint and manifest is present");
    expect(rendered).toContain("status:ok");
  });

  it("summarizes risk and ownership from the manifests rather than a static table", async () => {
    const rendered = await renderDoctor("tui");

    expect(rendered).toMatch(/risk: .*low=/u);
    expect(rendered).toMatch(/ownership: .*locus-specific=/u);
  });

  it("publishes no migration history, backlog counters or deleted fixtures", async () => {
    const tui = await renderDoctor("tui");
    const rpc = await renderDoctor("rpc");

    // The retired rows and counter labels of the superseded hand-maintained table, verbatim.
    const retired = [
      "backlog/design:",
      "omp backlog:",
      "redesign/split:",
      "fixtures/deleted:",
      "compat wrappers:",
      "omp-owned-to-import",
      "redesign-later",
      "split-required",
      "session-state-demo",
      "lifecycle-trace",
      "tools-ast-grep",
    ];
    for (const historical of retired) {
      expect(tui).not.toContain(historical);
      expect(rpc).not.toContain(historical);
    }
  });

  it("keeps the no-UI projection inside the ten-line string-array budget", async () => {
    const h = createHarness(undefined, { mode: "rpc" });
    devextDoctor(h.pi);

    await h.commands.get("devext")!.handler("doctor", h.ctx as ExtensionCommandContext);

    const payload = h.widgetPayloads.get("devext-doctor") as string[];
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.length).toBeLessThanOrEqual(10);
    expect(payload.join("\n")).toContain(`${declaredCount} declared entrypoint(s)`);
  });
});
