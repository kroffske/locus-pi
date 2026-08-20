import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import workflows from "../../../extensions/workflows/index.js";
import { createHarness, runTool } from "../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-source-check-"));
  roots.push(root);
  mkdirSync(path.join(root, ".pi", "workflows"), { recursive: true });
  return root;
}

function standardSource(body = 'return agent("Review the change");'): string {
  return `export const meta = { name: "sample", profile: "standard" };\nexport default function run({ agent }) { ${body} }\n`;
}

describe("workflow_check_source", () => {
  it("registers under the workflows owner and accepts a valid standard source", async () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, ".pi", "workflows", "sample.workflow.mjs"), standardSource());
    const harness = createHarness(root);
    workflows(harness.pi);

    expect(harness.tools.has("workflow_check_source")).toBe(true);
    expect(harness.tools.get("workflow_check_source")?.approval).toBe("read");
    const result = await runTool(harness, "workflow_check_source", {
      path: ".pi/workflows/sample.workflow.mjs",
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: ".pi/workflows/sample.workflow.mjs: standard workflow source shape passed",
    });
    expect(result.details).toEqual({
      owner: "workflows",
      path: ".pi/workflows/sample.workflow.mjs",
      errorCount: 0,
    });
  });

  it("returns every source-shape error without importing or running the target", async () => {
    const root = temporaryRoot();
    const marker = path.join(root, "executed.txt");
    writeFileSync(
      path.join(root, ".pi", "workflows", "sample.workflow.mjs"),
      `import { writeFileSync } from "node:fs";\n${standardSource('if (process.env.DEPLOY === "yes") return agent("Deploy"); return agent("Hold");')}\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`,
    );
    const harness = createHarness(root);
    workflows(harness.pi);

    const result = await runTool(harness, "workflow_check_source", {
      path: ".pi/workflows/sample.workflow.mjs",
    });

    expect(result.isError).toBe(true);
    expect(result.details?.errorCount).toBeGreaterThan(0);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(String((result.content[0] as { text: string }).text)).toContain("standard workflow source shape failed");
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects lexical and symlink escapes from the current project", async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const outsideFile = path.join(outside, "outside.workflow.mjs");
    writeFileSync(outsideFile, standardSource());
    symlinkSync(outsideFile, path.join(root, ".pi", "workflows", "linked.workflow.mjs"));
    const harness = createHarness(root);
    workflows(harness.pi);

    const lexical = await runTool(harness, "workflow_check_source", { path: "../outside.workflow.mjs" });
    const symlink = await runTool(harness, "workflow_check_source", {
      path: ".pi/workflows/linked.workflow.mjs",
    });

    expect(lexical.isError).toBe(true);
    expect(String((lexical.content[0] as { text: string }).text)).toContain("path escapes the project root");
    expect(symlink.isError).toBe(true);
    expect(String((symlink.content[0] as { text: string }).text)).toContain("through a symlink");
  });

  it("rejects an oversized source before parsing it", async () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, ".pi", "workflows", "large.workflow.mjs"), "x".repeat(512 * 1024 + 1));
    const harness = createHarness(root);
    workflows(harness.pi);

    const result = await runTool(harness, "workflow_check_source", {
      path: ".pi/workflows/large.workflow.mjs",
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text: string }).text)).toContain(
      "source exceeds the 524288-byte validation limit",
    );
  });
});
