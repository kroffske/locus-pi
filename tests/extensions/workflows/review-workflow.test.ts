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
} from "../../../extensions/_shared/workflow-artifacts.js";
import { createWorkflowResourceLoader } from "../../../extensions/_shared/workflow-resources.js";
import {
  createWorkflowRuntime,
  SchemaValidationError,
  WorkflowAgentExecutionError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

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
    publishText(name, text, stage) {
      const ref = priorRef(runId, `published-${published.length + 1}`, name, text);
      published.push({ ref, text, ...(stage === undefined ? {} : { stage }) });
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
  it("keeps every model stage read-only and removes the model publisher", () => {
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
    expect(source).toContain("const REVIEW_AGENT_DEFAULTS");
    expect(source.match(/maxToolCalls:/gu)).toHaveLength(1);
    expect(source.match(/workspaceMode:/gu)).toHaveLength(1);
    expect(source.match(/readOnly: true/gu)).toHaveLength(2);
    expect(source).toContain('tools: ["read", "git_read", "grep", "find"]');
    expect(source).toContain('tools: ["read", "git_read", "ast_index", "grep", "find"]');
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
      expect(prompt, name).toContain("This stage is host-enforced read-only.");
      expect(prompt, name).toContain("workflow runtime owns");
      expect(prompt, name).toContain("You have no shell");
      expect(prompt, name).toContain("git_read");
    }
  });

  it("keeps the four short stage tasks inline under one COMMON contract", () => {
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
    // One shared contract, prepended by each of the four inline stages.
    expect(source.match(/^\s*`\$\{COMMON\}$/gmu)).toHaveLength(4);
    expect(source).toContain("This stage is host-enforced read-only.");
    expect(source).toContain("You have no shell");

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
    // Inline, the same guidance is one constant used by the one navigating stage
    // that moved into the script; the clarifier, scope, and inventory stages
    // must not receive it.
    expect(source).toContain("const AST_INDEX_NOTE = ");
    expect(source).toMatch(/A missing AST Index never blocks a\s+review\./u);
    expect(source.match(/\$\{AST_INDEX_NOTE\}/gu)).toHaveLength(1);
  });

  it("requires a reachable path, root-cause dedup, and concern-relative answers from the verifier", () => {
    const verifier = promptSource("verifier.prompt.md");

    expect(verifier).toMatch(/confirmed only\s+when you can name a reachable input/u);
    expect(verifier).toMatch(/"There is no\s+validation here" is not a finding/u);
    expect(verifier).toMatch(/Missing defence in depth is not a defect/u);
    expect(verifier).toMatch(/Deduplicate by root cause before writing findings/u);
    expect(verifier).toMatch(/never `Rejected` for a question whose answer produced a finding/u);
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
      "ask review questions": [
        "# Review Questions",
        "## U1-Q1",
        "Question: Does it hold?",
        "## Coverage reconciliation",
        "C1: U1-Q1",
      ].join("\n"),
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
      "ask review questions",
      "verify and write review",
    ]);
    expect(calls.every((call) => call.readOnly === true)).toBe(true);
    expect(calls.every((call) => call.prompt.includes(intent))).toBe(true);
    expect(calls.map((call) => call.phase)).toEqual([
      "prepare-clarification",
      "resolve-scope",
      "inventory-changes",
      "plan-units",
      "ask-questions",
      "verify-review",
    ]);
    expect(calls[2]?.prompt).toContain(outputs["resolve review scope"]);
    expect(calls[3]?.prompt).toContain(outputs["inventory changes"]);
    expect(calls[4]?.prompt).toContain(outputs["plan review units"]);
    expect(calls[5]?.prompt).toContain(outputs["ask review questions"]);
    expect(published.map((item) => item.ref.name)).toEqual(["intent.md"]);
    expect(answers.map((item) => item.ref.name)).toEqual([
      "clarifier-decision.json",
      "scope.md",
      "inventory.md",
      "units.md",
      "questions.md",
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
    expect(calls[0]?.readOnly).toBe(true);
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
          "ask review questions":
            "# Review Questions\n## Coverage reconciliation\nC1: U1; No question needed: trivial change",
          "verify and write review": "# Code Review\nReady.\n## Coverage and limits\nC1: U1; inspected",
        };
        return completed(request, outputs[request.label!]!);
      },
      { runId: "execute-run", consumed: prior },
    );

    const result = await runWorkflow(dsl, "Include generated files only when tracked.");

    expect(result).toBe("# Code Review\nReady.\n## Coverage and limits\nC1: U1; inspected");
    expect(consumed).toEqual([intentRef, questionsRef]);
    expect(published.map((item) => item.ref.name)).toEqual(["clarification-answers.md"]);
    expect(answers.map((item) => item.ref.name)).toEqual([
      "scope.md",
      "inventory.md",
      "units.md",
      "questions.md",
      "review.md",
    ]);
    expect(calls.every((call) => call.prompt.includes(intentText))).toBe(true);
    expect(calls[0]?.prompt).toContain(questionsText);
    expect(calls[0]?.prompt).toContain("Include generated files only when tracked.");
  });

  it.each([
    [
      "arbitrary successful workflow",
      {
        target: { kind: "scriptPath" as const, ref: "arbitrary.workflow.mjs", source: "project" as const },
        artifact: { kind: "published" as const, stage: "prepare-clarification" },
      },
    ],
    [
      "wrong review phase",
      {
        target: { kind: "name" as const, ref: "review", source: "package" as const },
        artifact: { kind: "published" as const, stage: "verify-review" },
      },
    ],
    [
      "automatic answer instead of prepare publication",
      {
        target: { kind: "name" as const, ref: "review", source: "package" as const },
        artifact: { kind: "answer" as const, stage: "prepare-clarification" },
      },
    ],
  ])("rejects same-name artifacts from %s", async (_caseName, sourceMetadata) => {
    const runWorkflow = await loadWorkflow();
    const intentText = "review range A...B";
    const questionsText = "# Clarification Questions\n1. Which base?";
    const intentRef = priorRef("arbitrary-run", "published-1", "intent.md", intentText);
    const questionsRef = priorRef("arbitrary-run", "published-2", "clarification-questions.md", questionsText);
    const arbitrary = (ref: WorkflowArtifactRef, text: string): WorkflowConsumedTextArtifact => ({
      ...prepareArtifact(ref, text, intentRef, questionsRef),
      source: {
        runId: ref.runId,
        ...sourceMetadata,
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
        return completed(request, "unused");
      },
      { runId: "execute-run", consumed: prior },
    );

    await expect(runWorkflow(dsl, "Use A as the base.")).rejects.toThrow("Package review prepare-clarification run");
    expect(calls).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it.each([
    [
      "missing structured result",
      (artifact: WorkflowConsumedTextArtifact, intentRef: WorkflowArtifactRef, questionsRef: WorkflowArtifactRef) => {
        artifact.source.terminal = { artifactRefs: [intentRef, questionsRef] };
      },
    ],
    [
      "mismatched intent reference",
      (artifact: WorkflowConsumedTextArtifact, intentRef: WorkflowArtifactRef, questionsRef: WorkflowArtifactRef) => {
        artifact.source.terminal = {
          result: { mode: "prepared", intentRef: { ...intentRef, sha256: "0".repeat(64) }, questionsRef },
          artifactRefs: [intentRef, questionsRef],
        };
      },
    ],
    [
      "wrong prepare mode",
      (artifact: WorkflowConsumedTextArtifact, intentRef: WorkflowArtifactRef, questionsRef: WorkflowArtifactRef) => {
        artifact.source.terminal = {
          result: { mode: "executed", intentRef, questionsRef },
          artifactRefs: [intentRef, questionsRef],
        };
      },
    ],
    [
      "missing projected reference",
      (artifact: WorkflowConsumedTextArtifact, intentRef: WorkflowArtifactRef, questionsRef: WorkflowArtifactRef) => {
        artifact.source.terminal = {
          ...prepareTerminal(intentRef, questionsRef),
          artifactRefs: [questionsRef],
        };
      },
    ],
    [
      "unexpected result field",
      (artifact: WorkflowConsumedTextArtifact, intentRef: WorkflowArtifactRef, questionsRef: WorkflowArtifactRef) => {
        artifact.source.terminal = {
          result: { ...prepareTerminal(intentRef, questionsRef).result, accepted: true },
          artifactRefs: [intentRef, questionsRef],
        };
      },
    ],
  ])("rejects prepare provenance with %s", async (_caseName, corrupt) => {
    const runWorkflow = await loadWorkflow();
    const intentText = "review range A...B";
    const questionsText = "# Clarification Questions\n1. Which base?";
    const intentRef = priorRef("prepare-run", "published-1", "intent.md", intentText);
    const questionsRef = priorRef("prepare-run", "published-2", "clarification-questions.md", questionsText);
    const intentArtifact = prepareArtifact(intentRef, intentText, intentRef, questionsRef);
    corrupt(intentArtifact, intentRef, questionsRef);
    const prior = new Map([
      [`${intentRef.runId}:${intentRef.artifactId}`, intentArtifact],
      [
        `${questionsRef.runId}:${questionsRef.artifactId}`,
        prepareArtifact(questionsRef, questionsText, intentRef, questionsRef),
      ],
    ]);
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, published } = runtimeWith(
      async (request) => {
        calls.push(request);
        return completed(request, "unused");
      },
      { runId: "execute-run", consumed: prior },
    );

    await expect(runWorkflow(dsl, "Use A as the base.")).rejects.toThrow("verified terminal result");
    expect(calls).toHaveLength(0);
    expect(published).toHaveLength(0);
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
      "ask review questions": "# Review Questions\n## U1-Q1\nQuestion: Does it hold?",
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
      "ask review questions",
      "verify and write review",
    ]);
    // Every stage still receives the exact preceding handoff.
    expect(calls[3]?.prompt).toContain(outputs["inventory changes"]);
    expect(calls[5]?.prompt).toContain(outputs["ask review questions"]);
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
      "ask review questions": "# Review Questions\n## Coverage reconciliation\nC1: U2; U2-Q1",
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
    expect(calls).toHaveLength(6);
    // The dropped id remains visible as evidence in the retained handoffs.
    expect(answers.map((item) => item.ref.name)).toEqual([
      "clarifier-decision.json",
      "scope.md",
      "inventory.md",
      "units.md",
      "questions.md",
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
      "ask review questions": "# Review Questions\n## U1-Q1\nQuestion: Does it hold?",
      "verify and write review": "# Code Review\n## Verdict\nNeeds changes.",
    };
    const { dsl } = runtimeWith(async (request) => completed(request, outputs[request.label!]!));

    // A contradictory inventory is not an empty scope: the review continues.
    expect(await runWorkflow(dsl, "review the worktree")).toBe(outputs["verify and write review"]);
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
      "Agent answer is 64001 characters; the call allows 64000.",
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
