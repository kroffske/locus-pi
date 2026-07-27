import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
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
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

/**
 * The tracked `plan` example. Two loops carry its "iteratively" claim, and they
 * fail in different ways, so both are pinned here: the operator loop can pause
 * the run and resume it from host-verified bytes, and the drafting loop must
 * stop on the critic's verdict rather than on the round cap.
 */
const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/plan/plan.workflow.mjs");

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

function prepareArtifact(
  ref: WorkflowArtifactRef,
  text: string,
  taskRef: WorkflowArtifactRef,
  questionsRef: WorkflowArtifactRef,
): WorkflowConsumedTextArtifact {
  return {
    ref,
    text,
    source: {
      runId: ref.runId,
      target: { kind: "scriptPath", ref: "extensions/workflows/examples/plan/plan.workflow.mjs", source: "project" },
      artifact: { kind: "published", stage: "clarify-task" },
      terminal: {
        result: { mode: "prepared", taskRef, questionsRef },
        artifactRefs: [taskRef, questionsRef],
      },
    },
  };
}

function runtimeWith(
  runner: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult>,
  options: { runId?: string; consumed?: WorkflowConsumedTextArtifact[] } = {},
) {
  const runId = options.runId ?? "plan-test";
  const runDir = mkdtempSync(path.join(tmpdir(), "locus-plan-workflow-"));
  const published: PublishedArtifact[] = [];
  const answers: PublishedArtifact[] = [];
  const awaiting: Array<{ reason: string }> = [];
  let continuation: WorkflowBoundContinuation | undefined;
  if (options.consumed !== undefined && options.consumed.length > 0) {
    const pairs = options.consumed.map((item, index) => ({
      sourceRef: item.ref,
      consumedArtifact: { ...item, ref: priorRef(runId, `input-${index + 1}`, item.ref.name, item.text) },
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

const PLAN_DRAFT = [
  "# Implementation Plan",
  "## Goal",
  "The offset advances.",
  "",
  "## Steps",
  "### S1 — Advance the offset",
  "Files: `src/page.ts`",
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
function preDraftOutputs(): Record<string, string> {
  return {
    "decide clarification": '{"decision":"continue","questions":[]}',
    "map task context": "# Task Context\n## Existing behavior\n- `src/page.ts` — paginates.",
  };
}

describe("workflow example: plan.workflow.mjs", () => {
  it("keeps every planning stage read-only and lets the runtime own every artifact", () => {
    const source = readFileSync(workflowPath, "utf8");

    // Planning reads; it never writes. If this ever fails, a "plan" run can
    // change the operator's working tree without the operator asking for it.
    expect(source.match(/readOnly: true/gu)).toHaveLength(2);
    expect(source).not.toContain('"write"');
    expect(source).not.toContain('"edit"');
    expect(source).not.toContain('"bash"');
    expect(source.match(/maxToolCalls:/gu)).toHaveLength(1);
    expect(source.match(/workspaceMode:/gu)).toHaveLength(1);

    expect(source).toContain("const COMMON = ");
    // Four inline stage tasks: no prompt here is long enough to earn a file.
    expect(source).not.toContain("promptFile");
    expect(source.match(/^\s*`\$\{COMMON\}$/gmu)).toHaveLength(4);

    // Both loops branch on a declared shape plus a cross-field callback, never on
    // a regex over the model's Markdown.
    expect(source).toContain("CLARIFIER_SCHEMA");
    expect(source).toContain("PLAN_VERDICT_SCHEMA");
    expect(source).toContain("validate: clarifierDecisionErrors");
    expect(source).toContain("validate: planVerdictErrors");
    expect(source).toContain("const MAX_PLAN_ROUNDS = 4");
    expect(source).not.toContain("JSON.parse");

    for (const name of ["context.md", "plan.md", "plan-critique.json", "clarifier-decision.json"]) {
      expect(source, name).toContain(`artifact: "${name}"`);
    }
    for (const bound of ["maxAnswerChars: MAX_CONTEXT_CHARS", "maxAnswerChars: MAX_PLAN_CHARS"]) {
      expect(source, bound).toContain(bound);
    }
  });

  it("accepts the first draft when the critic accepts it, and returns that exact text", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      ...preDraftOutputs(),
      "draft plan round 1": PLAN_DRAFT,
      "critique plan round 1": '{"verdict":"accept","defects":[]}',
    };
    const { dsl, published, answers } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });
    const task = "  make pagination advance past the first page  \n";

    const result = await runWorkflow(dsl, task);

    expect(result).toBe(PLAN_DRAFT);
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "map task context",
      "draft plan round 1",
      "critique plan round 1",
    ]);
    expect(calls.every((call) => call.readOnly === true)).toBe(true);
    // The operator's exact words reach every stage; no stage sees a paraphrase.
    expect(calls.every((call) => call.prompt.includes(task))).toBe(true);
    expect(calls.map((call) => call.phase)).toEqual(["clarify-task", "map-context", "draft-plan", "critique-plan"]);
    expect(calls[2]?.prompt).toContain(outputs["map task context"]);
    expect(calls[3]?.prompt).toContain(PLAN_DRAFT);
    expect(published.map((item) => item.ref.name)).toEqual(["task.md"]);
    expect(published[0]?.text).toBe(task);
    expect(answers.map((item) => item.ref.name)).toEqual([
      "clarifier-decision.json",
      "context.md",
      "plan.md",
      "plan-critique.json",
    ]);
  });

  it("redrafts with the critic's exact defects and retains every round separately", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const secondDraft = PLAN_DRAFT.replace("Advance the offset.", "Advance the offset in `loadPage`.");
    const outputs: Record<string, string> = {
      ...preDraftOutputs(),
      "draft plan round 1": PLAN_DRAFT,
      "critique plan round 1": JSON.stringify({
        verdict: "revise",
        defects: ["S1: `src/page.ts` has no offset variable; name the symbol the step changes"],
      }),
      "draft plan round 2": secondDraft,
      "critique plan round 2": '{"verdict":"accept","defects":[]}',
    };
    const { dsl, answers } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    expect(await runWorkflow(dsl, "advance pagination")).toBe(secondDraft);
    expect(calls.map((call) => call.label)).toEqual([
      "decide clarification",
      "map task context",
      "draft plan round 1",
      "critique plan round 1",
      "draft plan round 2",
      "critique plan round 2",
    ]);
    // The second draft receives the first draft and the defect sentence verbatim,
    // numbered — not a summary the script invented.
    expect(calls[4]?.prompt).toContain(PLAN_DRAFT);
    expect(calls[4]?.prompt).toContain("1. S1: `src/page.ts` has no offset variable; name the symbol the step changes");
    // Both rounds are retained under the same reader-facing name: the artifact id
    // is the identity, so nothing is overwritten.
    expect(answers.map((item) => item.ref.name)).toEqual([
      "clarifier-decision.json",
      "context.md",
      "plan.md",
      "plan-critique.json",
      "plan.md",
      "plan-critique.json",
    ]);
    expect(answers[2]?.text).toBe(PLAN_DRAFT);
    expect(answers[4]?.text).toBe(secondDraft);
  });

  it("fails the run when the round cap is reached without an accepted plan", async () => {
    // A draft nobody accepted is not a plan, and failing here is also what keeps
    // it out of `plan-implement`: continuation consumes only a successful run's
    // projected artifacts.
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      const fixed = preDraftOutputs()[request.label!];
      if (fixed !== undefined) return completed(request, fixed);
      if (request.label!.startsWith("critique")) {
        return completed(request, JSON.stringify({ verdict: "revise", defects: ["S1: still unverifiable"] }));
      }
      return completed(request, PLAN_DRAFT);
    });

    expect(await runWorkflow(dsl, "advance pagination")).toEqual({
      ok: false,
      stoppedBy: "round-cap",
      rounds: 4,
      summary: "plan was not accepted within 4 drafting round(s)",
      unresolvedRows: ["S1: still unverifiable"],
    });
    expect(calls.filter((call) => call.label!.startsWith("draft plan"))).toHaveLength(4);
    expect(calls.at(-1)?.label).toBe("critique plan round 4");
  });

  it.each([
    [
      { verdict: "accept", defects: ["a defect nobody will read"] },
      'defects: expected 0 item(s) when verdict is "accept", got 1',
    ],
    [{ verdict: "revise", defects: [] }, 'defects: expected at least 1 item(s) when verdict is "revise", got 0'],
  ])("re-asks the critic for a verdict that disagrees with its own defects", async (verdict, message) => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      const fixed = preDraftOutputs()[request.label!];
      if (fixed !== undefined) return completed(request, fixed);
      if (request.label!.startsWith("critique")) return completed(request, JSON.stringify(verdict));
      return completed(request, PLAN_DRAFT);
    });

    const rejection = runWorkflow(dsl, "advance pagination");
    await expect(rejection).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(rejection).rejects.toThrow(message);
    // Three attempts: a call that declares `validate` gets one dedicated extra one.
    expect(calls.filter((call) => call.label === "critique plan round 1")).toHaveLength(3);
    expect(calls[1]?.prompt).not.toContain("REJECTED by the workflow script");
    expect(calls.some((call) => call.label === "draft plan round 2")).toBe(false);
  });

  it("pauses with the exact task, readable questions, and complete references", async () => {
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
                id: "target-surface",
                prompt: "Which surface should the plan change?",
                options: ["The CLI entry", "The library API"],
                recommended: "The CLI entry",
                allowCustom: true,
              },
            ],
          }),
        );
      },
      { runId: "prepare-run" },
    );
    const task = "  make it faster, but preserve my spacing  \n";

    const result = await runWorkflow(dsl, task);

    expect(result).toEqual({ mode: "prepared", taskRef: published[0]?.ref, questionsRef: published[1]?.ref });
    expect(published.map((item) => item.ref.name)).toEqual(["task.md", "clarification-questions.md"]);
    expect(published[0]?.text).toBe(task);
    // The published questions carry the id AND the prompt: an operator answering
    // in a text box, and every later stage, must be able to read the question
    // itself rather than a bare id.
    expect(published[1]?.text).toBe(
      [
        "# Clarification Questions",
        "",
        "Answer in any readable form; name the question id or its number so the",
        "continuation can tell your answers apart.",
        "",
        "1. [target-surface] Which surface should the plan change?",
        "   - The CLI entry",
        "   - The library API",
      ].join("\n"),
    );
    expect(calls.map((call) => call.label)).toEqual(["decide clarification"]);
    expect(answers.map((item) => item.ref.name)).toEqual(["clarifier-decision.json"]);
    expect(awaiting).toEqual([
      {
        reason: "plan clarification required",
        operatorHandoff: {
          title: "Plan clarification",
          questions: [
            {
              kind: "select",
              id: "target-surface",
              prompt: "Which surface should the plan change?",
              options: [{ label: "The CLI entry" }, { label: "The library API" }],
              recommended: "The CLI entry",
              allowCustom: true,
            },
          ],
          continuationArtifactRefs: [published[0]?.ref, published[1]?.ref],
        },
      },
    ]);
  });

  it("resumes from verified references and forwards the questions together with the answers", async () => {
    const runWorkflow = await loadWorkflow();
    const taskText = "make pagination advance past the first page";
    const questionsText = "# Clarification Questions\n\n1. [target-surface] Which surface should the plan change?";
    const taskRef = priorRef("prepare-run", "published-1", "task.md", taskText);
    const questionsRef = priorRef("prepare-run", "published-2", "clarification-questions.md", questionsText);
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, published, answers } = runtimeWith(
      async (request) => {
        calls.push(request);
        const outputs: Record<string, string> = {
          ...preDraftOutputs(),
          "draft plan round 1": PLAN_DRAFT,
          "critique plan round 1": '{"verdict":"accept","defects":[]}',
        };
        return completed(request, outputs[request.label!]!);
      },
      {
        runId: "execute-run",
        consumed: [
          prepareArtifact(taskRef, taskText, taskRef, questionsRef),
          prepareArtifact(questionsRef, questionsText, taskRef, questionsRef),
        ],
      },
    );

    const result = await runWorkflow(dsl, "The library API.");

    expect(result).toBe(PLAN_DRAFT);
    // No second clarification round: the operator loop runs at most once.
    expect(calls.map((call) => call.label)).toEqual([
      "map task context",
      "draft plan round 1",
      "critique plan round 1",
    ]);
    expect(published.map((item) => item.ref.name)).toEqual(["clarification-answers.md"]);
    expect(answers.map((item) => item.ref.name)).toEqual(["context.md", "plan.md", "plan-critique.json"]);
    expect(calls.every((call) => call.prompt.includes(taskText))).toBe(true);
    // "The library API." is meaningless without the question it answers, so both
    // travel together into every stage that receives the clarification.
    expect(calls[0]?.prompt).toContain(questionsText);
    expect(calls[0]?.prompt).toContain("The library API.");
  });

  it.each([
    [
      "an artifact another workflow published",
      (artifact: WorkflowConsumedTextArtifact) => {
        artifact.source.target = { kind: "name", ref: "review", source: "package" };
      },
    ],
    [
      "a different stage of this workflow",
      (artifact: WorkflowConsumedTextArtifact) => {
        artifact.source.artifact = { kind: "published", stage: "map-context" };
      },
    ],
    [
      "a terminal result that does not name these refs",
      (artifact: WorkflowConsumedTextArtifact) => {
        artifact.source.terminal = {
          result: { mode: "prepared" },
          artifactRefs: artifact.source.terminal.artifactRefs,
        };
      },
    ],
  ])("refuses continuation bytes from %s", async (_caseName, corrupt) => {
    const runWorkflow = await loadWorkflow();
    const taskText = "make pagination advance";
    const questionsText = "# Clarification Questions\n\n1. [target-surface] Which surface?";
    const taskRef = priorRef("prepare-run", "published-1", "task.md", taskText);
    const questionsRef = priorRef("prepare-run", "published-2", "clarification-questions.md", questionsText);
    const taskArtifact = prepareArtifact(taskRef, taskText, taskRef, questionsRef);
    corrupt(taskArtifact);
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, published } = runtimeWith(
      async (request) => {
        calls.push(request);
        return completed(request, "unused");
      },
      {
        runId: "execute-run",
        consumed: [taskArtifact, prepareArtifact(questionsRef, questionsText, taskRef, questionsRef)],
      },
    );

    // Host-owned provenance is the one class no child can repair, so it ends the
    // run before a single child is asked instead of being handed back as a retry.
    await expect(runWorkflow(dsl, "The library API.")).rejects.toThrow("verified terminal result of a plan");
    expect(calls).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("refuses an incomplete continuation, empty input, and oversized input", async () => {
    const runWorkflow = await loadWorkflow();
    const taskText = "make pagination advance";
    const questionsText = "# Clarification Questions\n\n1. [target-surface] Which surface?";
    const taskRef = priorRef("prepare-run", "published-1", "task.md", taskText);
    const questionsRef = priorRef("prepare-run", "published-2", "clarification-questions.md", questionsText);
    const partial = runtimeWith(async (request) => completed(request, "unused"), {
      runId: "execute-run",
      consumed: [prepareArtifact(taskRef, taskText, taskRef, questionsRef)],
    });

    await expect(runWorkflow(partial.dsl, "The library API.")).rejects.toThrow(
      "plan continuation requires exactly task.md and clarification-questions.md",
    );

    const { dsl } = runtimeWith(async (request) => completed(request, "unused"));
    await expect(runWorkflow(dsl, "   ")).rejects.toThrow("plan task must be a non-empty string");
    await expect(runWorkflow(dsl, { task: "object" })).rejects.toThrow("plan task must be a non-empty string");
    await expect(runWorkflow(dsl, "x".repeat(16_001))).rejects.toThrow("16000-character context limit");
  });
});
