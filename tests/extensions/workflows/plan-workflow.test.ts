import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import type {
  WorkflowArtifactPorts,
  WorkflowArtifactRef,
  WorkflowBoundContinuation,
  WorkflowConsumedTextArtifact,
} from "../../../extensions/workflows/runtime/workflow-artifacts.js";
import { workflowContinuationForHandoff } from "../../../extensions/workflows/runtime/workflow-handoff.js";
import { createWorkflowResourceLoader } from "../../../extensions/workflows/runtime/workflow-resources.js";
import { runWorkflowScript } from "../../../extensions/workflows/runtime/workflow-runner.js";
import {
  createWorkflowRuntime,
  SchemaValidationError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/workflows/runtime/workflow-runtime.js";
import { createHarness } from "../../test-harness.js";

/**
 * The tracked `plan` example. One loop carries its "iteratively" claim, and it can
 * end in two ways, so both are pinned here: the drafting loop must stop on the
 * critic's verdict, and the round cap is the safety net that retains the stalled
 * state and hands the decision to the operator.
 */
const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/plan/plan.workflow.mjs");

interface PublishedArtifact {
  ref: WorkflowArtifactRef;
  text: string;
  stage?: string;
  kind?: "published" | "primary";
}

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function completed(request: WorkflowAgentRequest, text: string): WorkflowAgentResult {
  return {
    ok: true,
    status: "completed",
    summary: text,
    text,
    diagnostics: [],
    agent: request.agent,
    ...(request.label === undefined ? {} : { label: request.label }),
  };
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A finished child answer, for the tests that go through the real runner. */
function completedChild(request: AgentRunRequest, text: string) {
  return {
    status: "completed" as const,
    agentName: request.agent.name,
    reason: text,
    text,
    diagnostics: [],
    lifecycleEntryIds: [],
  };
}

function priorRef(runId: string, artifactId: string, name: string, text: string): WorkflowArtifactRef {
  return { runId, artifactId, name, sha256: digest(text) };
}

function runtimeWith(
  runner: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult>,
  options: { consumed?: Map<string, WorkflowConsumedTextArtifact> } = {},
) {
  const runId = "plan-test";
  const runDir = mkdtempSync(path.join(tmpdir(), "locus-plan-workflow-"));
  const published: PublishedArtifact[] = [];
  const answers: PublishedArtifact[] = [];
  const awaiting: Array<{ reason: string; operatorHandoff?: unknown }> = [];
  let continuation: WorkflowBoundContinuation | undefined;
  if (options.consumed !== undefined && options.consumed.size > 0) {
    const pairs = [...options.consumed.values()].map((item, index) => ({
      sourceRef: item.ref,
      consumedArtifact: {
        ...item,
        ref: priorRef(runId, `input-${index + 1}`, item.ref.name, item.text),
      },
    }));
    continuation = { originRunId: pairs[0]!.sourceRef.runId, artifacts: pairs };
  }
  const artifactPorts: WorkflowArtifactPorts = {
    recordAgentEvidence(input) {
      if (input.text === undefined) return {};
      const ref = priorRef(runId, `answer-${answers.length + 1}`, input.name, input.text);
      answers.push({ ref, text: input.text, ...(input.stage === undefined ? {} : { stage: input.stage }) });
      return { answer: ref };
    },
    publishText(name, text, stage, kind = "published") {
      const ref = priorRef(runId, `published-${published.length + 1}`, name, text);
      published.push({ ref, text, kind, ...(stage === undefined ? {} : { stage }) });
      return ref;
    },
    consumeText(ref) {
      throw new Error(`unexpected workflow-local artifact consume: ${ref.name}`);
    },
  };
  return {
    ...createWorkflowRuntime({
      runId,
      agentRunner: runner,
      resourceLoader: createWorkflowResourceLoader({ workflowSourcePath: workflowPath, runDir }),
      artifactPorts,
      onAwaitOperator(declaration) {
        awaiting.push(declaration);
      },
      ...(continuation === undefined ? {} : { continuation }),
      projectRoot: process.cwd(),
    }),
    published,
    answers,
    awaiting,
  };
}

/** The four artifacts a stalled run retains, as consumed continuation pairs. */
function stalledPlanContinuation(
  overrides: Partial<Record<string, string>> = {},
): Map<string, WorkflowConsumedTextArtifact> {
  const originRunId = "plan-origin-run";
  const texts: Record<string, string> = {
    "task.md": "advance pagination",
    "context.md": SCOUT_CONTEXT,
    "plan.md": PLAN_DRAFT,
    "unresolved-defects.md": "1. S1: still unverifiable",
    ...overrides,
  };
  return new Map(
    Object.entries(texts).map(([name, text]) => [
      name,
      {
        ref: priorRef(originRunId, `published-${name}`, name, text),
        text,
        source: {
          runId: originRunId,
          target: { kind: "name" as const, ref: "plan", source: "package" as const },
          artifact: { kind: "published" as const },
          terminal: { artifactRefs: [] },
        },
      },
    ]),
  );
}

const PLAN_DRAFT = [
  "# Implementation Plan",
  "## Outcome",
  "Outcome type: working delivery",
  "Primary result: Pagination advances past the first page.",
  "Consumer: Callers of the pagination API.",
  "Form and location: `src/page.ts` runtime behavior.",
  "Required content or behavior: The offset advances by the configured page size.",
  "Usability proof: `npm test -- page` passes the multi-page behavior case.",
  "Supporting evidence: implementation report and test output.",
  "",
  "## Assumptions",
  "- Assumed the caller owns the offset, because `loadPage` reads it; wrong if the store owns it.",
  "",
  "## Steps",
  "### S1 — Advance the offset",
  "Files: `src/page.ts`",
  "Context: Read `src/page.ts` and preserve its public API.",
  "Question: What one change advances the offset by the configured page size?",
  "Output: `src/page.ts` — updated implementation.",
  "Change: Advance the offset.",
  "Verify: `npm test -- page`",
  "Depends on: none",
  "",
  "## Out of scope",
  "- Renaming the module.",
  "",
  "## Open questions",
  "- none",
].join("\n");

/** Everything before the drafting loop, so a loop test only writes the loop. */
const SCOUT_CONTEXT = "# Task Context\n## Existing behavior\n- `src/page.ts` — paginates.";

describe("workflow example: plan.workflow.mjs", () => {
  it("allows one explicit primary document and rejects a second declaration", () => {
    const { dsl, published } = runtimeWith(async () => {
      throw new Error("no child expected");
    });

    const ref = dsl.publishPrimaryArtifact("plan.md", PLAN_DRAFT);

    expect(ref.name).toBe("plan.md");
    expect(published).toMatchObject([{ text: PLAN_DRAFT, kind: "primary" }]);
    expect(() => dsl.publishPrimaryArtifact("other.md", "other")).toThrow(/already published its primary output/u);
  });

  it("routes every planning stage through the agent tier and names no provider", () => {
    const source = readFileSync(workflowPath, "utf8");

    // One declaration, shared by all three stages, so a stage cannot drift onto
    // another route without this failing.
    expect(source).toContain('modelRole: "agent"');
    expect(source.match(/modelRole:/gu)).toHaveLength(1);
    // The reason the tier replaced a concrete pin: a packaged workflow that names a
    // provider fails by name for every operator who does not have that provider.
    // The package decides no vendor; the roles table does, and until it does the
    // stage runs on the session model.
    expect(source).not.toMatch(/model:\s*"[^"]*\//u);
  });

  it("keeps every planning stage read-only and lets the runtime own every artifact", () => {
    const source = readFileSync(workflowPath, "utf8");

    // Planning reads; it never writes. If this ever fails, a "plan" run can
    // change the operator's working tree without the operator asking for it.
    expect(source.match(/readOnly: true/gu)).toHaveLength(1);
    expect(source).not.toContain('"write"');
    expect(source).not.toContain('"edit"');
    expect(source).not.toContain('"bash"');
    // No `maxToolCalls` at all: the package budget contract supplies it, and a
    // stage that restated the default would silently disagree with it the day it moves.
    expect(source.match(/maxToolCalls:/gu)).toBeNull();
    expect(source.match(/workspaceMode:/gu)).toHaveLength(1);

    expect(source).toContain("const COMMON = ");
    // Three named prompt builders: no prompt here is long enough to earn a file.
    expect(source).not.toContain("promptFile");
    expect(source.match(/^\s*return `\$\{COMMON\}$/gmu)).toHaveLength(3);

    // The loop branches on a declared shape plus a cross-field callback, never on
    // a regex over the model's Markdown.
    expect(source).toContain("PLAN_VERDICT_SCHEMA");
    expect(source).toContain("validate: planVerdictErrors");
    expect(source).toContain("const MAX_PLAN_ROUNDS = 6");
    expect(source).not.toContain("JSON.parse");

    for (const name of ["context.md", "plan.md", "plan-critique.json"]) {
      expect(source, name).toContain(`artifact: "${name}"`);
    }
    for (const bound of ["maxAnswerChars: MAX_CONTEXT_CHARS", "maxAnswerChars: MAX_PLAN_CHARS"]) {
      expect(source, bound).toContain(bound);
    }
  });

  it("takes every agent's capabilities and every label from the one roster", async () => {
    // The roster is the cast list, and a capability lives in exactly one place: a
    // tools array copied per call site is how one planning stage quietly becomes
    // write-capable while the other two stay read-only.
    const source = readFileSync(workflowPath, "utf8");
    expect(source).toContain("const PLAN_AGENTS = Object.freeze({");
    expect(source.match(/tools: \[/gu)).toHaveLength(1);
    expect(source.match(/\.\.\.PLAN_AGENTS\.\w+\.options,/gu)).toHaveLength(3);
    // Each call site adds the label and nothing else, and the label is built from
    // the roster id, so a stage name cannot drift away from the cast list.
    expect(source.match(/^\s*label: /gmu)).toHaveLength(3);
    expect(source).toContain("label: PLAN_AGENTS.scout.id");
    expect(source).toContain("label: `${PLAN_AGENTS.planner.id} round ${round}`");
    expect(source).toContain("label: `${PLAN_AGENTS.critic.id} round ${round}`");

    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      scout: SCOUT_CONTEXT,
      "planner round 1": PLAN_DRAFT,
      "critic round 1": '{"verdict":"accept","defects":[]}',
    };
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    await runWorkflow(dsl, "advance pagination");

    expect(calls.map((call) => call.label)).toEqual(["scout", "planner round 1", "critic round 1"]);
    expect(calls[0]?.tools).toEqual(["read", "git_read", "ast_index", "grep", "find"]);
    // One shared roster option object means one capability set for all three.
    const capabilities = calls.map((call) =>
      JSON.stringify({
        tools: call.tools,
        readOnly: call.readOnly,
        maxToolCalls: call.maxToolCalls,
        workspaceMode: call.workspaceMode,
        permissionMode: call.permissionMode,
      }),
    );
    expect(new Set(capabilities).size).toBe(1);
  });

  it("makes the planner record what it assumed and the critic treat a hidden decision as a defect", () => {
    // Nothing pauses this run for an answer, so an open decision has to land in
    // writing instead. The critic is what makes that binding: a plan cannot buy an
    // accept by staying vague about a choice it silently depends on.
    const source = readFileSync(workflowPath, "utf8");
    const prose = source.replace(/\s+/gu, " ");

    expect(source).toContain("\n## Assumptions\n- Assumed X, because Y; wrong if Z.");
    expect(prose).toContain('in the exact form "assumed X, because Y; wrong if Z"');

    expect(prose).toContain("a decision the plan depends on but never states — especially an ambiguity");
    expect(prose).toContain("while a choice recorded under \\`## Assumptions\\` with its reason is not");
  });

  it("makes the primary user result the source of the steps and verification", () => {
    // Three failures from one live run on 2026-07-28, each addressed on both
    // sides so the critic can refuse what the planner is told not to write: a
    // plan whose first "step" only read nine files, a second step that wrote
    // three independent document sections at once, and verifications no later
    // agent could rerun, which forced the implementation report to grade every
    // step partial.
    const prose = readFileSync(workflowPath, "utf8").replace(/\s+/gu, " ");

    expect(prose).toContain("Every step changes the repository.");
    expect(prose).toContain("a step that changes nothing");
    expect(prose).toContain("Start with the result, not the edits.");
    expect(prose).toContain("Name one primary result.");
    expect(prose).toContain("the named primary result is only a list of completed steps");
    expect(prose).toContain("the steps can all pass without producing the primary result");
    expect(prose).toContain("one command a later agent can rerun without a human");
    expect(prose).toContain("a step block missing any of the mandatory");
  });

  it("uses one small agent subtask per semantic question, even when that creates many steps", () => {
    const prose = readFileSync(workflowPath, "utf8").replace(/\s+/gu, " ");

    expect(prose).toContain("One plan step is one agent subtask");
    expect(prose).toContain("one semantic question");
    expect(prose).toContain("one result-producing step and one output per item");
    expect(prose).toContain("For every Airflow DAG file");
    expect(prose).toContain("that DAG's description output");
    expect(prose).toContain("never use it to batch per-item answers");
    expect(prose).toContain("use this exact topology");
    expect(prose).toContain("every discovered DAG gets one metadata step");
    expect(prose).toContain("one description step with a different output");
    expect(prose).toContain("Item agents do not append directly to the shared final file");
    expect(prose).toContain("outputs/dags/customer-sync-metadata.json");
    expect(prose).toContain("never emit an ellipsis placeholder");
    expect(prose).toContain("Forty-four explicit steps are valid");
    expect(prose).toContain("Context:");
    expect(prose).toContain("Question:");
    expect(prose).toContain("Output:");
  });

  it("gives the critic a hard DAG subtask audit before normal review", () => {
    const prose = readFileSync(workflowPath, "utf8").replace(/\s+/gu, " ");

    expect(prose).toContain("HARD AGENT-SUBTASK GATE");
    expect(prose).toContain("Output: none");
    expect(prose).toContain(".pi/workspaces/...");
    expect(prose).toContain("one metadata step and a separate description step");
    expect(prose).toContain("Build the item-to-step mapping yourself");
  });

  it("allows acceptance only after blocking open questions are resolved", () => {
    const prose = readFileSync(workflowPath, "utf8").replace(/\s+/gu, " ");

    expect(prose).toContain("A plan with any such question is not acceptable yet");
    expect(prose).toContain("a non-empty Open questions section");
    expect(prose).toContain("optional follow-ups belong in Out of scope or Assumptions");
  });

  it("tells a stalled operator to continue the run instead of editing the retained draft", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(source).toContain("Do not edit the retained plan.md or start a fresh plan run");
    expect(source).toContain("continue this stalled run with custom guidance");
  });

  it("tells both roles that a closing verification step is a step that changes nothing", () => {
    // The same rerun accepted a final "integrity pass" step whose whole content
    // was re-checking what the earlier steps' own verifications already prove.
    // The ban on steps that change nothing was already there; it did not read as
    // covering a step called a verification, so both roles now say it does.
    const prose = readFileSync(workflowPath, "utf8").replace(/\s+/gu, " ");

    expect(prose).toContain(
      "A closing step that checks the finished result is the same mistake wearing a different name.",
    );
    expect(prose).toContain("The plan ends with the last step that changes something.");
    expect(prose).toContain(
      "A closing step that verifies the finished result is this defect and not an exception to it",
    );
  });

  it("accepts the first draft when the critic accepts it, and returns that exact text", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      scout: SCOUT_CONTEXT,
      "planner round 1": PLAN_DRAFT,
      "critic round 1": '{"verdict":"accept","defects":[]}',
    };
    const { dsl, published, answers } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });
    const task = "  make pagination advance past the first page  \n";

    const result = await runWorkflow(dsl, task);

    expect(result).toBe(PLAN_DRAFT);
    expect(calls.map((call) => call.label)).toEqual(["scout", "planner round 1", "critic round 1"]);
    expect(calls.every((call) => call.readOnly === true)).toBe(true);
    // The operator's exact words reach every stage; no stage sees a paraphrase.
    expect(calls.every((call) => call.prompt.includes(task))).toBe(true);
    expect(calls.map((call) => call.phase)).toEqual(["scout-repository", "draft-plan", "critique-plan"]);
    expect(calls[1]?.prompt).toContain(SCOUT_CONTEXT);
    expect(calls[2]?.prompt).toContain(PLAN_DRAFT);
    expect(published.map((item) => item.ref.name)).toEqual(["task.md", "plan.md"]);
    expect(published[0]?.text).toBe(task);
    expect(published[1]).toMatchObject({ text: PLAN_DRAFT, kind: "primary" });
    expect(answers.map((item) => item.ref.name)).toEqual(["context.md", "plan.md", "plan-critique.json"]);
  });

  it("reopens a critic acceptance when a new plan omits part of the agent-subtask contract", async () => {
    const runWorkflow = await loadWorkflow();
    const incompletePlan = PLAN_DRAFT.replace(/^Context:.*\n/mu, "");
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      scout: SCOUT_CONTEXT,
      "planner round 1": incompletePlan,
      "critic round 1": '{"verdict":"accept","defects":[]}',
      "planner round 2": PLAN_DRAFT,
      "critic round 2": '{"verdict":"accept","defects":[]}',
    };
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    await expect(runWorkflow(dsl, "advance pagination")).resolves.toBe(PLAN_DRAFT);
    expect(calls.map((call) => call.label)).toEqual([
      "scout",
      "planner round 1",
      "critic round 1",
      "planner round 2",
      "critic round 2",
    ]);
    expect(calls[3]?.prompt).toContain("must contain exactly one non-empty Context:, Question:, and Output: line");
  });

  it("reopens a critic acceptance when the Airflow per-item execution contract is incomplete", async () => {
    const runWorkflow = await loadWorkflow();
    const common = [
      "# Implementation Plan",
      "## Outcome",
      "Outcome type: working delivery",
      "Primary result: Airflow DAG inventory.",
      "Consumer: Airflow operators.",
      "Form and location: `dag-inventory.md`.",
      "Required content or behavior: One evidence-backed row per DAG.",
      "Usability proof: `test -s dag-inventory.md`.",
      "Supporting evidence: per-DAG outputs.",
      "## Assumptions",
      "- none",
      "## Steps",
      "### S1 — Discover DAGs",
      "Files: `dags/`",
      "Context: Repository DAG directory.",
      "Question: Which Python files define DAGs?",
      "Output: `outputs/dag-files.txt` — one path per line.",
      "Change: Write the candidate list.",
      "Verify: `test -s outputs/dag-files.txt`",
      "Depends on: none",
      "### S2 — Extract example metadata",
      "Files: `dags/example.py`",
      "Context: The source file and S1 list.",
      "Question: What are the DAG id, owner, email, schedule, and does the DAG define a literal description keyword argument? Do NOT extract or store any description text.",
      "Output: `outputs/example-metadata.json` — literal fields plus `has_description`.",
      "Change: Write the metadata output.",
      "Verify: `test -s outputs/example-metadata.json`",
      "Depends on: S1",
    ];
    const tail = [
      "### S4 — Assemble inventory",
      "Files: `outputs/example-metadata.json`, `outputs/example-description.md`",
      "Context: Both per-DAG outputs.",
      "Question: How should the two outputs be assembled into the inventory?",
      "Output: `dag-inventory.md` — one Markdown table.",
      "Change: Write the final inventory.",
      "Verify: `test -s dag-inventory.md`",
      "Depends on: S2, S3",
      "## Out of scope",
      "- Running Airflow.",
      "## Open questions",
      "- none",
    ];
    const goodPlan = [
      ...common,
      "### S3 — Describe example DAG",
      "Files: `dags/example.py`",
      "Context: Read the DAG code deeply.",
      "Question: What does this DAG do? Write its concise description.",
      "Output: `outputs/example-description.md` — one description.",
      "Change: Write the description output.",
      "Verify: `test -s outputs/example-description.md`",
      "Depends on: S1",
      ...tail,
      "```",
      "Plan verified against the repository and ready for implementation.",
    ].join("\n");
    const badPlan = goodPlan
      .replace(
        "does the DAG define a literal description keyword argument?",
        "what is the explicit description value (if any)?",
      )
      .replace("`outputs/dag-files.txt`", "`/tmp/dag-files.txt`");
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      scout: "# Context\n- `dags/example.py` defines one DAG.",
      "planner round 1": badPlan,
      "critic round 1": '{"verdict":"accept","defects":[]}',
      "planner round 2": goodPlan,
      "critic round 2": '{"verdict":"accept","defects":[]}',
    };
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    await expect(runWorkflow(dsl, "Create an Airflow DAG inventory with descriptions")).resolves.toBe(goodPlan);
    expect(calls.map((call) => call.label)).toEqual([
      "scout",
      "planner round 1",
      "critic round 1",
      "planner round 2",
      "critic round 2",
    ]);
    expect(calls[3]?.prompt).toContain("Airflow per-item split is incomplete");
    expect(calls[3]?.prompt).toContain("metadata missing");
    expect(calls[3]?.prompt).toContain("Question and Output omit description text entirely");
    expect(calls[3]?.prompt).toContain("repository-relative backticked Output path");
  });

  it("redrafts with the critic's exact defects and retains every round separately", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const secondDraft = PLAN_DRAFT.replace("Advance the offset.", "Advance the offset in `loadPage`.");
    const outputs: Record<string, string> = {
      scout: SCOUT_CONTEXT,
      "planner round 1": PLAN_DRAFT,
      "critic round 1": JSON.stringify({
        verdict: "revise",
        defects: ["S1: `src/page.ts` has no offset variable; name the symbol the step changes"],
      }),
      "planner round 2": secondDraft,
      "critic round 2": '{"verdict":"accept","defects":[]}',
    };
    const { dsl, answers } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    expect(await runWorkflow(dsl, "advance pagination")).toBe(secondDraft);
    expect(calls.map((call) => call.label)).toEqual([
      "scout",
      "planner round 1",
      "critic round 1",
      "planner round 2",
      "critic round 2",
    ]);
    // The second draft receives the first draft and the defect sentence verbatim,
    // numbered — not a summary the script invented.
    expect(calls[3]?.prompt).toContain(PLAN_DRAFT);
    expect(calls[3]?.prompt).toContain("1. S1: `src/page.ts` has no offset variable; name the symbol the step changes");
    // Both rounds are retained under the same reader-facing name: the artifact id
    // is the identity, so nothing is overwritten.
    expect(answers.map((item) => item.ref.name)).toEqual([
      "context.md",
      "plan.md",
      "plan-critique.json",
      "plan.md",
      "plan-critique.json",
    ]);
    expect(answers[1]?.text).toBe(PLAN_DRAFT);
    expect(answers[3]?.text).toBe(secondDraft);
  });

  it("gives every critic round the previous round's defects so the loop converges instead of relitigating", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const defect = "S1: `src/page.ts` has no offset variable; name the symbol the step changes";
    const outputs: Record<string, string> = {
      scout: SCOUT_CONTEXT,
      "planner round 1": PLAN_DRAFT,
      "critic round 1": JSON.stringify({ verdict: "revise", defects: [defect] }),
      "planner round 2": PLAN_DRAFT.replace("Advance the offset.", "Advance the offset in `loadPage`."),
      "critic round 2": '{"verdict":"accept","defects":[]}',
    };
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    await runWorkflow(dsl, "advance pagination");

    const secondCritic = calls.find((call) => call.label === "critic round 2");
    // The exact defect sentence, numbered, inside the previous-defects block —
    // and the ratchet contract that makes new defects earn their place.
    expect(secondCritic?.prompt).toContain("--- BEGIN DEFECTS REPORTED ON THE PREVIOUS DRAFT ---");
    expect(secondCritic?.prompt).toContain(`1. ${defect}`);
    expect(secondCritic?.prompt).toContain("never reopen an aspect of\nthe plan you previously left unflagged");
    const firstCritic = calls.find((call) => call.label === "critic round 1");
    expect(firstCritic?.prompt).toContain("(none; this is the first draft)");
  });

  it("hands the round cap to the operator with the retained draft instead of failing the run", async () => {
    // A draft nobody accepted is still not a plan — the run returns no plan text.
    // But the scout's map and six rounds of drafting are paid for, so the cap
    // retains them and asks the operator instead of burning the run.
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, published, awaiting } = runtimeWith(async (request) => {
      calls.push(request);
      if (request.label === "scout") return completed(request, SCOUT_CONTEXT);
      if (request.label!.startsWith("critic")) {
        return completed(request, JSON.stringify({ verdict: "revise", defects: ["S1: still unverifiable"] }));
      }
      return completed(request, PLAN_DRAFT);
    });

    expect(await runWorkflow(dsl, "advance pagination")).toEqual({
      decision: "needs_operator",
      stoppedBy: "round-cap",
      rounds: 6,
      summary: "plan was not accepted within 6 drafting round(s); awaiting operator guidance",
      unresolvedRows: ["S1: still unverifiable"],
    });
    expect(calls.filter((call) => call.label!.startsWith("planner"))).toHaveLength(6);
    expect(calls.at(-1)?.label).toBe("critic round 6");
    // The stalled state is retained under its own names, ready for continuation.
    // The task is published twice on purpose: once at the start of the run, and
    // again with the other three refs so all four are the run's NEWEST outputs
    // and no amount of schema re-asking can push one out of the terminal
    // projection window the handoff requires them to be inside.
    expect(published.map((item) => item.ref.name)).toEqual([
      "task.md",
      "task.md",
      "context.md",
      "plan.md",
      "unresolved-defects.md",
    ]);
    expect(published[3]?.text).toBe(PLAN_DRAFT);
    expect(published[4]?.text).toBe("1. S1: still unverifiable");
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]).toMatchObject({
      reason: "plan round cap without acceptance",
      operatorHandoff: {
        title: "Plan drafting stalled",
        // A select with one exact option plus free text: the accept decision has
        // to be unambiguous, and a near-miss on a typed phrase would silently
        // become drafting guidance.
        questions: [
          { kind: "select", id: "plan-guidance", options: [{ label: "accept last draft" }], allowCustom: true },
        ],
      },
    });
    const refs = (awaiting[0]?.operatorHandoff as { continuationArtifactRefs: WorkflowArtifactRef[] })
      .continuationArtifactRefs;
    expect(refs.map((ref) => ref.name)).toEqual(["task.md", "context.md", "plan.md", "unresolved-defects.md"]);
  });

  it("lets the operator accept the retained draft without spawning a single agent", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, published, awaiting } = runtimeWith(
      async (request) => {
        calls.push(request);
        return completed(request, "never used");
      },
      { consumed: stalledPlanContinuation() },
    );

    // Case-insensitive around whitespace: this is a human typing an answer.
    expect(await runWorkflow(dsl, "  Accept Last Draft \n")).toBe(PLAN_DRAFT);
    expect(calls).toEqual([]);
    expect(awaiting).toEqual([]);
    // The accepting run republishes the task and the now-accepted plan as its own.
    expect(published.map((item) => item.ref.name)).toEqual(["task.md", "plan.md"]);
    expect(published[1]?.text).toBe(PLAN_DRAFT);
  });

  it("redrafts under operator guidance from the retained state, without re-scouting", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const guided = PLAN_DRAFT.replace("Advance the offset.", "Advance the offset behind the feature flag.");
    const outputs: Record<string, string> = {
      "planner round 1": guided,
      "critic round 1": '{"verdict":"accept","defects":[]}',
    };
    const { dsl, published } = runtimeWith(
      async (request) => {
        calls.push(request);
        return completed(request, outputs[request.label!]!);
      },
      { consumed: stalledPlanContinuation() },
    );
    const guidance = "Keep S1 but do the change behind the existing feature flag; the verify command is fine as is.";

    expect(await runWorkflow(dsl, guidance)).toBe(guided);
    expect(published.map((item) => ({ name: item.ref.name, stage: item.stage }))).toEqual([
      { name: "task.md", stage: "publish-plan" },
      { name: "plan.md", stage: "publish-plan" },
    ]);
    // No scout: the retained context is the map, and the loop restarts at round 1.
    expect(calls.map((call) => call.label)).toEqual(["planner round 1", "critic round 1"]);
    const planner = calls[0]!;
    expect(planner.prompt).toContain("--- BEGIN OPERATOR GUIDANCE ---");
    expect(planner.prompt).toContain(guidance);
    expect(planner.prompt).toContain(PLAN_DRAFT);
    expect(planner.prompt).toContain("1. S1: still unverifiable");
    expect(planner.prompt).toContain("continues a previous run that stalled at its round cap");
    const critic = calls[1]!;
    expect(critic.prompt).toContain("--- BEGIN OPERATOR GUIDANCE ---");
    expect(critic.prompt).toContain("a defect the guidance explicitly waives or\noverrules is not a defect");
    expect(critic.prompt).toContain("1. S1: still unverifiable");
  });

  it("refuses a continuation that does not carry exactly the four retained artifacts", async () => {
    const runWorkflow = await loadWorkflow();
    const partial = stalledPlanContinuation();
    partial.delete("unresolved-defects.md");
    const { dsl } = runtimeWith(async (request) => completed(request, "never used"), { consumed: partial });

    await expect(runWorkflow(dsl, "some guidance")).rejects.toThrow(
      "plan continuation requires exactly task.md, context.md, plan.md, unresolved-defects.md",
    );
  });

  it.each([
    [
      { verdict: "accept", defects: ["a defect nobody will read"] },
      "verdict accept must carry no defects: withdraw them or return verdict revise",
    ],
    [{ verdict: "revise", defects: [] }, "verdict revise must name at least one defect the next draft can close"],
  ])("re-asks the critic for a verdict that disagrees with its own defects", async (verdict, message) => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      if (request.label === "scout") return completed(request, SCOUT_CONTEXT);
      if (request.label!.startsWith("critic")) return completed(request, JSON.stringify(verdict));
      return completed(request, PLAN_DRAFT);
    });

    const rejection = runWorkflow(dsl, "advance pagination");
    await expect(rejection).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(rejection).rejects.toThrow(message);
    // Three attempts: a call that declares `validate` gets one dedicated extra one.
    expect(calls.filter((call) => call.label === "critic round 1")).toHaveLength(3);
    // The re-ask reaches only the call that failed: a stage that answered fine
    // never sees the validator's rejection banner.
    expect(calls[1]?.prompt).not.toContain("REJECTED by the workflow script");
    expect(calls.some((call) => call.label === "planner round 2")).toBe(false);
  });

  it("round-caps into an actionable handoff through the real runner, and the continuation accepts the draft", async () => {
    // The mock-runtime tests above pin the script's behavior; this one pins the
    // seam that broke in the live run this change answers: the cap's declared
    // refs must survive the runner's terminal artifact projection, and the
    // handoff continuation must feed the same workflow back to an accepted plan.
    const root = mkdtempSync(path.join(tmpdir(), "locus-plan-e2e-"));
    try {
      mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
      writeFileSync(
        path.join(root, ".agents", "agents", "default.md"),
        "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
      );
      const harness = createHarness(root, { sessionId: "plan-e2e-parent" });
      const executed: string[] = [];
      const createExecutor = (): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          const role = request.task.includes("map the repository facts")
            ? "scout"
            : request.task.includes("write the complete implementation plan")
              ? "planner"
              : "critic";
          executed.push(role);
          const text =
            role === "scout"
              ? SCOUT_CONTEXT
              : role === "planner"
                ? PLAN_DRAFT
                : '{"verdict":"revise","defects":["S1: still unverifiable"]}';
          return {
            status: "completed",
            agentName: request.agent.name,
            reason: text,
            text,
            diagnostics: [],
            lifecycleEntryIds: [],
          };
        },
      });

      const stalled = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "plan",
        input: "advance pagination",
        createExecutor,
      });

      expect(stalled.ok, stalled.error).toBe(true);
      expect(stalled.disposition).toMatchObject({ status: "awaiting_operator" });
      expect(stalled.operatorHandoff).toBeDefined();
      const refs = stalled.operatorHandoff!.continuationArtifactRefs;
      expect(refs.map((ref) => ref.name)).toEqual(["task.md", "context.md", "plan.md", "unresolved-defects.md"]);
      expect(executed.filter((role) => role === "planner")).toHaveLength(6);

      const accepted = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "plan",
        input: "accept last draft",
        continuation: workflowContinuationForHandoff(stalled.operatorHandoff!),
        createExecutor: () => {
          throw new Error("accepting the retained draft must not spawn an agent");
        },
      });

      expect(accepted.ok, accepted.error).toBe(true);
      expect(accepted.disposition).toMatchObject({ status: "completed" });
      expect(accepted.result).toBe(PLAN_DRAFT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps handoff refs in the terminal projection while re-asked answers stay runtime-only", async () => {
    // Schema re-asks still write exact answer evidence per attempt, but only
    // deliberate publications enter the terminal handoff projection.
    const root = mkdtempSync(path.join(tmpdir(), "locus-plan-projection-"));
    try {
      mkdirSync(path.join(root, ".agents", "agents"), { recursive: true });
      writeFileSync(
        path.join(root, ".agents", "agents", "default.md"),
        "---\nname: default\ndescription: test\nevidence:\n  mode: none\n---\nTest.\n",
      );
      const harness = createHarness(root, { sessionId: "plan-projection-parent" });
      let criticCalls = 0;
      const createExecutor = (): AgentExecutor => ({
        async run(request: AgentRunRequest) {
          if (request.task.includes("map the repository facts")) {
            return completedChild(request, SCOUT_CONTEXT);
          }
          if (request.task.includes("write the complete implementation plan")) {
            return completedChild(request, PLAN_DRAFT);
          }
          criticCalls += 1;
          // Every critic round burns one rejected attempt before answering, which
          // is inside its own re-ask budget and doubles its artifact output.
          return completedChild(
            request,
            criticCalls % 2 === 1
              ? '{"verdict":"accept","defects":["a defect nobody will read"]}'
              : '{"verdict":"revise","defects":["S1: still unverifiable"]}',
          );
        },
      });

      const stalled = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "plan",
        input: "advance pagination",
        createExecutor,
      });

      expect(stalled.ok, stalled.error).toBe(true);
      expect(stalled.disposition).toMatchObject({ status: "awaiting_operator" });
      // Automatic child answers stay runtime-only, so the terminal projection
      // contains the deliberate handoff publications without window pressure.
      expect(stalled.artifactRefsOmitted ?? 0).toBe(0);
      const refs = stalled.operatorHandoff?.continuationArtifactRefs ?? [];
      expect(refs.map((ref) => ref.name)).toEqual(["task.md", "context.md", "plan.md", "unresolved-defects.md"]);
      // And the operator can actually act on it: the continuation is accepted by
      // the host, which re-verifies every ref against that projection.
      const accepted = await runWorkflowScript({
        pi: harness.pi,
        ctx: harness.ctx,
        signal: new AbortController().signal,
        name: "plan",
        input: "accept last draft",
        continuation: workflowContinuationForHandoff(stalled.operatorHandoff!),
        createExecutor,
      });
      expect(accepted.ok, accepted.error).toBe(true);
      expect(accepted.result).toBe(PLAN_DRAFT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an empty task, and bounds nothing the host already bounds", async () => {
    const runWorkflow = await loadWorkflow();
    const { dsl } = runtimeWith(async (request) => completed(request, "unused"));

    await expect(runWorkflow(dsl, "   ")).rejects.toThrow("plan requires a non-empty task");
    await expect(runWorkflow(dsl, { task: "object" })).rejects.toThrow("plan requires a non-empty task");

    // The host caps workflow input on both entry surfaces. A second copy of that
    // number here can only agree with it or wrongly disagree, and the copy that
    // used to live here was never reachable.
    const source = readFileSync(workflowPath, "utf8");
    expect(source).not.toMatch(/MAX_TASK_CHARS|input\.length|taskText\.length/u);
  });
});
