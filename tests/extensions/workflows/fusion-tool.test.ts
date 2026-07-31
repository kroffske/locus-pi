import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import { fusionConfigPath, loadFusionConfig } from "../../../extensions/workflows/fusion-config.js";
import { runDirectFusion, type DirectFusionRunOptions } from "../../../extensions/workflows/fusion-runner.js";
import { registerFusionSurface } from "../../../extensions/workflows/fusion-surface.js";
import type { DirectFusionRunResult } from "../../../extensions/workflows/fusion-runner.js";
import workflows from "../../../extensions/workflows/index.js";
import { createHarness, emit, runTool } from "../../test-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "fusion-tool-"));
  roots.push(root);
  return root;
}

function completedDirectResult(root: string): DirectFusionRunResult {
  return {
    runId: "20260731-120000-test",
    runDir: path.join(root, ".pi", "locus-pi", "workflows", "20260731-120000-test"),
    ok: true,
    disposition: { status: "completed" },
    result: "The judge answer.",
    journal: [],
    resultPersistence: { ok: true, path: path.join(root, "result.json") },
  };
}

describe("direct Fusion surface", () => {
  it("registers a described tool but keeps it inactive by default", async () => {
    const harness = createHarness(temporaryRoot());
    harness.pi.setActiveTools(["workflow", "fusion"]);
    workflows(harness.pi);

    await emit(harness, "session_start");

    expect(harness.tools.get("fusion")?.description).toContain("standalone question");
    expect(harness.commands.has("fusion")).toBe(true);
    expect(harness.activeTools).toEqual(["workflow"]);
  });

  it("configures named available models and enables or disables the tool immediately", async () => {
    const root = temporaryRoot();
    const harness = createHarness(root, {
      models: [
        { provider: "test", id: "alpha", name: "Alpha" },
        { provider: "test", id: "beta", name: "Beta" },
        { provider: "test", id: "judge", name: "Judge" },
      ],
    });
    harness.pi.setActiveTools(["workflow"]);
    registerFusionSurface(harness.pi);
    await emit(harness, "session_start");
    const command = harness.commands.get("fusion")!;

    await command.handler("set --members test/alpha,test/beta --judge test/judge", harness.ctx);
    expect(harness.activeTools).toEqual(["workflow"]);
    await command.handler("enable", harness.ctx);
    expect(harness.activeTools).toEqual(["workflow", "fusion"]);
    harness.pi.setActiveTools(["workflow"]);
    await emit(harness, "session_start");
    expect(harness.activeTools).toEqual(["workflow", "fusion"]);
    await command.handler("disable", harness.ctx);
    expect(harness.activeTools).toEqual(["workflow"]);

    expect(await loadFusionConfig(harness.ctx)).toEqual({
      version: 1,
      enabled: false,
      members: ["test/alpha", "test/beta"],
      judge: "test/judge",
    });
    expect(JSON.parse(readFileSync(fusionConfigPath(root), "utf8"))).toMatchObject({ enabled: false });
  });

  it("offers only host-available models in the interactive selector", async () => {
    const harness = createHarness(temporaryRoot(), {
      models: [
        { provider: "test", id: "alpha", name: "Alpha" },
        { provider: "test", id: "beta", name: "Beta" },
        { provider: "test", id: "gamma", name: "Gamma" },
        { provider: "test", id: "judge", name: "Judge" },
      ],
    });
    registerFusionSurface(harness.pi);
    harness.selectQueue.push("2", "test/alpha", "test/beta", "test/judge");

    await harness.commands.get("fusion")!.handler("configure", harness.ctx);

    expect(harness.selectCalls[1]?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "test/alpha" }),
        expect.objectContaining({ value: "test/beta" }),
        expect.objectContaining({ value: "test/gamma" }),
        expect.objectContaining({ value: "test/judge" }),
      ]),
    );
    expect(await loadFusionConfig(harness.ctx)).toMatchObject({
      members: ["test/alpha", "test/beta"],
      judge: "test/judge",
    });
  });

  it("fails closed at session start when the persisted config is malformed", async () => {
    const root = temporaryRoot();
    mkdirSync(path.dirname(fusionConfigPath(root)), { recursive: true });
    writeFileSync(fusionConfigPath(root), '{"version":1,"enabled":true,"members":"invalid"}\n', "utf8");
    const harness = createHarness(root);
    harness.pi.setActiveTools(["workflow", "fusion"]);
    registerFusionSurface(harness.pi);

    await emit(harness, "session_start");

    expect(harness.activeTools).toEqual(["workflow"]);
    expect(harness.notifications).toContainEqual(expect.stringContaining("Fusion remains inactive"));
  });

  it("exposes configured Fusion to the main-session tool API without forwarding ambient history", async () => {
    const root = temporaryRoot();
    const harness = createHarness(root, {
      models: [
        { provider: "test", id: "alpha" },
        { provider: "test", id: "beta" },
        { provider: "test", id: "judge" },
      ],
    });
    const runFusion = vi.fn(async (_options: DirectFusionRunOptions) => completedDirectResult(root));
    registerFusionSurface(harness.pi, { runFusion });
    const command = harness.commands.get("fusion")!;
    await command.handler("set --members test/alpha,test/beta --judge test/judge", harness.ctx);
    await command.handler("enable", harness.ctx);

    const result = await runTool(harness, "fusion", {
      question: "Which migration is safer?",
      context: "Downtime must remain below four minutes.",
      output: "Return one paragraph.",
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "The judge answer." });
    expect(runFusion).toHaveBeenCalledOnce();
    expect(runFusion.mock.calls[0]?.[0]).toMatchObject({
      question: "Which migration is safer?",
      context: { mode: "provided", text: "Downtime must remain below four minutes." },
      members: [{ model: "test/alpha" }, { model: "test/beta" }],
      judge: { model: "test/judge" },
    });
    expect(JSON.stringify(runFusion.mock.calls[0]?.[0])).not.toContain("ambient");
  });

  it("runs a standalone question manually through /fusion run", async () => {
    const root = temporaryRoot();
    const harness = createHarness(root, {
      models: [
        { provider: "test", id: "alpha" },
        { provider: "test", id: "beta" },
        { provider: "test", id: "judge" },
      ],
    });
    const runFusion = vi.fn(async (_options: DirectFusionRunOptions) => completedDirectResult(root));
    registerFusionSurface(harness.pi, { runFusion });
    const command = harness.commands.get("fusion")!;
    await command.handler("set --members test/alpha,test/beta --judge test/judge", harness.ctx);
    await command.handler("enable", harness.ctx);

    await command.handler("run Which migration is safer?", harness.ctx);

    expect(runFusion).toHaveBeenCalledOnce();
    expect(runFusion.mock.calls[0]?.[0]).toMatchObject({ question: "Which migration is safer?" });
    expect(harness.sentMessages).toContainEqual({
      message: expect.objectContaining({ customType: "fusion-result", content: "The judge answer." }),
    });
  });

  it("fails closed before a run when a configured model is unavailable", async () => {
    const root = temporaryRoot();
    const harness = createHarness(root, {
      models: [
        { provider: "test", id: "alpha" },
        { provider: "test", id: "beta" },
        { provider: "test", id: "judge" },
      ],
    });
    const runFusion = vi.fn(async (_options: DirectFusionRunOptions) => completedDirectResult(root));
    registerFusionSurface(harness.pi, { runFusion });
    const command = harness.commands.get("fusion")!;
    await command.handler("set --members test/alpha,test/beta --judge test/judge", harness.ctx);
    await command.handler("enable", harness.ctx);
    harness.ctx.modelRegistry!.getAvailable = () => [
      { provider: "test", id: "alpha" },
      { provider: "test", id: "beta" },
    ];

    const result = await runTool(harness, "fusion", { question: "Question" });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("test/judge") });
    expect(runFusion).not.toHaveBeenCalled();
  });
});

describe("direct Fusion runner", () => {
  it("runs the configured panel through the real child-agent bridge and persists ordinary Fusion evidence", async () => {
    const root = temporaryRoot();
    const agentsDir = path.join(root, ".agents", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, "default.md"),
      "---\nname: default\ndescription: Fusion test agent\nreadOnly: true\nevidence:\n  mode: none\n---\nAnswer the task.\n",
      "utf8",
    );
    const harness = createHarness(root, {
      models: [
        { provider: "test", id: "alpha" },
        { provider: "test", id: "beta" },
        { provider: "test", id: "judge" },
      ],
    });
    const executed: string[] = [];

    const result = await runDirectFusion({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      question: "Which migration is safer?",
      members: [
        { label: "member-01", model: "test/alpha" },
        { label: "member-02", model: "test/beta" },
      ],
      judge: { label: "judge", model: "test/judge" },
      createExecutor: ({ model }): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          const id = (model as { id?: string } | undefined)?.id ?? "unknown";
          executed.push(id);
          return {
            status: "completed",
            agentName: request.agent.name,
            reason: "answered",
            text: id === "judge" ? "Use the reversible migration." : `${id} evidence`,
            executedModel: `test/${id}`,
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.result).toBe("Use the reversible migration.");
    expect(executed.slice(0, 2).sort()).toEqual(["alpha", "beta"]);
    expect(executed[2]).toBe("judge");
    expect(result.artifactRefs?.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "fusion-0001-packet.md",
        "fusion-0001-member-01-member-01.md",
        "fusion-0001-member-02-member-02.md",
        "fusion-0001-result.md",
      ]),
    );
    const envelope = JSON.parse(readFileSync(path.join(result.runDir, "runtime", "result.json"), "utf8"));
    expect(envelope).toMatchObject({ ok: true, disposition: { status: "completed" } });
  });
});
