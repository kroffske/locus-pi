import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { isWorkflowResultExplicitFailure } from "../../../../extensions/workflows/runtime/workflow-outcome.js";
import { createWorkflowArtifactStore } from "../../../../extensions/workflows/runtime/workflow-artifacts.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function example(name: string, overrides: Record<string, unknown[]> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "adaptive-example-"));
  roots.push(root);
  const seen: WorkflowAgentRequest[] = [];
  const counts: Record<string, number> = {};
  const answers: Record<string, unknown[]> = {
    acceptance: ["accepted"],
    cut: [["slice A: replace parser", "slice B: obsolete follow-up"], ["slice C: verify new caller"], []],
    scope: ["work", "work", "complete"],
    route: ["fix", "accept"],
    recheck: ["accept"],
    verdict: ["complete"],
    ...overrides,
  };
  const runtime = createWorkflowRuntime({
    runId: "adaptive-example",
    artifactPorts: createWorkflowArtifactStore({
      projectRoot: root,
      runId: "adaptive-example",
      runDir: ensureWorkflowRunDir(root, "adaptive-example"),
    }),
    agentRunner: async (request) => {
      seen.push(request);
      const label = request.label!;
      const index = counts[label] ?? 0;
      counts[label] = index + 1;
      const options = answers[label] ?? [`${label} evidence`];
      const value = options[index] ?? options.at(-1);
      if (value instanceof Error) throw value;
      return {
        ok: true,
        status: "completed",
        summary: "scripted child",
        diagnostics: [],
        text: request.returnContract ? JSON.stringify(value) : String(value),
        ...(request.returnContract
          ? { outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const } }
          : {}),
      };
    },
  });
  const module = await import(
    pathToFileURL(path.resolve(`extensions/workflows/references/examples/${name}.workflow.mjs`)).href
  );
  return { run: () => module.default(runtime.dsl, ".tasks/example"), seen, counts, runtime };
}

describe("actual adaptive reference with real workflow runtime and scripted children", () => {
  it("replaces the remaining queue and rechecks corrections before the next slice", async () => {
    const h = await example("adaptive-slices");
    const result = await h.run();
    expect(result).toMatchObject({
      ok: true,
      status: "complete",
      verification: ["tests evidence", "integration evidence"],
    });
    const workers = h.seen.filter((r) => r.label === "implement");
    expect(workers).toHaveLength(2);
    expect(workers[0]!.prompt).toContain("slice A: replace parser");
    expect(workers[1]!.prompt).toContain("slice C: verify new caller");
    expect(workers[1]!.prompt).not.toContain("slice B: obsolete follow-up");
    const labels = h.seen.map((r) => r.label);
    expect(labels.indexOf("recheck")).toBeLessThan(labels.lastIndexOf("cut"));
    expect(h.seen.filter((r) => r.label === "cut")[1]!.prompt).toContain("slice B: obsolete follow-up");
    expect(h.seen.find((r) => r.label === "record")!.prompt).toContain(
      "Current implementation/correction:\ncorrect evidence",
    );
    expect(h.counts.correct).toBe(1);
    expect(h.counts.recheck).toBe(1);
    expect(h.runtime.getJournal().filter((line) => line.kind === "agent_end")).toHaveLength(h.seen.length);
  });
  it("reaches final QA after three corrected slices within 31 logical calls", async () => {
    const h = await example("adaptive-slices", {
      cut: [["A"], ["B"], ["C"], []],
      scope: ["work", "work", "work", "complete"],
      route: ["fix"],
    });
    expect(await h.run()).toMatchObject({ ok: true });
    expect(h.counts.implement).toBe(3);
    expect(h.counts.recheck).toBe(3);
    expect(h.seen).toHaveLength(31);
  });
  it("bounds all recuts cumulatively and returns the untruncated remainder", async () => {
    const remaining = ["still required A", "still required B", "still required C", "still required D"];
    const h = await example("adaptive-slices", { cut: [remaining], scope: ["work"], route: ["accept"] });
    expect(await h.run()).toMatchObject({ ok: false, summary: "Total slice allowance exhausted.", remaining });
    expect(h.counts.implement).toBe(3);
    expect(h.counts.cut).toBe(4);
    expect(h.counts.verdict).toBeUndefined();
  });
  it.each([
    { acceptance: ["needs_owner"] },
    { scope: ["needs_owner"] },
    { scope: ["work"], cut: [[]] },
    { scope: ["complete"], cut: [["unfinished"]] },
  ])("does not implement without a consistent accepted scope: %j", async (overrides) => {
    const h = await example("adaptive-slices", overrides);
    expect(await h.run()).toMatchObject({ ok: false });
    expect(h.counts.implement).toBeUndefined();
  });
  it("stops after a failed recheck without implementing another slice", async () => {
    const h = await example("adaptive-slices", { recheck: ["blocked"] });
    expect(await h.run()).toMatchObject({ ok: false, recheck: "blocked" });
    expect(h.counts.implement).toBe(1);
    expect(h.counts.cut).toBe(1);
  });
  it("keeps adverse QA evidence in the final blocked result", async () => {
    const h = await example("adaptive-slices", { tests: ["FAIL: acceptance test failed"], verdict: ["blocked"] });
    expect(await h.run()).toMatchObject({
      ok: false,
      verification: ["FAIL: acceptance test failed", "integration evidence"],
    });
    expect(h.seen.find((r) => r.label === "verdict")!.prompt).toContain("FAIL: acceptance test failed");
  });
  it.each([new Error("required QA unavailable"), ""])(
    "a lost or empty required QA child fails before a final verdict: %s",
    async (failure) => {
      const h = await example("adaptive-slices", { tests: [failure] });
      await expect(h.run()).rejects.toThrow();
      expect(h.counts.integration).toBe(1);
      expect(h.counts.verdict).toBeUndefined();
    },
  );
  it("design returns the review and a manual next command without launching implementation", async () => {
    const h = await example("adaptive-design");
    const result = await h.run();
    expect(isWorkflowResultExplicitFailure(result)).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      status: "needs_owner",
      review: "design-review evidence",
      next_command: "/workflows run adaptive-slices -- <task-directory>",
    });
    expect(h.seen.map((r) => r.label)).toEqual(["design", "design-review", "reconcile"]);
  });
});
