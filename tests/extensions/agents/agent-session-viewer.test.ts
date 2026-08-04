import { afterEach, describe, expect, it, vi } from "vitest";
import { TUI, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import {
  agentLiveStore,
  type AgentLiveExecutionHandle,
} from "../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import agents from "../../../extensions/agents/index.js";
import {
  AgentSessionViewer,
  createAgentViewerCapability,
  loadAgentViewerCapability,
} from "../../../extensions/agents/session-viewer.js";
import { createHarness, emit } from "../../test-harness.js";

class FakeAssistantComponent {
  #message: any;
  constructor(message?: unknown) {
    this.#message = message;
  }
  updateContent(message: unknown): void {
    this.#message = message;
  }
  render(): string[] {
    return (
      this.#message?.content
        ?.filter((item: any) => item.type === "text")
        .map((item: any) => `assistant:${item.text}`) ?? []
    );
  }
  invalidate(): void {}
}

class FakeToolComponent {
  #expanded = false;
  constructor(
    readonly name: string,
    readonly id: string,
    _args?: unknown,
    _options?: unknown,
    _definition?: unknown,
    private readonly ui?: { requestRender(): void },
  ) {}
  updateArgs(): void {
    this.ui?.requestRender();
  }
  markExecutionStarted(): void {
    this.ui?.requestRender();
  }
  setArgsComplete(): void {
    this.ui?.requestRender();
  }
  updateResult(): void {
    this.ui?.requestRender();
  }
  setExpanded(expanded: boolean): void {
    this.#expanded = expanded;
    this.ui?.requestRender();
  }
  render(): string[] {
    return [`tool:${this.name}:${this.#expanded ? "expanded" : "compact"}`];
  }
  invalidate(): void {}
}

class TallFakeToolComponent extends FakeToolComponent {
  override render(): string[] {
    return Array.from({ length: 12 }, (_, index) => `tool-output-${index}`);
  }
}

class FakeEditorComponent {
  focused = false;
  #value = "";
  constructor(
    _tui: unknown,
    _keybindings: unknown,
    _title: string,
    _prefill: string | undefined,
    private readonly onSubmit: (value: string) => void,
    private readonly onCancel: () => void,
  ) {}
  render(): string[] {
    return ["input", `> ${this.#value}`, "Enter submit · Esc cancel"];
  }
  handleInput(data: string): void {
    if (data === "enter" || data === "\n") this.onSubmit(this.#value);
    else if (data === "escape") this.onCancel();
    else this.#value += data;
  }
  invalidate(): void {}
  dispose(): void {}
}

function capability() {
  const result = createAgentViewerCapability({
    AssistantMessageComponent: FakeAssistantComponent,
    ToolExecutionComponent: FakeToolComponent,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.capability;
}

function tallToolCapability() {
  const result = createAgentViewerCapability({
    AssistantMessageComponent: FakeAssistantComponent,
    ToolExecutionComponent: TallFakeToolComponent,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.capability;
}

function interactiveCapability() {
  const result = createAgentViewerCapability({
    AssistantMessageComponent: FakeAssistantComponent,
    ToolExecutionComponent: FakeToolComponent,
    ExtensionEditorComponent: FakeEditorComponent,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.capability;
}

function executionFor(rowId: string): AgentLiveExecutionHandle {
  const execution = agentLiveStore.captureExecutionAuthority(rowId);
  if (execution === undefined) throw new Error(`No live execution for ${rowId}`);
  return execution;
}

class RecordingTerminal implements Terminal {
  readonly writes: string[] = [];
  readonly kittyProtocolActive = false;

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {}

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  get output(): string {
    return this.writes.join("");
  }

  reset(): void {
    this.writes.length = 0;
  }
}

async function flushForcedRender(tui: TUI): Promise<void> {
  tui.requestRender(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => agentLiveStore.reset());

describe("AgentSessionViewer", () => {
  it("keeps a terminal-height live viewport and makes the original request reachable", () => {
    const row = agentLiveStore.begin({
      id: "request-viewer",
      agentName: "reviewer",
      label: "Review",
      request: "Inspect the changed command router and explain every regression risk before editing.",
    });
    for (let index = 0; index < 8; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `history-${index}` }], stopReason: "stop" },
      });
    }
    const tui = { terminal: { rows: 8, columns: 32 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability());

    const rendered = viewer.render(32);
    expect(rendered).toHaveLength(tui.terminal.rows);
    expect(rendered.every((line) => visibleWidth(line) === 32)).toBe(true);
    expect(rendered[0]).toMatch(/^── /u);
    expect(rendered.at(-1)).toMatch(/^── Esc close/u);
    expect(rendered.join("\n")).toContain("history-7");
    expect(rendered.join("\n")).not.toContain("history-0");

    viewer.handleInput("home");
    const historyStart = viewer.render(32).join("\n");
    expect(historyStart).toContain("── Request");
    expect(historyStart).toContain("Inspect the changed command");
    expect(historyStart.indexOf("── Request")).toBeLessThan(historyStart.indexOf("── Agent history"));
    for (const width of [1, 2, 8]) {
      const narrow = viewer.render(width);
      expect(narrow).toHaveLength(tui.terminal.rows);
      expect(narrow.every((line) => visibleWidth(line) === width)).toBe(true);
    }
    viewer.dispose();
  });

  it("renders request control characters as text instead of terminal control sequences", () => {
    const row = agentLiveStore.begin({
      id: "safe-request-viewer",
      agentName: "reviewer",
      label: "Review",
      request: "Check \u001b[31mred\u001b[0m and \u009b31mC1-red\u009b0m output\tcarefully.",
    });
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { terminal: { rows: 8, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    const rendered = viewer.render(80).join("\n");
    expect(rendered).not.toContain("\u001b[31mred");
    expect(rendered).not.toContain("\u009b");
    expect(rendered).toContain("Check �[31mred�[0m and �31mC1-red�0m output  carefully.");
    viewer.dispose();
  });

  it("follows live additions at the tail and pages through retained history", () => {
    const row = agentLiveStore.begin({ id: "viewer-row", agentName: "reviewer", label: "Review" });
    for (let index = 0; index < 12; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `message-${index}` }], stopReason: "stop" },
      });
    }
    const tui = { terminal: { rows: 8, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability());

    const initial = viewer.render(80);
    expect(initial).toHaveLength(tui.terminal.rows);
    expect(initial.every((line) => visibleWidth(line) === 80)).toBe(true);
    expect(initial.join("\n")).toContain("message-11");
    expect(initial.join("\n")).not.toContain("message-0");

    tui.requestRender.mockClear();
    viewer.handleInput("up");
    expect(tui.requestRender).not.toHaveBeenCalled();
    viewer.handleInput("home");
    expect(viewer.render(80).join("\n")).toContain("message-0");
    viewer.handleInput("end");
    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "message-12" }], stopReason: "stop" },
    });
    expect(tui.requestRender).toHaveBeenCalled();
    const updated = viewer.render(80).join("\n");
    expect(updated).toContain("message-12");
    viewer.dispose();
  });

  it("writes a stable terminal-height viewport through Pi TUI across live and control redraws", async () => {
    const row = agentLiveStore.begin({
      id: "tui-scrollback-row",
      agentName: "reviewer",
      label: "Review",
      request: "Inspect every retained message.",
    });
    for (let index = 0; index < 12; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `scrollback-${index}` }], stopReason: "stop" },
      });
    }
    agentLiveStore.feedSessionEvent(row.id, {
      type: "tool_execution_start",
      toolCallId: "read-scrollback",
      toolName: "read",
      args: { path: "README.md" },
    });
    const terminal = new RecordingTerminal(80, 8);
    const tui = new TUI(terminal, false);
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability(), {
      active: 2,
      list: [1, 2],
      readBody: (round) => (round === 1 ? ["historical-round-1"] : undefined),
    });
    tui.addChild(viewer);

    await flushForcedRender(tui);
    expect(terminal.output.split("\r\n")).toHaveLength(terminal.rows);
    expect(terminal.output).toContain("scrollback-11");
    expect(terminal.output).toContain("tool:read:compact");

    viewer.handleInput("home");
    expect(viewer.render(80).join("\n")).toContain("Inspect every retained message.");
    viewer.handleInput("end");

    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "scrollback-12" }], stopReason: "stop" },
    });
    await vi.waitFor(() => expect(terminal.output).toContain("scrollback-12"));

    terminal.reset();
    viewer.handleInput("d");
    await flushForcedRender(tui);
    expect(terminal.output).toContain("tool:read:expanded");
    expect(viewer.render(80).join("\n")).toContain("scrollback-12");

    terminal.reset();
    viewer.handleInput("left");
    await flushForcedRender(tui);
    expect(terminal.output).toContain("historical-round-1");
    viewer.handleInput("right");
    await flushForcedRender(tui);
    expect(viewer.render(80).join("\n")).toContain("scrollback-12");

    viewer.dispose();
    tui.stop();
  });

  it("does not clear the terminal or scrollback when live content above a tall tool changes", async () => {
    const row = agentLiveStore.begin({ id: "stable-live-viewport", agentName: "reviewer", label: "Review" });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_start",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "draft" },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
        ],
      },
    });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    const terminal = new RecordingTerminal(80, 8);
    const tui = new TUI(terminal, false);
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), tallToolCapability());
    tui.addChild(viewer);
    await flushForcedRender(tui);

    terminal.reset();
    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "revised" },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
        ],
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(terminal.output).not.toContain("\u001b[2J\u001b[H\u001b[3J");
    viewer.dispose();
    tui.stop();
  });

  it("toggles native tool detail and closes without cancelling the row", () => {
    const row = agentLiveStore.begin({ id: "tool-row", agentName: "reviewer", label: "Review" });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    const done = vi.fn();
    const tui = { terminal: { rows: 6, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, done, capability());

    expect(viewer.render(80).join("\n")).toContain("tool:read:compact");
    tui.requestRender.mockClear();
    viewer.render(80);
    expect(tui.requestRender).not.toHaveBeenCalled();
    viewer.handleInput("d");
    expect(viewer.render(80).join("\n")).toContain("tool:read:expanded");
    viewer.handleInput("escape");
    viewer.dispose();

    expect(done).toHaveBeenCalledTimes(1);
    expect(agentLiveStore.rows.get(row.id)?.status).toBe("working");
  });

  it("uses Pi's editor surface to send input to the active child", async () => {
    const row = agentLiveStore.begin({ id: "interactive-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const send = vi.fn(async () => {});
    const unregister = agentLiveStore.registerInputForExecution(execution, send);
    const done = vi.fn();
    const tui = { terminal: { rows: 14, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(execution, tui, done, interactiveCapability(), undefined, {
      matches: () => false,
    });

    expect(viewer.render(80)).toHaveLength(tui.terminal.rows);
    viewer.handleInput("h");
    viewer.handleInput("i");
    viewer.handleInput("enter");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("hi"));
    await vi.waitFor(() => expect(viewer.render(80).join("\n")).toContain("message queued"));
    expect(done).not.toHaveBeenCalled();

    unregister();
    viewer.dispose();
  });

  it("does not capture input through an editor that cannot fit in the terminal", async () => {
    const row = agentLiveStore.begin({ id: "short-interactive-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const send = vi.fn(async () => {});
    const unregister = agentLiveStore.registerInputForExecution(execution, send);
    const tui = { terminal: { rows: 4, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(execution, tui, vi.fn(), interactiveCapability(), undefined, {
      matches: () => false,
    });

    const compact = viewer.render(80);
    expect(compact).toHaveLength(tui.terminal.rows);
    expect(compact.join("\n")).toContain("resize terminal for input");
    viewer.handleInput("x");
    viewer.handleInput("enter");
    expect(send).not.toHaveBeenCalled();

    tui.terminal.rows = 14;
    expect(viewer.render(80).join("\n")).toContain("Enter send");
    viewer.handleInput("x");
    viewer.handleInput("enter");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("x"));

    unregister();
    viewer.dispose();
  });

  it("types round-number digits into the active editor instead of changing rounds", async () => {
    const row = agentLiveStore.begin({ id: "round-input-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const send = vi.fn(async () => {});
    const unregister = agentLiveStore.registerInputForExecution(execution, send);
    const viewer = new AgentSessionViewer(
      execution,
      { terminal: { rows: 14, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      interactiveCapability(),
      { active: 2, list: [1, 2], readBody: () => ["historical round"] },
      { matches: () => false },
    );

    viewer.render(80);
    viewer.handleInput("1");
    viewer.handleInput("x");
    viewer.handleInput("enter");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("1x"));

    unregister();
    viewer.dispose();
  });

  it("mounts the installed Pi native editor inside the fixed viewport", async () => {
    const { initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme(undefined, false);
    const loaded = await loadAgentViewerCapability();
    if (!loaded.ok) throw new Error(loaded.reason);
    const row = agentLiveStore.begin({ id: "native-editor-row", agentName: "reviewer", label: "Review" });
    const execution = executionFor(row.id);
    const send = vi.fn(async () => {});
    const unregister = agentLiveStore.registerInputForExecution(execution, send);
    const terminal = new RecordingTerminal(80, 24);
    const tui = new TUI(terminal, false);
    const viewer = new AgentSessionViewer(execution, tui, vi.fn(), loaded.capability, undefined, {
      matches: () => false,
    });
    tui.addChild(viewer);

    const rendered = viewer.render(80);
    expect(rendered).toHaveLength(terminal.rows);
    expect(rendered.join("\n")).toContain("Message this agent");
    viewer.handleInput("o");
    viewer.handleInput("k");
    viewer.handleInput("\r");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("ok"));

    unregister();
    viewer.dispose();
    tui.stop();
  });

  it("keeps Escape ownership while leaving terminal navigation to Pi scrollback", async () => {
    const h = createHarness(process.cwd(), { isStreaming: true });
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    const row = agentLiveStore.begin({ id: "guarded-viewer", agentName: "reviewer", label: "Review" });
    const done = vi.fn();
    const tui = { terminal: { rows: 8, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, done, capability());

    expect([...h.terminalInputHandlers].map((handler) => handler("down")).every((result) => result === undefined)).toBe(
      true,
    );
    tui.requestRender.mockClear();
    viewer.handleInput("down");
    expect(tui.requestRender).not.toHaveBeenCalled();

    expect(
      [...h.terminalInputHandlers].map((handler) => handler("escape")).every((result) => result === undefined),
    ).toBe(true);
    expect(h.confirmCalls).toHaveLength(0);
    viewer.handleInput("escape");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("cleans its listener idempotently and reports missing native capability", () => {
    const row = agentLiveStore.begin({ id: "cleanup-row", agentName: "reviewer", label: "Review" });
    const before = agentLiveStore.emitter.listenerCount("change");
    const viewer = new AgentSessionViewer(executionFor(row.id), { requestRender: vi.fn() }, vi.fn(), capability());
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before + 1);
    viewer.dispose();
    viewer.dispose();
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);

    expect(createAgentViewerCapability({})).toEqual({
      ok: false,
      reason: "Installed Pi host does not export AssistantMessageComponent and ToolExecutionComponent.",
    });
  });

  it("closes exactly once and becomes inert when its live execution is replaced", () => {
    const first = agentLiveStore.begin({ id: "replaced-viewer", agentName: "reviewer", label: "execution A" });
    const done = vi.fn();
    const tui = { terminal: { rows: 6, columns: 80 }, requestRender: vi.fn() };
    const before = agentLiveStore.emitter.listenerCount("change");
    const viewer = new AgentSessionViewer(executionFor(first.id), tui, done, capability());
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before + 1);

    agentLiveStore.begin({ id: first.id, agentName: "reviewer", label: "execution B" });

    expect(done).toHaveBeenCalledOnce();
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);
    expect(viewer.render(80)).toEqual([]);
    viewer.handleInput("down");
    viewer.invalidate();
    viewer.dispose();
    agentLiveStore.reset();
    expect(done).toHaveBeenCalledOnce();
  });

  it("keeps a selected historical round readable after replacement but never opens replacement live output", () => {
    const first = agentLiveStore.begin({ id: "round-viewer", agentName: "reviewer", label: "execution A" });
    const done = vi.fn();
    const tui = { terminal: { rows: 6, columns: 100 }, requestRender: vi.fn() };
    const listenerBaseline = agentLiveStore.emitter.listenerCount("change");
    const viewer = new AgentSessionViewer(executionFor(first.id), tui, done, capability(), {
      active: 2,
      list: [1, 2],
      readBody: (round) => (round === 1 ? ["historical round A"] : undefined),
    });
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(listenerBaseline + 1);
    viewer.handleInput("left");
    tui.requestRender.mockClear();
    agentLiveStore.begin({ id: first.id, agentName: "reviewer", label: "execution B" });

    expect(agentLiveStore.emitter.listenerCount("change")).toBe(listenerBaseline);
    expect(tui.requestRender).not.toHaveBeenCalled();
    const historical = viewer.render(100).join("\n");
    expect(historical).toContain("historical round A");
    expect(historical).toContain("execution A");
    expect(historical).not.toContain("execution B");
    expect(done).not.toHaveBeenCalled();

    viewer.handleInput("right");
    expect(done).toHaveBeenCalledOnce();
    expect(viewer.render(100)).toEqual([]);
    viewer.dispose();
    expect(done).toHaveBeenCalledOnce();
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(listenerBaseline);
  });

  it.each([
    ["queued", "Agent is queued; no assistant output yet."],
    ["working", "Agent is working; waiting for assistant output…"],
    ["done", "Agent completed without assistant output."],
    ["cancelled", "Agent was cancelled before assistant output."],
    ["error", "Agent failed before assistant output."],
  ] as const)("renders leaf-status-aware empty text for %s", (status, message) => {
    const row = agentLiveStore.begin({ id: `empty-${status}`, agentName: "reviewer", label: status });
    agentLiveStore.patch(row.id, { status });
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { terminal: { rows: 5, columns: 80 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    expect(viewer.render(80).join("\n")).toContain(message);
    viewer.dispose();
  });

  it("renders a readable recorded answer and provenance without inferring verification", () => {
    const row = agentLiveStore.begin({ id: "replay-answer", agentName: "reviewer", label: "Review" });
    agentLiveStore.patch(row.id, {
      status: "done",
      finalAnswer: "## Review\n\nNo blocking findings.",
      resultArtifact: `workflow-artifact:run-1/call-1-answer#sha256=${"a".repeat(64)}`,
    });
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { terminal: { rows: 8, columns: 100 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    const text = viewer.render(100).join("\n");
    expect(text).toContain("showing recorded terminal text");
    expect(text).not.toContain("verified");
    expect(text).toContain("source: workflow-artifact:run-1/call-1-answer");
    expect(text).toContain("## Review");
    expect(text).toContain("No blocking findings.");
    expect(text).not.toContain("assistant:");
    viewer.dispose();
  });

  it.each([
    ["done", "recorded terminal text"],
    ["cancelled", "recorded cancellation text"],
    ["error", "recorded failure text"],
  ] as const)("labels ordinary %s row text without claiming it is an answer", (status, label) => {
    const row = agentLiveStore.begin({ id: `ordinary-${status}`, agentName: "reviewer", label: status });
    agentLiveStore.patch(row.id, {
      status,
      finalAnswer: `${status} terminal payload`,
      ...(status === "error" ? { errors: ["ordinary failure"] } : {}),
    });
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { terminal: { rows: 7, columns: 100 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    const text = viewer.render(100).join("\n");
    expect(text).toContain(`showing ${label}`);
    expect(text).not.toContain("recorded final answer");
    expect(text).toContain(`${status} terminal payload`);
    if (status === "error") expect(text).toContain("error: ordinary failure");
    viewer.dispose();
  });

  it("renders explicit artifact errors when a replay has neither transcript nor readable answer", () => {
    const row = agentLiveStore.begin({ id: "replay-error", agentName: "reviewer", label: "Review" });
    agentLiveStore.patch(row.id, { status: "done", errors: ["Replayed answer artifact is tampered."] });
    const viewer = new AgentSessionViewer(
      executionFor(row.id),
      { terminal: { rows: 6, columns: 100 }, requestRender: vi.fn() },
      vi.fn(),
      capability(),
    );

    const text = viewer.render(100).join("\n");
    expect(text).toContain("No child transcript or readable answer is available.");
    expect(text).toContain("error: Replayed answer artifact is tampered.");
    viewer.dispose();
  });
});
