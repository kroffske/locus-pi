import { afterEach, describe, expect, it, vi } from "vitest";
import agents from "../../../extensions/agents/index.js";
import {
  FLEET_FOCUS_FALLBACK_SHORTCUT,
  FleetFocusComponent,
  fleetMenuState,
  renderFleetMenuRows,
  selectFleetMenuLeafRows,
  selectFleetMenuRows,
} from "../../../extensions/_shared/fleet-menu.js";
import { agentLiveStore, type AgentLiveStatus } from "../../../extensions/_shared/agent-sdk-host.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  workflowAgentLiveChildRowId,
  workflowAgentLiveRowId,
  workflowGroupLiveRowId,
} from "../../../extensions/_shared/workflow-journal.js";
import type { WorkflowJournalLine } from "../../../extensions/_shared/workflow-runtime.js";
import { installWorkflowProgress, type WorkflowProgressComponent } from "../../../extensions/workflows/progress-widget.js";
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
    await vi.waitFor(() => expect(h.customOptions).toEqual([undefined, {
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
    }]));

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

  it("keeps focused controls as the last belowEditor widget line while the editor replacement stays empty", () => {
    const active = row("screen-order-row", "prove screen order");
    const h = createHarness();
    h.ctx.hasUI = true;
    agents(h.pi);
    installWorkflowProgress(h.ctx, "fleet-order", "screen-order", "run");
    const factory = h.widgetPayloads.get("fleet-order") as
      ((tui: { requestRender(): void; terminal: { rows: number; columns: number } }, theme: unknown) => WorkflowProgressComponent);
    const widget = factory({ requestRender: vi.fn(), terminal: { rows: 30, columns: 120 } }, {});
    fleetMenuState.setVisibleRows([active]);
    fleetMenuState.setFocused(true);
    const keyCapture = new FleetFocusComponent(() => [active], {}, { requestRender: vi.fn() }, vi.fn());

    const screen = [...keyCapture.render(120), ...widget.render(120)];

    expect(keyCapture.render(120)).toEqual([]);
    expect(h.widgetOptions.get("fleet-order")).toEqual({ placement: "belowEditor" });
    expect(screen.at(-1)).toContain("stop");
    expect(screen.at(-1)).toContain("back");
    expect(screen.findIndex((line) => line.includes("prove screen order"))).toBeLessThan(screen.length - 1);
    widget.dispose();
  });

  it("routes x through a stop request instead of cancelling immediately, while Esc only returns", () => {
    const active = row("cancel-row", "stop this child");
    const cancel = vi.fn();
    agentLiveStore.registerCancel(active.id, cancel);
    fleetMenuState.setVisibleRows([active]);
    fleetMenuState.setFocused(true);
    const done = vi.fn();
    const component = new FleetFocusComponent(
      () => [active],
      {},
      { requestRender: vi.fn() },
      done,
    );

    component.handleInput("x");
    component.handleInput("escape");

    expect(cancel).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith({ kind: "stop", rowId: active.id });
    expect(done).toHaveBeenCalledWith({ kind: "close" });
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

  it("removes the stop affordance and ignores x for a cancelled terminal row", () => {
    const terminal = row("cancelled-row", "cancelled child", "cancelled");
    const staleCancel = vi.fn();
    agentLiveStore.registerCancel(terminal.id, staleCancel);
    fleetMenuState.setVisibleRows([terminal]);
    fleetMenuState.setFocused(true);

    const rendered = renderFleetMenuRows([terminal], 120, { focused: true, selectedRowId: terminal.id });
    const component = new FleetFocusComponent(
      () => [terminal],
      {},
      { requestRender: vi.fn() },
      vi.fn(),
    );
    component.handleInput("x");

    expect(rendered.at(-1)).not.toContain("stop");
    expect(rendered.join("\n")).toContain("⊘");
    expect(staleCancel).not.toHaveBeenCalled();
  });

  it("renders aggregate rows but skips them for cursor, Enter, and x", () => {
    const group = agentLiveStore.begin({
      id: "workflow:run:group:parallel-1",
      agentName: "workflow-group",
      label: "parallel (2)",
      groupKind: "parallel",
      groupTotal: 2,
    });
    const firstRow = agentLiveStore.begin({ id: "parallel-child-1", parentRowId: group.id, agentName: "reviewer", label: "first child" });
    const secondRow = agentLiveStore.begin({ id: "parallel-child-2", parentRowId: group.id, agentName: "reviewer", label: "second child" });
    const first = agentLiveStore.patch(firstRow.id, { status: "working" })!;
    const second = agentLiveStore.patch(secondRow.id, { status: "working" })!;
    const rows = selectFleetMenuRows([group, first, second]);
    fleetMenuState.setVisibleRows(rows);
    fleetMenuState.setFocused(true);
    const done = vi.fn();
    const tui = { requestRender: vi.fn() };
    const component = new FleetFocusComponent(() => rows, {}, tui, done);

    expect(renderFleetMenuRows(rows, 120, { focused: true, selectedRowId: fleetMenuState.selectedRowId! }).join("\n")).toContain("parallel (2)");
    expect(renderFleetMenuRows(rows, 120, { focused: true, selectedRowId: group.id }).some((line) => line.startsWith("▸ "))).toBe(false);
    expect(fleetMenuState.selectedRowId).toBe(first.id);
    component.handleInput("down");
    expect(fleetMenuState.selectedRowId).toBe(second.id);
    component.handleInput("enter");
    component.handleInput("x");

    expect(done).toHaveBeenCalledWith({ kind: "drill", rowId: second.id });
    expect(done).toHaveBeenCalledWith({ kind: "stop", rowId: second.id });
    expect(done).not.toHaveBeenCalledWith(expect.objectContaining({ rowId: group.id }));
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
