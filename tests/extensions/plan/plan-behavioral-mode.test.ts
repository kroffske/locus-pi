import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentCycleMode,
  isInPlanMode,
  loadActiveModeState,
  modeStatePath,
  writeModeState,
} from "../../../extensions/_shared/mode-state.js";
import plan, { __resetModeUiStateForTests, __setEditorBaseLoaderForTests } from "../../../extensions/plan/index.js";
import { createHarness, emit } from "../../test-harness.js";

const fakeTheme = {
  fg: (color: string, text: string) => `<${color}>${text}`,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
};

let root: string;
let locusPiHome: string;
let previousLocusPiHome: string | undefined;
let previousAgentDir: string | undefined;

beforeEach(() => {
  root = path.join(tmpdir(), `locus-pi-plan-behavior-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  locusPiHome = path.join(tmpdir(), `locus-pi-home-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(locusPiHome, { recursive: true });
  writeFileSync(path.join(root, "src", "foo.ts"), "export const foo = 1;\n", "utf8");
  previousLocusPiHome = process.env["LOCUS_PI_HOME"];
  previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["LOCUS_PI_HOME"] = locusPiHome;
  process.env["PI_CODING_AGENT_DIR"] = path.join(root, "agent-dir");
  __resetModeUiStateForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(locusPiHome, { recursive: true, force: true });
  if (previousLocusPiHome === undefined) delete process.env["LOCUS_PI_HOME"];
  else process.env["LOCUS_PI_HOME"] = previousLocusPiHome;
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  __resetModeUiStateForTests();
});

function freeShiftTabForTest(): void {
  const agentDir = process.env["PI_CODING_AGENT_DIR"]!;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "keybindings.json"), JSON.stringify({ "app.thinking.cycle": [] }), "utf8");
}

function activePlanPath(): string {
  return path.join(locusPiHome, ".pi", "locus-pi", "project", "plans", "active-plan.md");
}

function armPlanMode(enteredAt = new Date().toISOString()): void {
  writeModeState(root, {
    version: 1,
    mode: "plan",
    slug: "active-plan",
    activeArtifactPath: activePlanPath(),
    enteredAt,
    status: "active",
  });
}

/** Arm plan mode AND write the composed-plan artifact the handoff reads. */
function armPlanWithArtifact(content = "# Active Plan\n\n- step one\n- step two\n"): string {
  armPlanMode();
  const p = activePlanPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
  return p;
}

describe("plan mode is behavioral, not a tool block (v2)", () => {
  it("registers no tool_call block hook from the plan extension", () => {
    const harness = createHarness(root);
    plan(harness.pi);
    expect(harness.handlers.get("tool_call") ?? []).toHaveLength(0);
    expect(harness.handlers.has("before_agent_start")).toBe(true);
  });

  it("never blocks a write or subprocess tool call, even while in plan mode", async () => {
    armPlanMode();
    const harness = createHarness(root);
    plan(harness.pi);

    const writeResults = (await emit(harness, "tool_call", { toolName: "write", toolArgs: { path: "src/foo.ts" } }))
      .filter((entry) => entry !== undefined);
    const bashResults = (await emit(harness, "tool_call", { toolName: "bash", toolArgs: { command: "python -c 'print(1)'" } }))
      .filter((entry) => entry !== undefined);

    expect(writeResults).toHaveLength(0);
    expect(bashResults).toHaveLength(0);
  });

  it("modeStatePath is unchanged", () => {
    expect(modeStatePath(root)).toBe(path.join(root, ".locus", "runtime", "mode", "state.json"));
  });
});

describe("plan-mode behavioral injection (before_agent_start)", () => {
  it("injects the planning framing into the system prompt while in plan mode", async () => {
    armPlanMode();
    const harness = createHarness(root);
    plan(harness.pi);

    const [result] = await emit(harness, "before_agent_start", { systemPrompt: "BASE PROMPT" });

    expect(result?.systemPrompt).toContain("BASE PROMPT");
    expect(result?.systemPrompt).toContain("<planning_mode>");
    expect(result?.systemPrompt?.toLowerCase()).toContain("throwaway script");
  });

  it("does not inject the planning framing when not in plan mode", async () => {
    const harness = createHarness(root);
    plan(harness.pi);

    const results = await emit(harness, "before_agent_start", { systemPrompt: "BASE PROMPT" });

    expect(results.every((entry) => entry === undefined || entry.systemPrompt === undefined)).toBe(true);
  });
});

describe("/mode command + optional Shift+Tab cycle (T-A/T-C)", () => {
  it("registers /mode without claiming Pi's reserved shift+tab by default", () => {
    const harness = createHarness(root);
    plan(harness.pi);
    expect(harness.commands.has("mode")).toBe(true);
    expect(harness.shortcuts.has("shift+tab")).toBe(false);
  });

  it("/mode with no argument cycles default -> plan -> default with a status label", async () => {
    const harness = createHarness(root);
    plan(harness.pi);
    const mode = harness.commands.get("mode")!;

    expect(currentCycleMode(loadActiveModeState(root))).toBe("default");

    await mode.handler("", harness.ctx);
    expect(currentCycleMode(loadActiveModeState(root))).toBe("plan");
    expect(harness.statuses.get("locus")).toBe("MODE plan");
    expect(harness.statuses.has("mode")).toBe(false);
    expect(harness.widgets.get("plan")).toContain("[CHANGE]");
    expect(harness.widgets.get("plan")).toContain("default -> plan");

    await mode.handler("", harness.ctx);
    expect(currentCycleMode(loadActiveModeState(root))).toBe("default");
    expect(harness.statuses.has("locus")).toBe(false);
  });

  it("registers shift+tab only after explicit /mode bind-shift-tab policy is persisted", async () => {
    freeShiftTabForTest();
    const harness = createHarness(root);
    plan(harness.pi);
    const shortcut = harness.shortcuts.get("shift+tab")!;

    await shortcut.handler(harness.ctx);
    expect(isInPlanMode(loadActiveModeState(root))).toBe(true);

    await shortcut.handler(harness.ctx);
    expect(isInPlanMode(loadActiveModeState(root))).toBe(false);
  });

  it("/mode <name> sets the mode directly", async () => {
    const harness = createHarness(root);
    plan(harness.pi);
    const mode = harness.commands.get("mode")!;

    await mode.handler("plan", harness.ctx);
    expect(isInPlanMode(loadActiveModeState(root))).toBe(true);

    await mode.handler("default", harness.ctx);
    expect(isInPlanMode(loadActiveModeState(root))).toBe(false);
  });

  it("places a no-op mode VIEW below the editor", async () => {
    const harness = createHarness(root);
    plan(harness.pi);

    await harness.commands.get("mode")!.handler("default", harness.ctx);

    expect(harness.widgets.get("plan")).toContain("[VIEW] Behavioral mode");
    expect(harness.widgets.get("plan")).toContain("Mode remains default");
    expect(harness.widgetOptions.get("plan")).toEqual({ placement: "belowEditor" });
  });

  it("renders typed mode view/change blocks at 146/80/48 columns and plain RPC", async () => {
    const harness = createHarness(root);
    plan(harness.pi);
    const mode = harness.commands.get("mode")!;

    await mode.handler("show", harness.ctx);
    const payload = harness.widgetPayloads.get("plan");
    expect(typeof payload).toBe("function");
    const component = (payload as (tui: unknown, theme: unknown) => { render(width: number): string[] })(
      { requestRender() {}, terminal: { rows: 40, columns: 146 } },
      {},
    );
    for (const width of [146, 80, 48]) {
      const lines = component.render(width);
      expect(lines.join("\n")).toContain("[VIEW]");
      expect(lines.join("\n")).toContain("Behavioral mode");
      expect(lines.every((line) => Array.from(line).length <= width)).toBe(true);
    }

    await mode.handler("plan", harness.ctx);
    expect(harness.widgets.get("plan")).toContain("[CHANGE]");
    expect(harness.widgets.get("plan")).toContain("default -> plan");

    const rpc = createHarness(path.join(root, "rpc"), { mode: "rpc" });
    rpc.ctx.hasUI = true;
    plan(rpc.pi);
    await rpc.commands.get("mode")!.handler("show", rpc.ctx);
    expect(Array.isArray(rpc.widgetPayloads.get("plan"))).toBe(true);
    expect(rpc.widgets.get("plan")).toContain("[VIEW] Behavioral mode");
  });
});

describe("mode-aware UI: status badge + input border color (T-UI)", () => {
  it("publishes PLAN through the shared bounded status and clears the legacy key", async () => {
    __setEditorBaseLoaderForTests(async () => undefined); // skip editor install; only badge here
    const harness = createHarness(root, { theme: fakeTheme });
    plan(harness.pi);
    const mode = harness.commands.get("mode")!;

    await mode.handler("plan", harness.ctx);
    expect(harness.statuses.get("locus")).toBe("MODE plan");
    expect(harness.statuses.has("mode")).toBe(false);

    await mode.handler("default", harness.ctx);
    expect(harness.statuses.has("locus")).toBe(false);
  });

  it("leaves the badge as plain text when no theme is available (test/non-interactive)", async () => {
    const harness = createHarness(root); // no theme
    plan(harness.pi);
    const mode = harness.commands.get("mode")!;
    await mode.handler("plan", harness.ctx);
    expect(harness.statuses.get("locus")).toBe("MODE plan");
  });

  it("session_start installs a mode-aware editor whose border tracks plan mode", async () => {
    class FakeEditor {
      borderColor: (s: string) => string = (s: string) => `BASE(${s})`;
    }
    __setEditorBaseLoaderForTests(async () => FakeEditor as unknown as new (...args: any[]) => any);
    const harness = createHarness(root, { theme: fakeTheme });
    plan(harness.pi);

    await emit(harness, "session_start", {});
    expect(harness.editorFactory).toBeTypeOf("function");

    const editor = harness.editorFactory!({}, { borderColor: (s: string) => s }, {}) as { borderColor: (s: string) => string };
    // Default mode: border defers to the base (host/theme) color.
    expect(editor.borderColor("─")).toBe("BASE(─)");

    // Enter plan: the SAME editor instance recolors via the shared flag.
    const mode = harness.commands.get("mode")!;
    await mode.handler("plan", harness.ctx);
    expect(editor.borderColor("─")).toBe("<accent>─");

    // Exit plan: border returns to the base color.
    await mode.handler("default", harness.ctx);
    expect(editor.borderColor("─")).toBe("BASE(─)");
  });

  it("session_start restores the plan badge from persisted state", async () => {
    __setEditorBaseLoaderForTests(async () => undefined);
    armPlanMode();
    const harness = createHarness(root, { theme: fakeTheme });
    plan(harness.pi);

    await emit(harness, "session_start", {});
    expect(harness.statuses.get("locus")).toBe("MODE plan");
    expect(harness.statuses.has("mode")).toBe(false);
  });

  it("does not install a custom editor when the UI has no theme", async () => {
    const harness = createHarness(root); // no theme -> cannot host a themed editor
    plan(harness.pi);
    await emit(harness, "session_start", {});
    expect(harness.editorFactory).toBeUndefined();
  });

  it("does not install the TUI editor factory in RPC even when the host exposes UI and a theme", async () => {
    class FakeEditor {}
    __setEditorBaseLoaderForTests(async () => FakeEditor as unknown as new (...args: any[]) => any);
    const harness = createHarness(root, { mode: "rpc", theme: fakeTheme });
    harness.ctx.hasUI = true;
    plan(harness.pi);

    await emit(harness, "session_start", {});

    expect(harness.editorFactory).toBeUndefined();
  });
});

describe("plan -> execution handoff on exit (T-D)", () => {
  // Spread harness.ctx so ctx.ui / session refs are preserved, but flip hasUI on
  // (the harness leaves it undefined) so the selector path is exercised.
  function uiCtx(harness: ReturnType<typeof createHarness>): typeof harness.ctx {
    return { ...harness.ctx, hasUI: true } as typeof harness.ctx;
  }

  it("plain-exits (no selector) when the UI is headless", async () => {
    armPlanWithArtifact();
    const harness = createHarness(root);
    plan(harness.pi);
    const planCmd = harness.commands.get("plan")!;

    await planCmd.handler("exit", harness.ctx); // harness.ctx.hasUI is undefined

    expect(harness.selectCalls).toHaveLength(0);
    expect(isInPlanMode(loadActiveModeState(root))).toBe(false);
    expect(harness.sentUserMessages).toHaveLength(0);
    expect(harness.widgets.get("plan")).toContain("[CHANGE]");
    expect(harness.widgets.get("plan")).toContain("plan -> default");
    expect(harness.widgets.get("plan")).toContain("No execution turn was queued.");
  });

  it("plain-exits when there is no composed plan artifact", async () => {
    armPlanMode(); // state armed, but no artifact file written
    const harness = createHarness(root);
    plan(harness.pi);
    const planCmd = harness.commands.get("plan")!;

    await planCmd.handler("exit", uiCtx(harness));

    expect(harness.selectCalls).toHaveLength(0);
    expect(isInPlanMode(loadActiveModeState(root))).toBe(false);
    expect(harness.sentUserMessages).toHaveLength(0);
  });

  it("'Execute (this context)' clears plan mode and injects the plan as a follow-up", async () => {
    armPlanWithArtifact();
    const harness = createHarness(root);
    plan(harness.pi);
    const planCmd = harness.commands.get("plan")!;
    // empty selectQueue -> harness returns the first option (Execute this context)

    await planCmd.handler("exit", uiCtx(harness));

    expect(harness.selectCalls).toHaveLength(1);
    expect(isInPlanMode(loadActiveModeState(root))).toBe(false);
    expect(harness.sentUserMessages).toHaveLength(1);
    const sent = harness.sentUserMessages[0]!;
    expect(sent.message).toContain("<plan>");
    expect(sent.message).toContain("step one");
    expect(sent.message).toContain("Begin now.");
    expect(sent.options).toMatchObject({ deliverAs: "followUp" });
    expect(harness.widgets.get("plan")).toContain("[CHANGE]");
    expect(harness.widgets.get("plan")).toContain("execution queued in this context");
  });

  it("'Keep planning' stays in plan mode and sends nothing", async () => {
    armPlanWithArtifact();
    const harness = createHarness(root);
    plan(harness.pi);
    harness.selectQueue.push("Keep planning");
    const planCmd = harness.commands.get("plan")!;

    await planCmd.handler("exit", uiCtx(harness));

    expect(isInPlanMode(loadActiveModeState(root))).toBe(true);
    expect(harness.sentUserMessages).toHaveLength(0);
    expect(harness.widgets.get("plan")).toContain("[RESULT]");
    expect(harness.widgets.get("plan")).toContain("Stayed in plan mode");
    expect(harness.widgets.get("plan")).toContain("[CANCELLED]");
  });

  it("'Tweak, then execute' prompts for an amendment and folds it into the prompt", async () => {
    armPlanWithArtifact();
    const harness = createHarness(root);
    plan(harness.pi);
    harness.selectQueue.push("Tweak, then execute"); // harness ui.input returns "typed"
    const planCmd = harness.commands.get("plan")!;

    await planCmd.handler("exit", uiCtx(harness));

    expect(isInPlanMode(loadActiveModeState(root))).toBe(false);
    expect(harness.sentUserMessages).toHaveLength(1);
    const sent = harness.sentUserMessages[0]!;
    expect(sent.message).toContain("Apply this amendment before executing:");
    expect(sent.message).toContain("typed");
    expect(harness.widgets.get("plan")).toContain("amended plan");
  });

  it("'Tweak, then execute' treats Escape as cancel and keeps plan mode", async () => {
    armPlanWithArtifact();
    const harness = createHarness(root);
    plan(harness.pi);
    harness.selectQueue.push("Tweak, then execute");
    const planCmd = harness.commands.get("plan")!;
    const ctx = {
      ...uiCtx(harness),
      ui: { ...harness.ctx.ui, async input() { return undefined as never; } },
    } as typeof harness.ctx;

    await planCmd.handler("exit", ctx);

    expect(isInPlanMode(loadActiveModeState(root))).toBe(true);
    expect(harness.sentUserMessages).toHaveLength(0);
    expect(harness.widgets.get("plan")).toContain("[CANCELLED]");
    expect(harness.widgets.get("plan")).toContain("no execution turn was queued");
  });

  it("'Execute with a fresh context' opens a new session seeded with the plan", async () => {
    armPlanWithArtifact();
    const harness = createHarness(root);
    plan(harness.pi);
    harness.selectQueue.push("Execute with a fresh context (reset)");
    const planCmd = harness.commands.get("plan")!;

    const freshMsgs: Array<{ message: string; options: Record<string, unknown> | undefined }> = [];
    const ctx = {
      ...harness.ctx,
      hasUI: true,
      async newSession(opts?: { withSession?: (c: unknown) => Promise<void> }) {
        await opts?.withSession?.({
          ...harness.ctx,
          hasUI: true,
          async sendUserMessage(message: string, options?: Record<string, unknown>) {
            freshMsgs.push({ message, options });
          },
        });
        return { cancelled: false };
      },
    } as typeof harness.ctx;

    await planCmd.handler("exit", ctx);

    expect(isInPlanMode(loadActiveModeState(root))).toBe(false);
    expect(harness.sentUserMessages).toHaveLength(0); // not the current session
    expect(freshMsgs).toHaveLength(1);
    expect(freshMsgs[0]!.message).toContain("<plan>");
    expect(freshMsgs[0]!.message).toContain("step two");
    expect(freshMsgs[0]!.options).toMatchObject({ deliverAs: "followUp" });
    expect(harness.widgets.get("plan")).toContain("fresh context");
  });

  it("leaving plan via /mode (no arg) runs the handoff decision", async () => {
    armPlanWithArtifact();
    const harness = createHarness(root);
    plan(harness.pi);
    const mode = harness.commands.get("mode")!;

    await mode.handler("", uiCtx(harness)); // empty queue -> Execute (this context)

    expect(harness.selectCalls).toHaveLength(1);
    expect(isInPlanMode(loadActiveModeState(root))).toBe(false);
    expect(harness.sentUserMessages).toHaveLength(1);
  });

  it("Shift+Tab plan-exit renders the same outcome widget as /plan exit, once the deferred decision settles (T-181)", async () => {
    armPlanWithArtifact();
    freeShiftTabForTest();
    const harness = createHarness(root);
    plan(harness.pi);
    const shortcut = harness.shortcuts.get("shift+tab")!;

    await shortcut.handler(uiCtx(harness)); // sync return; handoff decision resolves async
    await new Promise((resolve) => setImmediate(resolve)); // flush the deferred .then()

    expect(harness.selectCalls).toHaveLength(1);
    expect(isInPlanMode(loadActiveModeState(root))).toBe(false);
    expect(harness.sentUserMessages).toHaveLength(1);
    expect(harness.widgets.get("plan")).toContain("[CHANGE]");
    expect(harness.widgets.get("plan")).toContain("execution queued in this context");
  });
});

describe("/mode bind-shift-tab", () => {
  it("writes app.thinking.cycle: [] to keybindings.json under PI_CODING_AGENT_DIR", async () => {
    const agentDir = path.join(root, "agent-dir");
    const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    try {
      const harness = createHarness(root);
      plan(harness.pi);
      const mode = harness.commands.get("mode")!;

      await mode.handler("bind-shift-tab", harness.ctx); // harness confirm() returns true

      const content = readFileSync(path.join(agentDir, "keybindings.json"), "utf8");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      expect(parsed["app.thinking.cycle"]).toEqual([]);
    } finally {
      if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    }
  });

  it("preserves other bindings and is idempotent", async () => {
    const agentDir = path.join(root, "agent-dir2");
    const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    try {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(path.join(agentDir, "keybindings.json"), JSON.stringify({ "app.model.select": "ctrl+l" }), "utf8");
      const harness = createHarness(root);
      plan(harness.pi);
      const mode = harness.commands.get("mode")!;

      await mode.handler("bind-shift-tab", harness.ctx);
      const parsed = JSON.parse(readFileSync(path.join(agentDir, "keybindings.json"), "utf8")) as Record<string, unknown>;
      expect(parsed["app.model.select"]).toBe("ctrl+l");
      expect(parsed["app.thinking.cycle"]).toEqual([]);
    } finally {
      if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    }
  });
});
