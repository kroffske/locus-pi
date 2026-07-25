import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
  WorkflowAgentExecutionError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/review/review.workflow.mjs");

const READ_ONLY_PROMPTS = [
  "clarifier.prompt.md",
  "scope-resolver.prompt.md",
  "change-inventory.prompt.md",
  "unit-planner.prompt.md",
  "interrogator.prompt.md",
  "verifier.prompt.md",
];
const NAVIGATING_PROMPTS = ["unit-planner.prompt.md", "interrogator.prompt.md", "verifier.prompt.md"];

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
    expect(source).toContain("const REVIEW_AGENT_DEFAULTS");
    expect(source.match(/maxToolCalls:/gu)).toHaveLength(1);
    expect(source.match(/workspaceMode:/gu)).toHaveLength(1);
    expect(source.match(/readOnly: true/gu)).toHaveLength(2);
    expect(source).toContain('tools: ["read", "git_read", "grep", "find"]');
    expect(source).toContain('tools: ["read", "git_read", "ast_index", "grep", "find"]');
    expect(source).toContain("const MAX_CLARIFIER_PROMPT_CHARS = 500");
    expect(promptSource("clarifier.prompt.md")).toContain("Each prompt must fit in 500 characters");
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
    for (const name of READ_ONLY_PROMPTS) {
      const prompt = promptSource(name);
      expect(prompt, name).toContain("This stage is host-enforced read-only.");
      expect(prompt, name).toContain("workflow runtime owns");
      expect(prompt, name).toContain("You have no shell");
      expect(prompt, name).toContain("git_read");
    }
  });

  it("keeps the AST Index preference bounded by a grep fallback and only where symbols matter", () => {
    for (const name of NAVIGATING_PROMPTS) {
      const prompt = promptSource(name);
      expect(prompt, name).toContain("ast_index");
      expect(prompt, name).toMatch(/A missing AST Index never blocks a\s+review\./u);
      expect(prompt, name).toMatch(/continue with\s+`grep`, `find`, and direct reads/u);
    }
    for (const name of ["clarifier.prompt.md", "scope-resolver.prompt.md", "change-inventory.prompt.md"]) {
      expect(promptSource(name), name).not.toContain("ast_index");
    }
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
    const inventory = promptSource("change-inventory.prompt.md");
    const planner = promptSource("unit-planner.prompt.md");
    const interrogator = promptSource("interrogator.prompt.md");
    const verifier = promptSource("verifier.prompt.md");

    expect(inventory).toContain("stable coverage ids");
    expect(planner).toContain("Coverage: C1, C2");
    expect(planner).toMatch(/Every inventory id\s+must appear in exactly one unit/u);
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
    expect(resourceLoader.evidence()).toHaveLength(6);
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
      "continue decision requires no questions",
    ],
    [{ decision: "needs_operator", questions: [] }, "requires 1-8 questions"],
    [
      {
        decision: "needs_operator",
        questions: [
          { id: "same", prompt: "First?", options: [], allowCustom: true },
          { id: "same", prompt: "Second?", options: [], allowCustom: true },
        ],
      },
      "must be unique",
    ],
    [
      {
        decision: "needs_operator",
        questions: [{ id: "long", prompt: "x".repeat(501), options: [], allowCustom: true }],
      },
      "exceeds 500 characters",
    ],
  ])("rejects invalid clarifier domain output before review stages", async (decision, message) => {
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, published, awaiting } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, JSON.stringify(decision));
    });

    await expect((await loadWorkflow())(dsl, "review current branch")).rejects.toThrow(message);
    expect(calls.map((call) => call.label)).toEqual(["decide clarification"]);
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

  it("names the stage and prompt when the inventory declares neither coverage nor emptiness", async () => {
    const runWorkflow = await loadWorkflow();
    const outputs: Record<string, string> = {
      "decide clarification": '{"decision":"continue","questions":[]}',
      "resolve review scope": "# Review Scope\nTarget: working tree",
      "inventory changes": "# Change Inventory\n\nI looked around and found some stuff.",
    };
    const { dsl } = runtimeWith(async (request) => completed(request, outputs[request.label!]!));

    await expect(runWorkflow(dsl, "review the worktree")).rejects.toThrow(
      "the inventory-changes stage answer does not follow resources/change-inventory.prompt.md",
    );
  });

  it("refuses an inventory that claims emptiness and coverage at the same time", async () => {
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
    };
    const { dsl } = runtimeWith(async (request) => completed(request, outputs[request.label!]!));

    await expect(runWorkflow(dsl, "review the worktree")).rejects.toThrow(
      'declared "## No changes" together with C<n> coverage entries',
    );
  });

  it("fails closed before interrogation when unit planning drops inventory coverage", async () => {
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
        "Change: Deliberately dropped by the unit handoff.",
      ].join("\n"),
      "plan review units": "# Review Units\n## U1\nCoverage: C1\nPath: `src/kept.ts`",
      "ask review questions": "# Review Questions\n## Coverage gaps\nC2 is missing.",
      "verify and write review": "# Code Review\n## Verdict\nBlocked",
    };
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    await expect(runWorkflow(dsl, "review the dirty worktree")).rejects.toThrow(
      "units dropped inventory coverage id C2",
    );
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "resolve review scope",
      "inventory changes",
      "plan review units",
    ]);
  });

  it("rejects a final report that drops an inventory id even when its verdict claims readiness", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      "decide clarification": '{"decision":"continue","questions":[]}',
      "resolve review scope": "# Review Scope\nTarget: working tree",
      "inventory changes": [
        "# Change Inventory",
        "## C1",
        "Path: `src/a.ts`",
        "Change: first",
        "## C2",
        "Path: `src/b.ts`",
        "Change: second",
      ].join("\n"),
      "plan review units": "# Review Units\n## U1\nCoverage: C1, C2\nPath: `src/a.ts`",
      "ask review questions": "# Review Questions\n## Coverage reconciliation\nC1: U1\nC2: U1",
      "verify and write review":
        "# Code Review\n## Verdict\nReady for human acceptance\n## Coverage and limits\nC1: U1; inspected",
    };
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    await expect(runWorkflow(dsl, "review the dirty worktree")).rejects.toThrow(
      "final review dropped inventory coverage id C2",
    );
    expect(calls).toHaveLength(6);
  });

  it("rejects a coverage ledger that assigns an inventory id to the wrong unit", async () => {
    const runWorkflow = await loadWorkflow();
    const outputs: Record<string, string> = {
      "decide clarification": '{"decision":"continue","questions":[]}',
      "resolve review scope": "# Review Scope\nTarget: working tree",
      "inventory changes": "# Change Inventory\n## C1\nPath: `src/a.ts`\nChange: first",
      "plan review units": "# Review Units\n## U1\nCoverage: C1\nPath: `src/a.ts`",
      "ask review questions": "# Review Questions\n## Coverage reconciliation\nC1: U2; U2-Q1",
    };
    const { dsl } = runtimeWith(async (request) => completed(request, outputs[request.label!]!));

    await expect(runWorkflow(dsl, "review the dirty worktree")).rejects.toThrow(
      "questions handoff assigns coverage id C1 to the wrong unit",
    );
  });

  it("does not count a prose mention as a final coverage-ledger entry", async () => {
    const runWorkflow = await loadWorkflow();
    const outputs: Record<string, string> = {
      "decide clarification": '{"decision":"continue","questions":[]}',
      "resolve review scope": "# Review Scope\nTarget: working tree",
      "inventory changes": [
        "# Change Inventory",
        "## C1",
        "Path: `src/a.ts`",
        "Change: first",
        "## C2",
        "Path: `src/b.ts`",
        "Change: second",
      ].join("\n"),
      "plan review units": "# Review Units\n## U1\nCoverage: C1, C2\nPath: `src/a.ts`",
      "ask review questions": "# Review Questions\n## Coverage reconciliation\nC1: U1; U1-Q1\nC2: U1; U1-Q1",
      "verify and write review": [
        "# Code Review",
        "## Verdict",
        "Ready for human acceptance",
        "## Coverage and limits",
        "C1: U1; inspected",
        "A prose mention says C2 was inspected.",
      ].join("\n"),
    };
    const { dsl } = runtimeWith(async (request) => completed(request, outputs[request.label!]!));

    await expect(runWorkflow(dsl, "review the dirty worktree")).rejects.toThrow(
      "final review has malformed coverage ledger line",
    );
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
    await expect(runWorkflow(dsl, "review current branch")).rejects.toThrow("scope handoff exceeds the 64000");
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
