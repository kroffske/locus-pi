import { describe, expect, it } from "vitest";
import { createWorkflowTranscript, persistCommandWorkflowTranscript, WORKFLOW_EVENT_CUSTOM_TYPE } from "../../../extensions/workflows/workflow-transcript.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-sdk-host.js";
import { applyWorkflowJournalLineToAgentLiveStore, workflowAgentLiveRowId } from "../../../extensions/_shared/workflow-journal.js";
import type { RunWorkflowScriptResult } from "../../../extensions/_shared/workflow-runner.js";
import type { WorkflowJournalLine } from "../../../extensions/_shared/workflow-runtime.js";
import { compactWorkflowParentRows } from "../../../extensions/workflows/progress-widget.js";
import { createHarness } from "../../test-harness.js";

describe("workflow persistent transcript", () => {
  it("buffers command lifecycle, then persists one digest after the idle barrier without a model turn", async () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "/private/path/demo.workflow.mjs", "command");
    transcript.start("run-1");
    const completion = transcript.finish({
      runId: "run-1",
      runDir: "/tmp/run-1",
      ok: true,
      result: { summary: "done" },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-1/result.json" },
    });

    expect(harness.sentMessages).toEqual([]);
    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(true);
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]?.message.content).toEqual(expect.stringContaining("● workflow demo.workflow.mjs started"));
    expect(harness.sentMessages[0]?.message.content).toEqual(expect.stringContaining("✓ workflow demo.workflow.mjs finished · done"));
    for (const entry of harness.sentMessages) {
      expect(entry.message).toMatchObject({ customType: WORKFLOW_EVENT_CUSTOM_TYPE, display: true });
      expect(String(entry.message.content).length).toBeLessThanOrEqual(4096);
      expect(entry.options).toEqual({ triggerTurn: false });
      expect(entry.options).not.toHaveProperty("deliverAs");
    }
    expect(harness.waitForIdleCalls).toBe(1);
    expect(harness.customMessageDeliveries).toEqual(["append"]);
    expect(harness.notifications).toEqual([]);
  });

  it("persists exactly one final command failure in one workflow_end digest", async () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "broken", "command");
    const errorLine: WorkflowJournalLine = { ts: "t", runId: "run-2", kind: "error", message: "same failure" };
    transcript.start("run-2");
    transcript.event(errorLine);
    const failedRun: RunWorkflowScriptResult = {
      runId: "run-2",
      runDir: "/tmp/run-2",
      ok: false,
      result: null,
      error: "same failure",
      journal: [errorLine],
      resultPersistence: { ok: true, path: "/tmp/run-2/result.json" },
    };
    const firstCompletion = transcript.finish(failedRun);
    expect(transcript.finish(failedRun)).toBe(firstCompletion);
    await persistCommandWorkflowTranscript(harness.pi, harness.ctx, firstCompletion);

    const failures = harness.sentMessages.filter((entry) => String(entry.message.content).includes("same failure"));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message.details).toMatchObject({ eventKind: "workflow_end", runId: "run-2" });
    expect(String(failures[0]?.message.content)).toContain("failed");
  });

  it("preserves semantic failure summary and unresolved row ids without a technical error", () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "semantic-stop", "tool");
    transcript.start("semantic-failure");
    const intermediateError: WorkflowJournalLine = {
      ts: "t",
      runId: "semantic-failure",
      kind: "error",
      message: "intermediate child error",
    };
    transcript.event(intermediateError);

    const completion = transcript.finish({
      runId: "semantic-failure",
      runDir: "/tmp/semantic-failure",
      ok: false,
      result: {
        ok: false,
        summary: "Acceptance remains open",
        unresolvedRows: ["R-GIT", "R-CODE"],
      },
      journal: [intermediateError],
      resultPersistence: { ok: true, path: "/tmp/semantic-failure/result.json" },
    });

    expect(completion.digest).toContain("✗ workflow semantic-stop failed");
    expect(completion.digest).toContain("Acceptance remains open");
    expect(completion.digest).toContain("R-CODE, R-GIT");
    expect(completion.digest).not.toContain("unknown error");
    expect(completion.digest).not.toContain("intermediate child error");
  });

  it("uses a journal error only as fallback when no final semantic diagnostic exists", () => {
    const transcript = createWorkflowTranscript(createHarness().ctx, "fallback-stop", "tool");
    transcript.start("fallback-failure");
    transcript.event({ ts: "t", runId: "fallback-failure", kind: "error", message: "host bridge failed" });

    const completion = transcript.finish({
      runId: "fallback-failure",
      runDir: "/tmp/fallback-failure",
      ok: false,
      result: null,
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/fallback-failure/result.json" },
    });

    expect(completion.digest).toContain("host bridge failed");
  });

  it("uses a failed llm diagnostic as fallback when the script returns only ok:false", () => {
    const transcript = createWorkflowTranscript(createHarness().ctx, "llm-smoke", "tool");
    transcript.start("llm-auth-failure");
    transcript.event({
      ts: "t",
      runId: "llm-auth-failure",
      kind: "llm_end",
      status: "failed",
      label: "schema",
      message: "Workflow llm bridge: request auth failed: No API key found",
    });

    const completion = transcript.finish({
      runId: "llm-auth-failure",
      runDir: "/tmp/llm-auth-failure",
      ok: false,
      result: { ok: false },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/llm-auth-failure/result.json" },
    });

    expect(completion.digest).toContain("Workflow llm bridge: request auth failed: No API key found");
    expect(completion.digest).not.toContain("Workflow execution failed");
  });

  it("records result-persistence failure once as the terminal workflow verdict", () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "persistence-warning", "command");
    transcript.start("run-persistence-warning");

    const completion = transcript.finish({
      runId: "run-persistence-warning",
      runDir: "/tmp/run-persistence-warning",
      ok: false,
      error: "Workflow result was not persisted: blocked",
      result: { summary: "execution completed" },
      journal: [],
      resultPersistence: {
        ok: false,
        path: "/blocked/result.json",
        code: "WORKFLOW_RESULT_WRITE_FAILED",
        message: "Workflow result was not persisted: blocked",
      },
    });

    expect(harness.notifications).toEqual([]);
    expect(completion.digest).toContain("✗ workflow persistence-warning failed");
    expect(completion.digest).toContain("Workflow result was not persisted: blocked");
    expect(completion.digest).not.toContain("finished");
  });

  it("buffers a bounded tool digest without calling sendMessage and always retains workflow_end", () => {
    const harness = createHarness();
    const transcript = createWorkflowTranscript(harness.ctx, "bounded", "tool");
    agentLiveStore.reset();
    try {
      transcript.start("run-bounded");
      for (let index = 0; index < 40; index += 1) {
        const line: WorkflowJournalLine = {
          ts: `t${index}`,
          runId: "run-bounded",
          kind: "agent_start",
          agent: `agent-${index}-${"x".repeat(200)}`,
        };
        applyWorkflowJournalLineToAgentLiveStore(line);
        transcript.event(line);
      }
      transcript.event({ ts: "te", runId: "run-bounded", kind: "error", message: "intermediate journal failure" });
      const completion = transcript.finish({
        runId: "run-bounded",
        runDir: "/tmp/run-bounded",
        ok: false,
        result: null,
        error: "final failure",
        journal: [],
        resultPersistence: { ok: true, path: "/tmp/run-bounded/result.json" },
      });

      expect(harness.sentMessages).toEqual([]);
      expect(completion).toMatchObject({ eventKind: "workflow_end", lineCount: 22 });
      expect(completion.digest.match(/final failure/g)).toHaveLength(1);
      expect(completion.digest).not.toContain("intermediate journal failure");
      expect(completion.digest.split("\n").slice(1).every((line) => line.length <= 160)).toBe(true);
      expect(completion.digest.length).toBeLessThanOrEqual(4096);
    } finally {
      agentLiveStore.reset();
    }
  });

  it("uses stable agent plus label for cancelled lifecycle instead of a second parent-row petname", () => {
    const harness = createHarness();
    agentLiveStore.reset();
    try {
      const start: WorkflowJournalLine = {
        ts: "t1",
        runId: "run-cancelled",
        kind: "agent_start",
        agent: "reviewer",
        label: "sleep 60",
      };
      const end: WorkflowJournalLine = {
        ...start,
        ts: "t2",
        kind: "agent_end",
        status: "cancelled",
        durationMs: 60_000,
      };
      applyWorkflowJournalLineToAgentLiveStore(start);
      const parent = agentLiveStore.rows.get(workflowAgentLiveRowId(start))!;
      const child = agentLiveStore.begin({
        parentRowId: parent.id,
        agentName: "reviewer",
        label: "SDK child session",
        isolated: false,
        noMcp: false,
      });
      agentLiveStore.patch(child.id, { status: "cancelled" });
      const parentPetname = parent.displayName;
      const childPetname = child.displayName;
      if (parentPetname === undefined || childPetname === undefined) throw new Error("expected canonical petnames");

      const visible = compactWorkflowParentRows([...agentLiveStore.rows.values()]);
      expect(visible.map((row) => row.id)).toEqual([child.id]);
      expect(visible[0]?.displayName).toBe(child.displayName);

      const transcript = createWorkflowTranscript(harness.ctx, "cancel-smoke", "tool");
      transcript.start("run-cancelled");
      transcript.event(start);
      transcript.event(end);
      const completion = transcript.finish({
        runId: "run-cancelled",
        runDir: "/tmp/run-cancelled",
        ok: true,
        result: { summary: "child status reviewer cancelled" },
        journal: [start, end],
        resultPersistence: { ok: true, path: "/tmp/run-cancelled/result.json" },
      });

      expect(completion.digest).toContain("● agent reviewer started — sleep 60");
      expect(completion.digest).toContain("⊘ agent reviewer cancelled · 1m — sleep 60");
      expect(completion.digest).not.toContain("✓ agent");
      expect(completion.digest).not.toContain(parentPetname);
      expect(completion.digest).not.toContain(childPetname);
    } finally {
      agentLiveStore.reset();
    }
  });

  it("never sends when waitForIdle is unavailable and reports the missing persistence barrier", async () => {
    const harness = createHarness();
    delete harness.ctx.waitForIdle;
    const transcript = createWorkflowTranscript(harness.ctx, "fallback", "command");
    transcript.start("run-3");
    transcript.event({
      ts: "t",
      runId: "run-3",
      kind: "agent_end",
      agent: "reviewer",
      status: "completed",
      evidenceWarnings: ["weak proof"],
    });
    const completion = transcript.finish({
      runId: "run-3",
      runDir: "/tmp/run-3",
      ok: true,
      result: { summary: "done" },
      journal: [],
      resultPersistence: { ok: true, path: "/tmp/run-3/result.json" },
    });
    expect(await persistCommandWorkflowTranscript(harness.pi, harness.ctx, completion)).toBe(false);

    expect(harness.sentMessages).toEqual([]);
    expect(harness.notificationEvents).toContainEqual({ message: "⚠ agent evidence · weak proof", level: "warning" });
    expect(harness.notificationEvents).toContainEqual({
      message: "Workflow transcript was not persisted: ctx.waitForIdle is unavailable.",
      level: "warning",
    });
  });
});
