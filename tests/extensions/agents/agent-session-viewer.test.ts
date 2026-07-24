import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { agentLiveStore, type AgentLiveExecutionHandle } from "../../../extensions/_shared/agent-sdk-host.js";
import agents from "../../../extensions/agents/index.js";
import { AgentSessionViewer, createAgentViewerCapability } from "../../../extensions/agents/session-viewer.js";
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

function capability() {
  const result = createAgentViewerCapability({
    AssistantMessageComponent: FakeAssistantComponent,
    ToolExecutionComponent: FakeToolComponent,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.capability;
}

function executionFor(rowId: string): AgentLiveExecutionHandle {
  const execution = agentLiveStore.captureExecutionAuthority(rowId);
  if (execution === undefined) throw new Error(`No live execution for ${rowId}`);
  return execution;
}

afterEach(() => agentLiveStore.reset());

describe("AgentSessionViewer", () => {
  it("fills exact terminal height, follows tail, pauses on Up, and resumes on End", () => {
    const row = agentLiveStore.begin({ id: "viewer-row", agentName: "reviewer", label: "Review" });
    for (let index = 0; index < 12; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `message-${index}` }], stopReason: "stop" },
      });
    }
    const tui = { terminal: { rows: 8, columns: 80 }, requestRender: vi.fn() };
    const viewer = new AgentSessionViewer(executionFor(row.id), tui, vi.fn(), capability());

    const tail = viewer.render(80);
    expect(tail).toHaveLength(8);
    expect(tail.every((line) => visibleWidth(line) === 80)).toBe(true);
    expect(tail.join("\n")).toContain("message-11");

    viewer.handleInput("up");
    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "message-12" }], stopReason: "stop" },
    });
    expect(viewer.followTail).toBe(false);
    expect(viewer.render(80).slice(1, -1).join("\n")).not.toContain("assistant:message-12");

    viewer.handleInput("end");
    expect(viewer.followTail).toBe(true);
    expect(viewer.render(80).join("\n")).toContain("message-12");
    viewer.dispose();
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

  it("lets focused viewer receive Escape and Down before global terminal guards", async () => {
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
    viewer.handleInput("down");
    expect(tui.requestRender).toHaveBeenCalled();

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
