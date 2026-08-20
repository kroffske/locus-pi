import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import agents from "../../../extensions/agents/index.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  pruneCompletedWorkflowRunLiveRows,
  resetWorkflowLiveExecutions,
  workflowAgentLiveRowId,
  workflowGroupLiveRowId,
  workflowLiveExecutionCount,
  workflowRunIdFromRowId,
} from "../../../extensions/workflows/runtime/workflow-journal.js";
import {
  createWorkflowRuntime,
  type WorkflowJournalLine,
} from "../../../extensions/workflows/runtime/workflow-runtime.js";
import * as runner from "../../../extensions/workflows/runtime/workflow-runner.js";
import workflows from "../../../extensions/workflows/index.js";
import { createHarness, emit } from "../../test-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetWorkflowLiveExecutions();
  agentLiveStore.reset();
});

describe("completed workflow live-row retention", () => {
  it("binds group completion to the exact journal-start execution across replacement and reset", () => {
    const runId = "20260712-234108-group-authority";
    const start: WorkflowJournalLine = {
      ts: "start",
      runId,
      kind: "group_start",
      groupId: "parallel-1",
      groupKind: "parallel",
      groupTotal: 2,
    };
    const end: WorkflowJournalLine = {
      ts: "end",
      runId,
      kind: "group_end",
      status: "completed",
      groupId: "parallel-1",
      groupKind: "parallel",
      groupTotal: 2,
      groupCompleted: 2,
      groupFailed: 0,
    };
    const id = workflowGroupLiveRowId(start);
    applyWorkflowJournalLineToAgentLiveStore(start);
    expect(workflowLiveExecutionCount()).toBe(1);

    const replacement = agentLiveStore.beginExecution({
      id,
      agentName: "workflow-group",
      label: "replacement B",
      groupKind: "parallel",
      groupTotal: 9,
    });
    agentLiveStore.patchExecution(replacement, { status: "working" });
    applyWorkflowJournalLineToAgentLiveStore(end);
    expect(workflowLiveExecutionCount()).toBe(0);
    expect(agentLiveStore.rowForExecution(replacement)).toMatchObject({
      status: "working",
      groupTotal: 9,
    });
    expect(agentLiveStore.rowForExecution(replacement)?.groupCompleted).toBeUndefined();

    agentLiveStore.reset();
    const afterReset = agentLiveStore.beginExecution({
      id,
      agentName: "workflow-group",
      label: "replacement after reset",
      groupKind: "parallel",
      groupTotal: 7,
    });
    applyWorkflowJournalLineToAgentLiveStore(end);
    expect(agentLiveStore.rowForExecution(afterReset)?.status).toBe("queued");

    applyWorkflowJournalLineToAgentLiveStore(start);
    expect(workflowLiveExecutionCount()).toBe(1);
    applyWorkflowJournalLineToAgentLiveStore(end);
    expect(workflowLiveExecutionCount()).toBe(0);
    expect(agentLiveStore.rows.get(id)).toMatchObject({
      status: "done",
      groupTotal: 2,
      groupCompleted: 2,
      groupFailed: 0,
    });
  });

  it("keeps the writer map active-only through deterministic agent and group churn", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workflow-writer-churn-"));
    try {
      for (let index = 0; index < 100; index += 1) {
        const common = {
          runId: "writer-churn",
          agent: "reviewer",
          label: "review",
          phase: "review",
          callId: `call-${index}`,
        } as const;
        const start: WorkflowJournalLine = { ...common, ts: `start-${index}`, kind: "agent_start" };
        const end: WorkflowJournalLine = {
          ...common,
          ts: `end-${index}`,
          kind: "agent_end",
          status: "completed",
        };
        applyWorkflowJournalLineToAgentLiveStore(start);
        applyWorkflowJournalLineToAgentLiveStore(end, root);
        expect(workflowLiveExecutionCount()).toBe(0);

        const groupStart: WorkflowJournalLine = {
          ts: `group-start-${index}`,
          runId: "writer-churn",
          kind: "group_start",
          groupId: `parallel-${index}`,
          groupKind: "parallel",
          groupTotal: 1,
        };
        const groupEnd: WorkflowJournalLine = {
          ...groupStart,
          ts: `group-end-${index}`,
          kind: "group_end",
          status: "completed",
          groupCompleted: 1,
          groupFailed: 0,
        };
        applyWorkflowJournalLineToAgentLiveStore(groupStart);
        applyWorkflowJournalLineToAgentLiveStore(groupEnd);
        expect(workflowLiveExecutionCount()).toBe(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["runner", "artifact"] as const)(
    "terminalizes repeated %s throws with the original call identity and no writer leak",
    async (failureSource) => {
      const root = mkdtempSync(path.join(os.tmpdir(), `workflow-${failureSource}-throw-`));
      let attempt = 0;
      const runtime = createWorkflowRuntime({
        runId: `${failureSource}-throw-run`,
        projectRoot: root,
        onEvent: (line) => applyWorkflowJournalLineToAgentLiveStore(line, root),
        agentRunner: async (request) => {
          if (failureSource === "runner") throw new Error(`runner boom ${attempt}`);
          return {
            ok: true,
            status: "completed",
            summary: "done",
            text: "must persist",
            diagnostics: [],
            agent: request.agent,
          };
        },
        ...(failureSource === "artifact"
          ? {
              artifactPorts: {
                recordAgentEvidence() {
                  throw new Error(`artifact boom ${attempt}`);
                },
                publishText() {
                  throw new Error("unused");
                },
                consumeText() {
                  throw new Error("unused");
                },
              },
            }
          : {}),
      });
      try {
        for (attempt = 1; attempt <= 3; attempt += 1) {
          await expect(runtime.dsl.agent("review", { agent: "reviewer", label: "review" })).rejects.toThrow(
            `${failureSource} boom ${attempt}`,
          );
          const errorLine = runtime
            .getJournal()
            .filter((line) => line.kind === "error" && line.agent === "reviewer")
            .at(-1);
          expect(errorLine).toMatchObject({
            kind: "error",
            callId: `call-${String(attempt).padStart(4, "0")}`,
            message: `${failureSource} boom ${attempt}`,
          });
          if (errorLine === undefined) throw new Error("Expected agent error journal line.");
          expect(agentLiveStore.rows.get(workflowAgentLiveRowId(errorLine))).toMatchObject({
            status: "error",
            finalAnswer: `${failureSource} boom ${attempt}`,
            errors: [`${failureSource} boom ${attempt}`],
          });
          expect(workflowLiveExecutionCount()).toBe(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("releases the exact writer when a terminal store listener throws", () => {
    const start: WorkflowJournalLine = {
      ts: "start",
      runId: "listener-throw",
      kind: "agent_start",
      callId: "call-0001",
      agent: "reviewer",
      label: "review",
    };
    const error: WorkflowJournalLine = {
      ...start,
      ts: "error",
      kind: "error",
      message: "terminal failure",
    };
    applyWorkflowJournalLineToAgentLiveStore(start);
    const throwOnTerminal = () => {
      throw new Error("listener exploded");
    };
    agentLiveStore.emitter.on("change", throwOnTerminal);
    try {
      expect(() => applyWorkflowJournalLineToAgentLiveStore(error)).toThrow("listener exploded");
    } finally {
      agentLiveStore.emitter.off("change", throwOnTerminal);
    }

    expect(agentLiveStore.rows.get(workflowAgentLiveRowId(error))).toMatchObject({
      status: "error",
      finalAnswer: "terminal failure",
      errors: ["terminal failure"],
    });
    expect(workflowLiveExecutionCount()).toBe(0);
  });

  it("does not mutate or finalize a same-key replacement created by a terminal listener", () => {
    const start: WorkflowJournalLine = {
      ts: "start-a",
      runId: "listener-replacement",
      kind: "agent_start",
      callId: "call-0001",
      agent: "reviewer",
      label: "review",
    };
    const error: WorkflowJournalLine = {
      ...start,
      ts: "error-a",
      kind: "error",
      message: "execution A failed",
    };
    applyWorkflowJournalLineToAgentLiveStore(start);
    let replacementBytes = "";
    let replaced = false;
    const replaceOnTerminal = () => {
      if (replaced) return;
      replaced = true;
      applyWorkflowJournalLineToAgentLiveStore({ ...start, ts: "start-b" });
      const replacement = agentLiveStore.captureExecutionAuthority(workflowAgentLiveRowId(start));
      if (replacement === undefined) throw new Error("Expected replacement execution.");
      agentLiveStore.patchExecution(replacement, {
        status: "working",
        finalAnswer: "B sentinel",
        errors: ["B sentinel error"],
        tokenCount: { input: 8, output: 3 },
      });
      replacementBytes = JSON.stringify(agentLiveStore.rowForExecution(replacement));
    };
    agentLiveStore.emitter.on("change", replaceOnTerminal);
    try {
      applyWorkflowJournalLineToAgentLiveStore(error);
    } finally {
      agentLiveStore.emitter.off("change", replaceOnTerminal);
    }

    const replacement = agentLiveStore.captureExecutionAuthority(workflowAgentLiveRowId(start));
    expect(replaced).toBe(true);
    expect(JSON.stringify(replacement === undefined ? undefined : agentLiveStore.rowForExecution(replacement))).toBe(
      replacementBytes,
    );
    expect(workflowLiveExecutionCount()).toBe(1);
    applyWorkflowJournalLineToAgentLiveStore({ ...error, ts: "error-b", message: "execution B failed" });
    expect(workflowLiveExecutionCount()).toBe(0);
  });

  it.each([
    ["completed", "done", 0],
    ["cancelled", "cancelled", 0],
    ["failed", "error", 0],
    ["blocked", "error", 0],
    ["running", "working", 1],
    ["pending", "queued", 1],
    ["unknown-status", "working", 1],
    [undefined, "working", 1],
  ] as const)(
    "projects agent_end status %s and retains only nonterminal or malformed writer authority",
    (status, expectedStatus, expectedWriters) => {
      const common = {
        ts: "start",
        runId: `status-${status ?? "missing"}`,
        agent: "reviewer",
        label: "review",
        callId: "call-0001",
      } as const;
      const start: WorkflowJournalLine = { ...common, kind: "agent_start" };
      const end: WorkflowJournalLine = {
        ...common,
        ts: "end",
        kind: "agent_end",
        ...(status === undefined ? {} : { status }),
      };

      applyWorkflowJournalLineToAgentLiveStore(start);
      applyWorkflowJournalLineToAgentLiveStore(end);

      expect(agentLiveStore.rows.get(workflowAgentLiveRowId(start))?.status).toBe(expectedStatus);
      expect(workflowLiveExecutionCount()).toBe(expectedWriters);
    },
  );

  it("ignores a legacy no-callId error without touching or finalizing a newer overlapping execution", () => {
    const start: WorkflowJournalLine = {
      ts: "start-a",
      runId: "legacy-error-overlap",
      kind: "agent_start",
      agent: "reviewer",
      label: "review",
    };
    applyWorkflowJournalLineToAgentLiveStore(start);
    applyWorkflowJournalLineToAgentLiveStore({ ...start, ts: "start-b" });
    const replacement = agentLiveStore.captureExecutionAuthority(workflowAgentLiveRowId(start));
    if (replacement === undefined) throw new Error("Expected replacement execution.");
    agentLiveStore.patchExecution(replacement, {
      status: "working",
      finalAnswer: "B sentinel",
      errors: ["B sentinel error"],
      tokenCount: { input: 13, output: 5 },
    });
    const replacementBytes = JSON.stringify(agentLiveStore.rowForExecution(replacement));

    applyWorkflowJournalLineToAgentLiveStore({
      ...start,
      ts: "legacy-error",
      kind: "error",
      message: "ambiguous legacy failure",
    });

    expect(JSON.stringify(agentLiveStore.rowForExecution(replacement))).toBe(replacementBytes);
    expect(workflowLiveExecutionCount()).toBe(1);

    applyWorkflowJournalLineToAgentLiveStore({
      ...start,
      ts: "terminal-end",
      kind: "agent_end",
      status: "completed",
    });
    expect(workflowLiveExecutionCount()).toBe(0);
    expect(agentLiveStore.rows.get(workflowAgentLiveRowId(start))?.status).toBe("done");
  });

  it("resets writer authority on workflow session boundaries even after rows disappear independently", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workflow-writer-session-"));
    try {
      const harness = createHarness(root);
      workflows(harness.pi);
      const start: WorkflowJournalLine = {
        ts: "start",
        runId: "writer-session",
        kind: "agent_start",
        callId: "call-1",
        agent: "reviewer",
        label: "review",
        phase: "review",
      };

      applyWorkflowJournalLineToAgentLiveStore(start);
      agentLiveStore.reset();
      expect(workflowLiveExecutionCount()).toBe(1);
      await emit(harness, "session_start");
      expect(workflowLiveExecutionCount()).toBe(0);

      applyWorkflowJournalLineToAgentLiveStore(start);
      agentLiveStore.reset();
      expect(workflowLiveExecutionCount()).toBe(1);
      await emit(harness, "session_shutdown", { reason: "reload" });
      expect(workflowLiveExecutionCount()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps terminal group and leaves drillable after workflow UI cleanup", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workflow-retention-"));
    const script = path.join(root, "proof.workflow.mjs");
    writeFileSync(script, "export default async () => ({ ok: true });\n", "utf8");
    const runId = "20260712-234108-34da";
    const groupId = workflowGroupLiveRowId({ runId, groupId: "parallel-1" });
    const start = agentLine(runId, "agent_start");
    const anchorId = workflowAgentLiveRowId(start);
    const childId = `workflow-agent:${runId}:reviewer:beta:proof`;
    const events: WorkflowJournalLine[] = [
      {
        ts: "2026-07-12T23:41:08.000Z",
        runId,
        kind: "group_start",
        groupId: "parallel-1",
        groupKind: "parallel",
        groupTotal: 1,
      },
      start,
      agentLine(runId, "agent_end", "completed"),
      {
        ts: "2026-07-12T23:41:09.000Z",
        runId,
        kind: "group_end",
        status: "completed",
        groupId: "parallel-1",
        groupKind: "parallel",
        groupTotal: 1,
        groupCompleted: 1,
        groupFailed: 0,
      },
    ];
    const spy = vi.spyOn(runner, "runWorkflowScript").mockImplementation(async (options) => {
      options.onRunStart?.({ runId, runDir: path.join(root, ".locus-pi", "runs", runId) });
      for (const event of events) {
        options.onEvent?.(event);
        if (event.kind === "agent_start") {
          agentLiveStore.begin({
            id: childId,
            parentRowId: anchorId,
            agentName: "reviewer",
            label: "T209 beta streaming proof",
            isolated: false,
            noMcp: false,
          });
          agentLiveStore.patch(childId, { status: "working", currentTools: ["bash"] });
        }
        if (event.kind === "agent_end") {
          agentLiveStore.patch(childId, { status: "done", currentTools: ["bash"], finalAnswer: "beta complete" });
        }
      }
      return {
        runId,
        runDir: path.join(root, ".locus-pi", "runs", runId),
        ok: true,
        result: { ok: true },
        journal: events,
        resultPersistence: { ok: true, path: path.join(root, "result.json") },
      };
    });

    try {
      const harness = createHarness(root);
      harness.ctx.hasUI = false;
      workflows(harness.pi);
      await harness.commands.get("workflows")!.handler("run proof.workflow.mjs", harness.ctx);
      await emit(harness, "turn_end");

      expect(spy).toHaveBeenCalledOnce();
      expect(agentLiveStore.rows.get(groupId)).toMatchObject({ status: "done", groupKind: "parallel" });
      expect(agentLiveStore.rows.get(anchorId)).toMatchObject({ status: "done", currentTools: [] });
      expect(agentLiveStore.rows.get(childId)).toMatchObject({ status: "done", currentTools: [] });

      harness.ctx.hasUI = true;
      agents(harness.pi);
      harness.customInputQueue.push("escape");
      await harness.commands.get("ps")!.handler("last", harness.ctx);
      expect(harness.customRenderFrames.at(-1)?.[0]).toContain("T209 beta streaming proof");

      await harness.commands.get("ps")!.handler(groupId, harness.ctx);
      expect(harness.widgets.get("agents")).toContain("is a group summary; choose one child agent.");
      expect(harness.widgets.get("agents")).toContain(anchorId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains five terminal workflow runs, prunes older runs, and never removes an active run", () => {
    const terminalRunIds = Array.from({ length: 7 }, (_, index) => `20260712-00000${index + 1}-000${index + 1}`);
    for (const runId of terminalRunIds) addRunRows(runId, "completed");
    const activeRunId = "20260711-235959-active";
    addRunRows(activeRunId, "running");

    const removed = pruneCompletedWorkflowRunLiveRows(terminalRunIds.at(-1)!);
    const retainedRunIds = new Set(
      [...agentLiveStore.rows.keys()].map(workflowRunIdFromRowId).filter((runId) => runId !== undefined),
    );

    expect(removed).toBe(4);
    expect(retainedRunIds.has(terminalRunIds[0]!)).toBe(false);
    expect(retainedRunIds.has(terminalRunIds[1]!)).toBe(false);
    expect(retainedRunIds).toEqual(new Set([...terminalRunIds.slice(-5), activeRunId]));
    expect([...agentLiveStore.rows.values()].filter((row) => workflowRunIdFromRowId(row.id) === activeRunId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "working" })]),
    );

    expect(pruneCompletedWorkflowRunLiveRows("20260712-000008-no-live-rows")).toBe(0);
    expect(
      new Set([...agentLiveStore.rows.keys()].map(workflowRunIdFromRowId).filter((runId) => runId !== undefined)),
    ).toEqual(retainedRunIds);
  });
});

/**
 * W7 at the workflow live row, which is built from journal lines rather than by the
 * SDK host.
 *
 * `agent_start` carries the REQUESTED selector by documented design — it is written
 * before the bridge resolves anything — and `agent_end` for a refused call carries no
 * `model` to replace it. Without a rule here, a workflow stage whose tier was refused
 * ends as a terminal row labelled with a model that never ran.
 */
describe("workflow live rows and the model that executed", () => {
  const runId = "20260729-000001-tier-refusal";
  const started: WorkflowJournalLine = {
    ts: "start",
    runId,
    kind: "agent_start",
    callId: "call-0001",
    agent: "reviewer",
    label: "review",
    model: "no-such-provider/no-such-model",
    requestedModel: "no-such-provider/no-such-model",
    modelRole: "smol",
    thinking: "high",
  };

  it("drops the requested selector when the call failed without executing", () => {
    applyWorkflowJournalLineToAgentLiveStore(started);
    const id = workflowAgentLiveRowId(started);
    expect(agentLiveStore.rows.get(id)?.model).toBe("no-such-provider/no-such-model");

    applyWorkflowJournalLineToAgentLiveStore({
      ...started,
      ts: "end",
      kind: "agent_end",
      status: "failed",
      // No executedModel: the tier was refused before any child existed.
    });

    const row = agentLiveStore.rows.get(id);
    expect(row?.status).toBe("error");
    expect(row?.model).toBeUndefined();
    expect(row?.thinking).toBeUndefined();
  });

  it("drops the requested selector on a run-level error line for the same call", () => {
    // The other terminal line shape: a workflow `error` for a call that never reached
    // `agent_end`. Same rule — nothing reported an executed model, so nothing may be
    // labelled as having run.
    applyWorkflowJournalLineToAgentLiveStore(started);
    const id = workflowAgentLiveRowId(started);

    applyWorkflowJournalLineToAgentLiveStore({
      ...started,
      ts: "error",
      kind: "error",
      message: "Workflow agent bridge refused the declared tier.",
    });

    const row = agentLiveStore.rows.get(id);
    expect(row?.status).toBe("error");
    expect(row?.errors.join("\n")).toContain("refused the declared tier");
    expect(row?.model).toBeUndefined();
  });

  it("drops the requested selector on a REPLAYED completion, where no child ran at all", () => {
    // The status is `completed` and the row will read `done`, which is exactly why this
    // case is the easiest one to get wrong: a resumed run serves the recorded answer
    // without creating a child, so `agent_end` carries neither `model` nor
    // `executedModel`. Leaving the `agent_start` request standing would label a row
    // that spent no tokens with the model the operator asked for — a request presented
    // as a result on the one status nobody re-reads.
    applyWorkflowJournalLineToAgentLiveStore(started);
    const id = workflowAgentLiveRowId(started);
    expect(agentLiveStore.rows.get(id)?.model).toBe("no-such-provider/no-such-model");

    applyWorkflowJournalLineToAgentLiveStore({
      ts: "end",
      runId,
      kind: "agent_end",
      callId: "call-0001",
      agent: "reviewer",
      label: "review",
      status: "completed",
      replayed: true,
    });

    const row = agentLiveStore.rows.get(id);
    expect(row?.status).toBe("done");
    expect(row?.model).toBeUndefined();
    expect(row?.thinking).toBeUndefined();
  });

  it("keeps the label on an error line that reports what executed", () => {
    // The counter-case for the `error` shape: a script validator or artifact writer
    // that fails AFTER the child answered ends the call on an `error` line, and the
    // runtime forwards the readback onto it. That line must replace the requested
    // selector with what ran, not clear the row as if nothing had.
    applyWorkflowJournalLineToAgentLiveStore(started);
    const id = workflowAgentLiveRowId(started);

    applyWorkflowJournalLineToAgentLiveStore({
      ...started,
      ts: "error",
      kind: "error",
      source: "script",
      message: "validator exploded after the child had already answered",
      model: "test/fast",
      executedModel: "test/fast",
      thinking: "low",
    });

    const row = agentLiveStore.rows.get(id);
    expect(row?.status).toBe("error");
    expect(row?.model).toBe("test/fast");
    expect(row?.thinking).toBe("low");
  });

  it("keeps the label on a failure that did execute, including an unavailable readback", () => {
    // The counter-case, so the rule above cannot be satisfied by blanking every failed
    // row: a child that ran and then failed HAS a model to name, and a peer that
    // reported nothing still ran — `unavailable` is recorded as evidence while the
    // row keeps the display value it had.
    applyWorkflowJournalLineToAgentLiveStore(started);
    const id = workflowAgentLiveRowId(started);

    applyWorkflowJournalLineToAgentLiveStore({
      ...started,
      ts: "end",
      kind: "agent_end",
      status: "failed",
      model: "test/fast",
      executedModel: "unavailable",
    });

    const row = agentLiveStore.rows.get(id);
    expect(row?.status).toBe("error");
    expect(row?.model).toBe("test/fast");
  });
});

function agentLine(
  runId: string,
  kind: "agent_start" | "agent_end",
  status?: "running" | "completed",
): WorkflowJournalLine {
  return {
    ts: "2026-07-12T23:41:08.001Z",
    runId,
    kind,
    agent: "reviewer",
    label: "beta",
    phase: "proof",
    groupId: "parallel-1",
    groupKind: "parallel",
    ...(status === undefined ? {} : { status }),
  };
}

function addRunRows(runId: string, status: "running" | "completed"): void {
  applyWorkflowJournalLineToAgentLiveStore({
    ts: `${runId}:group-start`,
    runId,
    kind: "group_start",
    groupId: "parallel-1",
    groupKind: "parallel",
    groupTotal: 1,
  });
  applyWorkflowJournalLineToAgentLiveStore(agentLine(runId, "agent_start"));
  if (status === "completed") {
    applyWorkflowJournalLineToAgentLiveStore(agentLine(runId, "agent_end", "completed"));
    applyWorkflowJournalLineToAgentLiveStore({
      ts: `${runId}:group-end`,
      runId,
      kind: "group_end",
      status: "completed",
      groupId: "parallel-1",
      groupKind: "parallel",
      groupTotal: 1,
      groupCompleted: 1,
      groupFailed: 0,
    });
  }
}
