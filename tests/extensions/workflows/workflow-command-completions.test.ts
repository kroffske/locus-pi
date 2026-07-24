import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import workflows, { workflowArgumentCompletions } from "../../../extensions/workflows/index.js";
import { createHarness, emit } from "../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-completions-"));
  roots.push(root);
  const workflowsDir = path.join(root, ".pi", "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(
    path.join(workflowsDir, "alpha.workflow.mjs"),
    'export const meta={name:"alpha",description:"Alpha workflow"}; export default async()=>null;\n',
    "utf8",
  );
  for (const runId of ["20260724-120000-old", "20260724-130000-new"]) {
    const runDir = path.join(root, ".locus", "runtime", "workflows", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, "result.json"),
      JSON.stringify({ runId, ok: true, result: null, journal: [] }),
      "utf8",
    );
  }
  return root;
}

describe("workflow command argument completion", () => {
  it("returns full argument strings for grammar-owned tokens and yields free text and paths", async () => {
    const root = project();
    const harness = createHarness(root);
    harness.ctx.cwd = root;
    workflows(harness.pi);
    await emit(harness, "session_start");
    const complete = harness.commands.get("workflows")?.getArgumentCompletions;
    expect(complete).toBeTypeOf("function");
    if (complete === undefined) throw new Error("expected workflow argument completion");

    expect(complete("st")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "status " }),
        expect.objectContaining({ value: "stop " }),
      ]),
    );
    expect(complete("run a")).toContainEqual(expect.objectContaining({ value: "run alpha", label: "alpha" }));
    expect(complete("info a")).toContainEqual(expect.objectContaining({ value: "info alpha", label: "alpha" }));
    expect(complete("status 20260724-13")).toContainEqual(
      expect.objectContaining({ value: "status 20260724-130000-new" }),
    );
    expect(complete("stop ")).toContainEqual(expect.objectContaining({ value: "stop last" }));
    expect(complete("run alpha ")).toEqual([
      expect.objectContaining({ value: "run alpha --resume ", label: "--resume" }),
    ]);
    expect(complete("run alpha --res")).toEqual([
      expect.objectContaining({ value: "run alpha --resume ", label: "--resume" }),
    ]);
    expect(complete("run alpha --resume 20260724-13")).toContainEqual(
      expect.objectContaining({ value: "run alpha --resume 20260724-130000-new" }),
    );
    expect(complete("run alpha review current changes")).toBeNull();
    expect(complete("run ./local.workflow.mjs")).toBeNull();
    expect(complete("list auth")).toBeNull();
    expect(complete("unknown tail")).toBeNull();
  });

  it("keeps the exported provider structurally usable without a live Pi context", () => {
    const root = project();
    expect(workflowArgumentCompletions("run a", root, root)).toContainEqual(
      expect.objectContaining({ value: "run alpha" }),
    );
  });
});
