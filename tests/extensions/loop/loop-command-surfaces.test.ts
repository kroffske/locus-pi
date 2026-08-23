import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerLoop } from "../../../extensions/loop/index.js";
import { registerPlan } from "../../../extensions/plan/index.js";
import { ensureWorkflowRunDir } from "../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowJournalFile } from "../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../extensions/workflows/runtime/workflow-result.js";
import { createHarness, runTool } from "../../test-harness.js";

/**
 * Characterization coverage for the `/loop` surfaces that the original
 * `loop.test.ts` never reached: the help block, the two "once" preconditions
 * (missing source, missing run id), the two input-dialog rejection reasons, the
 * workflow path through the bare `/loop` dialog, and the focus text that a
 * `/loop once goal <focus>` submit carries into the artifact.
 *
 * Every expectation below was written against the pre-split single-file
 * entrypoint and seen green there, so it pins current behavior rather than the
 * behavior the split would like to have.
 */

async function writeCompletedWorkflowRun(projectRoot: string, runId: string): Promise<void> {
  const runDir = ensureWorkflowRunDir(projectRoot, runId);
  await writeFile(
    workflowJournalFile(runDir),
    `${JSON.stringify({ ts: "2026-06-17T12:00:00.000Z", runId, kind: "phase", phase: "collect", message: "collect" })}\n`,
    "utf8",
  );
  await writeFile(workflowResultFile(runDir), JSON.stringify({ ok: true }, null, 2), "utf8");
}

describe("loop command surfaces", () => {
  it("renders the help block below the editor for /loop help and /loop ?", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-help-"));
    try {
      const h = createHarness(projectRoot);
      registerLoop(h.pi);

      h.ctx.ui.setStatus("loop", "manual");
      await h.commands.get("loop")!.handler("help", h.ctx);
      const widget = h.widgets.get("loop") ?? "";
      expect(widget).toContain("[VIEW]");
      expect(widget).toContain("Loop help");
      expect(widget).toContain("One manual continuation per submit; no auto-repeat.");
      expect(widget).toContain("/loop status — inspect eligible sources");
      expect(widget).toContain("/loop once goal [focus]");
      expect(widget).toContain("/loop once workflow <runId> [focus]");
      expect(widget).toContain("Supported sources: goal, workflow");
      expect(widget).toContain("maxSteps: 1");
      expect(widget).toContain("autoDispatch: false");
      expect(h.widgetOptions.get("loop")).toMatchObject({ placement: "belowEditor" });
      expect(h.statuses.has("loop")).toBe(false);

      h.widgets.delete("loop");
      await h.commands.get("loop")!.handler("?", h.ctx);
      expect(h.widgets.get("loop") ?? "").toContain("Loop help");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("renders the status block below the editor", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-status-placement-"));
    try {
      const h = createHarness(projectRoot);
      registerLoop(h.pi);

      await h.commands.get("loop")!.handler("status", h.ctx);
      expect(h.widgets.get("loop") ?? "").toContain("Loop status");
      expect(h.widgetOptions.get("loop")).toMatchObject({ placement: "belowEditor" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("blocks /loop once with no source and reports the two supported forms", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-no-source-"));
    try {
      const h = createHarness(projectRoot);
      registerLoop(h.pi);

      const result = await runTool(h, "loop", { action: "once" });
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({
        owner: "loop",
        source: "blocked",
        reason: "missing source: use /loop once goal or /loop once workflow <runId>",
        supportedSources: ["goal", "workflow"],
      });

      await h.commands.get("loop")!.handler("once", h.ctx);
      const widget = h.widgets.get("loop") ?? "";
      expect(widget).toContain("[WARN]");
      expect(widget).toContain("Loop continuation is blocked.");
      expect(widget).toContain("missing source: use /loop once goal or /loop once");
      expect(widget).toContain("Inspect eligibility: /loop status");
      expect(h.widgetOptions.get("loop")).toMatchObject({ placement: "aboveEditor" });
      expect(h.statuses.has("loop")).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("blocks /loop once workflow with no run id", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-no-run-id-"));
    try {
      const h = createHarness(projectRoot);
      registerLoop(h.pi);

      const result = await runTool(h, "loop", { action: "once", source: "workflow" });
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({
        owner: "loop",
        source: "blocked",
        reason: "workflow continuation requires /loop once workflow <runId>",
      });

      await h.commands.get("loop")!.handler("once workflow", h.ctx);
      const widget = h.widgets.get("loop") ?? "";
      expect(widget).toContain("Loop continuation is blocked.");
      expect(widget).toContain("workflow continuation requires /loop once workflow");
      expect(existsSync(path.join(projectRoot, ".locus", "runtime", "loop", "workflow"))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("carries the focus text of /loop once goal <focus> into the artifact prompt", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-goal-focus-"));
    try {
      const h = createHarness(projectRoot);
      registerPlan(h.pi);
      registerLoop(h.pi);
      await runTool(h, "goal", { op: "create", objective: "Ship the bounded loop focus" });

      await h.commands.get("loop")!.handler("once goal tighten the release proof", h.ctx);

      const artifact = JSON.parse(
        await readFile(path.join(projectRoot, ".locus", "runtime", "goal", "continue.md"), "utf8"),
      ) as Record<string, unknown>;
      expect(String(artifact.prompt ?? "")).toContain("tighten the release proof");
      expect(h.widgets.get("loop") ?? "").toContain("[RESULT]");
      expect(h.statuses.get("locus")).toBe("LOOP: goal");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("re-asks the bare /loop dialog for an empty submit and for a workflow with no run id", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-input-reasons-"));
    try {
      const runId = "20260617-120000-abcd";
      await writeCompletedWorkflowRun(projectRoot, runId);
      const h = createHarness(projectRoot);
      h.ctx.hasUI = true;
      registerLoop(h.pi);

      const editor = vi
        .fn()
        .mockResolvedValueOnce("   ")
        .mockResolvedValueOnce("workflow")
        .mockResolvedValueOnce(`workflow ${runId} recheck the verify phase`);
      h.ctx.ui.editor = editor as never;

      await h.commands.get("loop")!.handler("", h.ctx);

      expect(editor).toHaveBeenNthCalledWith(1, "[INPUT] Loop — goal [focus] | workflow <runId> [focus]", "goal ");
      expect(editor).toHaveBeenNthCalledWith(2, "[WARN] Loop continuation — enter goal or workflow source", "   ");
      expect(editor).toHaveBeenNthCalledWith(3, "[WARN] Loop continuation — workflow requires a run id", "workflow");

      const artifact = JSON.parse(
        await readFile(path.join(projectRoot, ".locus", "runtime", "loop", "workflow", `${runId}.json`), "utf8"),
      ) as Record<string, unknown>;
      expect(artifact).toMatchObject({ source: "workflow", runId, autoDispatch: false, maxSteps: 1 });
      expect(String(artifact.prompt ?? "")).toContain("recheck the verify phase");
      expect(h.widgets.get("loop") ?? "").toContain("[RESULT]");
      expect(h.statuses.get("locus")).toBe("LOOP: workflow");
      expect(h.sentMessages).toEqual([]);
      expect(h.sentUserMessages).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
