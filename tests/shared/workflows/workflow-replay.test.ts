import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runner.js";
import { readWorkflowRunSummary } from "../../../extensions/_shared/workflow-journal.js";
import { readWorkflowReplayLog } from "../../../extensions/_shared/workflow-replay.js";
import {
  CURATED_PACKAGE_WORKFLOW_NAMES,
  packagedWorkflowPath,
  runWorkflowScript,
} from "../../../extensions/_shared/workflow-runner.js";
import { assessWorkflowReplaySafety } from "../../../extensions/_shared/workflow-script-identity.js";
import type { WorkflowJournalLine } from "../../../extensions/_shared/workflow-runtime.js";
import workflowsExt from "../../../extensions/workflows/index.js";
import type { WorkflowTextComponent } from "../../../extensions/workflows/progress-widget.js";
import { createWorkflowTranscript } from "../../../extensions/workflows/workflow-transcript.js";
import { createHarness } from "../../test-harness.js";

/**
 * T-109 — `--resume` replays recorded agent calls.
 *
 * Every case here answers the same question from a different side: can a resumed
 * run report success for work it did not do? The recorded answer must come from a
 * real earlier execution of the identical request, or the call must run again.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
  const dir = path.join(root, ".pi", "workflows");
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
  transcript.start(outcome.runId);
  for (const line of outcome.journal) transcript.event(line);
  return transcript.finish(outcome.raw).digest;
}

/**
 * Run one saved workflow with a scripted child. The child answer is a pure
 * function of the prompt, so a difference between two runs can only come from
 * the replay machinery, never from the fake model.
 */
async function runWorkflow(
  root: string,
  name: string,
  options: { input?: string; resumeFromRunId?: string } = {},
): Promise<RunOutcome> {
  const harness = createHarness(root, { sessionId: `replay-${name}` });
  const executedPrompts: string[] = [];
  const createExecutor = (): AgentExecutor => ({
    async run(request: AgentRunRequest) {
      executedPrompts.push(request.task);
      return {
        status: "completed" as const,
        agentName: request.agent.name,
        reason: "answered",
        text: `answer(${request.task})`,
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

const UNSUPPORTED_SCHEMA_WORKFLOW = `export const meta = { name: "unsupported", description: "declares an ignored keyword" };
export default async function runWorkflow(dsl) {
  return await dsl.agent("shape me", { schema: { type: "number", minimum: 3 } });
}
`;

describe("workflow --resume replays recorded agent calls", () => {
  it("projects an unreadable persisted result envelope as unknown", () => {
    const root = temporaryProject();
    const runDir = path.join(root, ".locus", "runtime", "workflows", "corrupt-result");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "result.json"), "{not-json", "utf8");

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

  it("refuses to replay when the script bytes changed, and runs every call fresh", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "stages", THREE_STAGE_WORKFLOW);
    const first = await runWorkflow(root, "stages", { input: "alpha" });

    // Same prompts, different bytes: the runner cannot prove the recorded calls
    // still sit at the same positions, so it refuses rather than guessing.
    writeWorkflow(root, "stages", `${THREE_STAGE_WORKFLOW}\n// reviewed edit\n`);
    const resumed = await runWorkflow(root, "stages", { input: "alpha", resumeFromRunId: first.runId });

    expect(resumed.replay).toMatchObject({
      replayed: false,
      refusedReason: "script-changed",
      replayedCalls: 0,
      freshCalls: 3,
    });
    expect(resumed.executedPrompts).toEqual(["stage-1", "stage-2 alpha", "stage-3"]);
    expect(resumed.journal.some((line) => JSON.stringify(line).includes("reason=script-changed"))).toBe(true);
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
    expect(existsSync(path.join(first.runDir, "replay.ndjson"))).toBe(false);

    const resumed = await runWorkflow(root, "unsafe", { resumeFromRunId: first.runId });
    expect(resumed.replay).toMatchObject({ replayed: false, refusedReason: "replay-unsafe-script" });
    expect(resumed.executedPrompts).toEqual(["stage-1"]);
  });

  // The five refusal reasons are the contract's fail-closed surface. Each one
  // must run the workflow COMPLETELY fresh and still report the run itself as
  // ok — refusing to replay means "re-run for real", never "fail the run".
  it("refuses with source-run-unusable when the recorded run lost its persisted identity", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "stages", THREE_STAGE_WORKFLOW);
    const first = await runWorkflow(root, "stages", { input: "alpha" });

    // The run id still resolves (journal.ndjson survives), so this is reached
    // rather than the hard "source run not found" error raised earlier.
    rmSync(path.join(first.runDir, "result.json"));
    const resumed = await runWorkflow(root, "stages", { input: "alpha", resumeFromRunId: first.runId });

    expect(resumed.ok).toBe(true);
    expect(resumed.replay).toMatchObject({
      replayed: false,
      refusedReason: "source-run-unusable",
      replayedCalls: 0,
      freshCalls: 3,
    });
    expect(resumed.executedPrompts).toEqual(["stage-1", "stage-2 alpha", "stage-3"]);
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
    expect(existsSync(path.join(first.runDir, "replay.ndjson"))).toBe(false);

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
    expect(digestFor(root, first)).not.toContain("[replayed]");
    const resumedDigest = digestFor(root, resumed);
    expect(resumedDigest).toContain("[replayed]");
    expect(resumedDigest).toContain("3 replayed from a recorded run");
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
    expect(digest).toContain("2 replayed from a recorded run");
    expect(digestFor(root, first)).not.toContain("replayed from a recorded run");
  });

  it("keeps the recorded payload out of journal.ndjson and in the sidecar record", async () => {
    const root = temporaryProject();
    writeWorkflow(root, "stages", THREE_STAGE_WORKFLOW);
    const first = await runWorkflow(root, "stages", { input: "alpha" });

    const journalText = readFileSync(path.join(first.runDir, "journal.ndjson"), "utf8");
    expect(journalText).not.toContain("answer(stage-1)");
    const recorded = readWorkflowReplayLog(root, first.runId);
    expect(recorded.filter((entry) => entry.kind === "agent")).toHaveLength(3);
    expect(JSON.stringify(recorded)).toContain("answer(stage-1)");

    // The three run artifacts coexist and result.json carries the typed envelope.
    const resumed = await runWorkflow(root, "stages", { input: "alpha", resumeFromRunId: first.runId });
    const persisted = JSON.parse(readFileSync(path.join(resumed.runDir, "result.json"), "utf8")) as {
      replay?: Record<string, unknown>;
    };
    expect(persisted.replay).toMatchObject({
      replayed: true,
      recorded: true,
      sourceRunId: first.runId,
      replayedCalls: 3,
      freshCalls: 0,
    });
    for (const artifact of ["journal.ndjson", "replay.ndjson", "result.json"]) {
      expect(existsSync(path.join(resumed.runDir, artifact)), artifact).toBe(true);
    }
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
    for (const name of CURATED_PACKAGE_WORKFLOW_NAMES) {
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
    expect(existsSync(path.join(first.runDir, "replay.ndjson"))).toBe(false);

    const resumed = await runWorkflow(root, "bypass", { resumeFromRunId: first.runId });
    expect(resumed.replay).toMatchObject({ replayed: false, refusedReason: "replay-unsafe-script" });
    expect(resumed.executedPrompts).toEqual(["stage-1"]);
  });
});
