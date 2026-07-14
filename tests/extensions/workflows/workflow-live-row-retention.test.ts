import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import agents from "../../../extensions/agents/index.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-sdk-host.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  pruneCompletedWorkflowRunLiveRows,
  workflowAgentLiveRowId,
  workflowGroupLiveRowId,
  workflowRunIdFromRowId,
} from "../../../extensions/_shared/workflow-journal.js";
import type { WorkflowJournalLine } from "../../../extensions/_shared/workflow-runtime.js";
import * as runner from "../../../extensions/_shared/workflow-runner.js";
import workflows from "../../../extensions/workflows/index.js";
import { createHarness, emit } from "../../test-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
  agentLiveStore.reset();
});

describe("completed workflow live-row retention", () => {
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
      options.onRunStart?.({ runId, runDir: path.join(root, ".locus", "runtime", "workflows", runId) });
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
        runDir: path.join(root, ".locus", "runtime", "workflows", runId),
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
      [...agentLiveStore.rows.keys()]
        .map(workflowRunIdFromRowId)
        .filter((runId) => runId !== undefined),
    );

    expect(removed).toBe(4);
    expect(retainedRunIds.has(terminalRunIds[0]!)).toBe(false);
    expect(retainedRunIds.has(terminalRunIds[1]!)).toBe(false);
    expect(retainedRunIds).toEqual(new Set([...terminalRunIds.slice(-5), activeRunId]));
    expect([...agentLiveStore.rows.values()].filter((row) => workflowRunIdFromRowId(row.id) === activeRunId))
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: "working" })]));

    expect(pruneCompletedWorkflowRunLiveRows("20260712-000008-no-live-rows")).toBe(0);
    expect(new Set([...agentLiveStore.rows.keys()].map(workflowRunIdFromRowId).filter((runId) => runId !== undefined)))
      .toEqual(retainedRunIds);
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
