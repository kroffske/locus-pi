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
    "design-route": ["revise", "revise", "ready"],
    cut: [["slice A: replace parser", "slice B: obsolete follow-up"], ["slice C: verify new caller"], []],
    scope: ["work", "work", "complete"],
    route: ["fix", "fix", "accept", "accept"],
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
      if (value && typeof value === "object" && "failureCause" in value) return value as never;
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

describe("actual adaptive references with real runtime and scripted children", () => {
  it("rechecks two corrections, then replaces the remaining queue", async () => {
    const h = await example("adaptive-slices");
    const result = await h.run();
    expect(result).toMatchObject({ ok: true, status: "complete" });
    const workers = h.seen.filter((r) => r.label === "implement");
    expect(workers).toHaveLength(2);
    expect(workers[0]!.prompt).toContain("slice A: replace parser");
    expect(workers[1]!.prompt).toContain("slice C: verify new caller");
    expect(workers[1]!.prompt).not.toContain("slice B: obsolete follow-up");
    expect(h.counts.correct).toBe(2);
    expect(h.counts.review).toBe(4);
    const labels = h.seen.map((r) => r.label);
    expect(labels.slice(labels.indexOf("implement"), labels.indexOf("record"))).toEqual([
      "implement",
      "review",
      "arbiter",
      "route",
      "correct",
      "review",
      "arbiter",
      "route",
      "correct",
      "review",
      "arbiter",
      "route",
    ]);
    expect(h.seen.find((r) => r.label === "record")!.prompt).toContain("correct evidence");
    expect(h.seen.find((r) => r.label === "intake")!.prompt).toContain("No special acceptance file is required");
    expect(h.runtime.getJournal().filter((line) => line.kind === "agent_end")).toHaveLength(h.seen.length);
  });
  it("reaches final verification after three twice-corrected slices within the teaching allowance", async () => {
    const h = await example("adaptive-slices", {
      cut: [["A"], ["B"], ["C"], []],
      scope: ["work", "work", "work", "complete"],
      route: ["fix", "fix", "accept", "fix", "fix", "accept", "fix", "fix", "accept"],
    });
    expect(await h.run()).toMatchObject({ ok: true });
    expect(h.counts.implement).toBe(3);
    expect(h.counts.correct).toBe(6);
    expect(h.counts.review).toBe(9);
    expect(h.seen).toHaveLength(57);
  });
  it("bounds recuts cumulatively and returns the untruncated remainder", async () => {
    const remaining = ["still required A", "still required B", "still required C", "still required D"];
    const h = await example("adaptive-slices", { cut: [remaining], scope: ["work"], route: ["accept"] });
    expect(await h.run()).toMatchObject({ ok: false, status: "incomplete", reason: "slice_allowance", remaining });
    expect(h.counts.implement).toBe(3);
    expect(h.counts.cut).toBe(4);
  });
  it.each([
    { scope: ["needs_owner"] },
    { scope: ["blocked"] },
    { scope: ["work"], cut: [[]] },
    { scope: ["complete"], cut: [["unfinished"]] },
  ])("does not implement an inconsistent scope: %j", async (overrides) => {
    const h = await example("adaptive-slices", overrides);
    expect(await h.run()).toMatchObject({ ok: false });
    expect(h.counts.implement).toBeUndefined();
  });
  it("returns the latest reviewed work when repeated correction uses the allowance", async () => {
    const h = await example("adaptive-slices", { route: ["fix"] });
    expect(await h.run()).toMatchObject({
      ok: false,
      status: "incomplete",
      reason: "review_allowance",
      currentWork: "correct evidence",
    });
    expect(h.counts.implement).toBe(1);
    expect(h.counts.correct).toBe(2);
    expect(h.counts.review).toBe(3);
    expect(h.counts.record).toBeUndefined();
  });
  it("gives a failed final reviewer and successful sibling to substantive arbitration", async () => {
    const failed = {
      ok: false,
      status: "failed",
      failureCause: "provider-error",
      summary: "review unavailable",
      diagnostics: ["provider failure"],
    };
    const h = await example("adaptive-slices", { tests: [failed], verdict: ["incomplete"] });
    const result = await h.run();
    expect(result).toMatchObject({ ok: false, status: "incomplete" });
    expect(result.verification[0]).toContain("Cause: provider-error");
    expect(result.verification[1]).toContain("integration evidence");
    const prompt = h.seen.find((r) => r.label === "final-arbiter")!.prompt;
    expect(prompt).toContain("No accepted agent answer");
    expect(prompt).toContain("integration evidence");
  });
  it("propagates raw reviewer errors without reaching an arbiter", async () => {
    const h = await example("adaptive-slices", { review: [new Error("host failed")] });
    await expect(h.run()).rejects.toThrow("host failed");
    expect(h.counts.arbiter).toBeUndefined();
  });
  it("repairs design residuals after the second review without creating implementation", async () => {
    const h = await example("adaptive-design", {
      "design-review": ["nine defects", "bad test link; state owner missing; claim unverified", "all criteria checked"],
      "design-correct": ["first revised candidate", "corrected link and ownership; claim explicitly unverified"],
    });
    const result = await h.run();
    expect(isWorkflowResultExplicitFailure(result)).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      status: "ready",
      candidate: "corrected link and ownership; claim explicitly unverified",
    });
    expect(result.next_action).toContain("author a separate workflow");
    expect(h.counts["design-correct"]).toBe(2);
    expect(h.counts["design-review"]).toBe(3);
    expect(h.seen.filter((r) => r.label === "design-arbiter")[1]!.prompt).toContain("bad test link");
    expect(h.counts.implement).toBeUndefined();
  });
  it.each(["retry_review", "ready", "needs_owner", "stop"])(
    "preserves an empty review outcome for arbiter route %s",
    async (route) => {
      const h = await example("adaptive-design", {
        "design-review": ["", "later review"],
        "design-route": [route, "ready"],
      });
      const result = await h.run();
      expect(h.seen.find((r) => r.label === "design-arbiter")!.prompt).toContain("Cause: empty-answer");
      expect(h.counts["design-correct"]).toBeUndefined();
      expect(result.ok).toBe(route === "retry_review" || route === "ready");
      expect(h.counts["design-review"]).toBe(route === "retry_review" ? 2 : 1);
    },
  );
  it("publishes an incomplete specification at the limit without an unreviewed correction", async () => {
    const h = await example("adaptive-design", { "design-route": ["revise"] });
    expect(await h.run()).toMatchObject({
      ok: false,
      reason: "review_allowance",
      candidate: "design-correct evidence",
    });
    expect(h.counts["design-correct"]).toBe(2);
    expect(h.counts["design-review"]).toBe(3);
  });
});
