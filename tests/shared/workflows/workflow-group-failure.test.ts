import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_GROUP_FAILURE,
  WorkflowGroupFailureError,
  createWorkflowRuntime,
  type WorkflowAgentRunner,
} from "../../../extensions/_shared/workflow-runtime.js";
import { runWorkflowScript } from "../../../extensions/_shared/workflow-runner.js";
import { readWorkflowRunSummary } from "../../../extensions/_shared/workflow-journal.js";
import { createHarness } from "../../test-harness.js";

const okRunner: WorkflowAgentRunner = async (request) => ({
  ok: true,
  status: "completed",
  summary: request.prompt,
  diagnostics: [],
  agent: request.agent,
});

describe("workflow group failure contract", () => {
  it("keeps all-success ordering and treats an explicitly returned null as a real value", async () => {
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "group-success-null", agentRunner: okRunner });

    const parallel = await dsl.parallel([async () => null, async () => "second"]);
    const pipeline = await dsl.pipeline([1, 2], async (value) => Number(value) + 1);

    expect(parallel).toEqual([null, "second"]);
    expect(pipeline).toEqual([2, 3]);
    expect(getJournal().filter((line) => line.kind === "group_end")).toEqual([
      expect.objectContaining({ groupKind: "parallel", status: "completed", groupCompleted: 2, groupFailed: 0 }),
      expect.objectContaining({ groupKind: "pipeline", status: "completed", groupCompleted: 2, groupFailed: 0 }),
    ]);
  });

  it("stops later stages for failed items and reports item/stage evidence after siblings finish", async () => {
    const stageTwoSeen: string[] = [];
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "pipeline-failure-slots", agentRunner: okRunner });

    let caught: unknown;
    try {
      await dsl.pipeline(
        ["a", "b", "c"],
        async (value) => value === "b"
          ? { ok: false, status: "blocked", summary: "blocked at stage zero" }
          : { ok: true, value },
        async (value) => {
          const item = (value as { value: string }).value;
          stageTwoSeen.push(item);
          if (item === "c") throw new Error("stage one exploded");
          return item.toUpperCase();
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorkflowGroupFailureError);
    const failure = caught as WorkflowGroupFailureError<unknown>;
    expect(failure.partialResults).toEqual([
      "A",
      { ok: false, status: "blocked", summary: "blocked at stage zero" },
      null,
    ]);
    expect(failure.failures).toEqual([
      {
        index: 1,
        stageIndex: 0,
        kind: "returned-failure",
        status: "blocked",
        message: "blocked at stage zero",
      },
      { index: 2, stageIndex: 1, kind: "thrown", message: "stage one exploded" },
    ]);
    expect(stageTwoSeen).toEqual(["a", "c"]);
    expect(getJournal().filter((line) => line.kind === "group_end").at(-1)).toMatchObject({
      groupKind: "pipeline",
      status: "failed",
      groupCompleted: 1,
      groupFailed: 2,
    });
  });

  it("persists a JSON-safe typed envelope and failed status for an unhandled group failure", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-group-unhandled-"));
    const harness = createHarness(root, { sessionId: "wf-group-unhandled" });
    try {
      writeFileSync(path.join(root, "unhandled.workflow.mjs"), [
        "export default async function run({ parallel }) {",
        "  await parallel([",
        "    async () => BigInt(1),",
        "    async () => { throw new Error('branch exploded'); },",
        "  ]);",
        "  return { ok: true, summary: 'must not reach' };",
        "}",
        "",
      ].join("\n"), "utf8");

      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "unhandled.workflow.mjs",
      });
      const persisted = JSON.parse(readFileSync(result.resultPersistence.path, "utf8")) as {
        ok?: boolean;
        result?: unknown;
        error?: string;
      };

      expect(result.ok).toBe(false);
      expect(result.error).toContain("parallel failed in 1/2 branch(es)");
      expect(result.result).toMatchObject({
        ok: false,
        kind: "workflow_group_failure",
        code: WORKFLOW_GROUP_FAILURE,
        groupKind: "parallel",
        total: 2,
        completed: 1,
        failed: 1,
      });
      expect(persisted).toMatchObject({ ok: false, result: result.result, error: result.error });
      expect(readWorkflowRunSummary(root, result.runId).status).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows explicit typed partial recovery but never projects partial:true as ordinary success", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-group-acknowledged-"));
    const harness = createHarness(root, { sessionId: "wf-group-acknowledged" });
    try {
      writeFileSync(path.join(root, "acknowledged.workflow.mjs"), [
        "export default async function run({ parallel }) {",
        "  try {",
        "    await parallel([",
        "      async () => ({ ok: true, value: 'kept' }),",
        "      async () => ({ ok: false, status: 'cancelled', summary: 'operator stopped branch' }),",
        "    ]);",
        "  } catch (error) {",
        `    if (!error || error.code !== ${JSON.stringify(WORKFLOW_GROUP_FAILURE)}) throw error;`,
        "    return {",
        "      partial: true,",
        "      outcome: 'partial',",
        "      completed: error.completed,",
        "      failed: error.failed,",
        "      kept: error.partialResults[0].value,",
        "      failureStatus: error.failures[0].status,",
        "    };",
        "  }",
        "}",
        "",
      ].join("\n"), "utf8");

      const result = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        scriptPath: "acknowledged.workflow.mjs",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        partial: true,
        outcome: "partial",
        completed: 1,
        failed: 1,
        kept: "kept",
        failureStatus: "cancelled",
      });
      expect(readWorkflowRunSummary(root, result.runId).status).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
