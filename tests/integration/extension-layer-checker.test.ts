import { appendFile, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkExtensionLayers } from "../../scripts/check-extension-layers.js";

const fixtureRoots: string[] = [];

afterEach(async () => {
  while (fixtureRoots.length > 0) await rm(fixtureRoots.pop()!, { recursive: true, force: true });
});

describe("extension layer checker negative rules", () => {
  it("rejects a shared module importing feature code", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, "extensions/_shared/host/error-text.ts"),
      '\nimport "../../workflows/index.js";\n',
      "utf8",
    );

    await expectRule(root, "rule 1 (no upward import)");
  });

  it("rejects a shared module importing a higher layer", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, "extensions/_shared/host/error-text.ts"),
      '\nimport "../runtime/session-core.js";\n',
      "utf8",
    );

    await expectRule(root, "rule 2 (layer order)");
  });

  it("rejects an unowned shared module", async () => {
    const root = await extensionFixture();
    await writeFile(path.join(root, "extensions/_shared/host/unowned.ts"), "export const unowned = true;\n", "utf8");

    await expectRule(root, "rule 3 (complete ownership)");
  });

  it("rejects a registry symbol named outside its owner", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, "extensions/loop/index.ts"),
      '\nvoid Symbol.for("locus-pi.agent-live-store.v5");\n',
      "utf8",
    );

    await expectRule(root, "rule 4 (registry ownership)");
  });

  it("rejects an undeclared mutable shared export", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, "extensions/_shared/host/error-text.ts"),
      "\nexport const reviewMutableState = new Map<string, string>();\n",
      "utf8",
    );

    await expectRule(root, "rule 5 (mutable module state)");
  });

  it("rejects a cross-feature import that bypasses the read facade", async () => {
    const root = await extensionFixture();
    await appendFile(
      path.join(root, "extensions/loop/index.ts"),
      '\nimport "../workflows/runtime/workflow-journal.js";\n',
      "utf8",
    );

    await expectRule(root, "rule 6 (feature-internal facade)");
  });
});

async function extensionFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "locus-extension-layers-"));
  fixtureRoots.push(root);
  await cp(path.resolve("extensions"), path.join(root, "extensions"), { recursive: true });
  return root;
}

async function expectRule(root: string, message: string): Promise<void> {
  const previousExitCode = process.exitCode;
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.exitCode = undefined;
  try {
    await checkExtensionLayers(root);
    const output = error.mock.calls.flatMap((call) => call.map(String)).join("\n");
    expect(process.exitCode).toBe(1);
    expect(output).toContain(message);
  } finally {
    error.mockRestore();
    process.exitCode = previousExitCode;
  }
}
