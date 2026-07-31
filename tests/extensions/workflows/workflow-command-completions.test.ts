import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  workflowArgumentCompletions,
  workflowFlatCommandCompletions,
} from "../../../extensions/workflows/command-completions.js";
import workflows from "../../../extensions/workflows/index.js";
import { ensureWorkflowRunDir } from "../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../extensions/workflows/runtime/workflow-result.js";
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
    const runDir = ensureWorkflowRunDir(root, runId);
    writeFileSync(workflowResultFile(runDir), JSON.stringify({ runId, ok: true, result: null, journal: [] }), "utf8");
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

  it("registers flat commands as thin routes with native argument completions", async () => {
    const root = project();
    const harness = createHarness(root);
    workflows(harness.pi);
    await emit(harness, "session_start");

    expect([...harness.commands.keys()]).toEqual(
      expect.arrayContaining([
        "workflows",
        "workflow-run",
        "workflow-stop",
        "workflow-list",
        "workflow-info",
        "workflow-status",
        "workflow-continue",
      ]),
    );
    expect(harness.commands.get("workflow-run")?.getArgumentCompletions?.("a")).toContainEqual(
      expect.objectContaining({ value: "alpha", label: "alpha" }),
    );
    expect(harness.commands.get("workflow-status")?.getArgumentCompletions?.("20260724-13")).toContainEqual(
      expect.objectContaining({ value: "20260724-130000-new" }),
    );
    expect(harness.commands.get("workflow-stop")?.getArgumentCompletions?.("")).toContainEqual(
      expect.objectContaining({ value: "last", label: "last" }),
    );
    expect(harness.commands.get("workflow-continue")?.getArgumentCompletions?.("20260724-130000-new ")).toEqual([]);
    expect(harness.commands.get("workflow-list")?.getArgumentCompletions?.("auth")).toBeNull();
  });

  it("keeps flat completion values scoped to the command argument buffer", () => {
    const root = project();
    expect(workflowFlatCommandCompletions("run", "a", root, root)).toContainEqual(
      expect.objectContaining({ value: "alpha", label: "alpha" }),
    );
    expect(workflowFlatCommandCompletions("info", "a", root, root)).toContainEqual(
      expect.objectContaining({ value: "alpha", label: "alpha" }),
    );
    expect(workflowFlatCommandCompletions("continue", "20260724-130000-new ", root, root)).toEqual([
      expect.objectContaining({ value: "20260724-130000-new --answer ", label: "--answer" }),
    ]);
  });
});
