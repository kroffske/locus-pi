/** Production-module contracts with deterministic child doubles, NOT live Pi/model proof. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowJournalLine,
} from "../../extensions/workflows/runtime/workflow-runtime.js";
import {
  createWorkflowReturnController,
  normalizeWorkflowReturnContract,
} from "../../extensions/workflows/runtime/workflow-return.js";
import { createWorkflowArtifactStore } from "../../extensions/workflows/runtime/workflow-artifacts.js";
import {
  createWorkflowReplayController,
  readWorkflowReplayLog,
} from "../../extensions/workflows/runtime/workflow-replay.js";
import {
  createWorkflowJournalSink,
  readWorkflowRunJournalState,
  applyWorkflowJournalLineToAgentLiveStore,
  resetWorkflowLiveExecutions,
  workflowAgentLiveRowId,
} from "../../extensions/workflows/runtime/workflow-journal.js";
import {
  createAgentSdkSessionExecutor,
  agentLiveStore,
  type SdkAgentSessionLike,
  type SdkAgentSessionEventLike,
} from "../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import type { AgentRunRequest } from "../../extensions/_shared/agent-runtime/agent-runner.js";
import {
  workflowRecoveryInputHash,
  readInterruptedWorkflowResumeBinding,
} from "../../extensions/workflows/runtime/workflow-interrupted-recovery.js";

export interface ContinuationContractCase {
  name: string;
  run: () => Promise<void>;
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const completed = (request: WorkflowAgentRequest, text: string): WorkflowAgentResult => ({
  ok: true,
  status: "completed",
  summary: "done",
  text,
  diagnostics: [],
  ...(request.executionMode === undefined ? {} : { executionMode: request.executionMode }),
});
const cases: ContinuationContractCase[] = [];
function test(name: string, run: () => Promise<void>): void {
  cases.push({ name, run });
}
function tempRun(root: string, id: string): string {
  const dir = path.join(root, ".locus-pi", "runs", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "locus-continuation-contract-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
async function example(
  name: string,
): Promise<(dsl: ReturnType<typeof createWorkflowRuntime>["dsl"], input: string) => Promise<unknown>> {
  const url = pathToFileURL(
    path.resolve(import.meta.dirname, "../../extensions/workflows/references/examples", `${name}.workflow.mjs`),
  );
  return (await import(url.href)).default;
}

// Scheduler: input order, local width, one leaf gate, precise admission evidence.
test("parallel keeps input order, while completion order remains independent", async () => {
  const finish: number[] = [];
  const runtime = createWorkflowRuntime({
    runId: "ordering",
    agentRunner: async (req) => {
      const n = Number(req.prompt);
      await delay((3 - n) * 8);
      finish.push(n);
      return completed(req, `${n}`);
    },
  });
  const values = await runtime.dsl.parallel(
    [0, 1, 2, 3].map((n) => () => runtime.dsl.agent(`${n}`, { label: `unit-${n}` })),
  );
  assert.deepEqual(values, ["0", "1", "2", "3"]);
  assert.deepEqual(finish, [3, 2, 1, 0]);
});
test("parallel local concurrency actually narrows execution and malformed options fail before calls", async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const runtime = createWorkflowRuntime({
    runId: "local-width",
    maxConcurrentAgents: 8,
    agentRunner: async (req) => {
      calls += 1;
      peak = Math.max(peak, ++active);
      await delay(2);
      active -= 1;
      return completed(req, "done");
    },
  });
  await runtime.dsl.parallel(
    [0, 1, 2, 3].map((n) => () => runtime.dsl.agent(`${n}`)),
    { concurrency: 1, title: "Business units", keys: ["a", "b", "c", "d"] },
  );
  assert.equal(peak, 1);
  assert.equal(calls, 4);
  assert.equal(runtime.getJournal().find((line) => line.kind === "group_start")?.groupLabel, "Business units");
  for (const opts of [
    { concurrency: 0 },
    { concurrency: 1.5 },
    { keys: ["a", "a"] },
    { keys: ["a"] },
    { bogus: true },
  ]) {
    await assert.rejects(
      runtime.dsl.parallel([() => runtime.dsl.agent("x"), () => runtime.dsl.agent("y")], opts as never),
    );
  }
  assert.equal(calls, 4);
});
test("nested groups retain one global leaf gate and full business-key paths", async () => {
  let active = 0,
    peak = 0;
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId: "nested",
    maxConcurrentAgents: 2,
    agentRunner: async (req) => {
      requests.push(req);
      peak = Math.max(peak, ++active);
      await delay(2);
      active -= 1;
      return completed(req, "done");
    },
  });
  await runtime.dsl.parallel(
    ["a", "b"].map(
      (candidate) => () =>
        runtime.dsl.parallel(
          ["id", "schedule"].map(
            (field) => () =>
              runtime.dsl.agent(`${candidate}:${field}`, {
                label: "extract",
                title: `${candidate} · ${field}`,
              }),
          ),
          { keys: ["id", "schedule"], concurrency: 4 },
        ),
    ),
    { keys: ["a", "b"], concurrency: 4 },
  );
  assert.equal(peak, 2);
  assert.deepEqual(
    requests.map((req) => req.itemPath),
    [
      ["a", "id"],
      ["a", "schedule"],
      ["b", "id"],
      ["b", "schedule"],
    ],
  );
  assert.deepEqual(
    requests.map((req) => req.title),
    ["a · id", "a · schedule", "b · id", "b · schedule"],
  );
});
test("phase is branch-local rather than the last sibling to mutate a global", async () => {
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId: "phases",
    agentRunner: async (req) => {
      requests.push(req);
      return completed(req, "done");
    },
  });
  runtime.dsl.phase("root");
  await runtime.dsl.parallel([
    async () => {
      runtime.dsl.phase("A");
      await delay(5);
      return runtime.dsl.agent("A");
    },
    async () => {
      runtime.dsl.phase("B");
      return runtime.dsl.agent("B");
    },
  ]);
  await runtime.dsl.agent("root");
  assert.deepEqual(
    requests.map((req) => [req.prompt, req.phase]),
    [
      ["B", "B"],
      ["A", "A"],
      ["root", "root"],
    ],
  );
});
test("queued is not started: actual starts respect the leaf gate and live projection", async () => {
  agentLiveStore.reset();
  resetWorkflowLiveExecutions();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createWorkflowRuntime({
    runId: "admission",
    maxConcurrentAgents: 1,
    agentRunner: async (req) => {
      if (req.prompt === "first") await held;
      return completed(req, "done");
    },
  });
  const running = runtime.dsl.parallel([
    () => runtime.dsl.agent("first", { title: "First" }),
    () => runtime.dsl.agent("second", { title: "Second" }),
  ]);
  await delay(5);
  const lines = runtime.getJournal();
  assert.equal(lines.filter((line) => line.kind === "agent_queued").length, 2);
  assert.equal(lines.filter((line) => line.kind === "agent_start").length, 1);
  const queued = lines.filter((line) => line.kind === "agent_queued")[1]!;
  applyWorkflowJournalLineToAgentLiveStore(queued);
  const row = agentLiveStore.rows.get(workflowAgentLiveRowId(queued));
  assert.equal(row?.status, "queued");
  assert.equal(row?.title, "Second");
  release();
  await running;
  for (const line of runtime
    .getJournal()
    .filter((entry) => entry.callId === queued.callId && entry.kind === "agent_start"))
    applyWorkflowJournalLineToAgentLiveStore(line);
  assert.equal(agentLiveStore.rows.get(workflowAgentLiveRowId(queued))?.status, "working");
  agentLiveStore.reset();
  resetWorkflowLiveExecutions();
});
test("new queue, title, item and decision events round-trip through the strict persisted journal", async () =>
  temporary(async (root) => {
    const id = "journal";
    tempRun(root, id);
    const sink = createWorkflowJournalSink(root, id);
    const runtime = createWorkflowRuntime({
      runId: id,
      journal: sink,
      agentRunner: async (req) => completed(req, '"complete"'),
    });
    await runtime.dsl.parallel(
      [() => runtime.dsl.agent("route", { label: "route", title: "Decision", choice: ["complete", "continue"] })],
      { keys: ["unit"], title: "Units" },
    );
    const state = readWorkflowRunJournalState(root, id);
    assert.deepEqual(state.diagnostics, []);
    assert.equal(state.lines.length, runtime.getJournal().length);
    assert.equal(state.lines.find((line) => line.choiceDecision)?.choiceDecision?.source, "validated");
    assert.deepEqual(state.lines.find((line) => line.kind === "agent_start")?.itemPath, ["unit"]);
  }));

// SDK execution is real production code; only the injected Pi session is simulated.
interface SessionScenario {
  submissions: Array<Array<unknown>>;
  rejectPrompt?: number;
  providerFailure?: boolean;
  cancelAfterProposal?: boolean;
  maxToolCalls?: number;
  maxTurns?: number;
  noRestriction?: boolean;
  conflicting?: boolean;
}
async function runSession(scenario: SessionScenario) {
  return temporaryValue(async (root) => {
    const controller = createWorkflowReturnController(
      normalizeWorkflowReturnContract({ output: { type: "string", singleLine: true }, repair: { maxAttempts: 3 } }),
    );
    const abort = new AbortController();
    const prompts: string[] = [];
    const restrictions: string[][] = [];
    const ids: string[] = [];
    let created = 0,
      disposed = 0,
      toolCalls = 0,
      active = ["read", "write", "workflow_return"];
    let emit: (event: SdkAgentSessionEventLike) => void = () => {};
    const messages: unknown[] = [];
    const executor = createAgentSdkSessionExecutor({
      maxToolCalls: scenario.maxToolCalls ?? 10,
      turnTimeoutMs: 1000,
      reportsDir: path.join(root, "reports"),
      createSession: async () => {
        created += 1;
        const session: SdkAgentSessionLike = {
          sessionId: "same-child",
          messages,
          subscribe(listener) {
            emit = listener;
            return () => {
              emit = () => {};
            };
          },
          async prompt(text) {
            prompts.push(text);
            ids.push("same-child");
            emit({ type: "turn_start" });
            if (scenario.rejectPrompt === prompts.length) throw new Error("provider transport rejected");
            for (const value of scenario.submissions[prompts.length - 1] ?? []) {
              toolCalls += 1;
              emit({ type: "tool_execution_start", toolName: "workflow_return", toolCallId: `t${toolCalls}` });
              await controller.tool.execute(`t${toolCalls}`, { value }, abort.signal);
              emit({ type: "tool_execution_end", toolName: "workflow_return", toolCallId: `t${toolCalls}` });
            }
            if (scenario.providerFailure)
              messages.push({ role: "assistant", stopReason: "error", errorMessage: "provider failed after proposal" });
            if (scenario.cancelAfterProposal) abort.abort();
            emit({ type: "agent_end", willRetry: false });
          },
          getActiveToolNames: () => [...active],
          ...(scenario.noRestriction
            ? {}
            : {
                setActiveToolsByName(names: string[]) {
                  active = [...names];
                  restrictions.push([...names]);
                },
              }),
          getSessionStats: () => ({ sessionId: "same-child", toolCalls, toolResults: toolCalls }),
          getLastAssistantText: () => "Untrusted narrative is not the accepted value",
          exportToJsonl(target) {
            const file = target ?? path.join(root, "session.jsonl");
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, "{}\n");
            return file;
          },
          async abort() {},
          dispose() {
            disposed += 1;
          },
        };
        return { session };
      },
    });
    const request: AgentRunRequest = {
      executionMode: "bare",
      task: "Research the field",
      projectRoot: root,
      workingDirectory: root,
      parentSessionId: "parent",
      maxTurns: scenario.maxTurns ?? 6,
      depth: 0,
      maxDepth: 1,
      allowedTools: ["*"],
      approvalTier: "allow",
      customTools: [controller.tool],
      responseAcceptance: controller.acceptance,
    };
    const result = await executor.run(request, abort.signal);
    return { result, created, disposed, prompts, restrictions, ids, toolCalls };
  });
}
async function temporaryValue<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "locus-session-contract-"));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test("invalid output is corrected in the same session with only return tools, then disposed once", async () => {
  const got = await runSession({ submissions: [["bad\nline"], ["orders"]] });
  assert.equal(got.result.status, "completed");
  assert.equal(got.result.text, '"orders"');
  assert.deepEqual(got.ids, ["same-child", "same-child"]);
  assert.equal(got.created, 1);
  assert.equal(got.disposed, 1);
  assert.equal(got.prompts.length, 2);
  assert.match(got.prompts[1]!, /Reuse your existing evidence/u);
  assert.ok(got.restrictions.length >= 2);
  assert.ok(got.restrictions.every((names) => JSON.stringify(names) === '["workflow_return"]'));
  assert.deepEqual(got.result.outputAcceptance, { source: "tool", attempts: 2, toolName: "workflow_return" });
});
test("missing return tool use receives bounded same-session clarification", async () => {
  const recovered = await runSession({ submissions: [[], ["orders"]] });
  assert.equal(recovered.result.status, "completed");
  assert.equal(recovered.created, 1);
  const exhausted = await runSession({ submissions: [[], [], []] });
  assert.equal(exhausted.prompts.length, 3);
  assert.equal(exhausted.result.failureCause, "output-contract-exhausted");
  assert.equal(exhausted.result.outputAcceptance, undefined);
  assert.equal(exhausted.disposed, 1);
});
test("identical return proposal is idempotent; conflicting proposals never succeed", async () => {
  const duplicate = await runSession({ submissions: [["orders", "orders"]] });
  assert.equal(duplicate.result.status, "completed");
  assert.equal(duplicate.result.outputAcceptance?.attempts, 1);
  const conflict = await runSession({ submissions: [["orders", "other"]] });
  assert.equal(conflict.result.failureCause, "output-contract-conflict");
  assert.equal(conflict.result.outputAcceptance, undefined);
});
test("a proposed value is not success after provider failure or cancellation", async () => {
  const failed = await runSession({ submissions: [["orders"]], providerFailure: true });
  assert.equal(failed.result.failureCause, "provider-error");
  assert.equal(failed.result.outputAcceptance, undefined);
  const cancelled = await runSession({ submissions: [["orders"]], cancelAfterProposal: true });
  assert.equal(cancelled.result.status, "cancelled");
  assert.equal(cancelled.result.outputAcceptance, undefined);
});
test("tool and assistant-turn budgets accumulate across clarification rather than reset", async () => {
  const tools = await runSession({ submissions: [["bad\nline"], ["orders"]], maxToolCalls: 1 });
  assert.equal(tools.result.failureCause, "tool-call-budget");
  const turns = await runSession({ submissions: [[], ["orders"]], maxTurns: 1 });
  assert.equal(turns.result.failureCause, "assistant-turn-budget");
  assert.equal(turns.prompts.length, 1);
});
test("unsupported same-session host fails before asking the model, without a new-session fallback", async () => {
  const got = await runSession({ submissions: [["orders"]], noRestriction: true });
  assert.equal(got.result.failureCause, "output-contract-unavailable");
  assert.equal(got.prompts.length, 0);
  assert.equal(got.disposed, 1);
});
test("malformed output contracts fail before any child starts", async () => {
  let calls = 0;
  const runtime = createWorkflowRuntime({
    runId: "bad-contracts",
    agentRunner: async (req) => {
      calls += 1;
      return completed(req, '"value"');
    },
  });
  const invalid = [
    { returnVia: "other" },
    { returnVia: "tool" },
    { output: { type: "string" } },
    { returnVia: "tool", choice: ["yes", "no"], output: { type: "string" } },
    { returnVia: "tool", output: { type: "string" }, repair: {} },
    { returnVia: "tool", output: { type: "string" }, repair: { maxAttempts: 4 } },
    { returnVia: "tool", output: { type: "string", extra: true } },
    { returnVia: "tool", output: { type: "string" }, attempts: 2 },
  ];
  for (const options of invalid) await assert.rejects(runtime.dsl.agent("work", options as never));
  assert.equal(calls, 0);
});
test("runtime sends the output contract and accepts only a successful receipt, preserving exact value", async () =>
  temporary(async (root) => {
    const id = "accepted-output";
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: tempRun(root, id) });
    const runtime = createWorkflowRuntime({
      runId: id,
      artifactPorts: store,
      agentRunner: async (req) => {
        assert.equal(req.returnContract?.singleLine, true);
        return {
          ...completed(req, '"orders"'),
          outputAcceptance: { source: "tool", attempts: 2, toolName: "workflow_return" },
        };
      },
    });
    const value = await runtime.dsl.agent("Extract ID", {
      label: "id",
      returnVia: "tool",
      output: { type: "string", singleLine: true },
    });
    assert.equal(value, "orders");
    assert.equal(runtime.getJournal().filter((line) => line.kind === "agent_start").length, 1);
    const canonical = store.list().filter((record) => record.kind === "answer");
    assert.ok(
      store
        .list()
        .some(
          (record) =>
            store
              .read({ runId: record.runId, artifactId: record.artifactId, name: record.name, sha256: record.sha256 })
              .toString() === '"orders"',
        ),
      `accepted bytes missing: ${JSON.stringify(canonical)}`,
    );
    assert.equal(runtime.getJournal().find((line) => line.kind === "agent_end")?.outputAcceptance?.attempts, 2);
    const incompatible = createWorkflowRuntime({
      runId: "bad-boundary",
      agentRunner: async (req) => completed(req, '"orders"'),
    });
    await assert.rejects(
      incompatible.dsl.agent("Extract", { returnVia: "tool", output: { type: "string" } }),
      /acceptance|receipt|output/iu,
    );
  }));
test("fallback has structured provenance and never masks provider failures", async () => {
  for (const failureCause of ["output-contract-exhausted", "provider-error", "output-contract-conflict"] as const) {
    const runtime = createWorkflowRuntime({
      runId: `fallback-${failureCause}`,
      agentRunner: async () => ({ ok: false, status: "failed", summary: failureCause, diagnostics: [], failureCause }),
    });
    const call = runtime.dsl.agent("Classify", {
      label: "route",
      returnVia: "tool",
      choice: ["yes", "no", "unresolved"],
      choiceFallback: "unresolved",
    });
    if (failureCause !== "output-contract-exhausted") {
      await assert.rejects(call);
      assert.equal(runtime.getJournal().filter((line) => line.choiceDecision !== undefined).length, 0);
    } else {
      assert.equal(await call, "unresolved");
      assert.deepEqual(runtime.getJournal().find((line) => line.choiceDecision)?.choiceDecision, {
        value: "unresolved",
        source: "fallback",
        returnVia: "tool",
        attempts: 2,
        reason: "output-contract-exhausted",
      });
    }
  }
});

// Run the actual example source against runtime and persisted artifact owners.
async function refinement(routes: string[]) {
  return temporaryValue(async (root) => {
    const id = "refinement";
    const requests: WorkflowAgentRequest[] = [];
    let decisions = 0;
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: tempRun(root, id) });
    const runtime = createWorkflowRuntime({
      runId: id,
      artifactPorts: store,
      agentRunner: async (req) => {
        requests.push(req);
        if (req.label === "decision") {
          assert.ok(req.returnContract);
          return {
            ...completed(req, JSON.stringify(routes[decisions++])),
            outputAcceptance: { source: "tool", attempts: 1, toolName: "workflow_return" },
          };
        }
        return completed(
          req,
          req.label === "worker"
            ? `work-${decisions + 1}: evidence and remainder`
            : `review-${decisions + 1}: exact feedback\nremaining criterion R2`,
        );
      },
    });
    const result = await (await example("refinement"))(runtime.dsl, "Goal G1; do not change scope");
    return {
      result,
      requests,
      journal: runtime.getJournal(),
      artifacts: store.list().map((record) => ({
        ...record,
        text: store
          .read({ runId: record.runId, artifactId: record.artifactId, name: record.name, sha256: record.sha256 })
          .toString(),
      })),
    };
  });
}
test("refinement complete on first round has no second worker and one primary", async () => {
  const got = await refinement(["complete"]);
  assert.equal(got.requests.length, 3);
  assert.equal(got.artifacts.filter((record) => record.kind === "primary").length, 1);
});
test("continue launches a new worker with exact goal, work and reviewer handoff, then completes", async () => {
  const got = await refinement(["continue_progress", "complete"]);
  assert.equal(got.requests.length, 6);
  const second = got.requests.filter((req) => req.label === "worker")[1]!;
  assert.match(second.prompt, /Goal G1; do not change scope/u);
  assert.match(second.prompt, /work-1: evidence and remainder/u);
  assert.match(second.prompt, /review-1: exact feedback\nremaining criterion R2/u);
  assert.ok(got.artifacts.some((record) => /Decision: continue_progress/u.test(record.text)));
  assert.equal(got.journal.filter((line) => line.choiceDecision).length, 2);
});
test("round cap and repeated no-progress are blocked, never a primary success", async () => {
  const cap = await refinement(["continue_progress", "continue_progress", "continue_progress"]);
  assert.equal(cap.requests.length, 9);
  assert.equal((cap.result as { summary: string }).summary, "round_cap");
  assert.equal((cap.result as { ok: boolean }).ok, false);
  assert.equal(cap.artifacts.filter((record) => record.kind === "primary").length, 0);
  const stalled = await refinement(["continue_stalled", "continue_stalled"]);
  assert.equal(stalled.requests.length, 6);
  assert.equal((stalled.result as { summary: string }).summary, "no_progress");
});
test("fixed graph still performs exactly one worker and no reviewer", async () =>
  temporary(async (root) => {
    const id = "fixed";
    const requests: WorkflowAgentRequest[] = [];
    const store = createWorkflowArtifactStore({ projectRoot: root, runId: id, runDir: tempRun(root, id) });
    const runtime = createWorkflowRuntime({
      runId: id,
      artifactPorts: store,
      agentRunner: async (req) => {
        requests.push(req);
        return completed(req, "fixed output");
      },
    });
    await (
      await example("fixed")
    )(runtime.dsl, "fixed goal");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.returnContract, undefined);
  }));
test("recorded adaptive prefix replays without repeating confirmed worker side effects", async () =>
  temporary(async (root) => {
    const source = tempRun(root, "source");
    let effects = 0;
    const first = createWorkflowRuntime({
      runId: "source",
      replay: createWorkflowReplayController({ runDir: source }),
      agentRunner: async (req) => {
        effects += 1;
        return completed(req, "confirmed");
      },
    });
    assert.equal(await first.dsl.agent("goal", { label: "worker" }), "confirmed");
    const recorded = readWorkflowReplayLog(root, "source");
    assert.equal(recorded.length, 1);
    const replay = createWorkflowReplayController({
      runDir: tempRun(root, "resume"),
      recorded,
      requireRecordedPrefix: true,
    });
    const resumed = createWorkflowRuntime({
      runId: "resume",
      replay,
      agentRunner: async (req) => {
        effects += 1;
        return completed(req, "new review");
      },
    });
    assert.equal(await resumed.dsl.agent("goal", { label: "worker" }), "confirmed");
    assert.equal(effects, 1);
    assert.equal(await resumed.dsl.agent("review", { label: "reviewer" }), "new review");
    assert.equal(effects, 2);
    assert.equal(replay.counts().replayedCalls, 1);
    const strict = createWorkflowReplayController({
      runDir: tempRun(root, "strict"),
      recorded,
      requireRecordedPrefix: true,
    });
    const changed = createWorkflowRuntime({
      runId: "strict",
      replay: strict,
      agentRunner: async (req) => {
        effects += 1;
        return completed(req, "wrong");
      },
    });
    await assert.rejects(changed.dsl.agent("changed goal", { label: "worker" }), /prefix divergence/u);
    assert.equal(effects, 2);
  }));
test("interrupted recovery fingerprints exact inputs and refuses missing authority without creating a result", async () =>
  temporary(async (root) => {
    const a = workflowRecoveryInputHash({ input: "goal", items: ["a", "b"], budget: { totalAgents: 9 } });
    assert.notEqual(a, workflowRecoveryInputHash({ input: "goal", items: ["b", "a"], budget: { totalAgents: 9 } }));
    assert.notEqual(a, workflowRecoveryInputHash({ input: "goal ", items: ["a", "b"], budget: { totalAgents: 9 } }));
    const dir = tempRun(root, "interrupted");
    assert.throws(() =>
      readInterruptedWorkflowResumeBinding(root, "interrupted", {
        target: { kind: "path", ref: "example.workflow.mjs", source: "project" } as never,
        scriptSha256: "0".repeat(64),
        recoveryInputSha256: a,
      }),
    );
    assert.throws(() => readFileSync(path.join(dir, "result.json")), /ENOENT/u);
  }));

test("SIGKILL after a confirmed prefix leaves no terminal result and replay does not repeat its effect", async () =>
  temporary(async (root) => {
    const loader = process.env.LOCUS_TEST_TS_LOADER;
    const args = loader === undefined ? ["--import", "tsx"] : ["--loader", loader];
    const child = spawn(
      process.execPath,
      [...args, path.resolve(import.meta.dirname, "workflow-confirmed-prefix-child.mjs"), root],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const closed = once(child, "close");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout!.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("CONFIRMED_PREFIX")) resolve();
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`child exited before checkpoint: ${code}; ${stderr}`)));
        timer = setTimeout(() => reject(new Error(`checkpoint timeout: ${stderr}`)), 10000);
      });
      child.kill("SIGKILL");
      const [code, signal] = await closed;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      const recorded = readWorkflowReplayLog(root, "killed-prefix");
      assert.equal(recorded.length, 1);
      const journal = readWorkflowRunJournalState(root, "killed-prefix");
      assert.deepEqual(journal.diagnostics, []);
      assert.equal(journal.lines.filter((line) => line.kind === "agent_end").length, 1);
      assert.throws(() => readFileSync(path.join(root, ".locus-pi/runs/killed-prefix/runtime/result.json")), /ENOENT/u);
      let repeated = 0;
      const resumed = createWorkflowRuntime({
        runId: "after-kill",
        replay: createWorkflowReplayController({
          runDir: tempRun(root, "after-kill"),
          recorded,
          requireRecordedPrefix: true,
        }),
        agentRunner: async (req) => {
          repeated += 1;
          return completed(req, "must not run");
        },
      });
      assert.equal(await resumed.dsl.agent("goal", { label: "worker" }), "confirmed");
      assert.equal(repeated, 0);
      assert.equal(readFileSync(path.join(root, "effect-count.txt"), "utf8"), "1");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  }));

export const workflowLocalContinuationContracts: readonly ContinuationContractCase[] = cases;
