import { afterEach, describe, expect, it, vi } from "vitest";
import agents from "../../../extensions/agents/index.js";
import {
  FLEET_FOCUS_FALLBACK_SHORTCUT,
  FleetFocusComponent,
  fleetMenuState,
  renderFleetMenuRows,
  selectFleetMenuLeafRows,
  selectFleetMenuRows,
} from "../../../extensions/_shared/agent-runtime/fleet-menu.js";
import { agentLiveStore, type AgentLiveStatus } from "../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import { DEFAULT_RENDER_MIN_INTERVAL_MS } from "../../../extensions/_shared/host/render-scheduler.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  workflowAgentLiveChildRowId,
  workflowAgentLiveRowId,
  workflowGroupLiveRowId,
} from "../../../extensions/workflows/runtime/workflow-journal.js";
import type { WorkflowJournalLine } from "../../../extensions/workflows/runtime/workflow-runtime.js";
import type { CustomUiComponent, CustomUiFactory } from "../../../extensions/_shared/host/pi-api.js";
import {
  installWorkflowProgress,
  type WorkflowProgressComponent,
} from "../../../extensions/workflows/operator/progress-widget.js";
import { workflowBackgroundRunRegistry } from "../../../extensions/workflows/run/background-run-registry.js";
import { createHarness, emit } from "../../test-harness.js";

afterEach(() => {
  fleetMenuState.setFocused(false);
  fleetMenuState.setVisibleRows([]);
  fleetMenuState.setEmptyEditorFocusAvailable(false);
  fleetMenuState.setFallbackFocusAvailable(false);
  agentLiveStore.reset();
});

function row(id: string, title: string, status: AgentLiveStatus = "working") {
  const value = agentLiveStore.begin({ id, agentName: "reviewer", label: title, title });
  return agentLiveStore.patch(value.id, { status })!;
}

describe("agent fleet menu", () => {
  it("puts the newest workflow run first and labels the runs behind it", () => {
    const earlier = agentLiveStore.begin({
      id: "workflow-agent:20260726-183012-a6aa:default",
      agentName: "default",
      label: "decide clarification",
      title: "decide clarification",
      workflowRunId: "20260726-183012-a6aa",
    });
    agentLiveStore.patch(earlier.id, { status: "done" });
    const current = agentLiveStore.begin({
      id: "workflow-agent:20260726-183412-b2c4:reviewer",
      agentName: "reviewer",
      label: "inventory changes",
      title: "inventory changes",
      workflowRunId: "20260726-183412-b2c4",
    });
    agentLiveStore.patch(current.id, { status: "working" });

    const rendered = renderFleetMenuRows([...agentLiveStore.rows.values()], 120, {});
    const text = rendered.join("\n");
    const label = rendered.findIndex((line) => line.includes("earlier workflow runs"));
    const currentRow = rendered.findIndex((line) => line.includes("inventory changes"));
    const earlierRow = rendered.findIndex((line) => line.includes("decide clarification"));

    expect(label).toBeGreaterThan(-1);
    expect(currentRow).toBeLessThan(label);
    expect(earlierRow).toBeGreaterThan(label);
    // Nothing is hidden: the earlier run stays drillable, it is only ranked below.
    expect(text).toContain("decide clarification");
  });

  it("keeps the same row projection when focus adds only the cursor and controls", () => {
    const first = row("row-a", "review auth");
    const second = row("row-b", "run tests");
    const rows = [first, second];
    const passive = renderFleetMenuRows(rows, 120, { focusShortcutsAvailable: true });
    const focused = renderFleetMenuRows(rows, 120, { focused: true, selectedRowId: second.id });

    const passiveRows = passive.slice(0, -1).map((line) => line.slice(2));
    const focusedRows = focused.slice(0, -1).map((line) => line.slice(2));
    expect(focusedRows).toEqual(passiveRows);
    expect(focused[1]).toMatch(/^▸ /);
    expect(passive.at(-1)).toContain("manage");
    expect(focused.at(-1)).toContain("stop");
    expect(focused.at(-1)).toContain("back");
  });

  it("caps the passive fleet at eight rows and reports the hidden count", () => {
    const rows = Array.from({ length: 11 }, (_unused, index) => row(`row-${index}`, `task ${index}`));

    const selected = selectFleetMenuRows(rows);
    const rendered = renderFleetMenuRows(rows, 120, { focusShortcutsAvailable: true });

    expect(selected).toHaveLength(8);
    expect(rendered.some((line) => line.includes("… and 3 more"))).toBe(true);
  });

  it("shows only explicit Shift+Down as the fleet shortcut", () => {
    const rendered = renderFleetMenuRows([row("down-row", "down agent")], 120, {
      emptyEditorFocusAvailable: true,
      fallbackFocusAvailable: true,
    });
    expect(rendered.at(-1)).toContain("shift+down manage");
    expect(rendered.at(-1)).not.toMatch(/(?:^|\s)down manage/u);
    expect(rendered.at(-1)).not.toContain("cmd+");
    expect(rendered.at(-1)).not.toContain("ctrl+");
  });

  it("leaves bare arrows to Pi and uses explicit Shift+Down to drill the selected row", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    row("workflow-agent:run:reviewer:a:phase", "first workflow row");
    const second = row("workflow-agent:run:reviewer:b:phase", "second workflow row");
    fleetMenuState.setVisibleRows(selectFleetMenuRows([...agentLiveStore.rows.values()]));
    h.customInputQueue.push("down", "enter", "q");

    expect(h.shortcuts.has(FLEET_FOCUS_FALLBACK_SHORTCUT)).toBe(true);
    expect(h.shortcuts.has("super+down")).toBe(false);
    expect(h.shortcuts.has("ctrl+down")).toBe(false);

    const down = [...h.terminalInputHandlers].map((handler) => handler("down"));
    const up = [...h.terminalInputHandlers].map((handler) => handler("up"));
    expect(down.every((result) => result === undefined)).toBe(true);
    expect(up.every((result) => result === undefined)).toBe(true);
    await h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    await vi.waitFor(() => expect(h.customOptions).toEqual([{ overlay: false }, { overlay: false }]));

    expect(h.customRenderFrames.at(-1)?.[0]).toContain(second.displayName);
    expect(fleetMenuState.focused).toBe(false);
  });

  it("leaves Up and Down to Pi even when the editor is empty and fleet rows are visible", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    row("editor-guard-row", "do not steal arrows");

    fleetMenuState.setVisibleRows(selectFleetMenuRows([...agentLiveStore.rows.values()]));
    const up = [...h.terminalInputHandlers].map((handler) => handler("up"));
    expect(up.every((result) => result === undefined)).toBe(true);

    const down = [...h.terminalInputHandlers].map((handler) => handler("down"));
    expect(down.every((result) => result === undefined)).toBe(true);
    expect(h.customComponents).toHaveLength(0);
  });

  it("renders focused rows and controls in the shared selector while the passive widget stays below editor", () => {
    const active = row("screen-order-row", "prove screen order");
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    installWorkflowProgress(h.ctx, "fleet-order", "screen-order", "run");
    const factory = h.widgetPayloads.get("fleet-order") as (
      tui: { requestRender(): void; terminal: { rows: number; columns: number } },
      theme: unknown,
    ) => WorkflowProgressComponent;
    const widget = factory({ requestRender: vi.fn(), terminal: { rows: 30, columns: 120 } }, {});
    fleetMenuState.setVisibleRows([active]);
    fleetMenuState.setFocused(true);
    const keyCapture = new FleetFocusComponent(() => [active], {}, { requestRender: vi.fn() }, vi.fn());

    const focused = keyCapture.render(120);
    const passive = widget.render(120);

    expect(h.widgetOptions.get("fleet-order")).toEqual({ placement: "belowEditor" });
    expect(focused.join("\n")).toContain("prove screen order");
    expect(focused.at(-1)).toContain("stop");
    expect(focused.at(-1)).toContain("back");
    expect(passive.join("\n")).toContain("prove screen order");
    expect(passive.at(-1)).toContain("manage");
    keyCapture.dispose();
    widget.dispose();
  });

  it("derives /ps rows from the global live store when ordinary and workflow panels coexist", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    const ordinary = row("ordinary-agent-row", "ordinary agent work");
    const workflowPanel = installWorkflowProgress(h.ctx, "workflow-coexistence", "review", "coexist-run", {
      scope: "workflow",
      declaredStages: [{ title: "review" }],
    });
    const workflowLine: WorkflowJournalLine = {
      ts: "2026-07-22T00:00:00.000Z",
      runId: "coexist-run",
      kind: "agent_start",
      agent: "reviewer",
      label: "workflow agent work",
      phase: "review",
    };
    applyWorkflowJournalLineToAgentLiveStore(workflowLine);
    workflowPanel.push(workflowLine);
    const workflowRow = agentLiveStore.rows.get(workflowAgentLiveRowId(workflowLine));
    if (workflowRow === undefined) throw new Error("expected projected workflow row");
    fleetMenuState.setVisibleRows([workflowRow]);
    workflowPanel.render(120);

    h.customInputQueue.push("escape");
    await h.commands.get("ps")!.handler("", h.ctx);

    const focused = h.customRenderFrames.at(-1)?.join("\n") ?? "";
    expect(focused).toContain(ordinary.displayName);
    expect(focused).toContain(workflowRow.displayName);
    expect(fleetMenuState.visibleRows()).toEqual([]);
    expect(fleetMenuState.selectedRowId).toBeUndefined();
    workflowPanel.dispose();
  });

  it("routes x through a stop request instead of cancelling immediately, while Esc only returns", () => {
    const active = row("cancel-row", "stop this child");
    const cancel = vi.fn();
    agentLiveStore.registerCancel(active.id, cancel);
    fleetMenuState.setVisibleRows([active]);
    fleetMenuState.setFocused(true);
    const done = vi.fn();
    const component = new FleetFocusComponent(() => [active], {}, { requestRender: vi.fn() }, done);

    component.handleInput("x");
    component.handleInput("escape");

    expect(cancel).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith({ kind: "stop", rowId: active.id });
    expect(done).toHaveBeenCalledWith({ kind: "close" });
    component.dispose();
  });

  it("keeps workflow rows inspectable but removes the competing x stop path", () => {
    const workflowLine: WorkflowJournalLine = {
      ts: "t",
      runId: "workflow-command-owned",
      kind: "agent_start",
      agent: "reviewer",
      label: "workflow child",
    };
    applyWorkflowJournalLineToAgentLiveStore(workflowLine);
    const workflowRow = agentLiveStore.rows.get(workflowAgentLiveRowId(workflowLine));
    expect(workflowRow).toMatchObject({ status: "working", workflowRunId: "workflow-command-owned" });
    if (workflowRow === undefined) throw new Error("expected workflow row");
    const done = vi.fn();
    fleetMenuState.setVisibleRows([workflowRow]);
    const rendered = renderFleetMenuRows([workflowRow], 120, {
      focused: true,
      selectedRowId: workflowRow.id,
    });
    const component = new FleetFocusComponent(() => [workflowRow], {}, { requestRender: vi.fn() }, done);

    component.handleInput("x");

    expect(rendered.at(-1)).not.toContain("stop");
    expect(done).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "stop" }));
    component.dispose();
  });

  it("cancels a selected child only after the operator confirms the x stop request", async () => {
    const active = row("confirmed-stop-row", "confirm this stop");
    const cancel = vi.fn();
    agentLiveStore.registerCancel(active.id, cancel);
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);

    h.confirmQueue.push(false);
    h.customInputQueue.push("x");
    await h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    expect(cancel).not.toHaveBeenCalled();
    expect(h.notifications).toContain("Agent continues running.");

    h.confirmQueue.push(true);
    h.customInputQueue.push("x");
    await h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.notifications).toContain("Agent cancellation requested.");
  });

  it("does not cancel a same-id replacement registered while stop confirmation is pending", async () => {
    const original = row("confirm-authority-row", "original execution");
    const originalCancel = vi.fn();
    agentLiveStore.registerCancel(original.id, originalCancel);
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    let resolveConfirm!: (confirmed: boolean) => void;
    const pendingConfirm = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    h.ctx.ui.confirm = vi.fn(async () => pendingConfirm);
    h.customInputQueue.push("x");

    const stopping = h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    await vi.waitFor(() => expect(h.ctx.ui.confirm).toHaveBeenCalledOnce());
    const replacement = agentLiveStore.begin({
      id: original.id,
      agentName: "reviewer",
      label: "replacement execution",
      title: "replacement execution",
    });
    agentLiveStore.patch(replacement.id, { status: "working" });
    const replacementCancel = vi.fn();
    agentLiveStore.registerCancel(replacement.id, replacementCancel);
    resolveConfirm(true);
    await stopping;

    expect(originalCancel).not.toHaveBeenCalled();
    expect(replacementCancel).not.toHaveBeenCalled();
    expect(h.notifications).toContain(`Agent ${replacement.id} is no longer stoppable.`);

    h.ctx.ui.confirm = vi.fn(async () => true);
    h.customInputQueue.push("x");
    await h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    expect(replacementCancel).toHaveBeenCalledOnce();
    expect(h.notifications).toContain("Agent cancellation requested.");
  });

  it("does not invoke a still-registered cancel seam after the row becomes terminal during confirmation", async () => {
    const active = row("terminal-during-confirm", "finishing execution");
    const cancel = vi.fn();
    agentLiveStore.registerCancel(active.id, cancel);
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    let resolveConfirm!: (confirmed: boolean) => void;
    const pendingConfirm = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    h.ctx.ui.confirm = vi.fn(async () => pendingConfirm);
    h.customInputQueue.push("x");

    const stopping = h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    await vi.waitFor(() => expect(h.ctx.ui.confirm).toHaveBeenCalledOnce());
    agentLiveStore.patch(active.id, { status: "done" });
    resolveConfirm(true);
    await stopping;

    expect(cancel).not.toHaveBeenCalled();
    expect(h.notifications).toContain(`Agent ${active.id} is no longer stoppable.`);
  });

  it("asks before global Escape aborts an active parent agent operation", async () => {
    const h = createHarness(process.cwd(), { isStreaming: true });
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    row("escape-guard-row", "guard this child");

    h.confirmQueue.push(false);
    const first = [...h.terminalInputHandlers].map((handler) => handler("\u001b"));
    await vi.waitFor(() => expect(h.confirmCalls).toHaveLength(1));
    expect(first).toContainEqual({ consume: true });
    expect(h.abortCalls).toBe(0);
    expect(h.notifications).toContain("Agent operation continues.");

    h.confirmQueue.push(true);
    const second = [...h.terminalInputHandlers].map((handler) => handler("escape"));
    await vi.waitFor(() => expect(h.abortCalls).toBe(1));
    expect(second).toContainEqual({ consume: true });
    expect(h.notifications).toContain("Agent cancellation requested.");
  });

  it("consumes global Escape without aborting or confirming while a workflow row is active", async () => {
    const h = createHarness(process.cwd(), { isStreaming: true });
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    applyWorkflowJournalLineToAgentLiveStore({
      ts: "t",
      runId: "escape-workflow",
      kind: "agent_start",
      agent: "reviewer",
      label: "workflow child",
    });

    const results = [...h.terminalInputHandlers].map((handler) => handler("\u001b"));

    expect(results).toContainEqual({ consume: true });
    expect(h.abortCalls).toBe(0);
    expect(h.confirmCalls).toEqual([]);
  });

  it("consumes global Escape while a tool workflow is active before its first live row", async () => {
    const sessionId = "escape-pending-workflow";
    const h = createHarness(process.cwd(), { isStreaming: true, sessionId });
    h.ctx.hasUI = true;
    const registry = workflowBackgroundRunRegistry();
    const lease = registry.startSession(process.cwd(), sessionId);
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const launched = registry.attach(lease, new AbortController().signal, async () => pending);
    expect(launched.ok).toBe(true);
    agents(h.pi);
    await emit(h, "session_start");

    const results = [...h.terminalInputHandlers].map((handler) => handler("\u001b"));

    expect(results).toContainEqual({ consume: true });
    expect(h.abortCalls).toBe(0);
    expect(h.confirmCalls).toEqual([]);

    settle();
    if (launched.ok) await launched.run.terminal;
    registry.shutdown(lease);
  });

  it("removes the stop affordance and ignores x for a cancelled terminal row", () => {
    const terminal = row("cancelled-row", "cancelled child", "cancelled");
    const staleCancel = vi.fn();
    agentLiveStore.registerCancel(terminal.id, staleCancel);
    fleetMenuState.setVisibleRows([terminal]);
    fleetMenuState.setFocused(true);

    const rendered = renderFleetMenuRows([terminal], 120, { focused: true, selectedRowId: terminal.id });
    const component = new FleetFocusComponent(() => [terminal], {}, { requestRender: vi.fn() }, vi.fn());
    component.handleInput("x");

    expect(rendered.at(-1)).not.toContain("stop");
    expect(rendered.join("\n")).toContain("⊘");
    expect(staleCancel).not.toHaveBeenCalled();
    component.dispose();
  });

  it("renders aggregate rows but skips them for cursor, Enter, and x", () => {
    const group = agentLiveStore.begin({
      id: "workflow:run:group:parallel-1",
      agentName: "workflow-group",
      label: "parallel (2)",
      groupKind: "parallel",
      groupTotal: 2,
    });
    const firstRow = agentLiveStore.begin({
      id: "parallel-child-1",
      parentRowId: group.id,
      agentName: "reviewer",
      label: "first child",
    });
    const secondRow = agentLiveStore.begin({
      id: "parallel-child-2",
      parentRowId: group.id,
      agentName: "reviewer",
      label: "second child",
    });
    const first = agentLiveStore.patch(firstRow.id, { status: "working" })!;
    const second = agentLiveStore.patch(secondRow.id, { status: "working" })!;
    const rows = selectFleetMenuRows([group, first, second]);
    fleetMenuState.setVisibleRows(rows);
    fleetMenuState.setFocused(true);
    const done = vi.fn();
    const tui = { requestRender: vi.fn() };
    const component = new FleetFocusComponent(() => rows, {}, tui, done);

    expect(
      renderFleetMenuRows(rows, 120, { focused: true, selectedRowId: fleetMenuState.selectedRowId! }).join("\n"),
    ).toContain("parallel (2)");
    expect(
      renderFleetMenuRows(rows, 120, { focused: true, selectedRowId: group.id }).some((line) => line.startsWith("▸ ")),
    ).toBe(false);
    expect(fleetMenuState.selectedRowId).toBe(first.id);
    component.handleInput("down");
    expect(fleetMenuState.selectedRowId).toBe(second.id);
    component.handleInput("enter");
    component.handleInput("x");

    expect(done).toHaveBeenCalledWith({ kind: "drill", rowId: second.id });
    expect(done).toHaveBeenCalledWith({ kind: "stop", rowId: second.id });
    expect(done).not.toHaveBeenCalledWith(expect.objectContaining({ rowId: group.id }));
    component.dispose();
  });

  it("repaints from live mutations, normalizes a removed cursor, and unsubscribes idempotently", () => {
    const first = row("live-focus-a", "first live row");
    const second = row("live-focus-b", "second live row");
    const requestRender = vi.fn();
    const before = agentLiveStore.emitter.listenerCount("change");
    const done = vi.fn();
    const component = new FleetFocusComponent(() => [...agentLiveStore.rows.values()], {}, { requestRender }, done);

    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before + 1);
    component.render(120);
    expect(fleetMenuState.selectedRowId).toBe(first.id);
    requestRender.mockClear();

    agentLiveStore.removeRows([first.id]);
    expect(requestRender).toHaveBeenCalledTimes(1);
    const rendered = component.render(120).join("\n");
    expect(fleetMenuState.selectedRowId).toBe(second.id);
    expect(rendered).toContain("second live row");
    expect(rendered).not.toContain("first live row");

    component.dispose();
    component.dispose();
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);
    requestRender.mockClear();
    agentLiveStore.patch(second.id, { label: "mutated after close" });
    expect(requestRender).not.toHaveBeenCalled();
    const selectedAfterDispose = fleetMenuState.selectedRowId;
    expect(component.render(120)).toEqual([]);
    component.handleInput("down");
    component.handleInput("enter");
    component.handleInput("x");
    component.handleInput("escape");
    component.invalidate();
    expect(fleetMenuState.selectedRowId).toBe(selectedAfterDispose);
    expect(done).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("coalesces a live-mutation storm and drops the trailing repaint on dispose", () => {
    // The focused /ps selector subscribes to the live store, which emits once
    // per SDK event. Unthrottled that is the render storm that flickers on WSL.
    vi.useFakeTimers();
    try {
      const target = row("storm-a", "storm row");
      const requestRender = vi.fn();
      const component = new FleetFocusComponent(
        () => [...agentLiveStore.rows.values()],
        {},
        { requestRender },
        vi.fn(),
      );
      component.render(120);
      requestRender.mockClear();

      for (let i = 0; i < 50; i += 1) agentLiveStore.patch(target.id, { title: `mutation ${i}` });

      // One leading repaint; the other 49 fold into a single trailing one.
      expect(requestRender).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS);
      expect(requestRender).toHaveBeenCalledTimes(2);

      // Newest state still reaches the screen.
      expect(component.render(120).join("\n")).toContain("mutation 49");

      // A pending trailing repaint must not outlive the component.
      agentLiveStore.patch(target.id, { title: "after close" });
      requestRender.mockClear();
      component.dispose();
      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS * 4);
      expect(requestRender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never repaints for store churn that changes nothing visible", () => {
    // On a console where every repaint blinks (WSL), the guarantee the operator
    // needs is byte-identity: a frame equal to what is on screen must not reach
    // the terminal at all — not even as a throttled leading render.
    vi.useFakeTimers();
    try {
      const target = row("quiet-a", "quiet row");
      const requestRender = vi.fn();
      const component = new FleetFocusComponent(
        () => [...agentLiveStore.rows.values()],
        {},
        { requestRender },
        vi.fn(),
      );
      component.render(120);
      requestRender.mockClear();

      // eventLines feed the observer digest, not the fleet row — invisible here.
      agentLiveStore.patch(target.id, { eventLines: ["tool bash started"] });
      vi.advanceTimersByTime(DEFAULT_RENDER_MIN_INTERVAL_MS * 4);
      expect(requestRender).not.toHaveBeenCalled();

      // A visible change still paints immediately.
      agentLiveStore.patch(target.id, { title: "now different" });
      expect(requestRender).toHaveBeenCalledTimes(1);

      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cursor movement on the immediate render path", () => {
    // Keystrokes are already human-rate-limited; throttling them would add
    // latency exactly where it is most visible.
    vi.useFakeTimers();
    try {
      row("cursor-a", "cursor row a");
      row("cursor-b", "cursor row b");
      const requestRender = vi.fn();
      const component = new FleetFocusComponent(
        () => [...agentLiveStore.rows.values()],
        {},
        { requestRender },
        vi.fn(),
      );
      component.render(120);
      requestRender.mockClear();

      component.handleInput("down");
      component.handleInput("up");
      component.handleInput("down");

      expect(requestRender).toHaveBeenCalledTimes(3);
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a stale menu result after reload even when the new session reuses the row id", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    row("reused-row", "old session row");
    const oldRequestRender = vi.fn();
    let oldComponent: CustomUiComponent | undefined;
    let resolveOld!: (value: unknown) => void;
    let oldFactoryDone = false;
    const oldResult = new Promise<unknown>((resolve) => {
      resolveOld = resolve;
    });
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>): Promise<T> {
      oldComponent = await factory({ requestRender: oldRequestRender }, {}, {}, (value) => {
        oldFactoryDone = true;
        resolveOld(value);
      });
      oldComponent.render(120);
      return oldResult as Promise<T>;
    };
    const oldMenu = h.commands.get("ps")!.handler("", h.ctx);
    await vi.waitFor(() => expect(oldComponent).toBeDefined());

    await emit(h, "session_start");
    const reused = row("reused-row", "new session row");
    row("new-session-second", "new session second row");
    const newCancel = vi.fn();
    agentLiveStore.registerCancel(reused.id, newCancel);
    const newRequestRender = vi.fn();
    let newComponent: CustomUiComponent | undefined;
    let resolveNew!: (value: unknown) => void;
    const newResult = new Promise<unknown>((resolve) => {
      resolveNew = resolve;
    });
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>): Promise<T> {
      newComponent = await factory({ requestRender: newRequestRender }, {}, {}, (value) => resolveNew(value));
      newComponent.render(120);
      return newResult as Promise<T>;
    };
    const newMenu = h.commands.get("ps")!.handler("", h.ctx);
    await vi.waitFor(() => expect(newComponent).toBeDefined());
    expect(fleetMenuState.focused).toBe(true);
    expect(fleetMenuState.selectedRowId).toBe(reused.id);
    const notificationsBeforeStaleResult = [...h.notifications];
    oldRequestRender.mockClear();
    newRequestRender.mockClear();

    expect(oldComponent?.render(120)).toEqual([]);
    // The session reset closed the old menu through its own `done` — that is what
    // hands Pi's editor slot back and lets the awaiting `/ps` handler return.
    // Its later input stays inert either way: the component is disposed, and the
    // ownership epoch stops any result from acting on the new session.
    expect(oldFactoryDone).toBe(true);
    oldComponent?.handleInput?.("down");
    oldComponent?.handleInput?.("enter");
    oldComponent?.handleInput?.("x");
    oldComponent?.handleInput?.("escape");
    expect(oldRequestRender).not.toHaveBeenCalled();
    expect(newRequestRender).not.toHaveBeenCalled();
    expect(fleetMenuState.selectedRowId).toBe(reused.id);

    resolveOld({ kind: "stop", rowId: reused.id });
    await oldMenu;
    expect(newCancel).not.toHaveBeenCalled();
    expect(h.notifications).toEqual(notificationsBeforeStaleResult);
    expect(fleetMenuState.focused).toBe(true);
    expect(fleetMenuState.selectedRowId).toBe(reused.id);

    resolveNew({ kind: "stop", rowId: reused.id });
    await newMenu;
    expect(newCancel).toHaveBeenCalledTimes(1);
    expect(h.notifications).toContain("Agent cancellation requested.");
    expect(fleetMenuState.focused).toBe(false);
    expect(fleetMenuState.selectedRowId).toBeUndefined();
  });

  it("disposes open focused selectors before session reset and shutdown without carrying their cursor", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    await emit(h, "session_start");
    const oldFirst = row("old-session-a", "old first row");
    row("old-session-b", "old second row");
    const before = agentLiveStore.emitter.listenerCount("change");
    const discardedRequestRender = vi.fn();
    const oldRequestRender = vi.fn();
    let oldComponent: CustomUiComponent | undefined;
    let resolveOld!: (value: unknown) => void;
    const oldResult = new Promise<unknown>((resolve) => {
      resolveOld = resolve;
    });
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>): Promise<T> {
      await factory({ requestRender: discardedRequestRender }, {}, {}, (value) => resolveOld(value));
      oldComponent = await factory({ requestRender: oldRequestRender }, {}, {}, (value) => resolveOld(value));
      oldComponent.render(120);
      return oldResult as Promise<T>;
    };

    const oldMenu = h.commands.get("ps")!.handler("", h.ctx);
    await vi.waitFor(() => expect(oldComponent).toBeDefined());
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before + 1);
    expect(fleetMenuState.focused).toBe(true);
    expect(fleetMenuState.selectedRowId).toBe(oldFirst.id);
    // Patch the rendered title (label is shadowed by it and would be filtered
    // by the frame-identity gate as an invisible change).
    agentLiveStore.patch(oldFirst.id, { title: "old row mutated" });
    expect(oldRequestRender).toHaveBeenCalledTimes(1);
    expect(discardedRequestRender).not.toHaveBeenCalled();
    oldRequestRender.mockClear();

    await emit(h, "session_start");
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);
    expect(oldRequestRender).not.toHaveBeenCalled();
    expect(fleetMenuState.focused).toBe(false);
    expect(fleetMenuState.selectedRowId).toBeUndefined();
    resolveOld({ kind: "close" });
    await oldMenu;

    const newFirst = row("new-session-a", "new first row");
    const newSecond = row("new-session-b", "new second row");
    let newRendered: string[] = [];
    let selectedInNewSession: string | undefined;
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>): Promise<T> {
      let result: T | undefined;
      const component = await factory({ requestRender: vi.fn() }, {}, {}, (value) => {
        result = value;
      });
      newRendered = component.render(120);
      component.handleInput?.("down");
      selectedInNewSession = fleetMenuState.selectedRowId;
      component.handleInput?.("escape");
      return result as T;
    };
    await h.commands.get("ps")!.handler("", h.ctx);
    expect(newRendered.join("\n")).toContain(newFirst.displayName);
    expect(newRendered.join("\n")).toContain(newSecond.displayName);
    expect(selectedInNewSession).toBe(newSecond.id);
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);

    const shutdownRequestRender = vi.fn();
    let resolveShutdown!: (value: unknown) => void;
    const shutdownResult = new Promise<unknown>((resolve) => {
      resolveShutdown = resolve;
    });
    h.ctx.ui.custom = async function <T>(factory: CustomUiFactory<T>): Promise<T> {
      const component = await factory({ requestRender: shutdownRequestRender }, {}, {}, (value) => {
        resolveShutdown(value);
      });
      component.render(120);
      return shutdownResult as Promise<T>;
    };
    const shutdownMenu = h.commands.get("ps")!.handler("", h.ctx);
    await vi.waitFor(() => expect(agentLiveStore.emitter.listenerCount("change")).toBe(before + 1));
    shutdownRequestRender.mockClear();
    await emit(h, "session_shutdown", { reason: "reload" });
    expect(agentLiveStore.emitter.listenerCount("change")).toBe(before);
    expect(fleetMenuState.focused).toBe(false);
    expect(fleetMenuState.selectedRowId).toBeUndefined();
    agentLiveStore.patch(newFirst.id, { label: "mutated after shutdown" });
    expect(shutdownRequestRender).not.toHaveBeenCalled();
    resolveShutdown({ kind: "close" });
    await shutdownMenu;
  });

  it("traverses group to journal anchor to transcript leaf for guidance, exact /ps tails, and last", async () => {
    const groupKey = "parallel-1";
    const start: WorkflowJournalLine = {
      ts: "2026-07-13T10:00:00.000Z",
      runId: "final-review",
      kind: "agent_start",
      agent: "reviewer",
      label: "review final repairs",
      phase: "verify",
      groupId: groupKey,
      groupKind: "parallel",
    };
    applyWorkflowJournalLineToAgentLiveStore({
      ts: start.ts,
      runId: start.runId,
      kind: "group_start",
      groupId: groupKey,
      groupKind: "parallel",
      groupTotal: 1,
    });
    applyWorkflowJournalLineToAgentLiveStore(start);
    const groupId = workflowGroupLiveRowId(start);
    const anchorId = workflowAgentLiveRowId(start);
    const childId = workflowAgentLiveChildRowId(start);
    const child = agentLiveStore.begin({
      id: childId,
      parentRowId: anchorId,
      agentName: "reviewer",
      label: "review final repairs",
    });
    agentLiveStore.feedSessionEvent(child.id, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Repairs verified" }], stopReason: "stop" },
    });
    agentLiveStore.patch(child.id, { status: "done" });
    expect(selectFleetMenuLeafRows([...agentLiveStore.rows.values()]).map((row) => row.id)).toEqual([child.id]);

    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);

    h.customInputQueue.push("escape");
    await h.commands.get("ps")!.handler("last", h.ctx);
    expect(h.customRenderFrames.at(-1)?.[0]).toContain(child.displayName);
    expect(h.customRenderFrames.at(-1)?.join("\n")).toContain("Repairs verified");

    await h.commands.get("ps")!.handler(groupId, h.ctx);
    expect(h.widgets.get("agents")).toContain("is a group summary; choose one child agent.");
    expect(h.widgets.get("agents")).toContain("Open /ps and select a child");
    expect(h.widgets.get("agents")).toContain(child.id);

    await h.commands.get("ps")!.handler(anchorId, h.ctx);
    expect(h.widgets.get("agents")).toContain("is a group summary; choose one child agent.");
    expect(h.widgets.get("agents")).toContain("Open /ps and select a child");
    expect(h.widgets.get("agents")).toContain(child.id);

    h.customInputQueue.push("escape");
    await h.commands.get("ps")!.handler(`  ${child.id}  `, h.ctx);
    expect(h.customRenderFrames.at(-1)?.[0]).toContain(child.displayName);
    expect(h.customRenderFrames.at(-1)?.join("\n")).toContain("Repairs verified");
  });

  it("resolves an active workflow row by petname and last", async () => {
    const workflow = row("workflow-agent:active:reviewer:verify:phase", "verify workflow output");
    const petname = workflow.displayName!;
    const byPetname = createHarness();
    byPetname.ctx.hasUI = true;
    byPetname.customInputQueue.push("q");
    agents(byPetname.pi);

    await byPetname.commands.get("agent")!.handler(`drill ${petname}`, byPetname.ctx);
    expect(byPetname.customRenderFrames[0]?.[0]).toContain(workflow.displayName);

    const byLast = createHarness();
    byLast.ctx.hasUI = true;
    byLast.customInputQueue.push("q");
    agents(byLast.pi);
    await byLast.commands.get("agent")!.handler("drill last", byLast.ctx);
    expect(byLast.customRenderFrames[0]?.[0]).toContain(workflow.displayName);
    expect(byLast.customRenderFrames[0]?.join("\n")).toContain("Agent is working; waiting for assistant output");
  });

  it("degrades to passive rows when custom UI is absent", async () => {
    const active = row("passive-row", "headless-safe");
    const h = createHarness();
    h.ctx.hasUI = false;
    delete h.ctx.ui.custom;
    agents(h.pi);

    await expect(h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx)).resolves.toBeUndefined();
    expect(renderFleetMenuRows([active], 80, { focusShortcutsAvailable: false }).join("\n")).toContain("headless-safe");
  });

  it("uses string-array passive widgets and honest focus/drill fallback in RPC mode", async () => {
    const h = createHarness(process.cwd(), { mode: "rpc" });
    h.ctx.hasUI = true;
    agents(h.pi);
    const panel = installWorkflowProgress(h.ctx, "rpc-fleet", "rpc-run", "run");
    const active = row("rpc-row", "rpc passive row");

    expect(Array.isArray(h.widgetPayloads.get("rpc-fleet"))).toBe(true);
    expect(h.widgets.get("rpc-fleet")).toContain("rpc passive row");
    await h.shortcuts.get(FLEET_FOCUS_FALLBACK_SHORTCUT)!.handler(h.ctx);
    expect(h.widgets.get("agents")).toContain("unavailable in rpc mode");
    await h.commands.get("agent")!.handler(`drill ${active.id}`, h.ctx);
    expect(h.widgets.get("agents")).toContain("[WARN] Agent drill");
    expect(h.widgets.get("agents")).toContain("Interactive drill is unavailable in rpc mode.");
    expect(h.customOptions).toEqual([]);
    panel.dispose();
  });
});
