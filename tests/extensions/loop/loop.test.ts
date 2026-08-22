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
import { createHarness, emit, runTool } from "../../test-harness.js";

function expectBoundedLoopText(text: string): void {
  const lines = text.split(/\r?\n/);
  expect(lines.length).toBeLessThanOrEqual(8);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
}

function expectCompactLoopStatusText(text: string, projectRoot: string): void {
  expectBoundedLoopText(text);
  expect(text).not.toContain(projectRoot);
  expect(text).not.toContain("path:");
}

describe("loop bounded continuation runtime", () => {
  it("registers canonical loop, reports idle status, and fails closed without a source", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-status-"));
    try {
      const h = createHarness(projectRoot);
      registerLoop(h.pi);

      const status = await runTool(h, "loop", { action: "status" });
      expect(status.isError).not.toBe(true);
      expect(status.content[0]).toMatchObject({ type: "text" });
      const statusText = status.content[0]?.type === "text" ? status.content[0].text : "";
      expect(statusText).toContain("status: idle");
      expectCompactLoopStatusText(statusText, projectRoot);
      expect(status.details).toMatchObject({ mode: "idle" });

      h.ctx.ui.setStatus("loop", "manual");
      await h.commands.get("loop")!.handler("status", h.ctx);
      const widget = h.widgets.get("loop") ?? "";
      expect(widget).toContain("[VIEW]");
      expect(widget).toContain("Loop status");
      expect(widget).toContain("status: idle");
      expect(widget).toContain("goal: missing");
      expect(widget).toContain("workflow: missing");
      expect(widget).toContain("review: unsupported");
      expect(widget).not.toContain(projectRoot);
      expect(widget.split(/\r?\n/u).every((line) => line.length <= 80)).toBe(true);
      expect(h.statuses.has("loop")).toBe(false);

      expect(h.tools.has("loopControl")).toBe(false);
      const missingSource = await runTool(h, "loop", { action: "start" });
      expect(missingSource.isError).toBe(true);
      expect(missingSource.content[0]?.type === "text" ? missingSource.content[0].text : "").toContain("no goal state");

      h.ctx.ui.setStatus("loop", "blocked");
      await h.commands.get("loop")!.handler("start goal", h.ctx);
      const blockedWidget = h.widgets.get("loop") ?? "";
      expect(blockedWidget).toContain("Loop stopped:");
      expect(h.statuses.get("loop")).not.toBe("blocked");
      expect(h.statuses.has("loop")).toBe(false);

      expect([...h.handlers.keys()].sort()).toEqual(["agent_settled", "input"]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("renders /loop status compactly when continuation sources are available", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-status-compact-"));
    try {
      const h = createHarness(projectRoot);
      registerPlan(h.pi);
      registerLoop(h.pi);

      const created = await runTool(h, "goal", {
        op: "create",
        objective: "Keep loop status compact at eighty columns",
      });
      expect(created.isError).not.toBe(true);

      const runId = "20260618-023148-6c50-extra-long-run-id-that-must-not-wrap";
      const runDir = ensureWorkflowRunDir(projectRoot, runId);
      await writeFile(
        workflowJournalFile(runDir),
        [
          JSON.stringify({ ts: "2026-06-18T02:31:48.000Z", runId, kind: "phase", phase: "verify", message: "verify" }),
        ].join("\n"),
        "utf8",
      );
      await writeFile(workflowResultFile(runDir), JSON.stringify({ ok: true }, null, 2), "utf8");

      const status = await runTool(h, "loop", { action: "status" });
      expect(status.isError).not.toBe(true);
      const statusText = status.content[0]?.type === "text" ? status.content[0].text : "";
      expect(statusText).toContain("status: manual");
      expect(statusText).toContain("goal: available");
      expect(statusText).toContain("workflow: available");
      expect(statusText).toContain("review: unsupported");
      expect(statusText).toContain("next: /loop once goal");
      expectCompactLoopStatusText(statusText, projectRoot);
      expect(status.details).toMatchObject({ mode: "manual", recommendedSource: "goal" });

      h.ctx.ui.setStatus("loop", "manual");
      await h.commands.get("loop")!.handler("status", h.ctx);
      const widget = h.widgets.get("loop") ?? "";
      expect(widget).toContain("[VIEW]");
      expect(widget).toContain("Loop status");
      expect(widget).toContain("status: manual");
      expect(widget).toContain("workflow: available");
      expect(widget).not.toContain(projectRoot);
      expect(widget.split(/\r?\n/u).every((line) => line.length <= 80)).toBe(true);
      expect(h.statuses.has("loop")).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("auto-dispatches bounded follow-ups and stops at the hard iteration limit", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-active-"));
    try {
      const h = createHarness(projectRoot, { sessionId: "loop-session" });
      registerPlan(h.pi);
      registerLoop(h.pi);
      await runTool(h, "goal", { op: "create", objective: "Complete two bounded steps" });

      const started = await runTool(h, "loop", {
        action: "until",
        source: "goal",
        condition: "two bounded steps are complete",
        maxIterations: 2,
        maxDurationMinutes: 5,
      });
      expect(started.isError).not.toBe(true);
      expect(h.sentMessages).toHaveLength(1);
      expect(JSON.stringify(h.sentMessages[0])).toContain("iteration 1/2");
      expect(JSON.stringify(h.sentMessages[0])).toContain("two bounded steps are complete");

      await emit(h, "agent_settled");
      expect(h.sentMessages).toHaveLength(1);
      await emit(h, "agent_settled");
      expect(h.sentMessages).toHaveLength(2);
      await emit(h, "agent_settled");

      const status = await runTool(h, "loop", { action: "status" });
      expect(status.details).toMatchObject({ status: "stopped", iteration: 2, maxIterations: 2 });
      expect(status.content[0]?.type === "text" ? status.content[0].text : "").toContain(
        "stopReason: maximum iteration limit reached",
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for unsupported sources on /loop once", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-unsupported-source-"));
    try {
      const h = createHarness(projectRoot);
      registerLoop(h.pi);

      h.ctx.ui.setStatus("loop", "blocked");
      await h.commands.get("loop")!.handler("once archive", h.ctx);
      expect(h.statuses.get("loop")).not.toBe("blocked");
      expect(h.statuses.has("loop")).toBe(false);
      expect(h.widgets.get("loop")).toContain("Loop continuation is blocked.");
      expect(h.widgets.get("loop")).toContain("unsupported loop source: archive");
      expect(existsSync(path.join(projectRoot, ".locus", "runtime", "goal", "continue.md"))).toBe(false);
      expect(existsSync(path.join(projectRoot, ".locus", "runtime", "loop", "workflow", "archive.json"))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("reuses the goal continuation contract through /loop once goal", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-goal-"));
    try {
      const h = createHarness(projectRoot);
      registerPlan(h.pi);
      registerLoop(h.pi);

      const created = await runTool(h, "goal", { op: "create", objective: "Ship the loop wrapper" });
      expect(created.isError).not.toBe(true);

      const status = await runTool(h, "loop", { action: "status" });
      expect(status.isError).not.toBe(true);
      expect(status.details).toMatchObject({ mode: "manual", recommendedSource: "goal" });
      const continuePath = path.join(projectRoot, ".locus", "runtime", "goal", "continue.md");
      expect(existsSync(continuePath)).toBe(false);

      await h.commands.get("loop")!.handler("once goal", h.ctx);
      const widget = h.widgets.get("loop") ?? "";
      expect(widget).toContain("[RESULT]");
      expect(widget).toContain("One bounded continuation is ready; it was not auto-dispatched.");
      expect(widget).toContain("[GOAL]");
      expect(widget).toContain("autoDispatch: false");
      expect(widget).toContain("maxSteps: 1");
      expect(widget).not.toContain("Do not auto-dispatch a child agent or model call.");
      expect(widget).not.toContain("Final result:");
      expect(widget).not.toContain("widget truncated");
      expect(widget.split(/\r?\n/).length).toBeLessThanOrEqual(10);
      expect(widget.split(/\r?\n/).every((line) => line.length <= 80)).toBe(true);
      expect(h.statuses.get("locus")).toBe("LOOP: goal");
      expect(h.statuses.has("loop")).toBe(false);

      const artifact = JSON.parse(
        await readFile(path.join(projectRoot, ".locus", "runtime", "goal", "continue.md"), "utf8"),
      ) as Record<string, unknown>;
      expect(artifact).toMatchObject({
        version: 1,
        autoDispatch: false,
        status: "manual",
        maxSteps: 1,
        stopReason: "continuation is a bounded next prompt artifact, not auto-dispatch",
      });
      expect(String(artifact.prompt ?? "")).toContain("Task:");
      expect(String(artifact.prompt ?? "")).toContain("Final result:");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("exposes bounded goal continuation metadata on /loop once goal", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-goal-metadata-"));
    try {
      const h = createHarness(projectRoot);
      registerPlan(h.pi);
      registerLoop(h.pi);

      const created = await runTool(h, "goal", { op: "create", objective: "Ship the loop wrapper" });
      expect(created.isError).not.toBe(true);

      const result = await runTool(h, "loop", { action: "once", source: "goal" });
      const details = result.details as
        | {
            owner?: string;
            source?: string;
            autoDispatch?: boolean;
            status?: string;
            maxSteps?: number;
            prompt?: string;
            sourceMetadata?: { goalId?: string; goalStatus?: string; objective?: string };
          }
        | undefined;

      expect(result.isError).not.toBe(true);
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Loop continuation saved.");
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("source: goal");
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("autoDispatch: false");
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("maxSteps: 1");
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").not.toContain("Final result:");
      expect(details).toMatchObject({
        owner: "loop",
        source: "goal",
        autoDispatch: false,
        status: "manual",
        maxSteps: 1,
        sourceMetadata: {
          goalStatus: "active",
          objective: "Ship the loop wrapper",
        },
      });
      expect(String(details?.prompt ?? "")).toContain("Task:");
      expect(String(details?.prompt ?? "")).toContain("Final result:");

      const artifact = JSON.parse(
        await readFile(path.join(projectRoot, ".locus", "runtime", "goal", "continue.md"), "utf8"),
      ) as Record<string, unknown>;
      expect(artifact).toMatchObject({
        version: 1,
        goalId: details?.sourceMetadata?.goalId,
        objective: "Ship the loop wrapper",
        autoDispatch: false,
        status: "manual",
        maxSteps: 1,
      });
      expect(String(artifact.prompt ?? "")).toContain("Task:");
      expect(String(artifact.prompt ?? "")).toContain("Final result:");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("reports blocked status when the goal source is complete", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-blocked-"));
    try {
      const h = createHarness(projectRoot);
      registerPlan(h.pi);
      registerLoop(h.pi);

      await runTool(h, "goal", { op: "create", objective: "Retire the goal source" });
      await runTool(h, "goal", { op: "complete" });

      const status = await runTool(h, "loop", { action: "status" });
      expect(status.isError).not.toBe(true);
      const statusText = status.content[0]?.type === "text" ? status.content[0].text : "";
      expect(statusText).toContain("status: blocked");
      expectCompactLoopStatusText(statusText, projectRoot);
      expect(status.details).toMatchObject({ mode: "blocked" });

      await h.commands.get("loop")!.handler("status", h.ctx);
      const widget = h.widgets.get("loop") ?? "";
      expect(widget).toContain("[VIEW]");
      expect(widget).toContain("status: blocked");
      expect(widget).toContain("goal: blocked");
      expect(widget).not.toContain(projectRoot);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("creates workflow continuations from persisted run metadata", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-workflow-"));
    try {
      const h = createHarness(projectRoot);
      registerLoop(h.pi);

      const runId = "20260617-120000-abcd";
      const runDir = ensureWorkflowRunDir(projectRoot, runId);
      await writeFile(
        workflowJournalFile(runDir),
        [
          JSON.stringify({
            ts: "2026-06-17T12:00:00.000Z",
            runId,
            kind: "phase",
            phase: "collect",
            message: "collect",
          }),
        ].join("\n"),
        "utf8",
      );
      await writeFile(workflowResultFile(runDir), JSON.stringify({ ok: true }, null, 2), "utf8");

      const result = await runTool(h, "loop", { action: "once", source: "workflow", runId });
      expect(result.isError).not.toBe(true);
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("source: workflow");
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(`runId: ${runId}`);
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("autoDispatch: false");
      expect(result.details).toMatchObject({
        owner: "loop",
        source: "workflow",
        sourceId: runId,
        runStatus: "completed",
        autoDispatch: false,
        status: "manual",
        maxSteps: 1,
        sourceMetadata: {
          runId,
          runStatus: "completed",
          sourcePath: path.join(projectRoot, ".locus-pi", "runs", runId),
        },
      });
      expect(String(result.details?.sourceSummary ?? "")).toContain("status: completed");
      expect(String(result.details?.prompt ?? "")).toContain("Task:");
      expect(String(result.details?.prompt ?? "")).toContain("Final result:");

      const artifact = JSON.parse(
        await readFile(path.join(projectRoot, ".locus", "runtime", "loop", "workflow", `${runId}.json`), "utf8"),
      ) as Record<string, unknown>;
      expect(artifact).toMatchObject({
        version: 1,
        source: "workflow",
        runId,
        autoDispatch: false,
        status: "manual",
        maxSteps: 1,
      });
      expect(String(artifact.sourceSummary ?? "")).toContain("status: completed");
      expect(String(artifact.prompt ?? "")).toContain("Task:");
      expect(String(artifact.prompt ?? "")).toContain("Final result:");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when workflow metadata is missing", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-missing-workflow-"));
    try {
      const h = createHarness(projectRoot);
      registerLoop(h.pi);

      const artifactPath = path.join(projectRoot, ".locus", "runtime", "loop", "workflow", "missing-run.json");
      expect(existsSync(artifactPath)).toBe(false);

      const result = await runTool(h, "loop", { action: "once", source: "workflow", runId: "missing-run" });
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ owner: "loop", source: "blocked" });
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
        "Loop continuation is blocked.",
      );
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
        "workflow continuation failed: No workflow metadata found for run missing-run.",
      );
      expect(existsSync(artifactPath)).toBe(false);

      await h.commands.get("loop")!.handler("once workflow missing-run", h.ctx);
      expect(h.widgets.get("loop")).toContain("Loop continuation is blocked.");
      expect(h.widgets.get("loop")).toContain("workflow continuation failed: No workflow metadata found for run");
      expect(h.widgets.get("loop")).toContain("missing-run.");
      expect(existsSync(artifactPath)).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("bare /loop accepts one bounded goal continuation without dispatching a model turn", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-bare-submit-"));
    try {
      const h = createHarness(projectRoot);
      h.ctx.hasUI = true;
      h.ctx.ui.editor = async (title, prefill) => {
        expect(title).toBe("[INPUT] Loop — goal [focus] | workflow <runId> [focus]");
        expect(prefill).toBe("goal ");
        return "goal verify the release proof" as never;
      };
      registerPlan(h.pi);
      registerLoop(h.pi);
      await runTool(h, "goal", { op: "create", objective: "Ship the bounded loop input" });

      await h.commands.get("loop")!.handler("", h.ctx);

      const artifactPath = path.join(projectRoot, ".locus", "runtime", "goal", "continue.md");
      const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as Record<string, unknown>;
      expect(artifact).toMatchObject({ autoDispatch: false, maxSteps: 1, status: "manual" });
      expect(String(artifact.prompt)).toContain("verify the release proof");
      expect(h.widgets.get("loop")).toContain("[RESULT]");
      expect(h.statuses.get("locus")).toBe("LOOP: goal");
      expect(h.sentMessages).toEqual([]);
      expect(h.sentUserMessages).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("bare /loop preserves invalid input when reopening and writes only after valid submit", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-bare-invalid-"));
    try {
      const h = createHarness(projectRoot);
      h.ctx.hasUI = true;
      registerPlan(h.pi);
      registerLoop(h.pi);
      await runTool(h, "goal", { op: "create", objective: "Repair invalid loop input" });
      const editor = vi.fn().mockResolvedValueOnce("archive stale").mockResolvedValueOnce("goal corrected focus");
      h.ctx.ui.editor = editor as never;

      await h.commands.get("loop")!.handler("", h.ctx);

      expect(editor).toHaveBeenNthCalledWith(1, "[INPUT] Loop — goal [focus] | workflow <runId> [focus]", "goal ");
      expect(editor).toHaveBeenNthCalledWith(
        2,
        "[WARN] Loop continuation — use goal or workflow source",
        "archive stale",
      );
      const artifactPath = path.join(projectRoot, ".locus", "runtime", "goal", "continue.md");
      expect(existsSync(artifactPath)).toBe(true);
      expect(h.widgets.get("loop")).toContain("[RESULT]");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("bare /loop cancel and no-UI paths do not create an artifact", async () => {
    const cancelledRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-bare-cancel-"));
    const headlessRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-bare-headless-"));
    try {
      const cancelled = createHarness(cancelledRoot);
      cancelled.ctx.hasUI = true;
      cancelled.ctx.ui.editor = async () => undefined as never;
      registerLoop(cancelled.pi);
      await cancelled.commands.get("loop")!.handler("", cancelled.ctx);
      expect(cancelled.widgets.get("loop")).toContain("[RESULT]");
      expect(cancelled.widgets.get("loop")).toContain("Cancelled; no continuation was created.");
      expect(existsSync(path.join(cancelledRoot, ".locus", "runtime", "goal", "continue.md"))).toBe(false);

      const headless = createHarness(headlessRoot, { mode: "print" });
      headless.ctx.hasUI = false;
      const editor = vi.fn();
      headless.ctx.ui.editor = editor as never;
      registerLoop(headless.pi);
      await headless.commands.get("loop")!.handler("", headless.ctx);
      expect(editor).not.toHaveBeenCalled();
      expect(headless.widgets.get("loop") ?? "").toBe("");
      expect(existsSync(path.join(headlessRoot, ".locus", "runtime", "goal", "continue.md"))).toBe(false);
    } finally {
      await rm(cancelledRoot, { recursive: true, force: true });
      await rm(headlessRoot, { recursive: true, force: true });
    }
  });

  it("bare /loop fails closed when the host returns an unsupported dialog result", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "locus-loop-bare-dialog-error-"));
    try {
      const h = createHarness(projectRoot);
      h.ctx.hasUI = true;
      h.ctx.ui.editor = async () => ({ label: "not-a-dialog-result" }) as never;
      registerLoop(h.pi);

      await expect(h.commands.get("loop")!.handler("", h.ctx)).resolves.toBeUndefined();

      expect(h.widgets.get("loop")).toContain("[ERROR]");
      expect(h.widgets.get("loop")).toContain("unsupported result");
      expect(h.widgets.get("loop")).toContain("No continuation artifact was created");
      expect(existsSync(path.join(projectRoot, ".locus", "runtime", "goal", "continue.md"))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
