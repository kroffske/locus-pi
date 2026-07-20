import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import workflowsExt from "../../../extensions/workflows/index.js";
import * as runner from "../../../extensions/_shared/workflow-runner.js";
import {
  WORKFLOW_LIVE_WIDGET_KEY,
  WorkflowProgressComponent,
  WorkflowTextComponent,
  installWorkflowProgress,
  installWorkflowTextWidget,
  renderAgentLiveRowsText,
} from "../../../extensions/workflows/progress-widget.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-sdk-host.js";
import { fleetMenuState } from "../../../extensions/_shared/fleet-menu.js";
import { workflowAgentLiveRowId } from "../../../extensions/_shared/workflow-journal.js";
import type { WorkflowJournalLine } from "../../../extensions/_shared/workflow-runtime.js";
import { createHarness, emit, runTool } from "../../test-harness.js";

function line(input: Omit<WorkflowJournalLine, "ts"> & { ts: string | number }): WorkflowJournalLine {
  return input as WorkflowJournalLine;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function writeWorkflowRun(root: string, runId: string): void {
  const dir = path.join(root, ".locus", "runtime", "workflows", runId);
  const journal: WorkflowJournalLine[] = [
    { ts: "2026-01-01T00:00:00.000Z", runId, kind: "phase", phase: "repair-proof" },
    { ts: "2026-01-01T00:00:01.000Z", runId, kind: "error", message: "failed proof" },
  ];
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "journal.ndjson"),
    journal.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );
  writeFileSync(path.join(dir, "result.json"), JSON.stringify({ runId, ok: false, journal }), "utf8");
}

function renderHarnessWidget(harness: ReturnType<typeof createHarness>, key = "workflows", width = 220): string {
  const payload = harness.widgetPayloads.get(key);
  expect(typeof payload).toBe("function");
  const stubTui = { requestRender: vi.fn(), terminal: { rows: 100, columns: width } };
  const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
  return component.render(width).join("\n");
}

describe("workflow progress widget", () => {
  it("renders phase, agent transitions, durations, and stays inside the terminal budget", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
    const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "r1");

    component.push(line({ kind: "phase", phase: "smoke", ts: 1, runId: "r1" }));
    component.push(line({ kind: "log", message: "starting", ts: 2, runId: "r1" }));
    component.push(line({ kind: "agent_start", agent: "explore", label: "note:explore", ts: 3, runId: "r1" }));
    component.push(
      line({
        kind: "agent_end",
        agent: "explore",
        label: "note:explore",
        status: "failed",
        durationMs: 22247,
        ts: 25,
        runId: "r1",
      }),
    );
    component.push(line({ kind: "agent_start", agent: "quick_task", label: "note:quick", ts: 26, runId: "r1" }));
    component.push(
      line({
        kind: "agent_end",
        agent: "quick_task",
        label: "note:quick",
        status: "completed",
        durationMs: 4346,
        ts: 30,
        runId: "r1",
      }),
    );

    const rendered = component.render(100);
    const text = rendered.join("\n");

    expect(rendered.length).toBeLessThanOrEqual(Math.max(6, Math.min(30 - 6, 24)));
    expect(text).toContain("workflow live-smoke (r1) - RUNNING phase=smoke active=0 done=2/2 failed=1");
    // T-191: the agent name is now the petname; the row's title carries the label
    // (`explore (note:explore)` → `note:explore`), so assert on titles + durations.
    expect(text).toContain("note:explore");
    expect(text).toContain("note:quick");
    expect(text).toContain("22s");
    expect(text).toContain("4s");
    expect(rendered.some((renderedLine) => renderedLine.includes("widget truncated"))).toBe(false);
  });

  it("projects a cancelled agent_end as terminal while the workflow may still finish successfully", () => {
    agentLiveStore.reset();
    fleetMenuState.setFocused(false);
    fleetMenuState.setVisibleRows([]);
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 120 } };
      const component = new WorkflowProgressComponent(tui, {}, "cancel-smoke", "cancel-r1");
      const start = line({ kind: "agent_start", agent: "reviewer", label: "sleep 60", ts: 1, runId: "cancel-r1" });
      const end = line({
        kind: "agent_end",
        agent: "reviewer",
        label: "sleep 60",
        status: "cancelled",
        durationMs: 60_000,
        ts: 2,
        runId: "cancel-r1",
      });

      component.push(start);
      component.render(120); // Seeds the exact row selected by the shared fleet menu.
      fleetMenuState.setFocused(true);
      component.push(end);
      component.finish({ ok: true, result: { summary: "child status reviewer cancelled" } });

      const text = component.render(120).join("\n");
      expect(text).toContain("workflow cancel-smoke (cancel-r1) - OK phase=not-set active=0 done=1/1 cancelled=1");
      expect(text).toContain("⊘");
      expect(text).toContain("sleep 60");
      expect(text).toContain("✓ child status reviewer cancelled");
      expect(text).not.toMatch(/[⠿⠻⠽⠾]/u);
      expect(text).not.toContain("stop");
      expect(agentLiveStore.rows.get(workflowAgentLiveRowId(end))).toMatchObject({
        status: "cancelled",
        currentTools: [],
      });
    } finally {
      fleetMenuState.setFocused(false);
      fleetMenuState.setVisibleRows([]);
      agentLiveStore.reset();
    }
  });

  it("collapses workflow parent rows once SDK child rows exist", () => {
    agentLiveStore.reset();
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "nested-r1");
      const parentLine = line({
        kind: "agent_start",
        agent: "reviewer",
        label: "review-step",
        phase: "smoke",
        ts: 1,
        runId: "nested-r1",
      });
      const parentRowId = workflowAgentLiveRowId(parentLine);

      component.push(parentLine);
      const child = agentLiveStore.begin({
        parentRowId,
        agentName: "reviewer",
        label: "SDK child session",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.patch(child.id, { status: "working", currentTools: ["read"], stepCount: 1 });

      const rendered = component.render(100);
      const text = rendered.join("\n");

      expect(text).not.toContain("reviewer (review-step)");
      // T-191: new grammar — petname + title, no `on task`/hash tail; the `└`
      // action sub-line is deferred to T-196, so an active tool adds no sub-line.
      expect(text).toContain("SDK child session");
      expect(text).not.toContain("on task");
      expect(text).not.toMatch(/reviewer#\w+/);
      expect(text).not.toContain("[current task]");
      component.dispose();
    } finally {
      agentLiveStore.reset();
    }
  });

  it("collapses workflow parent rows in the text fallback", () => {
    agentLiveStore.reset();
    try {
      agentLiveStore.begin({
        id: "workflow:text-r1:reviewer:review-step:smoke",
        agentName: "reviewer",
        label: "reviewer (review-step)",
        isolated: false,
        noMcp: false,
      });
      const child = agentLiveStore.begin({
        parentRowId: "workflow:text-r1:reviewer:review-step:smoke",
        agentName: "reviewer",
        label: "SDK child session",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.patch(child.id, { status: "working", currentTools: ["read"], stepCount: 1 });

      const rendered = renderAgentLiveRowsText();

      expect(rendered).not.toContain("reviewer (review-step)");
      // T-191: `⠿ <petname>  SDK child session …` — no `[Working]`, no `on task`.
      // Assert the petname the store actually assigned: it is derived from a
      // time-based row id and may carry a `-2`, `-3`, … collision suffix, so any
      // guessed pattern is a flake waiting to happen.
      expect(child.displayName).toBeDefined();
      expect(rendered).toContain(`⠿ ${child.displayName}  SDK child session`);
      expect(rendered).not.toContain("[Working]");
      expect(rendered).not.toContain("on task");
      expect(rendered).not.toContain("[current task]");
    } finally {
      agentLiveStore.reset();
    }
  });

  it("renders the model+effort badge, token counter, and group summaries in the new grammar", () => {
    agentLiveStore.reset();
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 260 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "rich-r1");
      component.push(
        line({
          kind: "group_start",
          groupId: "parallel-1",
          groupKind: "parallel",
          groupTotal: 2,
          ts: 1,
          runId: "rich-r1",
        }),
      );
      component.push(
        line({
          kind: "agent_start",
          agent: "reviewer",
          label: "review-step",
          model: "test/strong",
          thinking: "high",
          groupId: "parallel-1",
          groupKind: "parallel",
          ts: 2,
          runId: "rich-r1",
        }),
      );
      const parentRowId = workflowAgentLiveRowId({ runId: "rich-r1", agent: "reviewer", label: "review-step" });
      const child = agentLiveStore.begin({
        parentRowId,
        agentName: "reviewer",
        label: "SDK child session",
        model: "test/strong",
        thinking: "high",
        isolated: true,
        noMcp: true,
      });
      agentLiveStore.patch(child.id, {
        status: "working",
        currentTools: ["read"],
        currentToolArgs: '{"file":"README.md"}',
        turnCount: 1,
        tokenCount: { input: 7, output: 8 },
      });
      component.push(
        line({
          kind: "llm_start",
          label: "classify",
          model: "test/fast",
          thinking: "low",
          groupId: "parallel-1",
          groupKind: "parallel",
          ts: 3,
          runId: "rich-r1",
        }),
      );
      component.push(
        line({
          kind: "llm_end",
          label: "classify",
          status: "completed",
          model: "test/fast",
          thinking: "low",
          usage: { input: 2, output: 3, totalTokens: 5, costTotal: 0 },
          durationMs: 123,
          groupId: "parallel-1",
          groupKind: "parallel",
          ts: 4,
          runId: "rich-r1",
        }),
      );
      component.push(
        line({
          kind: "group_end",
          status: "failed",
          groupId: "parallel-1",
          groupKind: "parallel",
          groupTotal: 2,
          groupCompleted: 1,
          groupFailed: 1,
          durationMs: 456,
          ts: 5,
          runId: "rich-r1",
        }),
      );

      const rendered = component.render(260).join("\n");

      // Group summary row: label + k/n done + failed count (no `[Working]`/`group=`).
      expect(rendered).toContain("parallel (2)");
      expect(rendered).toContain("1/2 done");
      expect(rendered).toContain("1 failed");
      expect(rendered).toMatch(/parallel \(2\).*↓20/);
      // SDK child agent row: petname + title, model+effort badge (provider stripped),
      // no `on task`/`/effort=`/`args=`/`turns=`/`flags=`/`[current task]` sub-line.
      expect(rendered).toContain("SDK child session");
      expect(rendered).toContain("strong high");
      expect(rendered).not.toContain("on task");
      expect(rendered).not.toContain("/effort=");
      expect(rendered).not.toContain("[current task]");
      expect(rendered).not.toContain("turns=");
      expect(rendered).not.toContain("flags=");
      // llm() row: petname + title + badge + token counter `↓(input+output)` (was `tokens=5`).
      expect(rendered).toContain("classify");
      expect(rendered).toContain("fast low");
      expect(rendered).toContain("↓5");
      component.dispose();
    } finally {
      agentLiveStore.reset();
    }
  });

  it("self-clamps to the rows-6 budget on a very short terminal (rows=8 -> 2 lines)", () => {
    // SPEC 3/A: the tight rows-6 budget wins; there is no 6-line floor to override it.
    const tui = { requestRender: vi.fn(), terminal: { rows: 8, columns: 80 } };
    const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "r1");

    component.push(line({ kind: "phase", phase: "smoke", ts: 1, runId: "r1" }));
    for (let i = 0; i < 6; i += 1) {
      component.push(line({ kind: "agent_start", agent: `agent_${i}`, ts: 2 + i, runId: "r1" }));
    }

    const rendered = component.render(80);
    expect(rendered.length).toBeLessThanOrEqual(8 - 6);
    expect(rendered.some((renderedLine) => renderedLine.includes("widget truncated"))).toBe(false);
    component.dispose();
  });

  it("never emits a line wider than the terminal at a narrow width (40)", () => {
    // SPEC 3/B + H: every built line is width-fitted before coloring. With a bare {}
    // theme there is no ANSI, so visible width == string length.
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 40 } };
    const component = new WorkflowProgressComponent(tui, {}, "a-very-long-script-reference-name", "run-1234567890");

    component.push(line({ kind: "phase", phase: "a-long-phase-name-that-overflows", ts: 1, runId: "run-1234567890" }));
    component.push(
      line({
        kind: "agent_start",
        agent: "an_agent_with_a_long_name",
        label: "a-long-label-too",
        ts: 2,
        runId: "run-1234567890",
      }),
    );
    component.push(
      line({
        kind: "log",
        message: "a log line whose message far exceeds forty columns of width",
        ts: 3,
        runId: "run-1234567890",
      }),
    );
    component.push(
      line({
        kind: "agent_end",
        agent: "an_agent_with_a_long_name",
        label: "a-long-label-too",
        status: "completed",
        durationMs: 1234,
        ts: 4,
        runId: "run-1234567890",
      }),
    );

    for (const renderedLine of component.render(40)) {
      expect(renderedLine.length).toBeLessThanOrEqual(40);
    }
    component.dispose();
  });

  it("renders script, runtime, and legacy journal logs with distinct provenance", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
    const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "provenance-r1");

    component.push(
      line({ kind: "log", source: "script", message: "compare candidates", ts: 1, runId: "provenance-r1" }),
    );
    component.push(
      line({ kind: "log", source: "runtime", message: "[workflow:enter]", ts: 2, runId: "provenance-r1" }),
    );
    component.push(line({ kind: "log", message: "old journal line", ts: 3, runId: "provenance-r1" }));

    const text = component.render(100).join("\n");
    expect(text).toContain("│ script · compare candidates");
    expect(text).toContain("│ runtime · [workflow:enter]");
    expect(text).toContain("│ journal · old journal line");
    expect(text).not.toContain("log:");
    expect(text.match(/│ script ·/g)).toHaveLength(1);
    component.dispose();
  });

  it("forces a live re-render for an in-flight agent and stops the timer when it ends", () => {
    // SPEC 1/D: a long-running agent whose state has not changed must still get its
    // elapsed column refreshed by a timer, not only on the next journal event.
    vi.useFakeTimers();
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "r1");

      component.push(line({ kind: "agent_start", agent: "slow", ts: 1, runId: "r1" }));
      const afterStart = tui.requestRender.mock.calls.length;

      // No new journal event — only wall-clock advances. The timer must drive renders.
      vi.advanceTimersByTime(3000);
      expect(tui.requestRender.mock.calls.length).toBeGreaterThan(afterStart);

      // Agent ends -> timer retires -> further wall-clock ticks add no more renders.
      component.push(
        line({ kind: "agent_end", agent: "slow", status: "completed", durationMs: 3000, ts: 4, runId: "r1" }),
      );
      const afterEnd = tui.requestRender.mock.calls.length;
      vi.advanceTimersByTime(5000);
      expect(tui.requestRender.mock.calls.length).toBe(afterEnd);

      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps live progress running after invalidation and stops only on dispose", () => {
    vi.useFakeTimers();
    try {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "invalidate-r1");

      component.push(line({ kind: "agent_start", agent: "slow", ts: 1, runId: "invalidate-r1" }));
      tui.requestRender.mockClear();

      component.invalidate();
      vi.advanceTimersByTime(1000);
      expect(tui.requestRender).toHaveBeenCalled();

      tui.requestRender.mockClear();
      component.dispose();
      vi.advanceTimersByTime(3000);
      expect(tui.requestRender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops old journal lines and requests a render for every pushed event", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 80 } };
    const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "r");

    for (let i = 0; i < 200; i += 1) {
      component.push(line({ kind: "log", message: "x", ts: Date.now(), runId: "r" }));
    }

    expect(component.render(80).length).toBeLessThanOrEqual(24);
    expect(tui.requestRender.mock.calls.length).toBeGreaterThanOrEqual(200);
  });

  it("renders failed completion state in place", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
    const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "r");

    component.finish({ ok: false, error: "Pi SDK host: connection refused" });

    expect(
      component
        .render(100)
        .some(
          (renderedLine) =>
            renderedLine.includes("failed") || renderedLine.includes("error") || renderedLine.includes("FAIL"),
        ),
    ).toBe(true);
  });

  it("renders exact semantic failure rows when no technical error exists", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 180 } };
    const component = new WorkflowProgressComponent(tui, {}, "semantic", "semantic-r1");

    component.finish({
      ok: false,
      result: { ok: false, summary: "Acceptance remains open", unresolvedRows: ["R-GIT", "R-CODE"] },
    });

    const text = component.render(180).join("\n");
    expect(text).toContain("✗ Acceptance remains open · unresolved: R-CODE, R-GIT");
    expect(text).not.toContain("unknown error");
  });

  it("renders result persistence failure as the final workflow verdict", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 180 } };
    const component = new WorkflowProgressComponent(tui, {}, "silent", "persistence-r1");

    component.finish({
      ok: false,
      error: "Workflow result was not persisted: blocked",
      result: { summary: "execution completed" },
      resultPersistence: {
        ok: false,
        path: "/blocked/result.json",
        code: "WORKFLOW_RESULT_WRITE_FAILED",
        message: "Workflow result was not persisted: blocked",
      },
    });

    const text = component.render(180).join("\n");
    expect(text).toContain("FAILED");
    expect(text).toContain("✗ Workflow result was not persisted: blocked");
    expect(text).toContain("persistence: WORKFLOW_RESULT_WRITE_FAILED");
    expect(text).not.toContain("✓ execution completed");
  });

  it("prints the saved run directory in the finished result (T-188 W5)", () => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 120 } };
    const component = new WorkflowProgressComponent(tui, {}, "live-smoke", "20260101-000000-r1");

    component.finish({ ok: true, result: { ok: true }, runDir: ".locus/runtime/workflows/20260101-000000-r1" });

    const text = component.render(120).join("\n");
    expect(text).toContain("saved: .locus/runtime/workflows/20260101-000000-r1");
  });

  it("chooses a deterministic semantic completion without exposing arbitrary JSON", () => {
    const cases: Array<{ result: unknown; expected: string }> = [
      {
        result: { summary: "  candidates\n agree  ", verdict: "ignored", secret: { raw: true } },
        expected: "✓ candidates agree",
      },
      { result: { summary: "", verdict: "accepted", secret: { raw: true } }, expected: "✓ accepted" },
      { result: { verdict: false, secret: { raw: true } }, expected: "✓ false" },
      { result: "  plain result  ", expected: "✓ plain result" },
      { result: { match: true, secret: { raw: true } }, expected: "✓ completed" },
    ];

    for (const [index, testCase] of cases.entries()) {
      const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 220 } };
      const component = new WorkflowProgressComponent(tui, {}, "live-smoke", `summary-${index}`);
      component.finish({ ok: true, result: testCase.result });
      const text = component.render(220).join("\n");
      expect(text).toContain(testCase.expected);
      expect(text).not.toContain("secret");
      expect(text).not.toContain(JSON.stringify(testCase.result));
    }
  });

  it.each([220, 146])("keeps the semantic result readable and raw JSON out of the main widget at width %i", (width) => {
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: width } };
    const component = new WorkflowProgressComponent(tui, {}, "visibility-smoke", `width-${width}`);
    const verdict = "result1=55 result2=55 match=true";

    component.finish({
      ok: true,
      result: { verdict, rawEvidence: { first: 55, second: 55, nested: [1, 2, 3] } },
    });

    const rendered = component.render(width);
    expect(rendered).toContain(`✓ ${verdict}`);
    expect(rendered.join("\n")).not.toContain("rawEvidence");
    expect(rendered.every((renderedLine) => renderedLine.length <= width)).toBe(true);
  });

  it("renders the REQ-004 `└ <verb> · <gist>` action sub-line beneath a row while a tool is active (T-196)", () => {
    agentLiveStore.reset();
    try {
      agentLiveStore.begin({
        id: "workflow:dedupe-r1:reviewer:step:smoke",
        agentName: "reviewer",
        label: "reviewer (step)",
        isolated: false,
        noMcp: false,
      });
      const child = agentLiveStore.begin({
        parentRowId: "workflow:dedupe-r1:reviewer:step:smoke",
        agentName: "reviewer",
        label: "SDK child session",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.patch(child.id, { status: "working", currentTools: [], stepCount: 1 });

      // «thinking» kind (no active tool): still no sub-line, never the old `[current task]`.
      const idle = renderAgentLiveRowsText();
      expect(idle).toContain("SDK child session");
      expect(idle).not.toContain("[current task]");
      expect(idle).not.toContain("└");

      // Tool active → a `└ <verb> · <gist>` sub-line appears (bash → command-head),
      // with no raw arg-soup (`{`) and no old `tool=`/`[current task]` markers.
      agentLiveStore.patch(child.id, {
        currentTools: ["bash"],
        currentToolArgs: '{"command":"npm test -- sums.spec"}',
      });
      const active = renderAgentLiveRowsText();
      expect(active).toContain("└ bash · npm test");
      expect(active).not.toContain("[current task]");
      expect(active).not.toContain("{");
      expect(active).not.toContain("tool=bash");
    } finally {
      agentLiveStore.reset();
    }
  });

  it("installs the fleet widget below the editor as a factory instead of a constructed component", () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;

    installWorkflowProgress(harness.ctx, "workflows", "live-smoke", "placeholder");

    // REQ-007: passive fleet rows stay below the editor while focus temporarily
    // replaces only the editor component.
    expect(harness.widgetOptions.get("workflows")).toEqual({ placement: "belowEditor" });
    const factory = harness.widgetPayloads.get("workflows") ?? harness.widgets.get("workflows");
    expect(typeof factory).toBe("function");
    const stubTui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 100 } };
    const component = (factory as (tui: typeof stubTui, theme: unknown) => WorkflowProgressComponent)(stubTui, {});
    expect(typeof component.render).toBe("function");
    expect(typeof component.invalidate).toBe("function");
    expect(typeof component.dispose).toBe("function");
    expect((factory as (...args: unknown[]) => unknown).length).toBe(2);
  });

  it("installWorkflowProgress short-circuits setWidget when ctx.hasUI is not true", () => {
    // SPEC 5/F: a strict boolean gate. On a non-UI host (hasUI false) and on an
    // unknown host (hasUI absent/undefined) the function must NOT touch setWidget,
    // yet must still return a live component the headless caller can drive.
    for (const present of [true, false]) {
      const harness = createHarness();
      const setWidget = vi.fn();
      // present=true -> explicit non-UI host (hasUI false); present=false -> unknown
      // host (hasUI absent entirely). exactOptionalPropertyTypes forbids assigning
      // `undefined`, so model "absent" with delete rather than a write.
      if (present) harness.ctx.hasUI = false;
      else delete harness.ctx.hasUI;
      harness.ctx.ui.setWidget = setWidget;

      const component = installWorkflowProgress(harness.ctx, "workflows", "live-smoke", "placeholder");

      expect(setWidget).not.toHaveBeenCalled();
      expect(harness.widgetPayloads.has("workflows")).toBe(false);
      // The returned component is still live: push/finish must be harmless no-ops.
      expect(() => {
        component.push(line({ kind: "agent_start", agent: "a", ts: 1, runId: "r" }));
        component.finish({ ok: true });
      }).not.toThrow();
    }
  });

  it("run branch delegates approval to Pi before launch", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;
    workflowsExt(harness.pi);
    const handler = harness.commands.get("workflows")!.handler;
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
      runId: "run-1",
      runDir: "/tmp/run-1",
      ok: true,
      result: { ok: true },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-1/result.json" },
    });

    try {
      await handler("run live-smoke hello", harness.ctx);

      expect(harness.selectCalls).toHaveLength(0);
      expect(harness.notifications.some((message) => message.includes("Launch gate blocked"))).toBe(false);
      expect(harness.statuses.get("locus")).toContain("WF launch");
      expect(harness.statuses.has(WORKFLOW_LIVE_WIDGET_KEY)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("run branch does not depend on Locus select UI", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = false;
    harness.ctx.ui.select = undefined as unknown as typeof harness.ctx.ui.select;
    workflowsExt(harness.pi);
    const handler = harness.commands.get("workflows")!.handler;
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
      runId: "run-2",
      runDir: "/tmp/run-2",
      ok: true,
      result: { ok: true },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-2/result.json" },
    });

    try {
      await handler("run live-smoke hello", harness.ctx);

      expect(harness.notifications.some((message) => message.includes("Launch gate blocked"))).toBe(false);
      expect(harness.statuses.get("locus")).toContain("WF launch");
      expect(harness.statuses.has("workflows")).toBe(false);
      expect(harness.selectCalls).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("labels a settled command result as run history plus its workflow source", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-command-result-source-"));
    const scriptPath = path.join(root, "project.workflow.mjs");
    try {
      writeFileSync(scriptPath, "export default () => ({ verdict: 'ok' });\n", "utf8");
      const harness = createHarness(root);
      workflowsExt(harness.pi);
      const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue({
        runId: "run-project",
        runDir: "/tmp/run-project",
        ok: true,
        result: { verdict: "ok" },
        journal: [],
        target: { kind: "scriptPath", ref: "project.workflow.mjs", path: scriptPath, source: "project" },
        resultPersistence: { ok: true, path: "/tmp/run-project/result.json" },
      });

      try {
        await harness.commands.get("workflows")!.handler("run project.workflow.mjs", harness.ctx);

        const text = renderHarnessWidget(harness);
        expect(text).toContain("[RESULT] Workflow run");
        expect(text).toContain("[R] [P]");
        expect(text).toContain("Sources: [P] Project · [U] User · [PKG] Package · [R] immutable run history");
        expect(text).toContain("Detail: /workflows status run-project");
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders the same semantic completion in TUI/RPC and does not claim delivery in no-UI mode", async () => {
    for (const surface of ["tui", "rpc", "no-ui"] as const) {
      const root = mkdtempSync(path.join(tmpdir(), `wf-zero-event-${surface}-`));
      try {
        writeFileSync(
          path.join(root, "silent.workflow.mjs"),
          "export default function() { return { verdict: 'silent-ok', rawSecret: { nested: true } }; }\n",
          "utf8",
        );
        const harness = createHarness(root, { mode: surface === "rpc" ? "rpc" : "tui" });
        harness.ctx.hasUI = surface !== "no-ui";
        workflowsExt(harness.pi);

        await harness.commands.get("workflows")!.handler("run silent.workflow.mjs", harness.ctx);

        let text: string;
        if (surface === "tui") {
          const payload = harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY);
          expect(typeof payload).toBe("function");
          const stubTui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 220 } };
          const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowProgressComponent)(
            stubTui,
            {},
          );
          text = component.render(220).join("\n");
        } else if (surface === "rpc") {
          text = harness.widgets.get(WORKFLOW_LIVE_WIDGET_KEY) ?? "";
          expect(Array.isArray(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY))).toBe(true);
        } else {
          text = harness.widgets.get("workflows") ?? "";
          expect(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).toBeUndefined();
        }
        if (surface === "no-ui") {
          expect(text).toBe("");
        } else {
          expect(text).toContain("silent-ok");
          expect(text).not.toContain("rawSecret");
          expect(text).not.toContain("nested");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("keeps zero-event tool output semantic and exposes raw result only through status/result.json", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-zero-event-tool-"));
    try {
      writeFileSync(
        path.join(root, "silent.workflow.mjs"),
        "export default function() { return { summary: 'tool-ok', rawSecret: { nested: true } }; }\n",
        "utf8",
      );
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      workflowsExt(harness.pi);

      const result = await runTool(harness, "workflow", { scriptPath: "silent.workflow.mjs" });
      const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");

      expect(text).toContain("✓ workflow silent.workflow.mjs finished · tool-ok");
      expect(text).not.toContain("rawSecret");
      expect(result.details).not.toHaveProperty("result");
      expect(result.details).toMatchObject({
        resultPath: expect.stringContaining("result.json"),
        resultPersistence: { ok: true },
      });
      const resultPath = String(result.details?.resultPath ?? "");
      expect(readFileSync(resultPath, "utf8")).toContain('"rawSecret"');

      await harness.commands.get("workflows")!.handler(`status ${String(result.details?.runId ?? "")}`, harness.ctx);
      const payload = harness.widgetPayloads.get("workflows");
      expect(typeof payload).toBe("function");
      const stubTui = { requestRender: vi.fn(), terminal: { rows: 60, columns: 220 } };
      const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
      expect(component.render(220).join("\n")).toContain('"rawSecret"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects a non-JSON-safe trusted-file result as failure through tool, status, and result.json", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-non-json-tool-"));
    try {
      writeFileSync(path.join(root, "unsafe.workflow.mjs"), "export default function() { return 42n; }\n", "utf8");
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      workflowsExt(harness.pi);

      const result = await runTool(harness, "workflow", { scriptPath: "unsafe.workflow.mjs" });
      const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");

      expect(result.isError).toBe(true);
      expect(text).toContain("✗ workflow unsafe.workflow.mjs failed");
      expect(text).toContain("not JSON-safe");
      expect(text).not.toContain("finished");
      expect(result.details?.resultDiagnostic).toMatchObject({ code: "WORKFLOW_RESULT_NOT_JSON_SAFE" });

      const resultPath = String(result.details?.resultPath ?? "");
      expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({
        ok: false,
        resultDiagnostic: { code: "WORKFLOW_RESULT_NOT_JSON_SAFE" },
      });

      await harness.commands.get("workflows")!.handler(`status ${String(result.details?.runId ?? "")}`, harness.ctx);
      expect(renderHarnessWidget(harness)).toContain("status:failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders a persistence failure message once in tool output while retaining typed details", async () => {
    const message = "Workflow result was not persisted: blocked";
    const failed = {
      runId: "persistence-failure",
      runDir: "/tmp/persistence-failure",
      ok: false,
      result: { summary: "execution completed" },
      error: message,
      journal: [],
      resultPersistence: {
        ok: false as const,
        path: "/tmp/persistence-failure/result.json",
        code: "WORKFLOW_RESULT_WRITE_FAILED" as const,
        message,
      },
    };
    const harness = createHarness();
    workflowsExt(harness.pi);
    const spy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue(failed);
    try {
      const result = await runTool(harness, "workflow", { scriptPath: "persistence.workflow.mjs" });
      const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");

      expect(result.isError).toBe(true);
      expect(text.match(/Workflow result was not persisted: blocked/gu)).toHaveLength(1);
      expect(text).toContain("persistence: WORKFLOW_RESULT_WRITE_FAILED");
      expect(result.details?.resultPersistence).toEqual(failed.resultPersistence);
    } finally {
      spy.mockRestore();
    }
  });

  it("projects semantic failure rows through tool and headless command surfaces", async () => {
    const failed = {
      runId: "semantic-failure",
      runDir: "/tmp/semantic-failure",
      ok: false,
      result: { ok: false, summary: "Acceptance remains open", unresolvedRows: ["R-GIT", "R-CODE"] },
      journal: [],
      resultPersistence: { ok: true as const, path: "/tmp/semantic-failure/result.json" },
    };

    const toolHarness = createHarness();
    workflowsExt(toolHarness.pi);
    const toolSpy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue(failed);
    try {
      const result = await runTool(toolHarness, "workflow", { scriptPath: "semantic.workflow.mjs" });
      const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
      expect(result.isError).toBe(true);
      expect(text).toContain("Acceptance remains open");
      expect(text).toContain("R-CODE, R-GIT");
      expect(text).not.toContain("unknown error");
      expect(result.details?.result).toEqual(failed.result);
    } finally {
      toolSpy.mockRestore();
    }

    const commandHarness = createHarness();
    delete commandHarness.ctx.hasUI;
    workflowsExt(commandHarness.pi);
    const commandSpy = vi.spyOn(runner, "runWorkflowScript").mockResolvedValue(failed);
    try {
      await commandHarness.commands.get("workflows")!.handler("run semantic.workflow.mjs", commandHarness.ctx);
      const text = renderHarnessWidget(commandHarness);
      expect(text).toContain("[ERROR] Workflow run");
      expect(text).toContain("Acceptance remains open");
      expect(text).toContain("R-CODE, R-GIT");
      expect(text).not.toContain("Workflow execution failed.");
    } finally {
      commandSpy.mockRestore();
    }
  });

  it("pins an active run, then retires its widget while retaining terminal rows on next input", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-live-input-"));
    try {
      writeFileSync(
        path.join(root, "slow.workflow.mjs"),
        `export default async function run(dsl) {\n` +
          `  dsl.phase("slow");\n` +
          `  dsl.log("started");\n` +
          `  await new Promise((resolve) => setTimeout(resolve, 100));\n` +
          `  return { ok: true };\n` +
          `}\n`,
        "utf8",
      );
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      workflowsExt(harness.pi);
      const handler = harness.commands.get("workflows")!.handler;

      const runPromise = Promise.resolve(handler("run slow.workflow.mjs", harness.ctx));
      await waitUntil(() => harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY) !== undefined);
      expect(harness.statuses.get("locus")).toContain("WF");
      await emit(harness, "input", { text: "new prompt while workflow runs" });
      expect(harness.statuses.get("locus")).toContain("WF");
      await emit(harness, "turn_end");

      expect(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).not.toBeUndefined();
      expect(harness.statuses.get("locus")).toContain("WF");

      await runPromise;
      expect(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).not.toBeUndefined();
      const payload = harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY);
      const component = (payload as (tui: { requestRender: () => void }, theme: unknown) => WorkflowProgressComponent)(
        { requestRender: () => {} },
        {},
      );
      const ownedRowId = `workflow:${component.runId}:group:test`;
      agentLiveStore.begin({
        id: ownedRowId,
        agentName: "workflow-group",
        label: "test",
        groupKind: "parallel",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.begin({
        id: "agent-live-unlabelled",
        parentRowId: ownedRowId,
        agentName: "task",
        label: "child",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.begin({
        id: "agent-live-grandchild",
        parentRowId: "agent-live-unlabelled",
        agentName: "task",
        label: "grandchild",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.begin({
        id: "unrelated-row",
        agentName: "task",
        label: "other work",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.patch(ownedRowId, { status: "done" });
      agentLiveStore.patch("agent-live-unlabelled", { status: "done", currentTools: ["bash"] });
      agentLiveStore.patch("agent-live-grandchild", { status: "done", currentTools: ["read"] });

      await emit(harness, "input", { text: "new prompt after workflow completed" });

      expect(harness.widgetPayloads.has(WORKFLOW_LIVE_WIDGET_KEY)).toBe(true);
      expect(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).toBeUndefined();
      expect(agentLiveStore.rows.get(ownedRowId)).toMatchObject({ status: "done" });
      expect(agentLiveStore.rows.get("agent-live-unlabelled")).toMatchObject({ status: "done", currentTools: [] });
      expect(agentLiveStore.rows.get("agent-live-grandchild")).toMatchObject({ status: "done", currentTools: [] });
      expect(agentLiveStore.rows.has("unrelated-row")).toBe(true);
      expect(harness.statuses.has("locus")).toBe(false);
      const persisted = harness.sentMessages.map((entry) => String(entry.message.content));
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toContain("● workflow slow.workflow.mjs started");
      expect(persisted[0]).toContain("✓ workflow slow.workflow.mjs finished · completed");
      expect(
        harness.sentMessages.every(
          (entry) => entry.message.customType === "locus-workflow-event" && entry.message.display === true,
        ),
      ).toBe(true);
      expect(
        harness.sentMessages.every(
          (entry) => entry.options?.triggerTurn === false && entry.options.deliverAs === undefined,
        ),
      ).toBe(true);
    } finally {
      agentLiveStore.reset();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears a completed workflow surface on Pi turn_end but retains terminal drill rows", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-live-turn-end-"));
    try {
      writeFileSync(path.join(root, "done.workflow.mjs"), "export default () => ({ summary: 'done' });\n", "utf8");
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      workflowsExt(harness.pi);

      await harness.commands.get("workflows")!.handler("run done.workflow.mjs", harness.ctx);
      const payload = harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY);
      expect(typeof payload).toBe("function");
      const component = (payload as (tui: { requestRender: () => void }, theme: unknown) => WorkflowProgressComponent)(
        { requestRender: () => {} },
        {},
      );
      const ownedRowId = `workflow:${component.runId}:llm:test:`;
      agentLiveStore.begin({ id: ownedRowId, agentName: "llm", label: "test", isolated: false, noMcp: false });
      agentLiveStore.patch(ownedRowId, { status: "done", currentTools: ["read"] });

      await emit(harness, "turn_end");

      expect(harness.widgetPayloads.get(WORKFLOW_LIVE_WIDGET_KEY)).toBeUndefined();
      expect(agentLiveStore.rows.get(ownedRowId)).toMatchObject({ status: "done", currentTools: [] });
    } finally {
      agentLiveStore.reset();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("run command passes --resume as persisted retry metadata", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-command-resume-"));
    const sourceRunId = "20260101-000001-source";
    const runDir = path.join(root, ".locus", "runtime", "workflows", sourceRunId);
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        path.join(runDir, "journal.ndjson"),
        JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", runId: sourceRunId, kind: "log", message: "source" }) + "\n",
        "utf8",
      );
      writeFileSync(
        path.join(runDir, "result.json"),
        JSON.stringify({ runId: sourceRunId, ok: true, result: { source: true }, journal: [] }),
        "utf8",
      );
      writeFileSync(
        path.join(root, "retry.workflow.mjs"),
        "export default function(dsl, input) { dsl.log('retry command'); return { input }; }\n",
        "utf8",
      );

      const harness = createHarness(root);
      harness.ctx.hasUI = false;
      workflowsExt(harness.pi);
      harness.ctx.hasUI = true;
      const handler = harness.commands.get("workflows")!.handler;

      await handler(`run retry.workflow.mjs --resume ${sourceRunId} payload`, harness.ctx);

      expect(harness.selectCalls).toHaveLength(0);
      expect(harness.notifications.some((message) => message.includes("Launch gate blocked"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("status detail keeps raw result and distinguishes script, runtime, and legacy logs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-status-detail-"));
    const runId = "20260101-000001-detail";
    const runDir = path.join(root, ".locus", "runtime", "workflows", runId);
    const journal: WorkflowJournalLine[] = [
      { ts: "2026-01-01T00:00:00.000Z", runId, kind: "log", source: "script", message: "compare candidates" },
      { ts: "2026-01-01T00:00:01.000Z", runId, kind: "log", source: "runtime", message: "[workflow:exit]" },
      { ts: "2026-01-01T00:00:02.000Z", runId, kind: "log", message: "old journal line" },
      { ts: "2026-01-01T00:00:03.000Z", runId, kind: "agent_start", agent: "reviewer", label: "check" },
      {
        ts: "2026-01-01T00:00:04.000Z",
        runId,
        kind: "agent_end",
        agent: "reviewer",
        label: "check",
        status: "completed",
      },
      { ts: "2026-01-01T00:00:05.000Z", runId, kind: "llm_start", label: "classify" },
      {
        ts: "2026-01-01T00:00:06.000Z",
        runId,
        kind: "llm_end",
        label: "classify",
        status: "failed",
        model: "openai-codex/gpt-5.6-sol",
        message: "Workflow llm bridge: request auth failed: No API key found",
      },
    ];
    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        path.join(runDir, "journal.ndjson"),
        journal.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        "utf8",
      );
      writeFileSync(
        path.join(runDir, "result.json"),
        JSON.stringify({
          runId,
          ok: true,
          result: { summary: "match=true", rawEvidence: { first: 55, second: 55 } },
          journal,
          target: { kind: "name", ref: "detail", source: "project" },
          scriptIdentity: {
            sourcePath: "/private/source/detail.workflow.mjs",
            snapshotPath: path.join(runDir, `script-${"a".repeat(64)}.workflow.mjs`),
            scriptSha256: "a".repeat(64),
          },
        }),
        "utf8",
      );
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      workflowsExt(harness.pi);

      await harness.commands.get("workflows")!.handler(`status ${runId}`, harness.ctx);

      const payload = harness.widgetPayloads.get("workflows");
      expect(typeof payload).toBe("function");
      const stubTui = { requestRender: vi.fn(), terminal: { rows: 60, columns: 220 } };
      const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
      const text = component.render(220).join("\n");
      expect(text).toContain(`[R] [P] ${runId}`);
      expect(text).toContain("Source: [R] [P]");
      expect(text).toContain(`runDir: ${runDir}`);
      expect(text).toContain(
        `script: detail · coverage=entry-only-legacy · exec=source · unbound=unknown · snapshot=script-${"a".repeat(64)}.workflow.mjs · sha256=${"a".repeat(12)} · node=unknown`,
      );
      expect(text).not.toContain("/private/source/detail.workflow.mjs");
      expect(text).toContain("[script] compare candidates");
      expect(text).toContain("[runtime] [workflow:exit]");
      expect(text).toContain("[journal] old journal line");
      expect(text).toContain("[agent] -> reviewer (check)");
      expect(text).toContain("[agent] <- reviewer completed");
      expect(text).toContain("[llm]   <- classify failed");
      expect(text).toContain("Workflow llm bridge: request auth failed: No API key found");
      expect(text).toContain('"rawEvidence"');
      expect(text).not.toContain("[log]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps agent transport markers out of main status while retaining warnings and errors", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;
    workflowsExt(harness.pi);
    const runId = "20260101-000001-marker";
    const journal: WorkflowJournalLine[] = [
      { ts: "2026-01-01T00:00:00.000Z", runId, kind: "agent_start", agent: "reviewer", label: "check" },
      {
        ts: "2026-01-01T00:00:01.000Z",
        runId,
        kind: "agent_end",
        agent: "reviewer",
        label: "check",
        status: "completed",
        evidenceWarnings: ["weak proof"],
      },
      { ts: "2026-01-01T00:00:02.000Z", runId, kind: "error", message: "boom" },
    ];
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (options) => {
      options.onRunStart?.({ runId, runDir: `/tmp/${runId}` });
      for (const entry of journal) options.onEvent?.(entry);
      return {
        runId,
        runDir: `/tmp/${runId}`,
        ok: false,
        result: null,
        error: "boom",
        journal,
        resultPersistence: { ok: true, path: `/tmp/${runId}/result.json` },
      };
    });
    try {
      await harness.commands.get("workflows")!.handler("run live-smoke", harness.ctx);

      const mainStatuses = [...harness.statuses.values()].join("\n");
      expect(mainStatuses).not.toContain("[agent] ->");
      expect(mainStatuses).not.toContain("[agent] <-");
      expect(mainStatuses).toContain("[error] boom");
      const persisted = harness.sentMessages.map((entry) => String(entry.message.content));
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toContain("● agent ");
      expect(persisted[0]).toContain("✓ agent ");
      expect(harness.notifications).toContain("⚠ agent evidence · weak proof");
      expect(harness.notificationEvents).toContainEqual({ message: "⚠ agent evidence · weak proof", level: "warning" });
      expect(persisted.filter((message) => message.includes("boom"))).toEqual([
        expect.stringContaining("✗ workflow live-smoke failed · boom"),
      ]);
      const finalFailure = harness.sentMessages.find((entry) => String(entry.message.content).includes("boom"));
      expect(finalFailure?.message.details).toMatchObject({ eventKind: "workflow_end", runId });
    } finally {
      spy.mockRestore();
      agentLiveStore.reset();
    }
  });

  it("renders recent, project, personal, and packaged catalog groups in stable order", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const projectDir = path.join(root, ".pi", "workflows");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        path.join(projectDir, "alpha.workflow.mjs"),
        "export const meta = { description: 'Handles alpha invoices' }; export default () => 'alpha';\n",
        "utf8",
      );
      writeFileSync(
        path.join(projectDir, "beta.workflow.mjs"),
        "export const meta = { description: 'Reviews beta releases' }; export default () => 'beta';\n",
        "utf8",
      );
      const runId = "20260101-000001-alpha";
      const runDir = path.join(root, ".locus", "runtime", "workflows", runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(path.join(runDir, "journal.ndjson"), "", "utf8");
      writeFileSync(
        path.join(runDir, "result.json"),
        JSON.stringify({ runId, ok: true, result: "alpha", target: { kind: "name", ref: "alpha", source: "project" } }),
        "utf8",
      );
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      delete harness.ctx.ui.custom;
      workflowsExt(harness.pi);

      await harness.commands.get("workflows")!.handler("list", harness.ctx);
      const text = renderHarnessWidget(harness);

      expect(text).toContain("[VIEW] Workflow catalog");
      expect(text.indexOf("[R] Run history:")).toBeLessThan(text.indexOf("[P] Project:"));
      expect(text.indexOf("[P] Project:")).toBeLessThan(text.indexOf("[U] User:"));
      expect(text.indexOf("[U] User:")).toBeLessThan(text.indexOf("[PKG] Package:"));
      expect(text).toContain("[R] [P] alpha · historical run snapshot");
      expect(text).toContain("[P] alpha · Handles alpha invoices");
      expect(text).toContain("[P] beta · Reviews beta releases");
      expect(text).toContain("[PKG] live-smoke ·");
      expect(text).toContain("[U] User:");
      expect(text).toContain("(none found)");
      expect(text.match(/Sources: \[P\]/gu)).toHaveLength(1);
      expect(harness.widgetOptions.get("workflows")).toEqual({ placement: "belowEditor" });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("filters /workflows list by name and description and reports no-match separately from an empty catalog", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-catalog-filter-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const projectDir = path.join(root, ".pi", "workflows");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        path.join(projectDir, "alpha.workflow.mjs"),
        "export const meta = { description: 'Handles alpha invoices' }; export default () => 'alpha';\n",
        "utf8",
      );
      writeFileSync(
        path.join(projectDir, "beta.workflow.mjs"),
        "export const meta = { description: 'Reviews beta releases' }; export default () => 'beta';\n",
        "utf8",
      );
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      delete harness.ctx.ui.custom;
      workflowsExt(harness.pi);
      const handler = harness.commands.get("workflows")!.handler;

      await handler("list invoices", harness.ctx);
      const filtered = renderHarnessWidget(harness);
      expect(filtered).toContain("[P] alpha · Handles alpha invoices");
      expect(filtered).not.toContain("[P] beta");

      await handler("list definitely-no-match", harness.ctx);
      const noMatch = renderHarnessWidget(harness);
      expect(noMatch).toContain('No workflows match "definitely-no-match".');
      expect(noMatch).toMatch(/Catalog contains \d+ runnable workflow\(s\)/u);
      expect(noMatch).not.toContain("Workflow catalog:\n  (none)");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("static workflow text widgets self-clamp instead of relying on host string-array truncation", () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;

    installWorkflowTextWidget(
      harness.ctx,
      "workflows",
      Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
    );

    const factory = harness.widgetPayloads.get("workflows") ?? harness.widgets.get("workflows");
    expect(typeof factory).toBe("function");
    const stubTui = { requestRender: vi.fn(), terminal: { rows: 14, columns: 80 } };
    const component = (factory as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
    const rendered = component.render(80);
    expect(rendered.length).toBeLessThanOrEqual(14 - 6);
    expect(rendered.some((renderedLine) => renderedLine.includes("widget truncated"))).toBe(false);
  });

  it("bare dashboard replaces stale status with a typed transient command view", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;
    workflowsExt(harness.pi);
    const handler = harness.commands.get("workflows")!.handler;

    await handler("status", harness.ctx);
    expect(typeof harness.widgetPayloads.get("workflows")).toBe("function");

    await handler("", harness.ctx);

    expect(typeof harness.widgetPayloads.get("workflows")).toBe("function");
    const widget = harness.widgets.get("workflows") ?? "";
    expect(widget).toContain("[VIEW]");
    expect(widget).toContain("Workflow commands");
    expect(widget).toContain("Catalog: /workflows list [query]");
    expect(widget).toContain("Run: /workflows run <name|path>");
    expect(harness.notifications).toEqual([]);
  });

  it("places an unknown workflow warning above the editor", async () => {
    const harness = createHarness();
    harness.ctx.hasUI = true;
    workflowsExt(harness.pi);

    await harness.commands.get("workflows")!.handler("unexpected", harness.ctx);

    expect(harness.widgets.get("workflows")).toContain("[WARN] Workflow command");
    expect(harness.widgetOptions.get("workflows")).toEqual({ placement: "aboveEditor" });
  });

  it("list fallback and status install static widget factories on UI hosts", async () => {
    for (const commandText of ["list", "status"]) {
      const harness = createHarness();
      harness.ctx.hasUI = true;
      if (commandText === "list") delete harness.ctx.ui.custom;
      workflowsExt(harness.pi);
      const handler = harness.commands.get("workflows")!.handler;

      await handler(commandText, harness.ctx);

      const payload = harness.widgetPayloads.get("workflows");
      expect(typeof payload).toBe("function");
      const stubTui = { requestRender: vi.fn(), terminal: { rows: 40, columns: 100 } };
      const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
      expect(component.render(100).join("\n")).not.toContain("widget truncated");
    }
  });

  it("keeps workflow catalog, history, and detail controls inside the RPC string-array budget", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-static-rpc-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = path.join(root, "home");
      const workflowDir = path.join(root, ".pi", "workflows");
      mkdirSync(workflowDir, { recursive: true });
      for (let index = 0; index < 6; index += 1) {
        writeFileSync(
          path.join(workflowDir, `project-${index}.workflow.mjs`),
          `export const meta = { description: "Project workflow ${index}" }; export default () => null;\n`,
          "utf8",
        );
        writeWorkflowRun(root, `20260101-00000${index}-rpc`);
      }
      const longRunDir = path.join(root, ".locus", "runtime", "workflows", "20260101-000005-rpc");
      writeFileSync(
        path.join(longRunDir, "journal.ndjson"),
        `${JSON.stringify({
          ts: "2026-01-01T00:00:02.000Z",
          runId: "20260101-000005-rpc",
          kind: "log",
          source: "script",
          message: `long diagnostic ${"x".repeat(240)}`,
        })}\n`,
        "utf8",
      );
      const harness = createHarness(root, { mode: "rpc" });
      harness.ctx.hasUI = true;
      workflowsExt(harness.pi);
      const handler = harness.commands.get("workflows")!.handler;

      for (const [command, expectedControl] of [
        ["list", "Run: /workflows run <name|path>"],
        ["status", "Detail: /workflows status <runId>"],
        ["status 20260101-000005-rpc", "Full artifact: result.json"],
      ] as const) {
        await handler(command, harness.ctx);
        expect(Array.isArray(harness.widgetPayloads.get("workflows"))).toBe(true);
        const text = harness.widgets.get("workflows") ?? "";
        expect(text).toContain(expectedControl);
        expect(text).not.toContain("widget truncated");
        expect(text.split(/\r?\n/u).length).toBeLessThanOrEqual(10);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("status self-bounds many historical runs for an 80x24 widget", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-status-many-"));
    try {
      for (let i = 0; i < 25; i += 1) {
        writeWorkflowRun(root, `20260101-0000${String(i).padStart(2, "0")}-${String(i).padStart(4, "0")}`);
      }
      const harness = createHarness(root);
      harness.ctx.hasUI = true;
      workflowsExt(harness.pi);
      const handler = harness.commands.get("workflows")!.handler;

      await handler("status", harness.ctx);

      const payload = harness.widgetPayloads.get("workflows");
      expect(typeof payload).toBe("function");
      const stubTui = { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } };
      const component = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {});
      const rendered = component.render(80);
      const text = rendered.join("\n");
      const runRows = rendered.filter((renderedLine) => /\[R\].*failed.*20260101-/u.test(renderedLine));

      expect(rendered.length).toBeLessThanOrEqual(24 - 6);
      expect(runRows.length).toBeGreaterThan(0);
      expect(runRows.length).toBeLessThan(20);
      expect(rendered.every((renderedLine) => renderedLine.length <= 80)).toBe(true);
      expect(text).toContain("[VIEW]");
      expect(text).toContain("Showing 10 newest of 25 workflow run(s).");
      expect(text).toContain("Sources: [P] Project · [U] User · [PKG] Package · [R] immutable run history");
      expect(text).toContain("+15 older run(s) hidden");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
