import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import model, {
  buildEffortOperatorBlock,
  effortLevelsForModel,
  getModelRolesConfigPaths,
  loadModelRolesState,
  modelEffortCapability,
  modelRoleStatusContribution,
  MODEL_ROLE_ACTIONS,
  ModelRoleSelectorComponent,
  type EffortCommandOutcome,
} from "../../../extensions/model/index.js";
import {
  buildModelRows,
  roleSummaries,
  type AppliedModelRoleState,
} from "../../../extensions/model/model-role-selector.js";
import {
  buildModelRolesState,
  resolveAgentModelPreference,
  resolvePromptPlanningModelRole,
  resolveSummaryModelRole,
} from "../../../extensions/_shared/model-settings.js";
import { sessionJsonlPath } from "../../../extensions/_shared/files.js";
import { renderOperatorBlockPlain } from "../../../extensions/_shared/operator-ui.js";
import type { CustomUiComponent } from "../../../extensions/_shared/pi-api.js";
import { createHarness, emit, type Harness } from "../../test-harness.js";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";

const REASONING_MODELS = [
  {
    provider: "test",
    id: "fast",
    name: "Test Fast",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
  },
  {
    provider: "test",
    id: "strong",
    name: "Test Strong",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
  },
];

describe("model extension", () => {
  let previousHome: string | undefined;
  let root: string;
  let harness: Harness;

  beforeEach(async () => {
    previousHome = process.env.PI_MODEL_ROLES_HOME;
    root = await mkdtemp(join(tmpdir(), "pi-model-"));
    process.env.PI_MODEL_ROLES_HOME = join(root, "home");
    harness = createHarness(join(root, "project"), { models: REASONING_MODELS });
    model(harness.pi);
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.PI_MODEL_ROLES_HOME;
    else process.env.PI_MODEL_ROLES_HOME = previousHome;
    delete process.env.LOCUS_PI_SESSION_STORE;
    await rm(root, { recursive: true, force: true });
  });

  it("registers only /model-roles and /effort in the model namespace", () => {
    expect([...harness.commands.keys()].sort()).toEqual(["effort", "model-roles"]);
    expect(harness.commands.has("model")).toBe(false);
    expect(harness.commands.has("models")).toBe(false);
  });

  it("publishes source-backed capability labels for all six roles", () => {
    expect(MODEL_ROLE_ACTIONS.map(({ role, support, appliesCurrentModel }) => ({ role, support, appliesCurrentModel }))).toEqual([
      { role: "default", support: "active", appliesCurrentModel: true },
      { role: "agent", support: "active", appliesCurrentModel: false },
      { role: "task", support: "fallback", appliesCurrentModel: false },
      { role: "plan", support: "dormant", appliesCurrentModel: false },
      { role: "summary", support: "dormant", appliesCurrentModel: false },
      { role: "smol", support: "fallback", appliesCurrentModel: false },
    ]);
    expect(MODEL_ROLE_ACTIONS.map((action) => action.capability)).toEqual([
      "active · session + route fallback",
      "active · agents/workflows primary",
      "fallback · agents/workflows",
      "dormant · beta prompt planning",
      "dormant · resolver only",
      "fallback-only · summary resolver",
    ]);
  });

  it("applies DEFAULT model + effort, persists its route, and closes only on q", async () => {
    harness.customInputQueue.push(ENTER, ENTER, ...repeat(DOWN, 4), ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const state = await loadModelRolesState(harness.ctx);
    expect(harness.selectedModel).toMatchObject({ provider: "test", id: "fast" });
    expect(harness.thinkingLevel).toBe("high");
    expect(state.effective.get("default")?.assignment).toEqual({ model: "test/fast", thinking: "high" });
    expect(harness.entries.at(0)).toMatchObject({
      type: "model-roles",
      data: { role: "default", assignment: "test/fast:high", modelApplied: true, rolePersisted: true },
    });
    expect(harness.customOptions).toHaveLength(1);
    expect(joinFrames(harness).includes("[OK] DEFAULT → test/fast:high saved; Current session updated.")).toBe(true);
    expect(harness.statuses.has("model-roles")).toBe(false);
    expect(harness.statuses.get("locus")).toContain("routes");
    expect(harness.statuses.get("locus")).not.toContain("current=");
    expect(harness.statuses.get("locus")).not.toContain("high");
  });

  it("assigns two routes with different efforts in one selector session", async () => {
    harness.customInputQueue.push(
      ENTER, ENTER, ...repeat(DOWN, 4), ENTER,
      DOWN, ENTER, DOWN, ENTER, ...repeat(DOWN, 2), ENTER,
      "q",
    );

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const paths = getModelRolesConfigPaths(harness.ctx.session!.projectRoot);
    expect(JSON.parse(await readFile(paths.project, "utf8"))).toMatchObject({
      roles: { default: "test/fast:high", agent: "test/strong:low" },
    });
    expect(harness.entries).toHaveLength(2);
    expect(harness.customOptions).toHaveLength(1);
    const frames = joinFrames(harness);
    expect(frames).toContain("[OK] DEFAULT → test/fast:high saved; Current session updated.");
    expect(frames).toContain("[OK] AGENT → test/strong:low saved.");
    expect(frames).toContain("Provider filters:");
    expect(frames).toContain("Selected model: test/strong");
  });

  it.each([
    ["agent", 1],
    ["task", 2],
    ["plan", 3],
    ["summary", 4],
    ["smol", 5],
  ] as const)("persists %s with effort without changing the session model", async (role, roleIndex) => {
    harness.customInputQueue.push(DOWN, ENTER, ...repeat(DOWN, roleIndex), ENTER, ...repeat(DOWN, 2), ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const state = await loadModelRolesState(harness.ctx);
    expect(state.effective.get(role)?.assignment).toEqual({ model: "test/strong", thinking: "low" });
    expect(harness.selectedModel).toBeUndefined();
    expect(harness.thinkingLevel).toBeUndefined();
  });

  it("keeps DEFAULT route distinct after host model divergence and reopen", async () => {
    harness.customInputQueue.push(ENTER, ENTER, ENTER, "q");
    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    harness.ctx.model = REASONING_MODELS[1]!;
    harness.customRenderFrames.length = 0;
    harness.customInputQueue.push(ESC);
    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const frame = harness.customRenderFrames[0]!.join("\n");
    expect(frame).toContain("Current session model: test/strong");
    expect(frame).toContain("DEFAULT route: test/fast:off");
  });

  it("persists project config across a fresh harness without session entries", async () => {
    harness.customInputQueue.push(DOWN, ENTER, ENTER, ...repeat(DOWN, 3), ENTER, "q");
    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const reloaded = createHarness(harness.ctx.session!.projectRoot, { models: REASONING_MODELS });
    model(reloaded.pi);
    const state = await loadModelRolesState(reloaded.ctx);

    expect(state.effective.get("default")).toMatchObject({
      source: "project",
      assignment: { model: "test/strong", thinking: "medium" },
    });
  });

  it("renders real provider filters instead of status-like tabs", async () => {
    harness = createHarness(join(root, "project"), {
      models: [
        { provider: "openai", id: "gpt-5", name: "GPT 5", reasoning: true },
        { provider: "deepseek", id: "v4", name: "DeepSeek V4", reasoning: false },
        { provider: "openai", id: "gpt-5.4", name: "GPT 5.4", reasoning: true },
      ],
    });
    model(harness.pi);
    harness.customInputQueue.push(RIGHT, RIGHT, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const openaiFrame = harness.customRenderFrames.find((frame) => frame.join("\n").includes("[OPENAI]"));
    expect(openaiFrame?.join("\n")).toContain("Provider filters:");
    expect(openaiFrame?.join("\n")).toContain("openai/gpt-5");
    expect(openaiFrame?.join("\n")).not.toContain("deepseek/v4 —");
  });

  it("shows active, fallback, and dormant capability labels in the role step", async () => {
    harness.customInputQueue.push(ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const rolesFrame = harness.customRenderFrames.find((frame) => frame.join("\n").includes("Choose routing role:"));
    const text = rolesFrame?.join("\n") ?? "";
    expect(text).toContain("DEFAULT · active · session + route fallback");
    expect(text).toContain("AGENT · active · agents/workflows primary");
    expect(text).toContain("PLAN · dormant · beta prompt planning");
    expect(text).toContain("SMOL · fallback-only · summary resolver");
  });

  it("deduplicates registry rows with the same canonical selector", async () => {
    harness = createHarness(join(root, "project"), {
      models: [
        { provider: "deepseek", id: "v4", name: "DeepSeek V4", reasoning: false },
        { provider: "deepseek", id: "deepseek/v4", name: "DeepSeek: V4", reasoning: false },
        { provider: "openai", id: "gpt-5", name: "GPT 5", reasoning: true },
      ],
    });
    model(harness.pi);
    harness.customInputQueue.push(ESC);

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const frame = harness.customRenderFrames[0]!.join("\n");
    expect(frame.match(/deepseek\/v4/g)).toHaveLength(1);
    expect(frame).toContain("Models 1-2 of 2");
  });

  it("leaves the selector usable and the route unset when DEFAULT effort control is unavailable", async () => {
    delete harness.pi.setThinkingLevel;
    harness.customInputQueue.push(ENTER, ENTER, ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const state = await loadModelRolesState(harness.ctx);
    expect(state.effective.get("default")?.assignment).toBeUndefined();
    expect(joinFrames(harness)).toContain("[ERROR] Pi host did not expose verified thinking-level control");
    expect(joinFrames(harness)).toContain("Effort capability: registry");
  });

  it("leaves the selector usable when the host refuses DEFAULT model selection", async () => {
    harness.pi.setModel = vi.fn(async () => false);
    harness.customInputQueue.push(ENTER, ENTER, ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const state = await loadModelRolesState(harness.ctx);
    expect(state.effective.get("default")?.assignment).toBeUndefined();
    expect(joinFrames(harness)).toContain("[ERROR] Pi host refused the selected model");
    expect(joinFrames(harness)).toContain("Effort capability: registry");
  });

  it("does not persist DEFAULT when the host clamps the selected effort", async () => {
    harness.pi.setThinkingLevel = () => {
      harness.thinkingLevel = "off";
    };
    harness.customInputQueue.push(ENTER, ENTER, ...repeat(DOWN, 4), ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    expect(harness.selectedModel).toMatchObject({ provider: "test", id: "fast" });
    const state = await loadModelRolesState(harness.ctx);
    expect(state.effective.get("default")?.assignment).toBeUndefined();
    expect(joinFrames(harness)).toContain("[ERROR] Pi clamped effort high to off; DEFAULT route was not saved.");
  });

  it("reports partial success when Current changes but DEFAULT persistence fails", async () => {
    const projectRoot = join(root, "read-only-project");
    const roleDir = join(projectRoot, ".pi", "model-roles");
    await mkdir(roleDir, { recursive: true });
    await chmod(roleDir, 0o555);
    try {
      harness = createHarness(projectRoot, { models: REASONING_MODELS });
      model(harness.pi);
      harness.customInputQueue.push(ENTER, ENTER, ...repeat(DOWN, 4), ENTER, "q");

      await harness.commands.get("model-roles")!.handler("", harness.ctx);

      expect(harness.selectedModel).toMatchObject({ provider: "test", id: "fast" });
      expect(harness.thinkingLevel).toBe("high");
      const receiptFrame = harness.customRenderFrames.at(-1)!.join("\n");
      expect(receiptFrame).toContain("Current session model: test/fast · effort high");
      expect(receiptFrame).toContain("[WARN] Current session changed to test/fast · effort high, but DEFAULT route");
      expect(receiptFrame).toContain("was not saved: EACCES");
      const state = await loadModelRolesState(harness.ctx);
      expect(state.effective.get("default")?.assignment).toBeUndefined();
    } finally {
      await chmod(roleDir, 0o755);
    }
  });

  it("persists a non-default route through the real file path when ctx.settings is absent", async () => {
    delete harness.ctx.settings;
    harness.customInputQueue.push(DOWN, ENTER, DOWN, ENTER, ...repeat(DOWN, 2), ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const state = await loadModelRolesState(harness.ctx);
    expect(state.effective.get("agent")).toMatchObject({
      source: "session",
      assignment: { model: "test/strong", thinking: "low" },
    });
    const paths = getModelRolesConfigPaths(harness.ctx.session!.projectRoot);
    expect(JSON.parse(await readFile(paths.project, "utf8"))).toMatchObject({ roles: { agent: "test/strong:low" } });
  });

  it("accepts application-cursor sequences and keeps focus on the selected model", async () => {
    harness.customInputQueue.push("\x1bOB", ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    expect(joinFrames(harness)).toContain("Selected model: test/strong");
    expect(harness.entries).toEqual([]);
  });

  it("renders through Pi theme methods that depend on this binding", async () => {
    const theme = {
      colors: new Set(["accent", "text", "success", "warning", "error", "muted", "dim", "borderAccent", "borderMuted"]),
      fg(this: { colors: Set<string> }, color: string, text: string) {
        if (!this.colors.has(color)) throw new Error(`unknown color ${color}`);
        return `<${color}>${text}</${color}>`;
      },
      bold(text: string) { return `*${text}*`; },
    };
    harness = createHarness(join(root, "project"), { models: REASONING_MODELS, customTheme: theme });
    model(harness.pi);
    harness.customInputQueue.push(ESC);

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    expect(harness.customRenderFrames[0]?.join("\n")).toContain("<accent>[SELECT]</accent>");
    expect(harness.customRenderFrames[0]?.join("\n")).toContain("<borderAccent>");
  });

  it("renders a typed read-only fallback when custom UI is unavailable", async () => {
    delete harness.ctx.ui.custom;

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    expect(harness.entries).toEqual([]);
    expect(harness.widgets.get("model-roles")).toContain("[WARN] Model roles");
    expect(harness.widgets.get("model-roles")).toContain("Current session model:");
    expect(harness.widgets.get("model-roles")).toContain("DEFAULT route:");
    expect(harness.widgets.get("model-roles")).toContain("fallback is read-only");
    expect(harness.widgetOptions.get("model-roles")).toEqual({ placement: "aboveEditor" });
    expect(harness.notifications).toEqual([]);
  });

  it("does not call terminal-only custom UI from RPC even when the method is present", async () => {
    const rpc = createHarness(join(root, "rpc-model-roles"), { models: REASONING_MODELS, mode: "rpc" });
    rpc.ctx.hasUI = true;
    const custom = vi.fn(async () => undefined);
    rpc.ctx.ui.custom = custom as NonNullable<typeof rpc.ctx.ui.custom>;
    model(rpc.pi);

    await rpc.commands.get("model-roles")!.handler("", rpc.ctx);

    expect(custom).not.toHaveBeenCalled();
    expect(rpc.widgets.get("model-roles")).toContain("[WARN] Model roles");
    expect(rpc.widgets.get("model-roles")).toContain("fallback is read-only");
  });

  it("records model, effort, and persistence truth in the JSONL runtime event", async () => {
    process.env.LOCUS_PI_SESSION_STORE = "jsonl";
    harness.customInputQueue.push(DOWN, ENTER, ENTER, ...repeat(DOWN, 4), ENTER, "q");

    await harness.commands.get("model-roles")!.handler("", harness.ctx);

    const filePath = sessionJsonlPath(harness.ctx.session!.projectRoot);
    const records = (await readFile(filePath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      entry?: { payload?: { type?: string; data?: Record<string, unknown> } };
    });
    const event = records.find((record) => record.entry?.payload?.type === "model_role_runtime_event")?.entry?.payload?.data;
    expect(event).toMatchObject({
      role: "default",
      assignment: "test/strong:high",
      requestedThinking: "high",
      currentModel: "test/strong",
      currentThinking: "high",
      modelApplied: true,
      thinkingApplied: true,
      rolePersisted: true,
    });
  });

  it("loads user/project/settings/session precedence and project null inheritance", async () => {
    const paths = getModelRolesConfigPaths(harness.ctx.session!.projectRoot);
    await writeJson(paths.user, { version: 1, roles: { smol: "test/fast:low", task: "test/fast" } });
    await writeJson(paths.project, { version: 1, roles: { smol: null, task: "test/strong:medium" } });
    await harness.ctx.settings!.set("modelRoles", { task: "test/fast:high" });
    harness.entries.unshift({
      type: "model-roles",
      data: { version: 1, role: "task", assignment: "test/strong:xhigh", rolePersisted: true },
      timestamp: new Date().toISOString(),
    });

    const state = await loadModelRolesState(harness.ctx);

    expect(state.effective.get("smol")).toMatchObject({
      source: "user",
      inherited: true,
      assignment: { model: "test/fast", thinking: "low" },
    });
    expect(state.effective.get("task")).toMatchObject({
      source: "session",
      assignment: { model: "test/strong", thinking: "xhigh" },
    });
  });

  it("keeps PLAN/SUMMARY dormant resolver truth and AGENT/TASK active fallback truth", async () => {
    await harness.ctx.settings!.set("modelRoles", {
      default: "test/fast",
      smol: "test/fast:low",
      plan: "test/strong:high",
      task: "test/strong:medium",
    });
    const state = await loadModelRolesState(harness.ctx);

    expect(resolvePromptPlanningModelRole(state)).toMatchObject({ role: "plan", fallback: false });
    expect(resolveSummaryModelRole(state)).toMatchObject({ role: "smol", fallback: true });
    expect(resolveAgentModelPreference(state)).toMatchObject({ role: "task", fallback: true });
    expect(resolveAgentModelPreference(state, ["test/fast:xhigh"])).toMatchObject({
      source: "agent",
      assignment: { model: "test/fast", thinking: "xhigh" },
      fallback: false,
    });
  });

  it("syncs routing status on session_start without registering providers", async () => {
    const paths = getModelRolesConfigPaths(harness.ctx.session!.projectRoot);
    await writeJson(paths.project, { version: 1, roles: { default: "test/fast:high", agent: "test/strong:low" } });

    await emit(harness, "session_start");

    expect(harness.registeredProviders.size).toBe(0);
    expect(harness.statuses.get("locus")).toContain("routes");
    expect(harness.statuses.get("locus")).not.toContain("current=");
    expect(harness.statuses.has("model-roles")).toBe(false);
  });

  it("uses a routing-only bounded status contribution", () => {
    const state = buildModelRolesState(
      { project: "/project/config.json", user: "/user/config.json" },
      {},
      {},
      {},
      { roles: { default: "openai/gpt-5.6:high", agent: "deepseek/v4:low", task: "openrouter/long-model-name" } },
    );
    const contribution = modelRoleStatusContribution(roleSummaries(state));

    expect(contribution).toMatchObject({ id: "model.roles", lane: "route", narrow: "routes 3" });
    expect(contribution?.wide).toContain("DEFAULT=gpt-5.6");
    expect(contribution?.wide).not.toMatch(/current=|effort|high|cwd|context/);
    expect(contribution?.compact).not.toMatch(/current=|effort|high|cwd|context/);
  });

  it("/effort validates model capability before calling Pi", async () => {
    harness.ctx.model = { provider: "test", id: "plain", name: "Plain", reasoning: false };

    await harness.commands.get("effort")!.handler("high", harness.ctx);

    expect(harness.thinkingLevel).toBeUndefined();
    expect(harness.widgets.get("effort")).toContain("[ERROR]");
    expect(harness.widgets.get("effort")).toContain("test/plain does not support high");
    expect(harness.widgets.get("effort")).toContain("Supported: off");
    expect(harness.notifications).toEqual([]);
  });

  it("/effort offers capability-backed levels and verifies the result", async () => {
    harness.ctx.model = REASONING_MODELS[0]!;
    harness.selectQueue.push("xhigh");

    await harness.commands.get("effort")!.handler("", harness.ctx);

    expect(harness.selectCalls[0]?.title).toBe("[SELECT] Thinking effort · current off · test/fast");
    expect(harness.selectCalls[0]?.options).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(harness.thinkingLevel).toBe("xhigh");
    expect(harness.widgets.get("effort")).toContain("[CHANGE]");
    expect(harness.widgets.get("effort")).toContain("registry");
    expect(harness.notifications).toEqual([]);
  });

  it.each(["off", "minimal", "low", "medium", "high", "xhigh"] as const)(
    "/effort starts on the current %s level and Enter is idempotent",
    async (current) => {
      harness.ctx.model = REASONING_MODELS[0]!;
      harness.pi.setThinkingLevel?.(current);

      await harness.commands.get("effort")!.handler("", harness.ctx);

      expect(harness.selectCalls[0]?.title).toContain(`current ${current}`);
      expect(harness.selectCalls[0]?.options[0]).toBe(current);
      expect(harness.thinkingLevel).toBe(current);
      expect(harness.widgets.get("effort")).toContain("[VIEW]");
      expect(harness.widgets.get("effort")).toContain(`Current session effort remains ${current}.`);
      expect(harness.widgets.get("effort")).not.toContain("[CHANGE]");
    },
  );

  it("/effort cancel leaves session effort unchanged and emits no result surface", async () => {
    harness.ctx.model = REASONING_MODELS[0]!;
    let selectTitle = "";
    harness.ctx.ui.select = async (title) => {
      selectTitle = title;
      return { value: "high", cancelled: true };
    };

    await harness.commands.get("effort")!.handler("", harness.ctx);

    expect(selectTitle).toContain("[SELECT] Thinking effort");
    expect(harness.thinkingLevel).toBeUndefined();
    expect(harness.widgetPayloads.get("effort")).toBeUndefined();
    expect(harness.notifications).toEqual([]);
  });

  it("/effort no-arg in RPC mode gives an explicit typed recovery without opening a selector", async () => {
    const rpc = createHarness(join(root, "rpc-no-arg"), { models: REASONING_MODELS, mode: "rpc" });
    rpc.ctx.hasUI = true;
    rpc.ctx.model = REASONING_MODELS[0]!;
    model(rpc.pi);

    await rpc.commands.get("effort")!.handler("", rpc.ctx);

    expect(rpc.selectCalls).toHaveLength(0);
    expect(rpc.widgets.get("effort")).toContain("[WARN] Thinking effort");
    expect(rpc.widgets.get("effort")).toContain("Use an explicit level: /effort <level>");
    expect(rpc.thinkingLevel).toBeUndefined();
  });

  it.each([
    ["control", "thinking-level control"],
    ["verification", "thinking-level verification"],
  ] as const)("/effort reports missing host %s as a typed error without mutation", async (operation, message) => {
    harness.ctx.model = REASONING_MODELS[0]!;
    if (operation === "control") delete harness.pi.setThinkingLevel;
    else delete harness.pi.getThinkingLevel;

    await harness.commands.get("effort")!.handler("high", harness.ctx);

    expect(harness.thinkingLevel).toBeUndefined();
    expect(harness.widgets.get("effort")).toContain("[ERROR]");
    expect(harness.widgets.get("effort")).toContain(message);
    expect(harness.notifications).toEqual([]);
  });

  it("/effort reports a host clamp as WARN and does not claim the request succeeded", async () => {
    harness.ctx.model = REASONING_MODELS[0]!;
    harness.pi.setThinkingLevel = () => {
      harness.thinkingLevel = "medium";
    };
    harness.pi.getThinkingLevel = () => harness.thinkingLevel ?? "off";

    await harness.commands.get("effort")!.handler("high", harness.ctx);

    expect(harness.thinkingLevel).toBe("medium");
    expect(harness.widgets.get("effort")).toContain("[WARN]");
    expect(harness.widgets.get("effort")).toContain("Pi kept medium; high was not accepted.");
    expect(harness.widgets.get("effort")).not.toContain("[CHANGE]");
    expect(harness.notifications).toEqual([]);
  });

  it("/effort renders its actual CHANGE widget safely at 146/80/48 columns", async () => {
    harness.ctx.model = REASONING_MODELS[0]!;

    await harness.commands.get("effort")!.handler("high", harness.ctx);

    const payload = harness.widgetPayloads.get("effort");
    expect(typeof payload).toBe("function");
    const component = (payload as (_tui: unknown, theme: unknown) => CustomUiComponent)(
      { requestRender() {}, terminal: { rows: 40, columns: 146 } },
      {},
    );
    for (const width of [146, 80, 48]) {
      const lines = component.render(width);
      const text = lines.join("\n");
      expect(text).toContain("[CHANGE]");
      expect(text).toContain("Current session effort is now high.");
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(harness.widgetOptions.get("effort")).toEqual({ placement: "aboveEditor" });
    expect(harness.notifications).toEqual([]);
  });

  it("/effort emits the same typed hierarchy as plain RPC output", async () => {
    const rpc = createHarness(join(root, "rpc"), { models: REASONING_MODELS, mode: "rpc" });
    model(rpc.pi);
    rpc.ctx.model = REASONING_MODELS[0]!;

    await rpc.commands.get("effort")!.handler("high", rpc.ctx);

    const payload = rpc.widgetPayloads.get("effort");
    expect(Array.isArray(payload)).toBe(true);
    expect((payload as string[]).join("\n")).toContain("[CHANGE] Thinking effort");
    expect((payload as string[]).every((line) => visibleWidth(line) <= 80)).toBe(true);
    expect(rpc.notifications).toEqual([]);
  });
});

describe("effort operator surfaces", () => {
  const outcomes: EffortCommandOutcome[] = [
    { kind: "unknown", requested: "turbo", supported: ["off", "high"] },
    { kind: "unsupported", requested: "xhigh", model: "test/plain", supported: ["off"] },
    { kind: "unavailable", operation: "control", supported: ["off", "high"] },
    { kind: "unavailable", operation: "verification", supported: ["off", "high"] },
    { kind: "clamped", requested: "xhigh", actual: "high", supported: ["off", "high"] },
    { kind: "unchanged", level: "high", supported: ["off", "high"], capability: "registry" },
    { kind: "changed", level: "high", supported: ["off", "high"], capability: "registry" },
  ];

  it.each([146, 80, 48])("keeps every plain outcome typed and width-safe at %i columns", (width) => {
    for (const outcome of outcomes) {
      const block = buildEffortOperatorBlock(outcome);
      const lines = renderOperatorBlockPlain(block, width);
      const normalized = lines.join(" ");
      expect(normalized).toContain(`[${block.type}] Thinking effort`);
      expect(normalized).toContain(block.primary);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });
});

describe("ModelRoleSelectorComponent", () => {
  it("uses distinct semantic accents for active filter, routes, models, and cursor", () => {
    const { rows, summaries } = selectorFixture();
    const colors: Record<string, string> = {
      accent: "36",
      text: "37",
      success: "32",
      warning: "33",
      error: "31",
      muted: "90",
      dim: "90",
      borderAccent: "36",
      borderMuted: "90",
    };
    const component = new ModelRoleSelectorComponent({ requestRender: vi.fn() }, {
      fg(tone, text) { return `\x1b[${colors[tone]}m${text}\x1b[39m`; },
      bold(text) { return `\x1b[1m${text}\x1b[22m`; },
    }, {
      rows,
      roleSummaries: summaries,
      currentSelector: "test/fast",
      currentThinking: "high",
      applySelection: vi.fn(),
    });

    const text = component.render(146).join("\n");
    expect(text).toContain("\x1b[32m[ALL]\x1b[39m");
    expect(text).toContain("\x1b[33mDEFAULT\x1b[39m");
    expect(text).toContain("\x1b[33mSMOL\x1b[39m");
    expect(text).toContain("\x1b[33mtest/fast:high\x1b[39m");
    expect(text).toContain("\x1b[36mtest/fast\x1b[39m");
    expect(text).toContain("\x1b[36m>\x1b[39m");
    expect(text).toContain("Available roles:");
  });

  it("renders assigned routing roles and their models in warning color on separate lines", () => {
    const state = buildModelRolesState(
      { project: "/project/config.json", user: "/user/config.json" },
      {},
      {},
      {},
      { roles: { summary: "test/strong:low", smol: "test/strong:off" } },
    );
    const colors: Record<string, string> = {
      accent: "36",
      text: "37",
      success: "32",
      warning: "33",
      error: "31",
      muted: "90",
      dim: "90",
      borderAccent: "36",
      borderMuted: "90",
    };
    const component = new ModelRoleSelectorComponent({ requestRender: vi.fn() }, {
      fg(tone, text) { return `\x1b[${colors[tone]}m${text}\x1b[39m`; },
      bold(text) { return `\x1b[1m${text}\x1b[22m`; },
    }, {
      rows: buildModelRows(REASONING_MODELS, state, undefined),
      roleSummaries: roleSummaries(state),
      currentSelector: undefined,
      currentThinking: "off",
      applySelection: vi.fn(),
    });

    const lines = component.render(146);
    const routingIndex = lines.findIndex((line) => line.includes("Routing roles:"));
    expect(lines[routingIndex + 1]).toContain("\x1b[33mSUMMARY\x1b[39m");
    expect(lines[routingIndex + 2]).toContain("\x1b[33mSMOL\x1b[39m");
    expect(lines[routingIndex + 1]).toContain("\x1b[33mtest/strong:low\x1b[39m");
    expect(lines.join("\n")).toContain("\x1b[33m[SUMMARY]\x1b[39m");
    expect(lines.join("\n")).toContain("\x1b[33mtest/strong\x1b[39m");
  });

  it("renders typed, width-safe SELECT hierarchy at 146/80/48 columns", () => {
    const { rows, summaries } = selectorFixture();
    const component = new ModelRoleSelectorComponent({ requestRender: vi.fn() }, {}, {
      rows,
      roleSummaries: summaries,
      currentSelector: "test/fast",
      currentThinking: "high",
      applySelection: vi.fn(),
    });

    for (const width of [146, 80, 48]) {
      const lines = component.render(width);
      const text = lines.join("\n");
      expect(text).toContain("[SELECT]");
      expect(text).toContain("Model roles");
      expect(text).toContain("Current session model:");
      expect(text).toContain("DEFAULT route:");
      expect(text).toContain(width < 60 ? "Provider filter" : "Provider filters:");
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("supports back/cancel without mutation and preserves close after invalidate", async () => {
    const { rows, summaries } = selectorFixture();
    const done = vi.fn();
    const applySelection = vi.fn<() => Promise<AppliedModelRoleState>>();
    const component = new ModelRoleSelectorComponent({ requestRender: vi.fn() }, {}, {
      rows,
      roleSummaries: summaries,
      currentSelector: undefined,
      currentThinking: "off",
      applySelection,
      done,
    });

    await component.handleInput(ENTER);
    expect(component.render(80).join("\n")).toContain("Choose routing role:");
    await component.handleInput(ESC);
    expect(component.render(80).join("\n")).toContain("Provider filters:");
    await component.handleInput(ENTER);
    await component.handleInput(ENTER);
    expect(component.render(80).join("\n")).toContain("Effort capability:");
    await component.handleInput(ESC);
    expect(component.render(80).join("\n")).toContain("Choose routing role:");
    component.invalidate();
    await component.handleInput("q");

    expect(applySelection).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("keeps the model window bounded at wide, regular, and narrow widths", () => {
    const models = Array.from({ length: 12 }, (_, index) => ({
      provider: "bulk",
      id: `model-${String(index + 1).padStart(2, "0")}`,
      name: `Bulk ${index + 1}`,
      reasoning: false,
    }));
    const state = buildModelRolesState(
      { project: "/project/config.json", user: "/user/config.json" },
      {}, {}, {}, {},
    );
    const component = new ModelRoleSelectorComponent({ requestRender: vi.fn() }, {}, {
      rows: buildModelRows(models, state, undefined),
      roleSummaries: roleSummaries(state),
      currentSelector: undefined,
      currentThinking: "off",
      applySelection: vi.fn(),
    });

    for (const [width, expectedRows] of [[146, 8], [80, 6], [48, 4]] as const) {
      const lines = component.render(width);
      expect(lines.filter((line) => line.includes("bulk/model-")).length).toBe(expectedRows);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("keeps effort focus usable after an inline apply error", async () => {
    const { rows, summaries } = selectorFixture();
    const done = vi.fn();
    const component = new ModelRoleSelectorComponent({ requestRender: vi.fn() }, {}, {
      rows,
      roleSummaries: summaries,
      currentSelector: undefined,
      currentThinking: "off",
      async applySelection() {
        return {
          currentSelector: undefined,
          currentThinking: "off",
          roleSummaries: summaries,
          receipt: { kind: "error", text: "Persistence denied" },
        };
      },
      done,
    });

    await component.handleInput(ENTER);
    await component.handleInput(ENTER);
    await component.handleInput(ENTER);

    expect(component.render(80).join("\n")).toContain("[ERROR] Persistence denied");
    expect(component.render(80).join("\n")).toContain("Effort capability:");
    await component.handleInput(ESC);
    expect(component.render(80).join("\n")).toContain("Choose routing role:");
    await component.handleInput("q");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("returns to the model list with the receipt after a successful assignment", async () => {
    const { rows, summaries } = selectorFixture();
    const component = new ModelRoleSelectorComponent({ requestRender: vi.fn() }, {}, {
      rows,
      roleSummaries: summaries,
      currentSelector: "test/fast",
      currentThinking: "high",
      async applySelection() {
        return {
          currentSelector: "test/fast",
          currentThinking: "high",
          roleSummaries: summaries,
          receipt: { kind: "success", text: "SUMMARY saved" },
        };
      },
    });

    await component.handleInput(ENTER);
    await component.handleInput(ENTER);
    await component.handleInput(ENTER);

    const text = component.render(80).join("\n");
    expect(text).toContain("Provider filters:");
    expect(text).not.toContain("Choose routing role:");
    expect(text).not.toContain("Effort capability:");
    expect(text).toContain("[OK] SUMMARY saved");
  });
});

describe("model effort capability", () => {
  it("matches Pi reasoning/thinkingLevelMap capability semantics", () => {
    expect(effortLevelsForModel({ provider: "p", id: "plain", reasoning: false })).toEqual(["off"]);
    expect(effortLevelsForModel({
      provider: "p",
      id: "reasoning",
      reasoning: true,
      thinkingLevelMap: { minimal: null, xhigh: "xhigh" },
    })).toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(effortLevelsForModel({ provider: "p", id: "reasoning", reasoning: true })).toEqual([
      "off", "minimal", "low", "medium", "high",
    ]);
  });

  it("fails closed to off when capability is unknown", () => {
    expect(modelEffortCapability(undefined)).toEqual({ levels: ["off"], source: "unknown", known: false });
    expect(effortLevelsForModel({ provider: "p", id: "unknown" })).toEqual(["off"]);
  });

  it("keeps the legacy advertised-level shim explicit", () => {
    expect(modelEffortCapability({ provider: "p", id: "legacy", thinking: ["low", "high"] })).toEqual({
      levels: ["off", "low", "high"],
      source: "legacy",
      known: true,
    });
  });
});

function selectorFixture() {
  const state = buildModelRolesState(
    { project: "/project/config.json", user: "/user/config.json" },
    {},
    {},
    {},
    { roles: { default: "test/fast:high", agent: "test/strong:low" } },
  );
  return {
    rows: buildModelRows(REASONING_MODELS, state, "test/fast"),
    summaries: roleSummaries(state),
  };
}

function repeat(value: string, count: number): string[] {
  return Array.from({ length: count }, () => value);
}

function joinFrames(harness: Harness): string {
  return harness.customRenderFrames.flat().join("\n");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
