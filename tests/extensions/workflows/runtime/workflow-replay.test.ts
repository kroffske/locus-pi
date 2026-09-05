import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../../extensions/_shared/agent-runtime/agent-runner.js";
import { WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR } from "../../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import {
  readWorkflowRunJournal,
  readWorkflowRunSummary,
} from "../../../../extensions/workflows/runtime/workflow-journal.js";
import { ensureWorkflowRunDir } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowJournalFile } from "../../../../extensions/workflows/runtime/workflow-run-layout.js";
import { workflowResultFile } from "../../../../extensions/workflows/runtime/workflow-result.js";
import { DEFAULT_WORKFLOW_BUDGET } from "../../../../extensions/workflows/runtime/workflow-budget.js";
import {
  createWorkflowReplayController,
  readWorkflowReplayLog,
  WORKFLOW_REPLAY_SCHEMA_VERSION,
  workflowReplayFile,
  type WorkflowReplayController,
  type WorkflowReplayEntry,
  type WorkflowReplayRefusalReason,
} from "../../../../extensions/workflows/runtime/workflow-replay.js";
import {
  packagedWorkflowNames,
  packagedWorkflowPath,
  runWorkflowScript,
} from "../../../../extensions/workflows/runtime/workflow-runner.js";
import { assessWorkflowReplaySafety } from "../../../../extensions/workflows/runtime/workflow-script-identity.js";
import {
  WorkflowGroupFailureError,
  createWorkflowRuntime,
  type WorkflowJournalLine,
} from "../../../../extensions/workflows/runtime/workflow-runtime.js";
import workflowsExt from "../../../../extensions/workflows/index.js";
import type { WorkflowTextComponent } from "../../../../extensions/workflows/operator/progress-widget.js";
import { createWorkflowTranscript } from "../../../../extensions/workflows/transcript/workflow-transcript.js";
import { createHarness } from "../../../test-harness.js";
import { restoreGlobalModelRolesHome, writeGlobalModelRoles } from "../../../model-roles-fixture.js";

/**
 * T-109 — `--resume` may report success only from an identical recorded call;
 * otherwise the call runs again.
 */

const roots: string[] = [];

const REPLAY_REFUSAL_REASONS: Record<WorkflowReplayRefusalReason, true> = {
  "source-run-unusable": true,
  "target-changed": true,
  "identity-coverage-unproven": true,
  "replay-unsafe-script": true,
  "no-recorded-calls": true,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  restoreGlobalModelRolesHome();
});

function temporaryProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-replay-"));
  roots.push(root);
  const agents = path.join(root, ".agents", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(agents, "default.md"),
    "---\nname: default\ndescription: Replay test agent\nevidence:\n  mode: none\n---\nAnswer briefly.\n",
    "utf8",
  );
  return root;
}

function writeWorkflow(root: string, name: string, body: string): void {
  const dir = path.join(root, ".locus-pi", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.workflow.mjs`), body, "utf8");
}

interface RunOutcome {
  runId: string;
  runDir: string;
  ok: boolean;
  result: unknown;
  error?: string;
  replay: NonNullable<Awaited<ReturnType<typeof runWorkflowScript>>["replay"]>;
  /** Prompts that reached a real child. A replayed call never appears here. */
  executedPrompts: string[];
  journal: WorkflowJournalLine[];
  raw: Awaited<ReturnType<typeof runWorkflowScript>>;
}

/** Render the bounded lifecycle digest for one finished run from its own journal. */
function digestFor(root: string, outcome: RunOutcome): string {
  const harness = createHarness(root, { sessionId: `digest-${outcome.runId}` });
  const transcript = createWorkflowTranscript(harness.ctx, "stages", "tool");
  transcript.start(outcome.runId, outcome.runDir);
  for (const line of outcome.journal) transcript.event(line);
  return transcript.finish(outcome.raw).digest;
}

/** The workflow's own prompt, without the run working-directory note the bridge prepends. */
function workflowPrompt(task: string): string {
  const at = task.indexOf(WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR);
  return at === -1 ? task : task.slice(at + WORKFLOW_RUN_WORKSPACE_PROMPT_SEPARATOR.length);
}

/**
 * Run one saved workflow with a scripted child. The child answer is a pure
 * function of the prompt, so a difference between two runs can only come from
 * the replay machinery, never from the fake model.
 */
async function runWorkflow(
  root: string,
  name: string,
  options: {
    input?: string;
    resumeFromRunId?: string;
    outputDir?: string;
    roles?: Record<string, string>;
    /** Override the scripted child's answer for a prompt; may throw to fail that child. */
    answer?: (prompt: string) => string;
  } = {},
): Promise<RunOutcome> {
  process.env.PI_MODEL_ROLES_HOME = path.join(root, ".pi-user");
  const harness = createHarness(root, { sessionId: `replay-${name}` });
  if (options.roles !== undefined) writeGlobalModelRoles(root, options.roles);
  const executedPrompts: string[] = [];
  const createExecutor = (): AgentExecutor => ({
    async run(request: AgentRunRequest) {
      // The bridge prepends this run's working-directory note, whose path carries
      // the run id. The scripted child answers on the workflow's own prompt so a
      // recorded answer stays comparable across runs.
      const prompt = workflowPrompt(request.task);
      executedPrompts.push(prompt);
      const text = options.answer === undefined ? `answer(${prompt})` : options.answer(prompt);
      return {
        status: "completed" as const,
        agentName: request.agent?.name ?? "sub-agent",
        reason: "answered",
        text,
        diagnostics: [],
        lifecycleEntryIds: [],
      };
    },
  });
  const res = await runWorkflowScript({
    pi: harness.pi,
    ctx: harness.ctx,
    signal: new AbortController().signal,
    name,
    createExecutor,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}),
    ...(options.resumeFromRunId !== undefined ? { resumeFromRunId: options.resumeFromRunId } : {}),
  });
  expect(res.replay, "every run that reached its script identity reports a replay envelope").toBeDefined();
  return {
    runId: res.runId,
    runDir: res.runDir,
    ok: res.ok,
    result: res.result,
    ...(res.error !== undefined ? { error: res.error } : {}),
    replay: res.replay!,
    executedPrompts,
    journal: res.journal,
    raw: res,
  };
}

const THREE_STAGE_WORKFLOW = `export const meta = { name: "stages", description: "three sequential stages" };
export default async function runWorkflow(dsl, input) {
  const one = await dsl.agent("stage-1");
  const two = await dsl.agent("stage-2 " + String(input ?? ""));
  const three = await dsl.agent("stage-3");
  return { summary: [one, two, three].join(" | ") };
}
`;

/**
 * Three labeled stages, so a repair between two runs can name the node it
 * repaired. `bPrompt` is the only thing an edit changes, which is what makes the
 * middle node the repaired one and A the completed prefix.
 */
function labeledThreeStageWorkflow(bPrompt: string): string {
  return `export const meta = { name: "labeled", description: "three labeled stages" };
export default async function runWorkflow(dsl) {
  const a = await dsl.agent("stage-a", { label: "node-a" });
  const b = await dsl.agent(${JSON.stringify(bPrompt)}, { label: "node-b" });
  const c = await dsl.agent("stage-c", { label: "node-c" });
  return { summary: [a, b, c].join(" | ") };
}
`;
}

/** The name the runtime writes and compares: `[phase, label, occurrence]`. */
function nodeName(label: string, occurrence = 0, phase: string | null = null): string {
  return JSON.stringify([phase, label, occurrence]);
}

/**
 * The scripted child echoes its prompt, so the JSON it must return is fenced
 * inside the prompt — the runtime reads the first fence, ahead of the schema
 * block it appends.
 */
const SHAPED_WORKFLOW = `export const meta = { name: "shaped", description: "one shaped stage" };
const FENCE = "\\u0060\\u0060\\u0060";
const COUNT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["count"],
  properties: { count: { type: "integer" } },
};
export default async function runWorkflow(dsl) {
  const prompt = ["answer with:", FENCE + "json", '{"count":3}', FENCE].join("\\n");
  return await dsl.agent(prompt, { schema: COUNT_SCHEMA });
}
`;

/**
 * The same shaped stage plus a script validator whose verdict comes from the run
 * INPUT, not from the script bytes. That is what makes a rejected replay reachable
 * at all: the entry file is byte-identical between the two runs, so the resume is
 * not refused, and the prompt is input-independent, so the recorded key still hits.
 */
const VALIDATED_WORKFLOW = `export const meta = { name: "validated", description: "one shaped stage with a script validator" };
const FENCE = "\\u0060\\u0060\\u0060";
const COUNT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["count"],
  properties: { count: { type: "integer" } },
};
export default async function runWorkflow(dsl, input) {
  const prompt = ["answer with:", FENCE + "json", '{"count":3}', FENCE].join("\\n");
  const expected = Number(input ?? "3");
  let value = null;
  let rejected = "";
  try {
    value = await dsl.agent(prompt, {
      schema: COUNT_SCHEMA,
      validate: (answer) =>
        answer.count === expected ? [] : ["count: expected " + String(expected) + ", got " + String(answer.count)],
    });
  } catch (error) {
    rejected = String(error.message);
  }
  const tail = await dsl.agent("tail");
  return { value, rejected, tail };
}
`;

/**
 * One exact-choice step followed by a summary — the shape of a generated
 * implement-plan.workflow.mjs. The scripted child answers the step with the bare
 * word `completed`, the answer gpt-5.6-luna gave in run 20260822-194520-6c07.
 */
const ROUTED_WORKFLOW = `export const meta = { name: "routed", description: "one exact-choice step then a summary" };
export default async function runWorkflow(dsl) {
  const status = await dsl.agent("step: return exactly completed", { choice: ["completed", "blocked"] });
  if (status === "blocked") throw new Error("step is blocked");
  const summary = await dsl.agent("summary");
  return { status, summary };
}
`;

const UNSUPPORTED_SCHEMA_WORKFLOW = `export const meta = { name: "unsupported", description: "declares an ignored keyword" };
export default async function runWorkflow(dsl) {
  return await dsl.agent("shape me", { schema: { type: "number", minimum: 3 } });
}
`;

describe("workflow --resume replays recorded agent calls", () => {
  it("documents every closed replay refusal reason in the manual and manifest", () => {
    const manual = readFileSync(path.resolve("extensions/workflows/REFERENCE.md"), "utf8");
    const manifest = readFileSync(path.resolve("extensions/workflows/manifest.json"), "utf8");
    for (const reason of Object.keys(REPLAY_REFUSAL_REASONS) as WorkflowReplayRefusalReason[]) {
      expect(manual).toContain(`\`${reason}\``);
      expect(manifest).toContain(reason);
    }
  });
  it("projects an unreadable persisted result envelope as unknown", () => {
    const root = temporaryProject();
    const runDir = path.join(root, ".locus-pi", "runs", "corrupt-result");
    ensureWorkflowRunDir(root, "corrupt-result");
    writeFileSync(workflowResultFile(runDir), "{not-json", "utf8");

    expect(readWorkflowRunSummary(root, "corrupt-result").status).toBe("unknown");
  });

  it("reuses every recorded result when script, input and call order are unchanged", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "stages", THREE_STAGE_WORKFLOW);

    const first = await runWorkflow(root, "stages", { input: "alpha" });
    expect(first.ok).toBe(true);
    expect(first.executedPrompts).toEqual(["stage-1", "stage-2 alpha", "stage-3"]);
    expect(first.replay).toMatchObject({ replayed: false, recorded: true, replayedCalls: 0, freshCalls: 3 });

    const resumed = await runWorkflow(root, "stages", { input: "alpha", resumeFromRunId: first.runId });

    // The point of the feature: a full rerun that spawns no child at all.
    expect(resumed.executedPrompts).toEqual([]);
    expect(resumed.ok).toBe(true);
    expect(resumed.result).toEqual(first.result);
    expect(resumed.replay).toMatchObject({
      replayed: true,
      recorded: true,
      sourceRunId: first.runId,
      replayedCalls: 3,
      freshCalls: 0,
    });
    expect(resumed.replay.divergedAtCall).toBeUndefined();

    // The resumed run writes its own complete record, so resuming a resume works.
    const chained = readWorkflowReplayLog(root, resumed.runId).filter((entry) => entry.kind === "agent");
    expect(chained).toHaveLength(3);
  });

  it("keeps mapped live occurrences out of the base replay node identity", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "mapped-replay",
      `export const meta = { name: "mapped-replay", description: "three mapped calls from one callsite" };
export default async function runWorkflow(dsl) {
  const values = ["one", "two", "three"];
  const answers = await dsl.parallel(values.map((value) => () =>
    dsl.agent("classify " + value, { label: "classify-candidate", phase: "classify" })
  ));
  return { summary: answers.join(" | ") };
}
`,
    );

    const first = await runWorkflow(root, "mapped-replay");
    expect(first.ok).toBe(true);
    expect(first.executedPrompts).toEqual(["classify one", "classify two", "classify three"]);
    expect(
      readWorkflowReplayLog(root, first.runId)
        .filter((entry) => entry.kind === "agent")
        .map((entry) => (entry as { node?: string }).node),
    ).toEqual([
      nodeName("classify-candidate", 0, "classify"),
      nodeName("classify-candidate", 1, "classify"),
      nodeName("classify-candidate", 2, "classify"),
    ]);

    const resumed = await runWorkflow(root, "mapped-replay", { resumeFromRunId: first.runId });
    expect(resumed.ok).toBe(true);
    expect(resumed.executedPrompts).toEqual([]);
    expect(resumed.result).toEqual(first.result);
    expect(resumed.replay).toMatchObject({ replayed: true, replayedCalls: 3, freshCalls: 0 });
  });

  it("replays a schema-bearing call, and refuses an unsupported declaration before touching the record", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "shaped", SHAPED_WORKFLOW);

    const first = await runWorkflow(root, "shaped");
    expect(first.ok).toBe(true);
    expect(first.result).toEqual({ count: 3 });
    expect(first.executedPrompts).toHaveLength(1);

    // The declaration precheck runs before the replay lookup and the canonical key
    // is built from the resolved request, so widening the supported schema subset
    // never invalidates a recording made under the narrower one.
    const resumed = await runWorkflow(root, "shaped", { resumeFromRunId: first.runId });
    expect(resumed.executedPrompts).toEqual([]);
    expect(resumed.result).toEqual({ count: 3 });
    expect(resumed.replay).toMatchObject({ replayed: true, replayedCalls: 1, freshCalls: 0 });

    // An unsupported declaration fails ahead of both the child and the record:
    // the resumed run consumes no entry and spends no attempt.
    writeWorkflow(root, "unsupported", UNSUPPORTED_SCHEMA_WORKFLOW);
    const rejected = await runWorkflow(root, "unsupported");
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/unsupported keyword "minimum"/u);
    expect(rejected.executedPrompts).toEqual([]);
    expect(readWorkflowReplayLog(root, rejected.runId).filter((entry) => entry.kind === "agent")).toHaveLength(0);
  });

  it("resumes a run that failed after an exact-choice step answered with the bare word, re-running only the rest", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "routed", ROUTED_WORKFLOW);
    const stepAnswer = (prompt: string) => (prompt.startsWith("step:") ? "completed" : undefined);

    // The step completes and answers with the bare word; the summary child then fails, so
    // the run ends failed with the step's answer on record — the run an operator wants to
    // resume rather than redo.
    const first = await runWorkflow(root, "routed", {
      answer: (prompt) => {
        const step = stepAnswer(prompt);
        if (step !== undefined) return step;
        throw new Error("summary child lost its session");
      },
    });
    expect(first.ok).toBe(false);
    expect(first.executedPrompts.map((prompt) => prompt.split("\n")[0])).toEqual([
      "step: return exactly completed",
      "summary",
    ]);
    const stepEnd = first.journal.find((line) => line.kind === "agent_end" && line.schemaValidation !== undefined);
    expect(stepEnd?.schemaValidation).toEqual({ status: "valid", attempts: 1, errors: [], coercion: "bare-text" });
    // The persisted line round-trips through the file reader that feeds /workflows status.
    const persistedStepEnd = readWorkflowRunJournal(root, first.runId).find(
      (line) => line.kind === "agent_end" && line.schemaValidation !== undefined,
    );
    expect(persistedStepEnd?.schemaValidation).toEqual(stepEnd?.schemaValidation);

    const resumed = await runWorkflow(root, "routed", {
      resumeFromRunId: first.runId,
      answer: (prompt) => stepAnswer(prompt) ?? `answer(${prompt})`,
    });

    // The step is served from the record and read the same way; only the summary runs.
    expect(resumed.ok).toBe(true);
    expect(resumed.executedPrompts).toEqual(["summary"]);
    expect(resumed.result).toEqual({ status: "completed", summary: "answer(summary)" });
    expect(resumed.replay).toMatchObject({ replayed: true, replayedCalls: 1, freshCalls: 1 });
    const replayedStep = resumed.journal.find(
      (line) => line.kind === "agent_end" && line.schemaValidation !== undefined,
    );
    expect(replayedStep?.replayed).toBe(true);
    expect(replayedStep?.schemaValidation).toEqual({ status: "valid", attempts: 1, errors: [], coercion: "bare-text" });
  });

  it("re-applies the current script validator to a replayed answer", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "validated", VALIDATED_WORKFLOW);

    const first = await runWorkflow(root, "validated", { input: "3" });
    expect(first.ok).toBe(true);
    expect(first.result).toMatchObject({ value: { count: 3 }, rejected: "" });

    const resumed = await runWorkflow(root, "validated", { input: "3", resumeFromRunId: first.runId });
    expect(resumed.executedPrompts).toEqual([]);
    expect(resumed.result).toEqual(first.result);
    expect(resumed.replay).toMatchObject({ replayed: true, replayedCalls: 2, freshCalls: 0 });

    // A replayed attempt occupies an ordinal and increments `attempts`, and it
    // contributes no `usage` — a replayed call cost nothing and must not inflate
    // the run budget.
    const shapedEnd = resumed.journal.find((line) => line.kind === "agent_end" && line.schemaValidation !== undefined);
    expect(shapedEnd?.replayed).toBe(true);
    expect(shapedEnd?.schemaValidation).toEqual({ status: "valid", attempts: 1, errors: [] });
    expect(shapedEnd?.usage).toBeUndefined();
  });

  it("fails the run closed when the current validator rejects a replayed answer, without diverging", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "validated", VALIDATED_WORKFLOW);
    const first = await runWorkflow(root, "validated", { input: "3" });

    // Same script bytes, same prompt, different validator verdict. Re-asking here
    // would form an attempt-2 prompt whose key misses at that ordinal, trip the
    // one-way divergence latch and silently convert the operator's resume into a
    // full live run. Failing closed keeps the loss local and loud.
    const resumed = await runWorkflow(root, "validated", { input: "4", resumeFromRunId: first.runId });

    expect(resumed.executedPrompts).toEqual([]);
    expect(resumed.result).toMatchObject({
      value: null,
      rejected: "Replayed agent answer was rejected by the workflow script: count: expected 4, got 3",
    });
    const failed = resumed.journal.filter((line) => line.kind === "agent_end" && line.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.schemaValidation).toMatchObject({ status: "mismatch", source: "script" });
    // No divergence: the later call in the same run still replays.
    expect(resumed.replay).toMatchObject({ replayed: true, replayedCalls: 2, freshCalls: 0 });
    expect(resumed.replay.divergedAtCall).toBeUndefined();
  });

  it("invalidates an edited call AND every later call, even when the later prompts are unchanged", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "stages", THREE_STAGE_WORKFLOW);

    const first = await runWorkflow(root, "stages", { input: "alpha" });
    const resumed = await runWorkflow(root, "stages", { input: "beta", resumeFromRunId: first.runId });

    // stage-1 is byte-identical and replays. stage-2 changed. stage-3's prompt is
    // ALSO byte-identical, and it still re-runs: its recorded answer came after a
    // stage-2 answer that no longer exists.
    expect(resumed.executedPrompts).toEqual(["stage-2 beta", "stage-3"]);
    expect(resumed.replay).toMatchObject({
      replayed: true,
      replayedCalls: 1,
      freshCalls: 2,
      divergedAtCall: 1,
    });
    expect(resumed.result).toMatchObject({
      summary: "answer(stage-1) | answer(stage-2 beta) | answer(stage-3)",
    });
  });

  it("continues a repaired workflow from the stop point instead of refusing the changed bytes", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "labeled", labeledThreeStageWorkflow("stage-b"));
    const first = await runWorkflow(root, "labeled");
    expect(first.executedPrompts).toEqual(["stage-a", "stage-b", "stage-c"]);

    // The repair: only node B's prompt changes. This is the whole feature — the
    // operator edits the stopped workflow in place and continues the same run id.
    writeWorkflow(root, "labeled", labeledThreeStageWorkflow("stage-b repaired"));
    const resumed = await runWorkflow(root, "labeled", { resumeFromRunId: first.runId });

    // The load-bearing assertion is about REUSE, not freshness: `freshCalls: 2`
    // alone is equally true of a full restart. A never reaches a child again.
    expect(resumed.executedPrompts).toEqual(["stage-b repaired", "stage-c"]);
    expect(resumed.executedPrompts).not.toContain("stage-a");
    expect(resumed.replay).toMatchObject({
      replayed: true,
      replayedCalls: 1,
      freshCalls: 2,
      divergedAtCall: 1,
      divergedAtNode: nodeName("node-b"),
    });
    expect(resumed.replay.refusedReason).toBeUndefined();
    expect(resumed.result).toMatchObject({
      summary: "answer(stage-a) | answer(stage-b repaired) | answer(stage-c)",
    });
  });

  it("still reaches zero reuse when the repair also edits the earlier node", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "labeled", labeledThreeStageWorkflow("stage-b"));
    const first = await runWorkflow(root, "labeled");

    // The distinguishing negative. Without it the positive test above proves
    // nothing: a counter that can only ever report reuse would pass it too.
    writeWorkflow(
      root,
      "labeled",
      labeledThreeStageWorkflow("stage-b repaired").replace('"stage-a"', '"stage-a repaired"'),
    );
    const resumed = await runWorkflow(root, "labeled", { resumeFromRunId: first.runId });

    expect(resumed.executedPrompts).toEqual(["stage-a repaired", "stage-b repaired", "stage-c"]);
    expect(resumed.replay).toMatchObject({
      replayedCalls: 0,
      freshCalls: 3,
      divergedAtCall: 0,
      divergedAtNode: nodeName("node-a"),
    });
  });

  it("compares the recorded node name before the request key when the source changed", () => {
    // A SYNTHETIC unit on hand-written entries, and only that: it fixes the order
    // of the controller's checks. The runtime cannot produce this input, because
    // the canonical key already carries `phase` and `label`, so two different
    // names always hash to two different keys. It is not evidence against any
    // reachable answer substitution — that one is closed by the unique-label rule.
    const root = temporaryProject();
    const sourceRunId = "20260812-020202-a001";
    const source = createWorkflowReplayController({ runDir: ensureWorkflowRunDir(root, sourceRunId) });
    source.recordAgentAttempt(
      { node: nodeName("recorded"), canonicalRequest: "recorded-request" },
      {
        ok: true,
        text: "recorded answer",
      },
    );

    const resumed = createWorkflowReplayController({
      runDir: ensureWorkflowRunDir(root, "20260812-020202-a002"),
      recorded: readWorkflowReplayLog(root, sourceRunId),
      sourceScriptChanged: true,
    });

    // Both the name and the key differ; the reported reason names the node.
    expect(
      resumed.beginAgentAttempt({ node: nodeName("current"), canonicalRequest: "other-request", replayable: true }),
    ).toEqual({ replayed: false, reason: "node-mismatch" });
  });

  it("latches divergence after a recorded failure so the tail cannot replay a stale world", () => {
    const root = temporaryProject();
    const sourceRunId = "20260812-010101-f001";
    const source = createWorkflowReplayController({ runDir: ensureWorkflowRunDir(root, sourceRunId) });
    source.recordAgentAttempt({ canonicalRequest: "call-0" }, { ok: true, text: "recorded answer" });
    source.recordAgentAttempt({ canonicalRequest: "call-1" }, { ok: false });
    source.recordAgentAttempt({ canonicalRequest: "call-2" }, { ok: true, text: "later answer" });

    const resumed = createWorkflowReplayController({
      runDir: ensureWorkflowRunDir(root, "20260812-010101-f002"),
      recorded: readWorkflowReplayLog(root, sourceRunId),
    });

    // A recorded failure is never served back as an answer: it is named and re-run.
    expect(resumed.beginAgentAttempt({ canonicalRequest: "call-0", replayable: true })).toEqual({
      replayed: true,
      text: "recorded answer",
    });
    expect(resumed.beginAgentAttempt({ canonicalRequest: "call-1", replayable: true })).toEqual({
      replayed: false,
      reason: "recorded-failure",
    });
    // And re-running it changed the world, so the answer recorded AFTER it came
    // from a run where that node behaved differently. Serving it would be a
    // silent lie, so the latch holds for the rest of the run.
    expect(resumed.beginAgentAttempt({ canonicalRequest: "call-2", replayable: true })).toEqual({
      replayed: false,
      reason: "diverged",
    });
    expect(resumed.counts()).toEqual({ replayedCalls: 1, freshCalls: 2, divergedAtCall: 1 });
  });

  it("latches divergence after a side-effecting call, which no longer replays its tail", () => {
    const root = temporaryProject();
    const sourceRunId = "20260812-030303-s001";
    const source = createWorkflowReplayController({ runDir: ensureWorkflowRunDir(root, sourceRunId) });
    source.recordAgentAttempt({ canonicalRequest: "call-0" }, { ok: true, text: "first answer" });
    source.recordAgentAttempt({ canonicalRequest: "call-1" }, { ok: true, text: "worktree answer" });
    source.recordAgentAttempt({ canonicalRequest: "call-2" }, { ok: true, text: "later answer" });

    const resumed = createWorkflowReplayController({
      runDir: ensureWorkflowRunDir(root, "20260812-030303-s002"),
      recorded: readWorkflowReplayLog(root, sourceRunId),
    });

    expect(resumed.beginAgentAttempt({ canonicalRequest: "call-0", replayable: true })).toEqual({
      replayed: true,
      text: "first answer",
    });
    // A worktree call runs for real, so the filesystem this run observes is not
    // the one the later recorded answers describe. This narrows what a resume
    // reuses, deliberately: the name was previously covered by no test at all.
    expect(resumed.beginAgentAttempt({ canonicalRequest: "call-1", replayable: false })).toEqual({
      replayed: false,
      reason: "side-effecting-call",
    });
    expect(resumed.beginAgentAttempt({ canonicalRequest: "call-2", replayable: true })).toEqual({
      replayed: false,
      reason: "diverged",
    });
    expect(resumed.counts()).toEqual({ replayedCalls: 1, freshCalls: 2, divergedAtCall: 1 });
  });

  it("keeps a record written before node names replayable on identical bytes only", async () => {
    const root = temporaryProject();
    const unnamed = `export const meta = { name: "legacy", description: "two unnamed stages" };
export default async function runWorkflow(dsl) {
  const a = await dsl.agent("stage-a");
  const b = await dsl.agent("stage-b");
  return { summary: [a, b].join(" | ") };
}
`;
    writeWorkflow(root, "legacy", unnamed);
    const first = await runWorkflow(root, "legacy");
    expect(readWorkflowReplayLog(root, first.runId).every((entry) => !("node" in entry))).toBe(true);

    // Unchanged bytes: the position is still a legitimate name, so the old record
    // replays exactly as it always did.
    const identical = await runWorkflow(root, "legacy", { resumeFromRunId: first.runId });
    expect(identical.executedPrompts).toEqual([]);
    expect(identical.replay).toMatchObject({ replayedCalls: 2, freshCalls: 0 });

    // Repaired bytes: the record cannot say which node it holds, and the current
    // call has a name it cannot match. Fail closed on the first call, run fresh.
    writeWorkflow(
      root,
      "legacy",
      unnamed.replace(/dsl\.agent\("stage-(a|b)"\)/gu, 'dsl.agent("stage-$1", { label: "node-$1" })'),
    );
    const repaired = await runWorkflow(root, "legacy", { resumeFromRunId: first.runId });
    expect(repaired.executedPrompts).toEqual(["stage-a", "stage-b"]);
    expect(repaired.replay).toMatchObject({
      replayedCalls: 0,
      freshCalls: 2,
      divergedAtCall: 0,
      divergedAtNode: nodeName("node-a"),
    });
  });

  it("names the current first fresh call in divergedAtNode, and omits it when that call is unnamed", async () => {
    const root = temporaryProject();
    const oneNode = `export const meta = { name: "grow", description: "one labeled stage" };
export default async function runWorkflow(dsl) {
  return await dsl.agent("stage-a", { label: "node-a" });
}
`;
    writeWorkflow(root, "grow", oneNode);
    const first = await runWorkflow(root, "grow");

    // The repair appends a node. Its miss is `no-record`, where no recorded name
    // exists at all — so the field can only come from the CURRENT call.
    writeWorkflow(
      root,
      "grow",
      oneNode.replace(
        'return await dsl.agent("stage-a", { label: "node-a" });',
        'await dsl.agent("stage-a", { label: "node-a" });\n  return await dsl.agent("stage-b", { label: "node-b" });',
      ),
    );
    const named = await runWorkflow(root, "grow", { resumeFromRunId: first.runId });
    expect(named.executedPrompts).toEqual(["stage-b"]);
    expect(named.replay).toMatchObject({ replayedCalls: 1, divergedAtNode: nodeName("node-b") });

    // Same shape, but the appended call carries no label: there is no name to
    // report, and the field is absent rather than invented.
    writeWorkflow(
      root,
      "grow",
      oneNode.replace(
        'return await dsl.agent("stage-a", { label: "node-a" });',
        'await dsl.agent("stage-a", { label: "node-a" });\n  return await dsl.agent("stage-b");',
      ),
    );
    const unnamedTail = await runWorkflow(root, "grow", { resumeFromRunId: first.runId });
    expect(unnamedTail.executedPrompts).toEqual(["stage-b"]);
    expect(unnamedTail.replay).toMatchObject({ replayedCalls: 1, divergedAtCall: 1 });
    expect(unnamedTail.replay.divergedAtNode).toBeUndefined();
  });

  it("reads the completed prefix back from the record by node name alone", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "labeled", labeledThreeStageWorkflow("stage-b"));
    const first = await runWorkflow(root, "labeled");

    // This is what the field is stored FOR. The operator asks "which nodes
    // finished" and answers it from the record, without the workflow source and
    // without inverting a request hash.
    const completed = readWorkflowReplayLog(root, first.runId)
      .filter((entry) => entry.kind === "agent")
      .map((entry) => (entry as { node?: string }).node);
    expect(completed).toEqual([nodeName("node-a"), nodeName("node-b"), nodeName("node-c")]);
  });

  it("serves a deleted duplicate-label call's answer to its twin — the accepted residual", async () => {
    const root = temporaryProject();
    let answered = 0;
    const distinctAnswers = () => `answer-${String((answered += 1))}`;
    const twins = `export const meta = { name: "twins", description: "two call sites sharing one label" };
export default async function runWorkflow(dsl) {
  const first = await dsl.agent("same prompt", { label: "dup" });
  const second = await dsl.agent("same prompt", { label: "dup" });
  return { summary: [first, second].join(" | ") };
}
`;
    writeWorkflow(root, "twins", twins);
    const source = await runWorkflow(root, "twins", { answer: distinctAnswers });
    expect(source.result).toMatchObject({ summary: "answer-1 | answer-2" });

    // Delete the FIRST site. The survivor slides onto occurrence 0, so its name
    // and its key both match the deleted call's entry, and it is handed an answer
    // that belonged to a different call site. The recorded name does not catch
    // this; nothing in the runtime can. The strict source checker rejects such a
    // source before it runs, which is where this class is actually closed.
    writeWorkflow(
      root,
      "twins",
      twins.replace('  const first = await dsl.agent("same prompt", { label: "dup" });\n', "  const first = null;\n"),
    );
    const resumed = await runWorkflow(root, "twins", { resumeFromRunId: source.runId, answer: distinctAnswers });

    expect(resumed.executedPrompts).toEqual([]);
    expect(resumed.result).toMatchObject({ summary: " | answer-1" });
    expect(resumed.replay).toMatchObject({ replayedCalls: 1 });
  });

  it("refuses to replay identical bytes when the persisted target changed", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "alpha", THREE_STAGE_WORKFLOW);
    writeWorkflow(root, "beta", THREE_STAGE_WORKFLOW);
    const first = await runWorkflow(root, "alpha", { outputDir: "same-replay-workspace" });
    const resumed = await runWorkflow(root, "beta", {
      outputDir: "same-replay-workspace",
      resumeFromRunId: first.runId,
    });

    expect(resumed.replay).toMatchObject({
      replayed: false,
      refusedReason: "target-changed",
      replayedCalls: 0,
      freshCalls: 3,
    });
    expect(resumed.executedPrompts).toEqual(["stage-1", "stage-2 ", "stage-3"]);
  });

  it("replays an owner workflow across equivalent and confined symlink target spellings", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "post-code-review", THREE_STAGE_WORKFLOW);
    symlinkSync(
      path.join(root, ".locus-pi", "workflows", "post-code-review.workflow.mjs"),
      path.join(root, "post-code-review-alias.workflow.mjs"),
    );
    const firstHarness = createHarness(root, { sessionId: "replay-owner-alias-first" });
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      scriptPath: "post-code-review-alias.workflow.mjs",
      outputDir: "post-code-review-alias",
      createExecutor: () => ({
        async run(request: AgentRunRequest) {
          return {
            status: "completed" as const,
            agentName: request.agent?.name ?? "sub-agent",
            reason: "answered",
            text: `answer(${workflowPrompt(request.task)})`,
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      }),
    });
    expect(first.ok).toBe(true);

    const secondHarness = createHarness(root, { sessionId: "replay-owner-alias-second" });
    const resumed = await runWorkflowScript({
      pi: secondHarness.pi,
      ctx: secondHarness.ctx,
      signal: new AbortController().signal,
      scriptPath: ".locus-pi/workflows/post-code-review.workflow.mjs",
      outputDir: "post-code-review-alias",
      resumeFromRunId: first.runId,
      createExecutor: () => ({
        async run() {
          throw new Error("owner replay should not execute fresh children");
        },
      }),
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.replay).toMatchObject({ replayed: true, replayedCalls: 3, freshCalls: 0 });
  });

  it.each(["mismatch", "absent", "malformed"] as const)(
    "fails post-code-review exact resume before child execution when source target is %s",
    async (mode) => {
      const root = temporaryProject();
      writeWorkflow(root, "other", THREE_STAGE_WORKFLOW);
      writeWorkflow(root, "post-code-review", THREE_STAGE_WORKFLOW);
      const first = await runWorkflow(root, "other", { outputDir: "post-code-review-resume" });
      if (mode !== "mismatch") {
        const result = JSON.parse(readFileSync(workflowResultFile(first.runDir), "utf8")) as Record<string, unknown>;
        if (mode === "absent") delete result.target;
        else result.target = { kind: "name", ref: "nested/run/extra", source: "project" };
        writeFileSync(workflowResultFile(first.runDir), `${JSON.stringify(result)}\n`, "utf8");
      }

      const harness = createHarness(root, { sessionId: `exact-resume-${mode}` });
      const executedPrompts: string[] = [];
      const resumed = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "post-code-review",
        outputDir: "post-code-review-resume",
        resumeFromRunId: first.runId,
        createExecutor: () => ({
          async run(request: AgentRunRequest) {
            executedPrompts.push(workflowPrompt(request.task));
            return {
              status: "completed" as const,
              agentName: request.agent?.name ?? "sub-agent",
              reason: "must not run",
              text: "unexpected child execution",
              diagnostics: [],
              lifecycleEntryIds: [],
            };
          },
        }),
      });

      expect(resumed.ok).toBe(false);
      expect(resumed.replay).toBeUndefined();
      expect(executedPrompts).toEqual([]);
      expect(resumed.error).toContain(mode === "mismatch" ? "post-code-review" : "malformed persisted metadata");
      expect(resumed.error).toContain(
        mode === "mismatch"
          ? // Ordinary roots now write a launch binding too, so a non-owner source is
            // refused by its recorded ownership rather than by a missing binding.
            "ownership differs"
          : mode === "absent"
            ? "script identity is malformed"
            : "target is malformed",
      );
    },
  );

  it("fails the reverse post-code-review owner transition before execution", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "post-code-review", THREE_STAGE_WORKFLOW);
    writeWorkflow(root, "other", THREE_STAGE_WORKFLOW);
    const first = await runWorkflow(root, "post-code-review", { outputDir: "post-code-review-reverse" });
    const harness = createHarness(root, { sessionId: "exact-resume-reverse" });
    const resumed = await runWorkflowScript({
      pi: harness.pi,
      ctx: harness.ctx,
      signal: new AbortController().signal,
      name: "other",
      outputDir: "post-code-review-reverse",
      resumeFromRunId: first.runId,
      createExecutor: () => ({
        async run() {
          throw new Error("child must not run");
        },
      }),
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.replay).toBeUndefined();
    expect(resumed.error).toContain("ownership differs");
  });

  it("refuses to record or replay a script that reads the clock directly", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "unsafe",
      `export const meta = { name: "unsafe", description: "reads the clock directly" };
export default async function runWorkflow(dsl) {
  const started = Date.now();
  const answer = await dsl.agent("stage-1");
  return { summary: answer, elapsed: typeof started };
}
`,
    );

    const first = await runWorkflow(root, "unsafe");
    expect(first.ok).toBe(true);
    expect(first.replay).toMatchObject({ recorded: false, notRecordedReason: "replay-unsafe-script" });
    expect(existsSync(workflowReplayFile(first.runDir))).toBe(false);

    const resumed = await runWorkflow(root, "unsafe", { resumeFromRunId: first.runId });
    expect(resumed.replay).toMatchObject({ replayed: false, refusedReason: "replay-unsafe-script" });
    expect(resumed.executedPrompts).toEqual(["stage-1"]);
  });

  // Replay refusal reasons remain a fresh-run contract only when source identity
  // is readable. A source result without workspace identity cannot be resumed:
  // the runtime must fail before it can safely choose a workspace.
  it("fails when the recorded run lost its persisted workspace identity", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "stages", THREE_STAGE_WORKFLOW);
    const first = await runWorkflow(root, "stages", { input: "alpha" });

    // The run id still resolves (journal.ndjson survives), so this is reached
    // rather than the hard "source run not found" error raised earlier.
    rmSync(workflowResultFile(first.runDir));
    const resumedHarness = createHarness(root, { sessionId: "replay-missing-workspace" });
    const resumed = await runWorkflowScript({
      pi: resumedHarness.pi,
      ctx: resumedHarness.ctx,
      signal: new AbortController().signal,
      name: "stages",
      input: "alpha",
      resumeFromRunId: first.runId,
      createExecutor: () => ({
        async run() {
          throw new Error("child must not run");
        },
      }),
    });

    expect(resumed.ok).toBe(false);
    expect(resumed.replay).toBeUndefined();
    expect(resumed.error).toContain("has no persisted workspace identity");
  });

  it("refuses with identity-coverage-unproven for an entry-only script, and records nothing", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "modular",
      `export const meta = { name: "modular", description: "declares entry-only coverage", identityCoverage: "entry-only" };
export default async function runWorkflow(dsl) {
  return { summary: await dsl.agent("stage-1") };
}
`,
    );

    // Imported bytes are outside the entry hash, so a matching scriptSha256
    // would not prove the call sequence is the same. Fail closed at record time.
    const first = await runWorkflow(root, "modular");
    expect(first.ok).toBe(true);
    expect(first.replay).toMatchObject({ recorded: false, notRecordedReason: "identity-coverage-unproven" });
    expect(existsSync(workflowReplayFile(first.runDir))).toBe(false);

    const resumed = await runWorkflow(root, "modular", { resumeFromRunId: first.runId });
    expect(resumed.ok).toBe(true);
    expect(resumed.replay).toMatchObject({ replayed: false, refusedReason: "identity-coverage-unproven" });
    expect(resumed.executedPrompts).toEqual(["stage-1"]);
  });

  it("refuses with no-recorded-calls when a replay-safe run had nothing to record", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "inert",
      `export const meta = { name: "inert", description: "replay-safe with no calls" };
export default async function runWorkflow(dsl, input) {
  return { summary: "no agents here: " + String(input ?? "") };
}
`,
    );

    const first = await runWorkflow(root, "inert");
    expect(first.ok).toBe(true);

    const resumed = await runWorkflow(root, "inert", { resumeFromRunId: first.runId });
    expect(resumed.ok).toBe(true);
    expect(resumed.replay).toMatchObject({ replayed: false, refusedReason: "no-recorded-calls", replayedCalls: 0 });
    expect(resumed.executedPrompts).toEqual([]);
  });

  it("claims a fresh run id when an immediate resume mints a colliding id in the same second", async () => {
    // Regression: a run id is a second-resolution timestamp plus a 16-bit random
    // suffix, so a resume starting in the same second as the run it resumes can
    // mint the SAME id and die with EEXIST on the already-claimed journal. Freeze
    // the clock and script the suffix draws so the collision is forced; the
    // runner must claim the next fresh id instead of throwing.
    const root = temporaryProject();
    writeWorkflow(
      root,
      "inert",
      `export const meta = { name: "inert", description: "replay-safe with no calls" };
export default async function runWorkflow(dsl, input) {
  return { summary: "no agents here: " + String(input ?? "") };
}
`,
    );
    vi.useFakeTimers({ now: new Date("2026-08-23T00:02:30.453Z"), toFake: ["Date"] });
    let draws = 0;
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      draws += 1;
      // Both runs mint the same suffix; every later draw is distinct.
      return draws <= 2 ? 0x4560 / 0x10000 : (0x4560 + draws - 2) / 0x10000;
    });
    try {
      const first = await runWorkflow(root, "inert");
      expect(first.ok).toBe(true);
      expect(first.runId).toBe("20260823-000230-4560");

      const resumed = await runWorkflow(root, "inert", { resumeFromRunId: first.runId });
      expect(resumed.ok).toBe(true);
      // The retried claim, not an EEXIST crash: same frozen second, next suffix.
      expect(resumed.runId).toBe("20260823-000230-4561");
      expect(resumed.replay).toMatchObject({ replayed: false, refusedReason: "no-recorded-calls" });
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it("gives two stages on two tiers two distinct records", async () => {
    // The defect this guards: `modelRole` missing from the canonical request would
    // make these two calls "the same call", and a `slow` stage could be served an
    // answer a `smol` stage produced.
    const root = temporaryProject();
    writeWorkflow(
      root,
      "tiers",
      `export const meta = { name: "tiers", description: "one prompt on two tiers" };
export default async function runWorkflow(dsl) {
  const cheap = await dsl.agent("identical prompt", { modelRole: "smol" });
  const strong = await dsl.agent("identical prompt", { modelRole: "slow" });
  return { cheap, strong };
}
`,
    );

    const run = await runWorkflow(root, "tiers");
    expect(run.ok).toBe(true);

    const keys = readWorkflowReplayLog(root, run.runId)
      .filter((entry) => entry.kind === "agent")
      .map((entry) => entry.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("still treats two untiered calls with one prompt as the same call", async () => {
    // The control for the case above: without `modelRole` the two calls really are
    // identical, so the differing keys there come from the tier and nothing else.
    const root = temporaryProject();
    writeWorkflow(
      root,
      "untiered",
      `export const meta = { name: "untiered", description: "one prompt twice" };
export default async function runWorkflow(dsl) {
  const a = await dsl.agent("identical prompt");
  const b = await dsl.agent("identical prompt");
  return { a, b };
}
`,
    );

    const run = await runWorkflow(root, "untiered");

    const keys = readWorkflowReplayLog(root, run.runId)
      .filter((entry) => entry.kind === "agent")
      .map((entry) => entry.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("replays a pre-strict ordinary record without changing its canonical key", async () => {
    const root = temporaryProject();
    const runDir = ensureWorkflowRunDir(root, "20260829-010101-b003");
    const prompt = "ordinary stage";
    // Exact canonical bytes written before `requireModelRole` existed. A false/null
    // placeholder for the new opt-in flag would change this hash and invalidate every
    // ordinary record even though those calls retain their original fallback behavior.
    const legacyCanonicalRequest = JSON.stringify({
      prompt,
      executionMode: "bare",
      maxToolCalls: DEFAULT_WORKFLOW_BUDGET.toolCalls,
      model: null,
      modelRole: null,
      timeoutMs: null,
      maxTurns: null,
      label: null,
      phase: null,
      sandbox: null,
      permissionMode: "inherit-parent",
      workspaceMode: "project",
      workspaceHandle: null,
      capabilityMode: null,
      operatorAsk: null,
    });
    const recorded: WorkflowReplayEntry[] = [
      {
        v: WORKFLOW_REPLAY_SCHEMA_VERSION,
        seq: 0,
        kind: "agent",
        key: createHash("sha256").update(legacyCanonicalRequest, "utf8").digest("hex"),
        ok: true,
        text: "legacy ordinary answer",
      },
    ];
    const replay = createWorkflowReplayController({ runDir, recorded });
    const executedPrompts: string[] = [];
    const runtime = createWorkflowRuntime({
      runId: "ordinary-resume",
      replay,
      agentRunner: async (request) => {
        executedPrompts.push(request.prompt);
        return {
          ok: true as const,
          status: "completed" as const,
          summary: "fresh",
          text: "fresh answer",
          diagnostics: [],
          agent: request.agent,
        };
      },
    });

    await expect(runtime.dsl.agent(prompt)).resolves.toBe("legacy ordinary answer");
    expect(executedPrompts).toEqual([]);
    expect(replay.counts()).toEqual({ replayedCalls: 1, freshCalls: 0 });
  });

  it("refuses a pre-tier record with no-recorded-calls rather than key-mismatch", async () => {
    // Adding `modelRole` to the canonical request changed every sha256 key. Under the
    // old schema version the operator would be told `key-mismatch`, which everywhere
    // else means "your script changed" — a true-sounding lie. Dropping v1 lines makes
    // the log read as empty, and the reason the operator gets is the true one.
    const root = temporaryProject();
    writeWorkflow(root, "stages", THREE_STAGE_WORKFLOW);

    const first = await runWorkflow(root, "stages", { input: "alpha" });
    expect(first.ok).toBe(true);

    const recordPath = workflowReplayFile(first.runDir);
    const downgraded = readFileSync(recordPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), v: 1 }))
      .join("\n");
    writeFileSync(recordPath, `${downgraded}\n`, "utf8");

    const resumed = await runWorkflow(root, "stages", { input: "alpha", resumeFromRunId: first.runId });
    expect(resumed.replay).toMatchObject({ replayed: false, refusedReason: "no-recorded-calls", replayedCalls: 0 });
    expect(resumed.replay.refusedReason).not.toBe("key-mismatch");
    // Fail-closed either way: nothing was served from the unreadable record.
    expect(resumed.executedPrompts).toHaveLength(3);
  });

  it("reuses a record after the roles table is remapped — the stated residual", async () => {
    // KNOWN BEHAVIOUR, asserted so it cannot drift into a surprise. The canonical
    // request is built in the runtime (`canonicalAgentRequest`) before the bridge
    // consults the roles table, so the key identifies the tier a stage DECLARED, not
    // the model that produced the answer. Remap `smol` and the stale answer is served
    // under an unchanged key. Closing this means moving model resolution out of the
    // bridge and into the runtime; until then, a roles-table change invalidates
    // recorded runs BY HAND, and AUTHORING.md says so.
    const root = temporaryProject();
    writeWorkflow(
      root,
      "remapped",
      `export const meta = { name: "remapped", description: "one tiered stage" };
export default async function runWorkflow(dsl) {
  return { answer: await dsl.agent("tiered stage", { modelRole: "smol" }) };
}
`,
    );

    const first = await runWorkflow(root, "remapped", { roles: { smol: "test/fast" } });
    expect(first.ok).toBe(true);
    expect(first.executedPrompts).toEqual(["tiered stage"]);

    const resumed = await runWorkflow(root, "remapped", {
      resumeFromRunId: first.runId,
      roles: { smol: "test/strong" },
    });

    expect(resumed.replay).toMatchObject({ replayed: true, replayedCalls: 1 });
    expect(resumed.executedPrompts).toEqual([]);
  });

  it("replays dsl.now() and dsl.random() from the record instead of producing new values", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "sampled",
      `export const meta = { name: "sampled", description: "records its own nondeterminism" };
export default async function runWorkflow(dsl) {
  const startedAt = dsl.now();
  const draw = dsl.random();
  const answer = await dsl.agent("stage-1");
  return { summary: answer, startedAt, draw };
}
`,
    );

    const first = await runWorkflow(root, "sampled");
    // Supplying the values through the DSL is what keeps the script replay-safe.
    expect(first.replay.recorded).toBe(true);

    const resumed = await runWorkflow(root, "sampled", { resumeFromRunId: first.runId });
    expect(resumed.result).toEqual(first.result);
    expect(resumed.replay).toMatchObject({ replayed: true, replayedCalls: 1 });
  });

  it("marks a replayed run in the journal, the run summary and /workflows status", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "stages", THREE_STAGE_WORKFLOW);
    const first = await runWorkflow(root, "stages", { input: "alpha" });
    const resumed = await runWorkflow(root, "stages", { input: "alpha", resumeFromRunId: first.runId });

    const replayedEnds = resumed.journal.filter((line) => line.kind === "agent_end" && line.replayed === true);
    expect(replayedEnds).toHaveLength(3);
    // The first run must stay unmarked; the marker is evidence, not decoration.
    expect(first.journal.some((line) => line.replayed === true)).toBe(false);

    expect(readWorkflowRunSummary(root, resumed.runId).agentsReplayed).toBe(3);
    expect(readWorkflowRunSummary(root, first.runId).agentsReplayed).toBe(0);

    const harness = createHarness(root, { sessionId: "replay-status" });
    harness.ctx.hasUI = true;
    delete harness.ctx.ui.custom;
    workflowsExt(harness.pi);
    await harness.commands.get("workflows")!.handler(`status ${resumed.runId}`, harness.ctx);
    const payload = harness.widgetPayloads.get("workflows");
    expect(typeof payload).toBe("function");
    const stubTui = { requestRender: vi.fn(), terminal: { rows: 100, columns: 220 } };
    const rendered = (payload as (tui: typeof stubTui, theme: unknown) => WorkflowTextComponent)(stubTui, {})
      .render(220)
      .join("\n");

    expect(rendered).toContain("3/3 agent call(s) reused a recorded run");
    expect(rendered).toContain("[replayed]");
  });

  it("declares the replay in the bounded digest that reaches LLM context", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "stages", THREE_STAGE_WORKFLOW);
    const first = await runWorkflow(root, "stages", { input: "alpha" });
    const resumed = await runWorkflow(root, "stages", { input: "alpha", resumeFromRunId: first.runId });

    // The digest is the only workflow surface persisted into the model's
    // context, so it is checked against the same journal the run produced.
    expect(digestFor(root, first)).not.toContain("replayed");
    const resumedDigest = digestFor(root, resumed);
    // Every replayed row names the run it came from, so recorded evidence is
    // never read as work this run performed.
    expect(resumedDigest).toContain(`↻ agent sub-agent replayed from run #${first.runId.slice(-4)}`);
    expect(resumedDigest).toContain(`3 replayed from run #${first.runId.slice(-4)}`);
  });

  it("declares the replay in the digest of a run that FAILED after reusing recorded calls", async () => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "stages",
      `export const meta = { name: "stages", description: "two stages then a gate" };
export default async function runWorkflow(dsl, input) {
  const one = await dsl.agent("stage-1");
  const two = await dsl.agent("stage-2");
  if (String(input ?? "") === "boom") throw new Error("gate rejected the reused answers");
  return { summary: [one, two].join(" | ") };
}
`,
    );

    const first = await runWorkflow(root, "stages");
    const resumed = await runWorkflow(root, "stages", { input: "boom", resumeFromRunId: first.runId });

    // The prompts are unchanged, so both calls replay and only the gate is new.
    expect(resumed.ok).toBe(false);
    expect(resumed.executedPrompts).toEqual([]);
    expect(resumed.replay).toMatchObject({ replayed: true, replayedCalls: 2, freshCalls: 0 });

    // A failing run reused recorded evidence just as much as a passing one, and
    // the aggregate must not depend on the per-agent markers surviving the cap.
    const digest = digestFor(root, resumed);
    expect(digest).toContain("✗ workflow stages failed");
    expect(digest).toContain(`2 replayed from run #${first.runId.slice(-4)}`);
    expect(digestFor(root, first)).not.toContain("replayed from");
  });

  it("turns a direct partial:true group result into typed failure after replaying its recorded child", async () => {
    const root = temporaryProject();
    const sourceRunId = "20260827-004100-a001";
    const resumedRunId = "20260827-004101-a002";
    const sourcePrompts: string[] = [];
    const resumedPrompts: string[] = [];
    const createRuntime = (
      runId: string,
      replay: WorkflowReplayController,
      prompts: string[],
    ): ReturnType<typeof createWorkflowRuntime> =>
      createWorkflowRuntime({
        runId,
        replay,
        agentRunner: async (request) => {
          prompts.push(request.prompt);
          return {
            ok: true,
            status: "completed",
            summary: "done",
            text: `answer(${request.prompt})`,
            diagnostics: [],
            agent: request.agent,
          };
        },
      });

    const source = createRuntime(
      sourceRunId,
      createWorkflowReplayController({ runDir: ensureWorkflowRunDir(root, sourceRunId) }),
      sourcePrompts,
    );
    await expect(
      source.dsl.parallel([
        async () => ({ ok: true, partial: false, answer: await source.dsl.agent("recorded-stage") }),
      ]),
    ).resolves.toEqual([{ ok: true, partial: false, answer: "answer(recorded-stage)" }]);
    expect(sourcePrompts).toEqual(["recorded-stage"]);

    const recorded = readWorkflowReplayLog(root, sourceRunId);
    const resumedController = createWorkflowReplayController({
      runDir: ensureWorkflowRunDir(root, resumedRunId),
      recorded,
    });
    const resumed = createRuntime(resumedRunId, resumedController, resumedPrompts);

    let caught: unknown;
    try {
      await resumed.dsl.parallel([
        async () => ({ ok: true, partial: true, answer: await resumed.dsl.agent("recorded-stage") }),
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorkflowGroupFailureError);
    const failure = caught as WorkflowGroupFailureError<unknown>;
    expect(failure.partialResults).toEqual([{ ok: true, partial: true, answer: "answer(recorded-stage)" }]);
    expect(failure.failures).toEqual([{ index: 0, kind: "returned-failure", message: "branch returned partial:true" }]);
    expect(failure.toEnvelope()).toMatchObject({
      ok: false,
      kind: "workflow_group_failure",
      code: "WORKFLOW_GROUP_FAILURE",
      groupKind: "parallel",
      completed: 0,
      failed: 1,
      failures: [{ index: 0, kind: "returned-failure", message: "branch returned partial:true" }],
    });
    expect(resumedPrompts).toEqual([]);
    expect(resumedController.counts()).toEqual({ replayedCalls: 1, freshCalls: 0 });
  });

  it("keeps the recorded payload out of journal.ndjson and in the sidecar record", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "stages", THREE_STAGE_WORKFLOW);
    const first = await runWorkflow(root, "stages", { input: "alpha" });

    const journalText = readFileSync(workflowJournalFile(first.runDir), "utf8");
    expect(journalText).not.toContain("answer(stage-1)");
    const recorded = readWorkflowReplayLog(root, first.runId);
    expect(recorded.filter((entry) => entry.kind === "agent")).toHaveLength(3);
    expect(JSON.stringify(recorded)).toContain("answer(stage-1)");

    // The three run artifacts coexist and result.json carries the typed envelope.
    const resumed = await runWorkflow(root, "stages", { input: "alpha", resumeFromRunId: first.runId });
    const persisted = JSON.parse(readFileSync(workflowResultFile(resumed.runDir), "utf8")) as {
      replay?: Record<string, unknown>;
    };
    expect(persisted.replay).toMatchObject({
      replayed: true,
      recorded: true,
      sourceRunId: first.runId,
      replayedCalls: 3,
      freshCalls: 0,
    });
    expect(existsSync(workflowJournalFile(resumed.runDir)), "journal.ndjson").toBe(true);
    expect(existsSync(workflowReplayFile(resumed.runDir)), "replay.ndjson").toBe(true);
    expect(existsSync(workflowResultFile(resumed.runDir)), "result.json").toBe(true);
  });
});

describe("static replay-safety assessment", () => {
  it("accepts a script whose nondeterminism comes through the DSL", () => {
    expect(
      assessWorkflowReplaySafety("export default async (dsl) => ({ at: dsl.now(), draw: dsl.random() });\n"),
    ).toEqual({ replaySafety: "static-deterministic", nondeterministicCalls: [] });
  });

  it.each([
    ["export default () => Date.now();\n", "Date.now"],
    ["export default () => Math.random();\n", "Math.random"],
    ["export default () => new Date().toISOString();\n", "new Date"],
    ["export default () => performance.now();\n", "performance.now"],
    ["export default () => crypto.randomUUID();\n", "crypto.randomUUID"],
    ['export default () => Date["now"]();\n', "Date[…]"],
  ])("flags %j as unproven", (source, evidence) => {
    const assessment = assessWorkflowReplaySafety(source);
    expect(assessment.replaySafety).toBe("unproven");
    expect(assessment.nondeterministicCalls).toContain(evidence);
  });

  // Every shape below was CLEAN before the scan was widened, so each of these
  // scripts was recorded and replayed as `static-deterministic`. A bare root
  // name comparison is not a gate; reaching the same builtin through the global
  // object, a parenthesis, a fresh binding, or an ESM import has to land on the
  // same verdict.
  it.each([
    ["global object", "export default () => globalThis.Date.now();\n", "Date.now"],
    ["legacy global alias", "export default () => global.Date.now();\n", "Date.now"],
    ["self alias", "export default () => self.Math.random();\n", "Math.random"],
    ["computed global member", 'export default () => globalThis["Date"].now();\n', "Date.now"],
    ["unfoldable global member", "const k = pick();\nexport default () => globalThis[k].now();\n", "globalThis[…]"],
    ["parenthesised constructor", "export default () => new (Date)();\n", "new Date"],
    ["constructor via global", "export default () => new globalThis.Date();\n", "new Date"],
    ["destructured root", "const { random } = Math;\nexport default () => random();\n", "Math.random"],
    ["aliased root", "const d = Date;\nexport default () => d.now();\n", "alias:Date"],
    ["reassigned root", "let m;\nm = Math;\nexport default () => m.random();\n", "alias:Math"],
    ["rest-destructured root", "const { ...rest } = Math;\nexport default () => rest.random();\n", "alias:Math"],
  ])("flags a bypass through the %s as unproven", (_shape, source, evidence) => {
    const assessment = assessWorkflowReplaySafety(source);
    expect(assessment.replaySafety).toBe("unproven");
    expect(assessment.nondeterministicCalls).toContain(evidence);
  });

  // `node:` specifiers are what keeps a script `self-contained-static`, so the
  // blessed import path must not also be the easiest way past the safety scan.
  it.each([
    [
      "named import",
      'import { randomUUID } from "node:crypto";\nexport default () => randomUUID();\n',
      "node:crypto:randomUUID",
    ],
    [
      "renamed import",
      'import { performance as p } from "node:perf_hooks";\nexport default () => p.now();\n',
      "node:perf_hooks:performance",
    ],
    ["namespace import", 'import * as c from "node:crypto";\nexport default () => c.randomUUID();\n', "node:crypto:*"],
    ["default import", 'import c from "node:crypto";\nexport default () => c.randomUUID();\n', "node:crypto:*"],
    ["re-export", 'export { randomUUID } from "node:crypto";\nexport default () => 1;\n', "node:crypto:randomUUID"],
  ])("flags a nondeterministic builtin reached by %s as unproven", (_shape, source, evidence) => {
    const assessment = assessWorkflowReplaySafety(source);
    expect(assessment.replaySafety).toBe("unproven");
    expect(assessment.nondeterministicCalls).toContain(evidence);
  });

  // A conservative scan costs cache misses, which is the cheap failure. It must
  // not cost them on the deterministic shapes curated workflows actually use.
  it.each([
    [
      "deterministic builtin import",
      'import { createHash } from "node:crypto";\nexport default () => createHash("sha256");\n',
    ],
    [
      "node:fs and node:path",
      'import { readdirSync } from "node:fs";\nimport path from "node:path";\nexport default () => path.sep + readdirSync(".").length;\n',
    ],
    ["deterministic Date member", "const { UTC } = Date;\nexport default () => UTC(2020, 0, 1);\n"],
    ["process.env read", "export default () => process.env.HOME;\n"],
    ["a dsl method named now", "export default (dsl) => dsl.now();\n"],
  ])("leaves %s replayable", (_shape, source) => {
    expect(assessWorkflowReplaySafety(source)).toEqual({
      replaySafety: "static-deterministic",
      nondeterministicCalls: [],
    });
  });

  it("keeps every curated packaged workflow replay-safe", () => {
    for (const name of packagedWorkflowNames()) {
      const assessment = assessWorkflowReplaySafety(readFileSync(packagedWorkflowPath(name), "utf8"));
      expect(assessment, name).toEqual({ replaySafety: "static-deterministic", nondeterministicCalls: [] });
    }
  });
});

describe("replay-safety bypasses are refused end to end", () => {
  // QA confirmed both of these were recorded and then replayed with zero child
  // runs. The unit assessment above is the mechanism; this is the consequence.
  it.each([
    ["a clock reached through globalThis", "const started = globalThis.Date.now();", ""],
    ["randomness imported from node:crypto", "const id = randomUUID();", 'import { randomUUID } from "node:crypto";\n'],
  ])("never records or replays %s", async (_shape, statement, imports) => {
    const root = temporaryProject();
    writeWorkflow(
      root,
      "bypass",
      `${imports}export const meta = { name: "bypass", description: "smuggled nondeterminism" };
export default async function runWorkflow(dsl) {
  ${statement}
  const answer = await dsl.agent("stage-1");
  return { summary: answer };
}
`,
    );

    const first = await runWorkflow(root, "bypass");
    expect(first.ok).toBe(true);
    expect(first.replay).toMatchObject({ recorded: false, notRecordedReason: "replay-unsafe-script" });
    expect(existsSync(workflowReplayFile(first.runDir))).toBe(false);

    const resumed = await runWorkflow(root, "bypass", { resumeFromRunId: first.runId });
    expect(resumed.replay).toMatchObject({ replayed: false, refusedReason: "replay-unsafe-script" });
    expect(resumed.executedPrompts).toEqual(["stage-1"]);
  });
});

/**
 * T-131 W4 — the accepted consequence of giving `timeoutMs` a package default.
 *
 * `canonicalAgentRequest` is deliberately built from the RESOLVED request, so a
 * default that later changes value cannot silently reuse a record made under the
 * old one. Giving the axis a default for the FIRST time is that same event: every
 * record written while the field was absent describes a different call now.
 * Hiding the default from the key to protect old recordings would be exactly the
 * silent reuse that rule exists to prevent, so the invalidation is proven here
 * rather than assumed, and `CHANGELOG.md` names it.
 */
describe("the default timeoutMs invalidates records written before it", () => {
  function recordDir(): string {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-replay-timeout-"));
    roots.push(root);
    return ensureWorkflowRunDir(root, "20260812-010101-b001");
  }

  function answering(
    runId: string,
    options: { defaultTimeoutMs?: number; defaultMaxTurns?: number; replay: WorkflowReplayController },
  ) {
    const prompts: string[] = [];
    const runtime = createWorkflowRuntime({
      runId,
      replay: options.replay,
      ...(options.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: options.defaultTimeoutMs } : {}),
      ...(options.defaultMaxTurns !== undefined ? { defaultMaxTurns: options.defaultMaxTurns } : {}),
      agentRunner: async (request) => {
        prompts.push(request.prompt);
        return {
          ok: true as const,
          status: "completed" as const,
          summary: "done",
          text: `answer(${request.prompt})`,
          diagnostics: [],
          agent: request.agent,
        };
      },
    });
    return { ...runtime, prompts };
  }

  /** One REAL record written by a runtime with no default fuse: the exact bytes
   *  every run produced before this contract existed, not a hand-built key. */
  async function preDefaultRecord(prompt: string): Promise<WorkflowReplayEntry[]> {
    const runDir = recordDir();
    const controller = createWorkflowReplayController({ runDir });
    const source = answering("pre-default-run", { replay: controller });
    await source.dsl.agent(prompt);
    expect(source.prompts).toEqual([prompt]);
    return readFileSync(workflowReplayFile(runDir), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as WorkflowReplayEntry);
  }

  it("re-executes a pre-default record instead of serving it under the new key", async () => {
    const recorded = await preDefaultRecord("stage-1");
    expect(recorded).toHaveLength(1);

    const afterController = createWorkflowReplayController({ runDir: recordDir(), recorded });
    const after = answering("post-default-run", {
      replay: afterController,
      defaultTimeoutMs: DEFAULT_WORKFLOW_BUDGET.timeoutMs,
    });
    await after.dsl.agent("stage-1");

    // The child really ran again, and the run SAYS the prefix diverged at call 0
    // instead of quietly serving text recorded under an unbounded child.
    expect(after.prompts).toEqual(["stage-1"]);
    expect(afterController.counts()).toEqual({ replayedCalls: 0, freshCalls: 1, divergedAtCall: 0 });
    expect(after.getJournal().some((line) => line.replayed === true)).toBe(false);
  });

  it("still replays that record for a runtime without the default, so the case above is the default and not the record", async () => {
    const recorded = await preDefaultRecord("stage-1");

    const afterController = createWorkflowReplayController({ runDir: recordDir(), recorded });
    const after = answering("control-resume", { replay: afterController });

    await expect(after.dsl.agent("stage-1")).resolves.toBe("answer(stage-1)");
    expect(after.prompts).toEqual([]);
    expect(afterController.counts()).toEqual({ replayedCalls: 1, freshCalls: 0 });
  });
});

/**
 * T-131 W5 — `maxTurns` joins the canonical request.
 *
 * A field added to `WorkflowAgentRequest` and NOT added to `canonicalAgentRequest`
 * widens what counts as "the same call": two children with different turn budgets
 * would share one record and the second would be served an answer the first
 * produced under a different budget. Proven by whether a recorded answer is served,
 * not by comparing request objects — that comparison passes either way.
 */
describe("maxTurns is part of the replay key", () => {
  function recordDir(): string {
    const root = mkdtempSync(path.join(tmpdir(), "workflow-replay-turns-"));
    roots.push(root);
    return ensureWorkflowRunDir(root, "20260812-010101-b002");
  }

  function answeringTurns(runId: string, maxTurns: number, replay: WorkflowReplayController) {
    const prompts: string[] = [];
    const runtime = createWorkflowRuntime({
      runId,
      replay,
      defaultMaxTurns: maxTurns,
      agentRunner: async (request) => {
        prompts.push(request.prompt);
        return {
          ok: true as const,
          status: "completed" as const,
          summary: "done",
          text: `answer(${request.prompt})`,
          diagnostics: [],
          agent: request.agent,
        };
      },
    });
    return { ...runtime, prompts };
  }

  async function recordWith(maxTurns: number): Promise<WorkflowReplayEntry[]> {
    const runDir = recordDir();
    const source = answeringTurns("turns-source", maxTurns, createWorkflowReplayController({ runDir }));
    await source.dsl.agent("stage-1");
    return readFileSync(workflowReplayFile(runDir), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as WorkflowReplayEntry);
  }

  it("refuses a record made under a different turn budget", async () => {
    const recorded = await recordWith(5);
    const controller = createWorkflowReplayController({ runDir: recordDir(), recorded });
    const resumed = answeringTurns("turns-resume", 2, controller);

    await resumed.dsl.agent("stage-1");

    expect(resumed.prompts).toEqual(["stage-1"]);
    expect(controller.counts()).toEqual({ replayedCalls: 0, freshCalls: 1, divergedAtCall: 0 });
  });

  it("serves the same record under the same turn budget, so the case above is the budget", async () => {
    const recorded = await recordWith(5);
    const controller = createWorkflowReplayController({ runDir: recordDir(), recorded });
    const resumed = answeringTurns("turns-resume-same", 5, controller);

    await expect(resumed.dsl.agent("stage-1")).resolves.toBe("answer(stage-1)");
    expect(resumed.prompts).toEqual([]);
    expect(controller.counts()).toEqual({ replayedCalls: 1, freshCalls: 0 });
  });
});
