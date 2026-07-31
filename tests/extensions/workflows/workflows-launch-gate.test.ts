import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHarness } from "../../test-harness.js";
import workflows from "../../../extensions/workflows/index.js";
import * as runner from "../../../extensions/workflows/runtime/workflow-runner.js";
import { workflowResultFile } from "../../../extensions/workflows/runtime/workflow-result.js";

function registerHarness() {
  const h = createHarness();
  workflows(h.pi);
  return h;
}

function registerCommandHarness(root: string) {
  const h = createHarness(root);
  workflows(h.pi);
  return h;
}

async function waitForBackground(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await Promise.resolve();
}

describe("/workflows run launch gate", () => {
  it("warns that native exec approval does not sandbox trusted workflow JavaScript", () => {
    const h = registerHarness();
    const tool = h.tools.get("workflow")!;

    expect(tool.approval).toBe("exec");
    expect(tool.description).toContain("full Node.js/module access");
    expect(tool.description).toContain("not sandboxed");
    expect(tool.formatApprovalDetails?.({ name: "reviewed-workflow" })).toEqual([
      "Workflow: reviewed-workflow",
      "Surface: trusted-file workflow runner",
      "Trust: reviewed JavaScript with full Node.js/module access in the Pi host process",
      "Isolation: none — exec approval is consent, not a sandbox",
    ]);
  });

  it("runs an explicit operator command without a second approval prompt", async () => {
    const h = registerHarness();
    const approval = vi.spyOn(h.ctx.ui, "select");
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
      runId: "run-1",
      runDir: "/tmp/run-1",
      ok: true,
      result: { ok: true },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-1/result.json" },
    });
    try {
      await h.commands.get("workflows")!.handler("run live-smoke hello", h.ctx);
      expect(approval).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ script: "live-smoke", input: "hello" });
      expect(h.statuses.get("locus")).toContain("WF launch · operator cmd");
      expect(h.statuses.has("workflows")).toBe(false);
      expect(h.entries.some((entry) => entry.type === "decision")).toBe(false);
    } finally {
      approval.mockRestore();
      spy.mockRestore();
    }
  });

  it("rejects oversized effective command input before creating a workflow run", async () => {
    const h = registerHarness();
    const spy = vi.spyOn(runner, "runWorkflowScript");
    try {
      await h.commands.get("workflows")!.handler(`run live-smoke   ${"x".repeat(16_001)}   `, h.ctx);

      expect(spy).not.toHaveBeenCalled();
      const widget = h.widgets.get("workflows") ?? "";
      expect(widget).toContain("exceeds the 16000-character limit after command trimming");
      expect(widget).toContain("No workflow execution was started");
    } finally {
      spy.mockRestore();
    }
  });

  it("fails a busy streaming slash run closed before transcript or workflow execution", async () => {
    const h = createHarness(process.cwd(), { isStreaming: true });
    workflows(h.pi);
    const spy = vi.spyOn(runner, "runWorkflowScript");
    try {
      await h.commands.get("workflows")!.handler("run live-smoke", h.ctx);

      expect(h.ctx.isIdle()).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(h.sentMessages).toEqual([]);
      expect(h.customMessageDeliveries).toEqual([]);
      expect(h.notificationEvents).toEqual([]);
      const widget = h.widgets.get("workflows") ?? "";
      expect(widget).toContain("[WARN]");
      expect(widget).toContain("Workflow not started: Pi is busy streaming.");
      expect(widget).toContain("No workflow execution was started.");
      expect(widget).toContain("Recovery: wait for the current response to finish");
    } finally {
      spy.mockRestore();
    }
  });

  it("persists an idle slash run without steering or starting a model turn", async () => {
    const h = createHarness(process.cwd(), { isStreaming: false });
    workflows(h.pi);
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      request.onRunStart?.({ runId: "run-idle", runDir: "/tmp/run-idle" });
      return {
        runId: "run-idle",
        runDir: "/tmp/run-idle",
        ok: true,
        result: { summary: "idle complete" },
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-idle/result.json" },
      };
    });
    try {
      await h.commands.get("workflows")!.handler("run live-smoke", h.ctx);
      await waitForBackground(() => h.sentMessages.length === 1);

      expect(h.ctx.isIdle()).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(h.sentMessages).toHaveLength(1);
      expect(
        h.sentMessages.every((entry) => entry.options?.triggerTurn === false && entry.options.deliverAs === undefined),
      ).toBe(true);
      expect(h.customMessageDeliveries).toEqual(["append"]);
      expect(h.waitForIdleCalls).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("holds a one-shot slash run open until the workflow settles", async () => {
    const h = createHarness(process.cwd(), { isStreaming: false, mode: "print" });
    workflows(h.pi);
    let releaseRun: (() => void) | undefined;
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      request.onRunStart?.({ runId: "run-headless", runDir: "/tmp/run-headless" });
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return {
        runId: "run-headless",
        runDir: "/tmp/run-headless",
        ok: true,
        result: { summary: "headless complete" },
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-headless/result.json" },
      };
    });
    try {
      // `pi -p` disposes the session when the turn ends, so a detached run would
      // lose its ctx before the first child session. The command must not resolve
      // while the run is still in flight.
      let settled = false;
      const headless = Promise.resolve(h.commands.get("workflows")!.handler("run live-smoke", h.ctx)).then(() => {
        settled = true;
      });
      await waitForBackground(() => releaseRun !== undefined);
      expect(settled).toBe(false);
      releaseRun!();
      await headless;
      expect(settled).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns immediately in a session that outlives the turn", async () => {
    const h = createHarness(process.cwd(), { isStreaming: false });
    workflows(h.pi);
    let releaseRun: (() => void) | undefined;
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      request.onRunStart?.({ runId: "run-ui", runDir: "/tmp/run-ui" });
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return {
        runId: "run-ui",
        runDir: "/tmp/run-ui",
        ok: true,
        result: { summary: "ui complete" },
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-ui/result.json" },
      };
    });
    try {
      await h.commands.get("workflows")!.handler("run live-smoke", h.ctx);
      // A `tui` session (and a long-lived `rpc` one) outlives the turn, so the run
      // stays detached and the operator keeps the prompt while the panel streams.
      await waitForBackground(() => releaseRun !== undefined);
      expect(releaseRun).toBeDefined();
      releaseRun!();
    } finally {
      spy.mockRestore();
    }
  });

  it("buffers an idle-launched command through a later streaming interval and appends only after settled", async () => {
    const h = createHarness(process.cwd(), { isStreaming: false });
    workflows(h.pi);
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      request.onRunStart?.({ runId: "run-toctou", runDir: "/tmp/run-toctou" });
      h.setStreaming(true);
      return {
        runId: "run-toctou",
        runDir: "/tmp/run-toctou",
        ok: true,
        result: { summary: "settled complete", rawSecret: { hidden: true } },
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-toctou/result.json" },
      };
    });
    try {
      const command = Promise.resolve(h.commands.get("workflows")!.handler("run live-smoke", h.ctx));
      for (let attempt = 0; attempt < 20 && h.waitForIdleCalls === 0; attempt += 1) await Promise.resolve();

      expect(h.ctx.isIdle()).toBe(false);
      expect(h.waitForIdleCalls).toBe(1);
      // The run-boundary banner is published at launch, while the session is
      // still idle; nothing else is sent while the host streams.
      expect(h.sentMessages).toHaveLength(1);
      expect(h.sentMessages[0]?.message.details).toMatchObject({ eventKind: "workflow_start" });
      expect(h.customMessageDeliveries).toEqual(["append"]);

      h.setStreaming(false);
      await command;
      await waitForBackground(() => h.sentMessages.length === 2);

      expect(h.sentMessages).toHaveLength(2);
      expect(h.customMessageDeliveries).toEqual(["append", "append"]);
      expect(h.customMessageDeliveries).not.toContain("steer");
      expect(h.customMessageDeliveries).not.toContain("followUp");
      expect(h.customMessageDeliveries).not.toContain("turn");
      const digest = String(h.sentMessages[1]?.message.content ?? "");
      expect(digest).toContain("settled complete");
      expect(digest).not.toContain("rawSecret");
      expect(digest).not.toContain("hidden");
    } finally {
      h.setStreaming(false);
      spy.mockRestore();
    }
  });

  it("keeps the programmatic workflow tool on one native toolResult during a streaming-host hazard", async () => {
    const h = registerHarness();
    const sendMessage = vi.fn(() => {
      throw new Error("sendMessage is unsafe while tool output is streaming");
    });
    h.pi.sendMessage = sendMessage;
    const errorLine = { ts: "t", runId: "run-2", kind: "error" as const, message: "same failure" };
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (request) => {
      request.onRunStart?.({ runId: "run-2", runDir: "/tmp/run-2" });
      request.onEvent?.(errorLine);
      return {
        runId: "run-2",
        runDir: "/tmp/run-2",
        ok: false,
        result: null,
        error: "same failure",
        journal: [errorLine],
        resultPersistence: { ok: true, path: "/tmp/run-2/result.json" },
      };
    });
    try {
      const result = await h.tools
        .get("workflow")!
        .execute("tool-2", { name: "live-smoke" }, new AbortController().signal, () => void 0, h.ctx);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(result.content).toHaveLength(1);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(text).toContain("── workflow live-smoke · run #run2 · failed ");
      expect(text.match(/same failure/g)).toHaveLength(1);
      // Three lines, not two: a failed run also names the command that prints
      // the reason, which its clipped verdict line cannot carry.
      expect(text).toContain("read the full reason: /workflows status");
      expect(result.details?.transcript).toEqual({ surface: "tool", eventKind: "workflow_end", lineCount: 3 });
      expect(h.entries.some((entry) => entry.type === "decision")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("passes resume metadata to the workflow run call without a Locus approval request", async () => {
    const h = registerHarness();
    const approval = vi.spyOn(h.ctx.ui, "select");
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
      runId: "run-3",
      runDir: "/tmp/run-3",
      ok: true,
      result: { ok: true },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-3/result.json" },
    });
    try {
      await h.commands.get("workflows")!.handler("run live-smoke --resume run-old input", h.ctx);
      expect(approval).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ resumeFromRunId: "run-old", input: "input" }));
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ script: "live-smoke" });
      expect(h.entries.some((entry) => entry.type === "decision")).toBe(false);
    } finally {
      approval.mockRestore();
      spy.mockRestore();
    }
  });

  it("keeps the programmatic workflow tool headless", async () => {
    const h = registerHarness();
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
      runId: "run-4",
      runDir: "/tmp/run-4",
      ok: true,
      result: { ok: true },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-4/result.json" },
    });
    try {
      await h.tools
        .get("workflow")!
        .execute("tool-1", { name: "live-smoke" }, new AbortController().signal, () => void 0, h.ctx);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "live-smoke" });
      expect(h.entries.some((entry) => entry.type === "decision")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the programmatic workflow tool awaited until its runner settles", async () => {
    const h = registerHarness();
    let resolveRunner!: (result: runner.RunWorkflowScriptResult) => void;
    const pendingRunner = new Promise<runner.RunWorkflowScriptResult>((resolve) => {
      resolveRunner = resolve;
    });
    const spy = vi.spyOn(runner, "runWorkflowScript").mockReturnValue(pendingRunner);
    try {
      let settled = false;
      const toolResult = Promise.resolve(
        h.tools
          .get("workflow")!
          .execute("tool-awaited", { name: "live-smoke" }, new AbortController().signal, () => void 0, h.ctx),
      ).then((result) => {
        settled = true;
        return result;
      });
      await Promise.resolve();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      resolveRunner({
        runId: "run-awaited",
        runDir: "/tmp/run-awaited",
        ok: true,
        result: { summary: "awaited complete" },
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-awaited/result.json" },
      });
      const result = await toolResult;
      expect(settled).toBe(true);
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("awaited complete") });
    } finally {
      spy.mockRestore();
    }
  });

  it("renders the exact terminal text for the operator while keeping model tool content bounded", async () => {
    const h = registerHarness();
    const terminalText = `${"Complete plan line. ".repeat(600)}\nUNTRUNCATED_TERMINAL_SENTINEL`;
    const runDir = mkdtempSync(path.join(os.tmpdir(), "workflow-tool-full-result-"));
    const outputDir = path.join(runDir, "outputs");
    mkdirSync(outputDir);
    writeFileSync(path.join(outputDir, "workflow-result.md"), `${terminalText}\n`, "utf8");
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
      runId: "run-full-result",
      runDir,
      ok: true,
      result: terminalText,
      resultTextPath: path.join(outputDir, "workflow-result.md"),
      primaryOutputPath: path.join(outputDir, "plan.md"),
      journal: [],
      resultPersistence: { ok: true, path: path.join(runDir, "runtime", "result.json") },
    });
    try {
      const tool = h.tools.get("workflow")!;
      const result = await tool.execute(
        "tool-full-result",
        { name: "plan" },
        new AbortController().signal,
        () => void 0,
        h.ctx,
      );
      const modelText = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(modelText).not.toContain("UNTRUNCATED_TERMINAL_SENTINEL");
      expect(result.details).not.toHaveProperty("humanResultText");

      const operatorText = tool.renderResult!(result, h.ctx).render(80).join("\n");
      expect(operatorText).toContain("outputs:");
      expect(operatorText).toContain("primary output:");
      expect(operatorText).toContain("workflow-result.md");
      expect(operatorText).toContain("UNTRUNCATED_TERMINAL_SENTINEL");
    } finally {
      spy.mockRestore();
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("invalid path escape runs once, writes failed result evidence, and records no approval decision", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-launch-"));
    try {
      const h = createHarness(root);
      workflows(h.pi);
      const approval = vi.spyOn(h.ctx.ui, "select");
      const spy = vi.spyOn(runner, "runWorkflowScript");
      await h.commands.get("workflows")!.handler("run ../escape", h.ctx);
      expect(approval).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledTimes(1);
      const result = await spy.mock.results[0]?.value;
      expect(result?.ok).toBe(false);
      expect(String(result?.error ?? "")).toContain("escapes project root");
      expect(readFileSync(workflowResultFile(result!.runDir), "utf8")).toContain("escapes project root");
      expect(h.entries.some((entry) => entry.type === "decision")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not implement Locus denial for command runs", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-launch-deny-"));
    const h = registerCommandHarness(root);
    const approval = vi.spyOn(h.ctx.ui, "select");
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
      runId: "run-deny",
      runDir: "/tmp/run-deny",
      ok: true,
      result: { ok: true },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-deny/result.json" },
    });
    try {
      await h.commands.get("workflows")!.handler("run live-smoke", h.ctx);
      expect(approval).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(h.notifications.some((message) => message.includes("Launch gate blocked"))).toBe(false);
      expect(h.statuses.get("locus")).toContain("WF launch");
      expect(h.statuses.has("workflows")).toBe(false);
      expect(Array.from(h.entries).some((entry) => entry.type === "decision")).toBe(false);
    } finally {
      approval.mockRestore();
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves saved workflows nearest the working directory through /workflows run", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-launch-"));
    try {
      mkdirSync(path.join(root, ".claude", "workflows"), { recursive: true });
      mkdirSync(path.join(root, "nested", ".claude", "workflows"), { recursive: true });
      writeFileSync(
        path.join(root, ".claude", "workflows", "same.workflow.mjs"),
        "export default () => 'root';\n",
        "utf8",
      );
      writeFileSync(
        path.join(root, "nested", ".claude", "workflows", "same.workflow.mjs"),
        "export default () => 'nested';\n",
        "utf8",
      );

      const h = registerCommandHarness(root);
      h.ctx.session = { ...h.ctx.session!, workingDirectory: path.join(root, "nested") };
      const approval = vi.spyOn(h.ctx.ui, "select");
      const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
        runId: "run-3",
        runDir: "/tmp/run-3",
        ok: true,
        result: { ok: true },
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-3/result.json" },
      });
      try {
        await h.commands.get("workflows")!.handler("run same", h.ctx);
        expect(approval).not.toHaveBeenCalled();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[0]).toMatchObject({ script: "same" });
        expect(h.statuses.get("locus")).toContain("WF launch");
        expect(h.statuses.has("workflows")).toBe(false);
        expect(h.entries.some((entry) => entry.type === "decision")).toBe(false);
      } finally {
        approval.mockRestore();
        spy.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes failed result evidence for path escapes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wf-launch-"));
    try {
      const h = registerCommandHarness(root);
      const approval = vi.spyOn(h.ctx.ui, "select");
      const spy = vi.spyOn(runner, "runWorkflowScript");
      await h.commands.get("workflows")!.handler("run ../escape", h.ctx);
      expect(approval).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledTimes(1);
      const result = spy.mock.results[0]?.value as Promise<{ ok: boolean; error?: string; runDir: string }> | undefined;
      const resolved = await result!;
      expect(resolved.ok).toBe(false);
      expect(String(resolved.error ?? "")).toContain("escapes project root");
      expect(readFileSync(workflowResultFile(resolved.runDir), "utf8")).toContain("escapes project root");
      expect(h.entries.some((entry) => entry.type === "decision")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows available example names instead of a leaked path for an unknown workflow name", async () => {
    const h = registerHarness();
    const approval = vi.spyOn(h.ctx.ui, "select");
    const spy = vi.spyOn(runner, "runWorkflowScript");
    try {
      await h.commands.get("workflows")!.handler("run definitely-not-a-real-workflow", h.ctx);
      expect(approval).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
      const widget = h.widgets.get("workflows") ?? "";
      expect(widget).toContain("Workflow not found: definitely-not-a-real-workflow");
      expect(widget).toContain("[ERROR]");
      expect(widget).toContain("Available curated Package workflows:");
      expect(widget).toContain("live-smoke");
      expect(widget).toContain("requirements-grill");
      expect(widget).toContain("review");
      expect(widget).not.toContain("plan-build-review");
      expect(widget).toContain("/workflows list");
      expect(widget).not.toContain("Cannot find module");
      expect(widget).not.toMatch(/\/[\w./-]*examples[\w./-]*\.workflow\.mjs/);
      expect(h.entries.some((entry) => entry.type === "decision")).toBe(false);
    } finally {
      approval.mockRestore();
      spy.mockRestore();
    }
  });
});
