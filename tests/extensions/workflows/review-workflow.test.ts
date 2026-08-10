import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  WorkflowArtifactPorts,
  WorkflowArtifactRef,
  WorkflowBoundContinuation,
  WorkflowConsumedTextArtifact,
} from "../../../extensions/workflows/runtime/workflow-artifacts.js";
import { createWorkflowResourceLoader } from "../../../extensions/workflows/runtime/workflow-resources.js";
import {
  createWorkflowRuntime,
  SchemaValidationError,
  WorkflowAgentExecutionError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/workflows/runtime/workflow-runtime.js";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/review/review.workflow.mjs");

/**
 * What survives as a `promptFile()` charter after the 2026-07-25 threshold
 * migration. The four short stage tasks moved inline; these two are the role
 * charters long enough to bury the routing, which is what the escape hatch is
 * for. Both are navigating stages, so both must carry the AST Index guidance.
 */
const CHARTER_PROMPTS = ["interrogator.prompt.md", "verifier.prompt.md"];
/** Stage tasks that moved into the script and must not reappear as files. */
const INLINED_PROMPTS = [
  "clarifier.prompt.md",
  "scope-resolver.prompt.md",
  "change-inventory.prompt.md",
  "unit-planner.prompt.md",
];

interface PublishedArtifact {
  ref: WorkflowArtifactRef;
  text: string;
  stage?: string;
  kind?: string;
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

function priorRef(runId: string, artifactId: string, name: string, text: string): WorkflowArtifactRef {
  return { runId, artifactId, name, sha256: digest(text) };
}

function prepareTerminal(intentRef: WorkflowArtifactRef, questionsRef: WorkflowArtifactRef) {
  return {
    result: { mode: "prepared", intentRef, questionsRef },
    artifactRefs: [intentRef, questionsRef],
  };
}

function prepareArtifact(
  ref: WorkflowArtifactRef,
  text: string,
  intentRef: WorkflowArtifactRef,
  questionsRef: WorkflowArtifactRef,
): WorkflowConsumedTextArtifact {
  return {
    ref,
    text,
    source: {
      runId: ref.runId,
      target: { kind: "name", ref: "review", source: "package" },
      artifact: { kind: "published", stage: "prepare-clarification" },
      terminal: prepareTerminal(intentRef, questionsRef),
    },
  };
}

function runtimeWith(
  runner: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult>,
  options: { runId?: string; consumed?: Map<string, WorkflowConsumedTextArtifact> } = {},
) {
  const runId = options.runId ?? "review-test";
  const runDir = mkdtempSync(path.join(tmpdir(), "locus-review-workflow-"));
  const resourceLoader = createWorkflowResourceLoader({
    workflowSourcePath: workflowPath,
    runDir,
  });
  const published: PublishedArtifact[] = [];
  const answers: PublishedArtifact[] = [];
  const consumed: WorkflowArtifactRef[] = [];
  const awaiting: Array<{ reason: string }> = [];
  let continuation: WorkflowBoundContinuation | undefined;
  if (options.consumed !== undefined && options.consumed.size > 0) {
    const pairs = [...options.consumed.values()].map((item, index) => {
      consumed.push(item.ref);
      return {
        sourceRef: item.ref,
        consumedArtifact: {
          ...item,
          ref: priorRef(runId, `input-${index + 1}`, item.ref.name, item.text),
        },
      };
    });
    continuation = { originRunId: pairs[0]!.sourceRef.runId, artifacts: pairs };
  }
  const artifactPorts: WorkflowArtifactPorts = {
    recordAgentEvidence(input) {
      if (input.text === undefined) return {};
      const ref = priorRef(runId, `answer-${answers.length + 1}`, input.name, input.text);
      answers.push({ ref, text: input.text, ...(input.stage === undefined ? {} : { stage: input.stage }) });
      return { answer: ref };
    },
    publishText(name, text, stage, kind) {
      const ref = priorRef(runId, `published-${published.length + 1}`, name, text);
      published.push({ ref, text, ...(stage === undefined ? {} : { stage }), ...(kind === undefined ? {} : { kind }) });
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
      resourceLoader,
      artifactPorts,
      onAwaitOperator(declaration) {
        awaiting.push(declaration);
      },
      ...(continuation === undefined ? {} : { continuation }),
      projectRoot: process.cwd(),
    }),
    resourceLoader,
    published,
    answers,
    consumed,
    awaiting,
  };
}

function promptSource(name: string): string {
  return readFileSync(path.join(path.dirname(workflowPath), "resources", name), "utf8");
}

describe("workflow example: review.workflow.mjs", () => {
  it("keeps capability lists out of every model stage and removes the model publisher", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(source).toContain('promptFile("./resources/');
    expect(source).toContain("publishArtifact");
    expect(source).toContain("continuationArtifacts");
    expect(source).toContain("CLARIFIER_SCHEMA");
    // Split on 2026-07-26: one half decides and never throws, the other normalizes
    // and never rejects. Both names are pinned so neither can absorb the other's job.
    expect(source).toContain("function clarifierDecisionErrors");
    expect(source).toContain("function normalizeClarifierDecision");
    expect(source).toContain("validate: clarifierDecisionErrors");
    // The interrogation loop's exit condition is a declared shape plus a
    // cross-field callback, never a scan of the interrogator's Markdown.
    expect(source).toContain("QUESTION_COVERAGE_SCHEMA");
    expect(source).toContain("function questionCoverageErrors");
    expect(source).toContain("validate: questionCoverageErrors");
    expect(source).toContain("const MAX_QUESTION_ROUNDS = 3");
    expect(source).toContain("const REVIEW_AGENT_DEFAULTS");
    // No `maxToolCalls` at all: the package budget contract supplies it, and a
    // stage that restated the default would silently disagree with it the day it moves.
    expect(source.match(/maxToolCalls:/gu)).toBeNull();
    expect(source.match(/workspaceMode:/gu)).toHaveLength(1);
    expect(source).not.toMatch(/\breadOnly:/u);
    expect(source).not.toMatch(/\btools:/u);
    expect(source).not.toMatch(/\bpermissionMode:/u);
    expect(source).toContain("const MAX_CLARIFIER_PROMPT_CHARS = 500");
    expect(source).toContain("Each prompt must fit in ${MAX_CLARIFIER_PROMPT_CHARS} characters");
    expect(source).not.toContain("REVIEW_PUBLISH_OPTIONS");
    expect(source).not.toContain("publish review package");
    expect(source).not.toContain('phase("publish-review")');
    expect(existsSync(path.join(path.dirname(workflowPath), "resources", "publisher.prompt.md"))).toBe(false);
    expect(source).not.toContain("JSON.parse");
    expect(source).not.toContain("parallel");
    for (const name of ["scope.md", "inventory.md", "units.md", "questions.md", "review.md"]) {
      expect(source, name).toContain(`artifact: "${name}"`);
      expect(source, name).not.toContain(`publishArtifact("${name}"`);
    }
    for (const name of CHARTER_PROMPTS) {
      const prompt = promptSource(name);
      expect(prompt, name).toContain("You inherit every tool available to the parent workflow run.");
      expect(prompt, name).toContain("workflow runtime owns");
      expect(prompt, name).toContain("do not modify project files");
    }
  });

  it("keeps the five short stage tasks inline under one COMMON contract", () => {
    const source = readFileSync(workflowPath, "utf8");
    const resources = path.join(path.dirname(workflowPath), "resources");

    for (const name of INLINED_PROMPTS) {
      expect(existsSync(path.join(resources, name)), name).toBe(false);
      expect(source, name).not.toContain(name);
    }
    // Exactly the two charters above the ≳80-line bar remain external.
    expect(readdirSync(resources).sort()).toEqual(CHARTER_PROMPTS);
    expect(source.match(/promptFile\("\.\/resources\//gu)).toHaveLength(2);

    expect(source).toContain("const COMMON = ");
    // One shared contract, prepended by each of the five inline stages: the
    // clarifier, the scope resolver, the inventory, the unit planner, and the
    // question-coverage assessor that decides whether interrogation runs again.
    expect(source.match(/^\s*`\$\{COMMON\}$/gmu)).toHaveLength(5);
    expect(source).toContain("You inherit every tool available to the parent workflow run.");
    expect(source).toContain("do not modify project files");

    // Bounds on free text are per-call runtime gates, not hand-rolled throws.
    for (const bound of [
      "maxAnswerChars: MAX_SCOPE_CHARS",
      "maxAnswerChars: MAX_INVENTORY_CHARS",
      "maxAnswerChars: MAX_UNITS_CHARS",
      "maxAnswerChars: MAX_QUESTIONS_CHARS",
      "maxAnswerChars: MAX_REVIEW_CHARS",
    ]) {
      expect(source, bound).toContain(bound);
    }
  });

  it("keeps the AST Index preference bounded by a grep fallback and only where symbols matter", () => {
    const source = readFileSync(workflowPath, "utf8");

    for (const name of CHARTER_PROMPTS) {
      const prompt = promptSource(name);
      expect(prompt, name).toContain("ast_index");
      expect(prompt, name).toMatch(/A missing AST Index never blocks a\s+review\./u);
      expect(prompt, name).toMatch(/continue with\s+`grep`, `find`, and direct reads/u);
    }
    // Inline, the same guidance is one constant used by the two navigating stages
    // written in the script — the unit planner and the question-coverage assessor,
    // both of which reason about symbols. The clarifier, scope, and inventory
    // stages must not receive it.
    expect(source).toContain("const AST_INDEX_NOTE = ");
    expect(source).toMatch(/A missing AST Index never blocks a\s+review\./u);
    expect(source.match(/\$\{AST_INDEX_NOTE\}/gu)).toHaveLength(2);
  });

  it("requires a reachable path, root-cause dedup, and concern-relative answers from the verifier", () => {
    const verifier = promptSource("verifier.prompt.md");

    expect(verifier).toMatch(/confirmed only\s+when you can name a reachable input/u);
    expect(verifier).toMatch(/"There is no\s+validation here" is not a finding/u);
    expect(verifier).toMatch(/Missing defence in depth is not a defect/u);
    expect(verifier).toMatch(/Deduplicate by root cause before writing findings/u);
    expect(verifier).toMatch(/never `Rejected` for a question whose answer produced a finding/u);
    // Nothing in the script grades the verdict against the findings, so this
    // sentence is the only thing standing between a reader and a review that
    // reports a blocking defect under "ready for acceptance". A live run on
    // 2026-07-28 produced exactly that contradiction.
    expect(verifier).toMatch(/Write `Needs changes` whenever you confirmed even one `P1` or\s+`P2` finding/u);
  });

  it("forbids the inventory to drop what it judged out of scope, and outside its document", () => {
    // A live run on 2026-07-28 saw a real structural defect in the reviewed file,
    // decided it belonged to another class of problem than the operator asked
    // about, and wrote it in prose around the returned document. No later stage
    // reads that prose, so the finished review presented the ground as covered.
    const source = readFileSync(workflowPath, "utf8");

    expect(source).toContain("You do not decide what belongs to this review.");
    expect(source).toMatch(/Anything you noticed in the\s+changed surface gets an id/u);
    expect(source).toMatch(/no later stage\s+reads anything you write outside the returned document/u);
  });

  it("makes the interrogator question a claim the sources cannot settle", () => {
    // Same run: the reviewed document asserted a measured per-call cost that no
    // source can support. It drew no question and no declared limit, so it
    // reached the reader inside a review that claimed full coverage.
    const interrogator = promptSource("interrogator.prompt.md");

    expect(interrogator).toContain("A claim the sources cannot settle still gets a question.");
    expect(interrogator).toMatch(/Ask whether anything in the repository\s+supports the claim/u);
    expect(interrogator).toMatch(/asserts something the\s+repository cannot support, which is a finding/u);
  });

  it("makes every question id carry its question in both question-writing roles", () => {
    // The reader complaint this answers: a review that says `U2-Q3` and nothing
    // else is unreadable on its own, because the question document is a separate
    // artifact. Both roles that emit an id must emit the question beside it.
    const interrogator = promptSource("interrogator.prompt.md");
    const verifier = promptSource("verifier.prompt.md");

    expect(interrogator).toContain("## Every question id carries its question");
    expect(interrogator).toMatch(/Wherever an id\s+appears outside its own `## U<n>-Q<n>` block/u);
    expect(interrogator).toContain("C1: U1; U1-Q1 (Can every direct caller of `run` handle the new null result?)");

    expect(verifier).toContain("## Every question id carries its question");
    expect(verifier).toMatch(/every\s+place an id appears, the question appears with it/u);
    expect(verifier).toMatch(/do not paraphrase it/u);
    // The two templates a reader actually sees: a finding and a resolution.
    expect(verifier).toContain("Question: `U1-Q1` — Can every direct caller of `run` handle the new null result?");
    expect(verifier).toMatch(
      /### U1-Q1\nQuestion: Can every direct caller of `run` handle the new null result\?\nAnswer:/u,
    );
    expect(verifier).toMatch(/each with\s+its own `Question:` line quoting the interrogator's wording/u);
  });

  it("asks the interrogator for the complete set every round and forbids a silent drop", () => {
    const interrogator = promptSource("interrogator.prompt.md");

    expect(interrogator).toContain("{{ROUND_NUMBER}}");
    expect(interrogator).toContain("{{ROUND_CAP}}");
    expect(interrogator).toContain("{{PRIOR_QUESTIONS_TEXT}}");
    expect(interrogator).toContain("{{COVERAGE_GAPS_TEXT}}");
    // The loop only works because each round returns a whole document: the
    // workflow forwards the last round's exact text and never merges two of them.
    expect(interrogator).toMatch(/\*\*Return the complete question set every round, never a delta\.\*\*/u);
    expect(interrogator).toMatch(/Repeat every\s+question from the previous round verbatim/u);
    expect(interrogator).toMatch(/a question you leave out is a question\s+nobody answers/u);
    expect(interrogator).toContain("## Withdrawn questions");
    expect(interrogator).toContain("## Gaps not closed");
  });

  it("carries stable inventory coverage ids through interrogation and final verification", () => {
    // The inventory and unit-planner stages are inline now; the ledger discipline
    // they impose has to survive the move, so it is asserted against the script.
    const source = readFileSync(workflowPath, "utf8");
    const interrogator = promptSource("interrogator.prompt.md");
    const verifier = promptSource("verifier.prompt.md");

    expect(source).toContain("stable coverage ids");
    expect(source).toContain("Coverage: C1, C2");
    expect(source).toMatch(/Every inventory id\s+must appear in exactly one unit/u);
    expect(interrogator).toContain("{{INVENTORY_TEXT}}");
    expect(interrogator).toContain("## Coverage gaps");
    expect(interrogator).toContain("## Coverage reconciliation");
    expect(verifier).toContain("{{INVENTORY_TEXT}}");
    expect(verifier).toContain("original inventory is the coverage source of truth");
    expect(verifier).toContain("never return `Ready for\nhuman acceptance`");
  });

  it("documents exact artifact limits and single runtime-owned model answers", () => {
    const readme = readFileSync(path.join(path.dirname(workflowPath), "README.md"), "utf8");

    expect(readme).toContain("1–128 characters");
    expect(readme).toContain("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    expect(readme).toContain("2,097,152 UTF-8 bytes");
    expect(readme).toContain("Logical names are labels, not lookup keys");
    expect(readme).toContain("clarifier-decision.json");
    expect(readme).toContain("clarification-questions.md");
    expect(readme).toMatch(/avoiding duplicate model-text\s+publications/u);
  });

  it("uses a clarifier decision, forwards exact string intent, and returns verifier text", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      "decide clarification": '{"decision":"continue","questions":[]}',
      "resolve review scope": "  # Review Scope\nTarget: `origin/main...HEAD`\n",
      "inventory changes": "# Change Inventory\n## C1\nPath: `src/a.ts`\nChange: changed",
      "plan review units": "# Review Units\n## U1\nCoverage: C1\nPath: `src/a.ts`",
      "ask review questions round 1": [
        "# Review Questions",
        "## U1-Q1",
        "Question: Does it hold?",
        "## Coverage reconciliation",
        "C1: U1; U1-Q1 (Does it hold?)",
      ].join("\n"),
      "assess question coverage round 1": '{"decision":"complete","gaps":[]}',
      "verify and write review": [
        "# Code Review",
        "## Verdict",
        "Needs changes.",
        "## Coverage and limits",
        "C1: inspected through U1-Q1.",
      ].join("\n"),
    };
    const { dsl, resourceLoader, published, answers } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });
    const intent = "  review current branch; focus exactly on API drift  \n";

    const result = await runWorkflow(dsl, intent);

    expect(result).toBe(outputs["verify and write review"]);
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "resolve review scope",
      "inventory changes",
      "plan review units",
      "ask review questions round 1",
      "assess question coverage round 1",
      "verify and write review",
    ]);
    expect(calls.every((call) => call.readOnly === undefined)).toBe(true);
    expect(calls.every((call) => call.tools?.join(",") === "*")).toBe(true);
    expect(calls.every((call) => call.prompt.includes(intent))).toBe(true);
    expect(calls.map((call) => call.phase)).toEqual([
      "prepare-clarification",
      "resolve-scope",
      "inventory-changes",
      "plan-units",
      "ask-questions",
      "ask-questions",
      "verify-review",
    ]);
    expect(calls[2]?.prompt).toContain(outputs["resolve review scope"]);
    expect(calls[3]?.prompt).toContain(outputs["inventory changes"]);
    expect(calls[4]?.prompt).toContain(outputs["plan review units"]);
    expect(calls[5]?.prompt).toContain(outputs["ask review questions round 1"]);
    expect(calls[6]?.prompt).toContain(outputs["ask review questions round 1"]);
    expect(published.map((item) => item.ref.name)).toEqual(["intent.md", "review.md"]);
    expect(published.at(-1)?.kind).toBe("primary");
    expect(answers.map((item) => item.ref.name)).toEqual([
      "clarifier-decision.json",
      "scope.md",
      "inventory.md",
      "units.md",
      "questions.md",
      "question-coverage.json",
      "review.md",
    ]);
    expect(published[0]?.text).toBe(intent);
    expect(published[0]?.stage).toBe("resolve-scope");
    expect(answers.at(-1)?.text).toBe(result);
    // Two prompt files remain: the interrogator and verifier charters.
    expect(resourceLoader.evidence()).toHaveLength(2);
  });

  it("prepares clarification with exact persisted intent and complete artifact references", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, published, answers, awaiting } = runtimeWith(
      async (request) => {
        calls.push(request);
        return completed(
          request,
          JSON.stringify({
            decision: "needs_operator",
            questions: [
              {
                id: "review-scope",
                prompt: "Which base?",
                options: ["Current changes", "Last commit"],
                recommended: "Current changes",
                allowCustom: true,
              },
            ],
          }),
        );
      },
      { runId: "prepare-run" },
    );
    const intent = "  review this, but preserve my spacing  \n";

    const result = await runWorkflow(dsl, intent);

    expect(result).toEqual({
      mode: "prepared",
      intentRef: published[0]?.ref,
      questionsRef: published[1]?.ref,
    });
    expect(published.map((item) => [item.ref.name, item.text])).toEqual([
      ["intent.md", intent],
      [
        "clarification-questions.md",
        "# Clarification Questions\n\n1. Which base?\n   - Current changes\n   - Last commit",
      ],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.label).toBe("decide clarification");
    expect(calls[0]?.readOnly).toBeUndefined();
    expect(calls[0]?.tools).toEqual(["*"]);
    expect(calls[0]?.prompt).toContain(intent);
    expect(answers.map((item) => item.ref.name)).toEqual(["clarifier-decision.json"]);
    expect(awaiting).toEqual([
      {
        reason: "review clarification required",
        operatorHandoff: {
          title: "Review clarification",
          questions: [
            {
              kind: "select",
              id: "review-scope",
              prompt: "Which base?",
              options: [{ label: "Current changes" }, { label: "Last commit" }],
              recommended: "Current changes",
              allowCustom: true,
            },
          ],
          continuationArtifactRefs: [published[0]?.ref, published[1]?.ref],
        },
      },
    ]);
  });

  it.each([
    [
      {
        decision: "continue",
        questions: [{ id: "unexpected", prompt: "Unexpected question", options: [], allowCustom: true }],
      },
      'questions: expected 0 item(s) when decision is "continue", got 1',
    ],
    [
      { decision: "needs_operator", questions: [] },
      'questions: expected at least 1 item(s) when decision is "needs_operator", got 0',
    ],
    [
      {
        decision: "needs_operator",
        questions: [{ id: "scope", prompt: "Which base?", options: [], allowCustom: false }],
      },
      "questions[0]: expected an option or allowCustom true, got 0 option(s) and allowCustom false",
    ],
    [
      {
        decision: "needs_operator",
        questions: [{ id: "scope", prompt: "Which base?", options: ["Keep"], recommended: "Drop", allowCustom: true }],
      },
      'questions[0].recommended: value "Drop" is not one of questions[0].options',
    ],
  ])(
    "re-asks the clarifier for a cross-field violation, then fails closed before review stages",
    async (decision, message) => {
      // Each of these ended the run on the first answer until 2026-07-26: a count that
      // depends on the sibling `decision` field, and a `recommended` that must name a
      // real option of the same question. Passed to the runtime as `validate` they are
      // handed back to the child in their own repair block, and only exhaustion is fatal.
      const calls: WorkflowAgentRequest[] = [];
      const { dsl, published, awaiting } = runtimeWith(async (request) => {
        calls.push(request);
        return completed(request, JSON.stringify(decision));
      });

      const rejection = (await loadWorkflow())(dsl, "review current branch");
      await expect(rejection).rejects.toBeInstanceOf(SchemaValidationError);
      await expect(rejection).rejects.toThrow(message);
      // Three, not two: a call that declares `validate` gets one dedicated extra attempt.
      expect(calls.map((call) => call.label)).toEqual([
        "decide clarification",
        "decide clarification",
        "decide clarification",
      ]);
      expect(calls[1]?.prompt).toContain("matched the required shape but was REJECTED by the workflow script for:");
      expect(calls[1]?.prompt).toContain(message);
      expect(published).toHaveLength(0);
      expect(awaiting).toHaveLength(0);
    },
  );

  it("cannot reach the combined prompt budget through the declared bounds", () => {
    // Reported, not silently migrated: `maxItems: 8` and `maxLength: 500` cap the
    // combined trimmed prompt length at exactly 4,000, and the budget rejects only
    // ABOVE 4,000 — so no schema-valid answer can trip it. It moved into `validate`
    // with the other cross-item rules and is exercised at the runtime level in
    // workflow-agent-validate.test.ts; here it is pinned as arithmetic, which is the
    // only honest end-to-end assertion available.
    const source = readFileSync(workflowPath, "utf8");
    const bound = (name: string) =>
      Number(new RegExp(`const ${name} = ([0-9_]+);`, "u").exec(source)?.[1]?.replace(/_/gu, "") ?? Number.NaN);

    expect(bound("MAX_CLARIFIER_QUESTIONS") * bound("MAX_CLARIFIER_PROMPT_CHARS")).toBeLessThanOrEqual(
      bound("MAX_ALL_CLARIFIER_PROMPTS_CHARS"),
    );
  });

  it("re-asks the clarifier for a repeated question id instead of ending the run on the first answer", async () => {
    // Question-id uniqueness was a script `throw` until 2026-07-26, so this
    // exact input used to end the run on the first answer. Declared as
    // `uniqueBy: "id"` it is handed back to the child, which is why the call
    // count is two and the retry prompt has to carry the message.
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, published, awaiting } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(
        request,
        JSON.stringify({
          decision: "needs_operator",
          questions: [
            { id: "same", prompt: "First?", options: [], allowCustom: true },
            { id: "same", prompt: "Second?", options: [], allowCustom: true },
          ],
        }),
      );
    });

    const rejection = (await loadWorkflow())(dsl, "review current branch");
    await expect(rejection).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(rejection).rejects.toThrow('questions[1].id: value "same" duplicates item 0');
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "decide clarification",
      "decide clarification",
    ]);
    expect(calls[1]?.prompt).toContain('questions[1].id: value "same" duplicates item 0');
    expect(published).toHaveLength(0);
    expect(awaiting).toHaveLength(0);
  });

  it("rejects options that differ only by surrounding whitespace in the schema, not the normalizer", async () => {
    // The canonicalization pin: `normalizeClarifierDecision` trims every label, so
    // two labels the validator accepted must never collapse into one afterwards.
    // `uniqueTrimmedItems` trims with the same `String.prototype.trim`.
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, awaiting } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(
        request,
        JSON.stringify({
          decision: "needs_operator",
          questions: [{ id: "scope", prompt: "Which base?", options: ["Keep", " Keep "], allowCustom: false }],
        }),
      );
    });

    const rejection = (await loadWorkflow())(dsl, "review current branch");
    await expect(rejection).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(rejection).rejects.toThrow('questions[0].options[1]: trimmed value "Keep" duplicates item 0');
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "decide clarification",
      "decide clarification",
    ]);
    expect(awaiting).toHaveLength(0);
  });

  it("re-asks the clarifier for a whitespace-only prompt the length bound cannot see", async () => {
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, awaiting } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(
        request,
        JSON.stringify({
          decision: "needs_operator",
          questions: [{ id: "scope", prompt: "   ", options: [], allowCustom: true }],
        }),
      );
    });

    await expect((await loadWorkflow())(dsl, "review current branch")).rejects.toThrow(
      "questions[0].prompt: expected a non-blank string, got 3 whitespace character(s)",
    );
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "decide clarification",
      "decide clarification",
    ]);
    expect(awaiting).toHaveLength(0);
  });

  it("re-asks the clarifier for a declared bound instead of ending the run on the first answer", async () => {
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, published, awaiting } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(
        request,
        JSON.stringify({
          decision: "needs_operator",
          questions: [{ id: "long", prompt: "x".repeat(501), options: [], allowCustom: true }],
        }),
      );
    });

    // The 500-character prompt bound used to be a script `throw`, which ended
    // the run on the first answer. Declared as `maxLength` it is handed back to
    // the child by the schema retry, so the child gets a second chance and the
    // failure still closes.
    await expect((await loadWorkflow())(dsl, "review current branch")).rejects.toThrow(
      "questions[0].prompt: expected at most 500 character(s), got 501",
    );
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "decide clarification",
      "decide clarification",
    ]);
    expect(calls[1]?.prompt).toContain("expected at most 500 character(s), got 501");
    expect(published).toHaveLength(0);
    expect(awaiting).toHaveLength(0);
  });

  it("executes from verified same-run references, persists answers, and forwards the original intent", async () => {
    const runWorkflow = await loadWorkflow();
    const intentText = "review range A...B; focus on compatibility";
    const questionsText = "# Clarification Questions\n1. Include generated files?";
    const intentRef = priorRef("prepare-run", "published-1", "intent.md", intentText);
    const questionsRef = priorRef("prepare-run", "published-2", "clarification-questions.md", questionsText);
    const prior = new Map([
      [`${intentRef.runId}:${intentRef.artifactId}`, prepareArtifact(intentRef, intentText, intentRef, questionsRef)],
      [
        `${questionsRef.runId}:${questionsRef.artifactId}`,
        prepareArtifact(questionsRef, questionsText, intentRef, questionsRef),
      ],
    ]);
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, consumed, published, answers } = runtimeWith(
      async (request) => {
        calls.push(request);
        const outputs: Record<string, string> = {
          "resolve review scope": "# Review Scope\nTarget: A...B",
          "inventory changes": "# Change Inventory\n## C1\nPath: `src/a.ts`\nChange: changed",
          "plan review units": "# Review Units\n## U1\nCoverage: C1\nPath: `src/a.ts`",
          "ask review questions round 1":
            "# Review Questions\n## Coverage reconciliation\nC1: U1; No question needed: trivial change",
          "assess question coverage round 1": '{"decision":"complete","gaps":[]}',
          "verify and write review": "# Code Review\nReady.\n## Coverage and limits\nC1: U1; inspected",
        };
        return completed(request, outputs[request.label!]!);
      },
      { runId: "execute-run", consumed: prior },
    );

    const result = await runWorkflow(dsl, "Include generated files only when tracked.");

    expect(result).toBe("# Code Review\nReady.\n## Coverage and limits\nC1: U1; inspected");
    expect(consumed).toEqual([intentRef, questionsRef]);
    expect(published.map((item) => item.ref.name)).toEqual(["clarification-answers.md", "review.md"]);
    expect(answers.map((item) => item.ref.name)).toEqual([
      "scope.md",
      "inventory.md",
      "units.md",
      "questions.md",
      "question-coverage.json",
      "review.md",
    ]);
    expect(calls.every((call) => call.prompt.includes(intentText))).toBe(true);
    expect(calls[0]?.prompt).toContain(questionsText);
    expect(calls[0]?.prompt).toContain("Include generated files only when tracked.");
  });

  it("no longer re-derives the prepare run's provenance, and says so in the source", () => {
    // Owner decision 6, 2026-07-29. Two checks wearing one name were deleted here.
    //
    // The DIGEST half — matching `{runId, artifactId, name, sha256}` against the source
    // run's terminal projection — duplicated what the host refuses to skip before this
    // module starts. Its replacement proof is a real artifact store refusing an
    // unprojected ref and refusing tampered bytes, in
    // `tests/extensions/workflows/review-remediation-workflows.test.ts`; the fake ports
    // this file uses could never have proven it.
    //
    // The SEMANTIC half asserted that the consumed bytes were the terminal result of a
    // Package `review` `prepare-clarification` run — provenance the host does not check
    // and no agent can. The operator picks the source run through the closed
    // `continuation` control and the host verifies what they picked.
    const source = readFileSync(workflowPath, "utf8");

    expect(source).not.toContain("requirePrepareArtifact");
    expect(source).not.toContain("exactPrepareResult");
    expect(source).not.toContain("sameArtifactRef");
    expect(source).not.toContain("sha256");
    // The continuation SHAPE gate is upstream of all of it and stays.
    expect(source).toContain("review continuation requires exactly intent.md and clarification-questions.md");
  });

  it("accepts host-verified clarification artifacts from a differently-targeted run — the recorded residual risk", async () => {
    // The accepted trade, asserted as taken: it fails loudly if the semantic half is
    // quietly restored. The residual risk is answering questions from some other run,
    // which re-running with the right source fixes.
    const runWorkflow = await loadWorkflow();
    const intentText = "review range A...B";
    const questionsText = "# Clarification Questions\n1. Which base?";
    const intentRef = priorRef("arbitrary-run", "published-1", "intent.md", intentText);
    const questionsRef = priorRef("arbitrary-run", "published-2", "clarification-questions.md", questionsText);
    const arbitrary = (ref: WorkflowArtifactRef, text: string): WorkflowConsumedTextArtifact => ({
      ...prepareArtifact(ref, text, intentRef, questionsRef),
      source: {
        runId: ref.runId,
        target: { kind: "scriptPath" as const, ref: "arbitrary.workflow.mjs", source: "project" as const },
        artifact: { kind: "published" as const, stage: "prepare-clarification" },
        terminal: prepareTerminal(intentRef, questionsRef),
      },
    });
    const prior = new Map([
      [`${intentRef.runId}:${intentRef.artifactId}`, arbitrary(intentRef, intentText)],
      [`${questionsRef.runId}:${questionsRef.artifactId}`, arbitrary(questionsRef, questionsText)],
    ]);
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, published } = runtimeWith(
      async (request) => {
        calls.push(request);
        const outputs: Record<string, string> = {
          "resolve review scope": "# Review Scope\nTarget: A...B",
          "inventory changes": "# Change Inventory\n## C1\nPath: `src/a.ts`\nChange: changed",
          "plan review units": "# Review Units\n## U1\nCoverage: C1\nPath: `src/a.ts`",
          "ask review questions round 1":
            "# Review Questions\n## Coverage reconciliation\nC1: U1; No question needed: trivial change",
          "assess question coverage round 1": '{"decision":"complete","gaps":[]}',
          "verify and write review": "# Code Review\nReady.\n## Coverage and limits\nC1: U1; inspected",
        };
        return completed(request, outputs[request.label!]!);
      },
      { runId: "execute-run", consumed: prior },
    );

    await expect(runWorkflow(dsl, "Use A as the base.")).resolves.toBe(
      "# Code Review\nReady.\n## Coverage and limits\nC1: U1; inspected",
    );
    // The operator's answers were still persisted by the workflow, unchanged.
    expect(published.map((item) => item.ref.name)).toEqual(["clarification-answers.md", "review.md"]);
  });

  it("keeps host-owned continuation identity and provenance out of the retry loop entirely", async () => {
    // The safety boundary. A re-ask can only be offered where the model has exactly
    // one satisfying move: comply. Continuation identity and prepare-artifact
    // provenance are the HOST's evidence about which run produced what, and no
    // child can repair them — handing them back as bullets would coach a model
    // toward fabricating the provenance the host is supposed to own. This pins that
    // they still end the run, with no child asked and none re-asked.
    const runWorkflow = await loadWorkflow();
    const intentText = "review range A...B";
    const questionsText = "# Clarification Questions\n1. Which base?";
    const intentRef = priorRef("prepare-run", "published-1", "intent.md", intentText);
    const questionsRef = priorRef("prepare-run", "published-2", "clarification-questions.md", questionsText);
    const calls: WorkflowAgentRequest[] = [];
    // Exactly one continuation artifact where the workflow requires two: the
    // continuation-identity gate, upstream of every provenance check.
    const { dsl, published } = runtimeWith(
      async (request) => {
        calls.push(request);
        return completed(request, "unused");
      },
      {
        runId: "execute-run",
        consumed: new Map([
          [
            `${intentRef.runId}:${intentRef.artifactId}`,
            prepareArtifact(intentRef, intentText, intentRef, questionsRef),
          ],
        ]),
      },
    );

    await expect(runWorkflow(dsl, "Use A as the base.")).rejects.toThrow(
      "review continuation requires exactly intent.md and clarification-questions.md",
    );
    expect(calls).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  // A clean worktree is an answer, not a defect: the run that produced
  // `20260725-000629-269d` failed with "review inventory has no C<n> coverage
  // headings" only because the scope was legitimately empty.
  it("completes with a no-changes result when the inventory declares an empty scope", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      "decide clarification": '{"decision":"continue","questions":[]}',
      "resolve review scope": "# Review Scope\nTarget: `working tree vs index (git diff)`",
      "inventory changes": [
        "# Change Inventory",
        "## No changes",
        "Reason: git diff reports no unstaged tracked changes.",
      ].join("\n"),
    };
    const { dsl, answers } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    const result = await runWorkflow(dsl, "unstaged");

    expect(result).toEqual({
      mode: "no-changes",
      summary: "review found no changed surface in the resolved scope — git diff reports no unstaged tracked changes.",
      reviewedUnits: 0,
    });
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "resolve review scope",
      "inventory changes",
    ]);
    expect(answers.map((item) => item.ref.name)).toEqual(["clarifier-decision.json", "scope.md", "inventory.md"]);
  });

  it("keeps a no-changes summary when the empty inventory omits its reason line", async () => {
    const runWorkflow = await loadWorkflow();
    const outputs: Record<string, string> = {
      "decide clarification": '{"decision":"continue","questions":[]}',
      "resolve review scope": "# Review Scope\nTarget: working tree",
      "inventory changes": "# Change Inventory\n## No changes",
    };
    const { dsl } = runtimeWith(async (request) => completed(request, outputs[request.label!]!));

    expect(await runWorkflow(dsl, "unstaged")).toMatchObject({
      mode: "no-changes",
      summary:
        "review found no changed surface in the resolved scope — the change inventory reported no changed surface in the resolved scope",
    });
  });

  // Handoffs pass forward as exact text: the entry orchestrates and bounds, and
  // does not grade Markdown grammar. Coverage ids stay prompt discipline the
  // interrogator and verifier reconcile, so imperfect prose reaches the next stage
  // instead of ending a run that already spent several model calls.
  it("passes an inventory with no coverage ids forward instead of ending the run", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      "decide clarification": '{"decision":"continue","questions":[]}',
      "resolve review scope": "# Review Scope\nTarget: working tree",
      "inventory changes": "# Change Inventory\n\nI looked around and found some stuff.",
      "plan review units": "# Review Units\n## U1\nPath: `src/a.ts`",
      "ask review questions round 1": "# Review Questions\n## U1-Q1\nQuestion: Does it hold?",
      "assess question coverage round 1": '{"decision":"complete","gaps":[]}',
      "verify and write review": "# Code Review\n## Verdict\nNeeds changes.",
    };
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    expect(await runWorkflow(dsl, "review the worktree")).toBe(outputs["verify and write review"]);
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "resolve review scope",
      "inventory changes",
      "plan review units",
      "ask review questions round 1",
      "assess question coverage round 1",
      "verify and write review",
    ]);
    // Every stage still receives the exact preceding handoff.
    expect(calls[3]?.prompt).toContain(outputs["inventory changes"]);
    expect(calls[6]?.prompt).toContain(outputs["ask review questions round 1"]);
  });

  it("keeps reviewing when a stage drops or misassigns a coverage id", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      "decide clarification": '{"decision":"continue","questions":[]}',
      "resolve review scope": "# Review Scope\nTarget: working tree",
      "inventory changes": [
        "# Change Inventory",
        "## C1",
        "Path: `src/kept.ts`",
        "Change: Kept item.",
        "## C2",
        "Path: `src/dropped.ts`",
        "Change: Dropped by the unit handoff.",
      ].join("\n"),
      "plan review units": "# Review Units\n## U1\nCoverage: C1\nPath: `src/kept.ts`",
      "ask review questions round 1": "# Review Questions\n## Coverage reconciliation\nC1: U2; U2-Q1 (Does it hold?)",
      "assess question coverage round 1": '{"decision":"complete","gaps":[]}',
      "verify and write review": [
        "# Code Review",
        "## Verdict",
        "Needs changes.",
        "## Coverage and limits",
        "C1: U1; inspected",
        "A prose mention says C2 was inspected.",
      ].join("\n"),
    };
    const { dsl, answers } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    expect(await runWorkflow(dsl, "review the dirty worktree")).toBe(outputs["verify and write review"]);
    expect(calls).toHaveLength(7);
    // The dropped id remains visible as evidence in the retained handoffs.
    expect(answers.map((item) => item.ref.name)).toEqual([
      "clarifier-decision.json",
      "scope.md",
      "inventory.md",
      "units.md",
      "questions.md",
      "question-coverage.json",
      "review.md",
    ]);
  });

  it("keeps reviewing when the inventory declares emptiness together with a coverage id", async () => {
    const runWorkflow = await loadWorkflow();
    const outputs: Record<string, string> = {
      "decide clarification": '{"decision":"continue","questions":[]}',
      "resolve review scope": "# Review Scope\nTarget: working tree",
      "inventory changes": [
        "# Change Inventory",
        "## No changes",
        "Reason: nothing changed.",
        "## C1",
        "Path: `src/a.ts`",
        "Change: except this.",
      ].join("\n"),
      "plan review units": "# Review Units\n## U1\nCoverage: C1\nPath: `src/a.ts`",
      "ask review questions round 1": "# Review Questions\n## U1-Q1\nQuestion: Does it hold?",
      "assess question coverage round 1": '{"decision":"complete","gaps":[]}',
      "verify and write review": "# Code Review\n## Verdict\nNeeds changes.",
    };
    const { dsl } = runtimeWith(async (request) => completed(request, outputs[request.label!]!));

    // A contradictory inventory is not an empty scope: the review continues.
    expect(await runWorkflow(dsl, "review the worktree")).toBe(outputs["verify and write review"]);
  });

  /** Everything before interrogation, so a loop test only writes the loop. */
  function preInterrogationOutputs(): Record<string, string> {
    return {
      "decide clarification": '{"decision":"continue","questions":[]}',
      "resolve review scope": "# Review Scope\nTarget: working tree",
      "inventory changes": "# Change Inventory\n## C1\nPath: `src/a.ts`\nChange: changed",
      "plan review units": "# Review Units\n## U1\nCoverage: C1\nPath: `src/a.ts`",
      "verify and write review": "# Code Review\n## Verdict\nNeeds changes.",
    };
  }

  it("asks another question round with the assessor's exact gaps, and forwards the last round only", async () => {
    // One interrogation call used to be the whole stage, so a risk the first
    // reader did not think of was never asked about. The assessor decides between
    // rounds, and what it reports is handed to the next round as its own text.
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      ...preInterrogationOutputs(),
      "ask review questions round 1": "# Review Questions\n## U1-Q1\nQuestion: Does the guard hold?",
      "assess question coverage round 1": JSON.stringify({
        decision: "more_questions_needed",
        gaps: ["U1: no question asks whether the new null result reaches `renderRow`"],
      }),
      "ask review questions round 2": [
        "# Review Questions",
        "## U1-Q1",
        "Question: Does the guard hold?",
        "## U1-Q2",
        "Question: Can `renderRow` handle the new null result?",
      ].join("\n"),
      "assess question coverage round 2": '{"decision":"complete","gaps":[]}',
    };
    const { dsl, answers } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    const result = await runWorkflow(dsl, "review the worktree");

    expect(result).toBe(outputs["verify and write review"]);
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "resolve review scope",
      "inventory changes",
      "plan review units",
      "ask review questions round 1",
      "assess question coverage round 1",
      "ask review questions round 2",
      "assess question coverage round 2",
      "verify and write review",
    ]);
    // The second round receives the first round's complete text and the exact
    // gap sentence, numbered — not a summary the script invented.
    expect(calls[6]?.prompt).toContain(outputs["ask review questions round 1"]);
    expect(calls[6]?.prompt).toContain("1. U1: no question asks whether the new null result reaches `renderRow`");
    // The verifier answers the last round, which is the complete set. The script
    // forwards that one document; it never concatenates the rounds.
    expect(calls[8]?.prompt).toContain(
      `--- BEGIN REVIEW QUESTIONS ---\n${outputs["ask review questions round 2"]}\n--- END REVIEW QUESTIONS ---`,
    );
    // Both rounds are retained under the same reader-facing name; the artifact id
    // is the identity, so nothing is overwritten and nothing is merged.
    expect(answers.map((item) => item.ref.name)).toEqual([
      "clarifier-decision.json",
      "scope.md",
      "inventory.md",
      "units.md",
      "questions.md",
      "question-coverage.json",
      "questions.md",
      "question-coverage.json",
      "review.md",
    ]);
    expect(answers[4]?.text).toBe(outputs["ask review questions round 1"]);
    expect(answers[6]?.text).toBe(outputs["ask review questions round 2"]);
  });

  it("assesses even the round it cannot follow, and hands the surviving gaps to the verifier", async () => {
    // The cap is the safety net, not the exit condition — but a run that skips
    // the last assessment can only ever report "the cap stopped me", which reads
    // the same whether the question set was complete or the assessor was still
    // arguing with it. The final verdict is evidence rather than a branch: the
    // gaps it names reach the verifier as declared limits of the review.
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      const fixed = preInterrogationOutputs()[request.label!];
      if (fixed !== undefined) return completed(request, fixed);
      if (request.label!.startsWith("assess question coverage")) {
        return completed(request, JSON.stringify({ decision: "more_questions_needed", gaps: ["still uncovered"] }));
      }
      return completed(request, `# Review Questions\n## U1-Q1\nQuestion: Round ${request.label!.at(-1)}?`);
    });

    expect(await runWorkflow(dsl, "review the worktree")).toBe("# Code Review\n## Verdict\nNeeds changes.");
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "resolve review scope",
      "inventory changes",
      "plan review units",
      "ask review questions round 1",
      "assess question coverage round 1",
      "ask review questions round 2",
      "assess question coverage round 2",
      "ask review questions round 3",
      "assess question coverage round 3",
      "verify and write review",
    ]);
    // The gap the third assessment still reported is written into the verifier's
    // prompt, so an unasked question becomes a stated limit instead of silence.
    expect(calls.at(-1)?.prompt).toContain("COVERAGE GAPS NOBODY ASKED ABOUT");
    expect(calls.at(-1)?.prompt).toContain("still uncovered");
  });

  it.each([
    [
      { decision: "complete", gaps: ["a gap nobody will read"] },
      'gaps: expected 0 item(s) when decision is "complete", got 1',
    ],
    [
      { decision: "more_questions_needed", gaps: [] },
      'gaps: expected at least 1 item(s) when decision is "more_questions_needed", got 0',
    ],
    [
      {
        decision: "more_questions_needed",
        gaps: ["x".repeat(400), "y".repeat(400), "z".repeat(400), "w".repeat(400), "v".repeat(400), "u".repeat(400)],
      },
      "gaps: expected at most 2000 combined character(s), got 2400",
    ],
  ])("re-asks the coverage assessor for a cross-field violation, then fails closed", async (coverage, message) => {
    // Unlike the clarifier's combined-prompt budget, this one is reachable: six
    // schema-valid 400-character gaps exceed it, so the sum is a real rule the
    // assessor is re-asked about rather than arithmetic that can never fire.
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      const fixed = preInterrogationOutputs()[request.label!];
      if (fixed !== undefined) return completed(request, fixed);
      if (request.label!.startsWith("assess question coverage")) {
        return completed(request, JSON.stringify(coverage));
      }
      return completed(request, "# Review Questions\n## U1-Q1\nQuestion: Does it hold?");
    });

    const rejection = runWorkflow(dsl, "review the worktree");
    await expect(rejection).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(rejection).rejects.toThrow(message);
    expect(calls.filter((call) => call.label === "assess question coverage round 1")).toHaveLength(3);
    expect(calls.some((call) => call.label === "verify and write review")).toBe(false);
  });

  it("bounds direct intent and model handoffs before forwarding them", async () => {
    const runWorkflow = await loadWorkflow();
    let agentCalls = 0;
    const { dsl } = runtimeWith(async (request) => {
      agentCalls += 1;
      return completed(
        request,
        request.label === "decide clarification" ? '{"decision":"continue","questions":[]}' : "x".repeat(64_001),
      );
    });

    await expect(runWorkflow(dsl, "x".repeat(16_001))).rejects.toThrow("16000-character context limit");
    expect(agentCalls).toBe(0);
    await expect(runWorkflow(dsl, "review current branch")).rejects.toThrow(
      "Agent answer is 64001 characters; the call allows 64000. Budget axis: answerChars.",
    );
    expect(agentCalls).toBe(2);
  });

  it("refuses empty or object-valued semantic input", async () => {
    const runWorkflow = await loadWorkflow();
    const { dsl } = runtimeWith(async (request) => completed(request, "unused"));
    await expect(runWorkflow(dsl, "   ")).rejects.toThrow("intent must be a non-empty string");
    await expect(runWorkflow(dsl, { mode: "unknown" })).rejects.toThrow("intent must be a non-empty string");
  });

  it("stops the pipeline at the first failing stage", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      if (request.label === "decide clarification") {
        return completed(request, '{"decision":"continue","questions":[]}');
      }
      if (request.label === "plan review units") {
        return {
          ok: false,
          status: "failed",
          summary: "unit planner failed",
          diagnostics: ["provider unavailable"],
          agent: request.agent,
          label: request.label,
        };
      }
      return completed(
        request,
        request.label === "inventory changes"
          ? "# Change Inventory\n## C1\nPath: `src/a.ts`\nChange: changed"
          : `${request.label} text`,
      );
    });

    await expect(runWorkflow(dsl, "review current branch")).rejects.toBeInstanceOf(WorkflowAgentExecutionError);
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "resolve review scope",
      "inventory changes",
      "plan review units",
    ]);
  });
});
