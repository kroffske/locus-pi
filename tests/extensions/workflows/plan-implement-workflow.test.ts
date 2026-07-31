import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkflowArtifactStore,
  type WorkflowArtifactRef,
} from "../../../extensions/workflows/runtime/workflow-artifacts.js";
import { createWorkflowResourceLoader } from "../../../extensions/workflows/runtime/workflow-resources.js";
import { workflowResultFile } from "../../../extensions/workflows/runtime/workflow-result.js";
import {
  createWorkflowRuntime,
  SchemaValidationError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/workflows/runtime/workflow-runtime.js";

/**
 * The tracked `plan-implement` example. The plan arrives as bytes the host
 * verified and copied from a *previous* successful run, so these tests build a
 * real prior-run artifact store on disk rather than a hand-written source record.
 */
const workflowPath = path.join(
  process.cwd(),
  "extensions/workflows/examples/plan-implement/plan-implement.workflow.mjs",
);

const STEP_S1 = [
  "### S1 — Advance the offset",
  "",
  "Files: `src/page.ts`",
  "Change: Advance the offset by the page size.",
  "Verify: `npm test -- page`",
  "Depends on: none",
].join("\n");

const STEP_S2 = [
  "### S2 — Cover the final page",
  "",
  "Files: `tests/page.test.ts`",
  "Change: Add the missing final-page case.",
  "Verify: `npm test -- page`",
  "Depends on: S1",
].join("\n");

function planText(steps: string[] = [STEP_S1, STEP_S2]): string {
  return [
    "# Implementation Plan",
    "",
    "## Outcome",
    "Outcome type: working delivery",
    "Primary result: Pagination advances past the first page.",
    "Consumer: Callers of the pagination API.",
    "Form and location: `src/page.ts` runtime behavior.",
    "Required content or behavior: The offset advances by the configured page size.",
    "Usability proof: `npm test -- page` passes the multi-page behavior case.",
    "Supporting evidence: implementation report and test output.",
    "",
    "## Steps",
    "",
    ...steps.flatMap((step) => [step, ""]),
    "## Out of scope",
    "",
    "- Renaming the module.",
  ].join("\n");
}

interface PlanFixture {
  root: string;
  planRef: WorkflowArtifactRef;
  planText: string;
}

function createPlanFixture(options: { steps?: string[]; name?: string } = {}): PlanFixture {
  const root = mkdtempSync(path.join(tmpdir(), "locus-plan-implement-"));
  const sourceRunId = "plan-source";
  const sourceRunDir = path.join(root, ".pi", "locus-pi", "workflows", sourceRunId);
  mkdirSync(sourceRunDir, { recursive: true });
  const sourceStore = createWorkflowArtifactStore({ projectRoot: root, runId: sourceRunId, runDir: sourceRunDir });
  const text = planText(options.steps);
  const planRef = sourceStore.recordAgentEvidence({
    callId: "call-0003",
    name: options.name ?? "plan.md",
    stage: "draft-plan",
    text,
    replayed: false,
  }).answer!;
  writeFileSync(
    workflowResultFile(sourceRunDir),
    `${JSON.stringify({
      ok: true,
      result: text,
      artifactRefs: [planRef],
      target: {
        kind: "scriptPath",
        ref: "extensions/workflows/examples/plan/plan.workflow.mjs",
        source: "project",
      },
    })}\n`,
    "utf8",
  );
  return { root, planRef, planText: text };
}

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as { default?: (dsl: unknown, input?: unknown) => Promise<unknown> };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function completed(request: WorkflowAgentRequest, text: string): WorkflowAgentResult {
  const normalizedText =
    (request.label === "collect check evidence" || request.label === "collect reconciliation evidence") &&
    !text.trimStart().startsWith("{")
      ? checkEvidence(selectedIdsFromLedger(request.prompt))
      : text;
  return {
    ok: true,
    status: "completed",
    summary: normalizedText,
    text: normalizedText,
    diagnostics: [],
    agent: request.agent,
    ...(request.label === undefined ? {} : { label: request.label }),
  };
}

function failed(request: WorkflowAgentRequest, summary: string): WorkflowAgentResult {
  return {
    ok: false,
    status: "failed",
    summary,
    diagnostics: ["provider unavailable"],
    agent: request.agent,
    ...(request.label === undefined ? {} : { label: request.label }),
  };
}

let runtimeOrdinal = 0;

function runtimeWith(
  fixture: PlanFixture,
  agentRunner: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult>,
) {
  const runId = `plan-implement-test-${++runtimeOrdinal}`;
  const runDir = path.join(fixture.root, ".pi", "locus-pi", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  const artifactStore = createWorkflowArtifactStore({ projectRoot: fixture.root, runId, runDir });
  const consumedPlan = artifactStore.consumeText(fixture.planRef);
  return {
    artifactStore,
    ...createWorkflowRuntime({
      runId,
      projectRoot: fixture.root,
      artifactPorts: artifactStore,
      continuation: {
        originRunId: fixture.planRef.runId,
        artifacts: [{ sourceRef: fixture.planRef, consumedArtifact: consumedPlan }],
      },
      resourceLoader: createWorkflowResourceLoader({ workflowSourcePath: workflowPath, runDir }),
      agentRunner,
    }),
  };
}

function runtimeWithoutContinuation(
  fixture: PlanFixture,
  agentRunner: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult>,
) {
  const runId = `plan-implement-direct-test-${++runtimeOrdinal}`;
  const runDir = path.join(fixture.root, ".pi", "locus-pi", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  const artifactStore = createWorkflowArtifactStore({ projectRoot: fixture.root, runId, runDir });
  return {
    artifactStore,
    ...createWorkflowRuntime({
      runId,
      projectRoot: fixture.root,
      artifactPorts: artifactStore,
      resourceLoader: createWorkflowResourceLoader({ workflowSourcePath: workflowPath, runDir }),
      agentRunner,
    }),
  };
}

/** Named answers only: the consumed plan is an input record, not reviewable work. */
function namedAnswers(store: ReturnType<typeof createWorkflowArtifactStore>): string[] {
  return store
    .list()
    .filter((record) => record.kind === "answer")
    .map((record) => record.name);
}

function namedPublished(store: ReturnType<typeof createWorkflowArtifactStore>): string[] {
  return store
    .list()
    .filter((record) => record.kind === "published" || record.kind === "primary")
    .map((record) => record.name);
}

const DEFAULT_INTENT = "Implement the accepted plan.";

function selectedIdsFromLedger(prompt: string): string[] {
  return [...prompt.matchAll(/^\| (S[1-9][0-9]*) \| [^|]+ \| (?!not-selected)([^|]+) \|/gmu)].map((match) => match[1]!);
}

interface CheckEvidence {
  stepChecks: Array<{ id: string; command: string; status: "passed" | "failed" | "not-run"; evidence: string }>;
  repositoryChecks: Array<{ command: string; status: "passed" | "failed" | "not-run"; evidence: string }>;
  unexpectedChanges: string[];
  gaps: string[];
}

function checkEvidence(
  ids: string[],
  options: {
    stepStatus?: "passed" | "failed" | "not-run";
    repositoryStatus?: "passed" | "failed" | "not-run";
    gaps?: string[];
    unexpectedChanges?: string[];
  } = {},
): string {
  const stepStatus = options.stepStatus ?? "passed";
  const repositoryStatus = options.repositoryStatus ?? "passed";
  return JSON.stringify({
    stepChecks: ids.map((id) => ({
      id,
      command: "npm test -- page",
      status: stepStatus,
      evidence: `${id} verification ${stepStatus}.`,
    })),
    repositoryChecks: [
      {
        command: "npm run check",
        status: repositoryStatus,
        evidence: `Repository check ${repositoryStatus}.`,
      },
    ],
    unexpectedChanges: options.unexpectedChanges ?? [],
    gaps: options.gaps ?? [],
  } satisfies CheckEvidence);
}

function selection(steps: Array<{ id: string; note?: string }>): string {
  return JSON.stringify({ steps: steps.map(({ id, note = "" }) => ({ id, note })) });
}

function review(verdict: "accept" | "repair" | "blocked", summary: string, issues: string[] = []): string {
  return JSON.stringify({ verdict, summary, issues });
}

type ImplementationStatus = "done" | "partial" | "blocked" | "not-attempted";

interface ImplementationGrade {
  outcome: "complete" | "partial" | "blocked";
  summary: string;
  deliverable: {
    name: string;
    kind: "working-change" | "document" | "decision" | "evidence-package" | "gate" | "other";
    location: string;
    status: "ready" | "partial" | "missing";
    summary: string;
    evidence: string;
  };
  steps: Array<{
    id: string;
    status: ImplementationStatus;
    files: string[];
    evidence: string;
    remaining: string;
  }>;
  nextStep: string;
}

function grade(
  outcome: ImplementationGrade["outcome"],
  rows: Array<{ id: string; status: ImplementationStatus; remaining?: string }>,
  summary = "The live evidence supports this grade.",
  deliverableStatus: ImplementationGrade["deliverable"]["status"] = outcome === "complete"
    ? "ready"
    : outcome === "partial"
      ? "partial"
      : "missing",
): string {
  return JSON.stringify({
    outcome,
    summary,
    deliverable: {
      name: "Working pagination",
      kind: "working-change",
      location: "src/page.ts",
      status: deliverableStatus,
      summary: "Pagination advances by the configured page size.",
      evidence: "The multi-page behavior test proves the result.",
    },
    steps: rows.map(({ id, status, remaining }) => ({
      id,
      status,
      files: status === "not-attempted" ? [] : [id === "S1" ? "src/page.ts" : "tests/page.test.ts"],
      evidence: `${id} evidence was independently checked.`,
      remaining: status === "done" ? "none" : (remaining ?? `${id} still needs work.`),
    })),
    nextStep: outcome === "complete" ? "Review the implementation report." : "Resolve the named remaining work.",
  } satisfies ImplementationGrade);
}

function renderedReport(gradeText: string, planIds?: string[]): string {
  const value = JSON.parse(gradeText) as ImplementationGrade;
  const outcome = {
    complete: "Completed",
    partial: "Partly completed",
    blocked: "Blocked",
  }[value.outcome];
  const ids = planIds ?? value.steps.map((row) => row.id);
  const checks = JSON.parse(
    checkEvidence(ids.filter((id) => value.steps.some((row) => row.id === id))),
  ) as CheckEvidence;
  return [
    "# Workflow Summary",
    "",
    "## Outcome",
    "",
    `${outcome} — ${value.summary}`,
    "",
    "## Primary result",
    "",
    `Name: ${value.deliverable.name}`,
    `Type: ${value.deliverable.kind}`,
    `Location: ${value.deliverable.location}`,
    `Status: ${value.deliverable.status}`,
    `Summary: ${value.deliverable.summary}`,
    `Evidence: ${value.deliverable.evidence}`,
    "",
    "## Verification",
    "",
    ...checks.stepChecks.map((check) => `- ${check.id}: ${check.command} — ${check.status}; ${check.evidence}`),
    ...checks.repositoryChecks.map((check) => `- ${check.command} — ${check.status}; ${check.evidence}`),
    "",
    "## Remaining gaps",
    "",
    "none",
    "",
    "## Unexpected run-attributable changes",
    "",
    "none",
    "",
    "## Supporting workflow artifacts",
    "",
    "- `implementation-report.md` — per-step technical evidence.",
    "- `implementation-tasks.md` — latest execution ledger.",
    "",
    "## Next step",
    "",
    value.nextStep,
  ].join("\n");
}

describe("workflow example: plan-implement.workflow.mjs", () => {
  it("routes every implementation stage through the agent tier and names no provider", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(source).toContain('modelRole: "agent"');
    expect(source.match(/modelRole:/gu)).toHaveLength(1);
    // Same contract as the `plan` sibling: no concrete provider/id anywhere, so the
    // pair runs on any host and the operator's roles table picks the model.
    expect(source).not.toMatch(/model:\s*"[^"]*\//u);
  });

  it("keeps one write-capable role and persists workflow-owned task state plus runtime-owned agent evidence", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(source).toContain("continuationArtifacts()");
    expect(source).toContain("function parseStepBlocks");
    expect(source).toContain("function parseStepDependencies");
    expect(source).toContain("STEP_SELECTOR_SCHEMA");
    // Split the same way the curated examples are: one function decides and never
    // throws, the other merges and orders and never rejects.
    expect(source).toContain("function stepSelectionErrors");
    expect(source).toContain("function orderStepSelection");
    expect(source).toContain("validate: (value) => stepSelectionErrors(steps, value)");
    expect(source).toContain("STEP_REVIEW_SCHEMA");
    expect(source).toContain("validate: stepReviewErrors");
    expect(source).toContain("IMPLEMENTATION_REVIEW_SCHEMA");
    expect(source).toContain("implementationReviewErrors");
    expect(source).toContain("Unexpected run-attributable changes");
    expect(source).toContain('publishArtifact("implementation-tasks.md"');
    expect(source).toContain('publishArtifact("implementation-report.md", reportText)');
    expect(source).toContain('publishPrimaryArtifact("workflow-summary.md", summaryText)');
    expect(source).not.toContain("promptFile");
    expect(source).not.toContain("JSON.parse");

    // Exactly one write-capable options constant, and it is the only place the
    // edit tools appear.
    expect(source.match(/readOnly: true/gu)).toHaveLength(3);
    expect(source.match(/"write", "edit"/gu)).toHaveLength(1);

    for (const name of ["step-selection.json", "scope.md", "check-evidence.json", "implementation-verdict.json"]) {
      expect(source, name).toContain(`artifact: "${name}"`);
    }
    expect(source).toContain("artifact: `worker-${step.id}-attempt-${attempt}.md`");
    expect(source).toContain("artifact: `review-${step.id}-attempt-${attempt}.json`");
    for (const bound of [
      "maxAnswerChars: MAX_SCOPE_CHARS",
      "maxAnswerChars: MAX_WORKER_RESULT_CHARS",
      "maxAnswerChars: MAX_REVIEW_RESULT_CHARS",
      "maxAnswerChars: MAX_RAW_CHECK_EVIDENCE_CHARS",
      "maxAnswerChars: MAX_REPORT_RESULT_CHARS",
    ]) {
      expect(source, bound).toContain(bound);
    }
  });

  it("lists tasks, then writes and reviews each one in plan order before returning the report", async () => {
    const fixture = createPlanFixture({ name: "result.md" });
    const calls: WorkflowAgentRequest[] = [];
    const terminalGrade = grade("complete", [
      { id: "S1", status: "done" },
      { id: "S2", status: "done" },
    ]);
    const report = renderedReport(terminalGrade);
    const { dsl, artifactStore } = runtimeWith(fixture, async (request) => {
      calls.push(request);
      switch (request.label) {
        case "select plan steps":
          // Deliberately reversed: the plan's order is authority, not this list.
          return completed(request, selection([{ id: "S2" }, { id: "S1", note: "keep the signature" }]));
        case "resolve implementation scope":
          return completed(request, "# Scope\nS1 touches `src/page.ts`.");
        case "review step S1 attempt 1":
        case "review step S2 attempt 1":
          return completed(request, review("accept", `${request.label} passed.`));
        case "collect check evidence":
          return completed(request, "# Checks\n`npm test -- page` passed.");
        case "grade implementation":
          return completed(request, terminalGrade);
        default:
          return completed(request, `# ${request.label}\nDone.`);
      }
    });

    const result = await (await loadWorkflow())(dsl, DEFAULT_INTENT);

    expect(result).toBe(report);
    expect(calls.map((call) => call.label)).toEqual([
      "select plan steps",
      "resolve implementation scope",
      "implement step S1 attempt 1",
      "review step S1 attempt 1",
      "implement step S2 attempt 1",
      "review step S2 attempt 1",
      "collect check evidence",
      "grade implementation",
    ]);
    expect(calls.map((call) => call.phase)).toEqual([
      "select-steps",
      "resolve-implementation-scope",
      "apply-steps",
      "apply-steps",
      "apply-steps",
      "apply-steps",
      "collect-check-evidence",
      "report-implementation",
    ]);
    // The selector has no tools at all; every stage but the writers is read-only.
    expect(calls[0]?.tools).toEqual([]);
    expect(calls[0]?.readOnly).toBe(true);
    expect(calls[2]?.readOnly).toBeUndefined();
    expect(calls[3]?.readOnly).toBe(true);
    expect(calls[4]?.readOnly).toBeUndefined();
    expect(calls[5]?.readOnly).toBe(true);
    expect(calls[6]?.readOnly).toBe(true);
    expect(calls[7]?.readOnly).toBe(true);
    // Each writer receives exactly its own step block plus the operator note.
    expect(calls[2]?.prompt).toContain(STEP_S1);
    expect(calls[2]?.prompt).not.toContain("### S2 — Cover the final page");
    expect(calls[2]?.prompt).toContain("keep the signature");
    expect(calls[4]?.prompt).toContain(STEP_S2);
    expect(calls[4]?.prompt).toContain("| S1 | Advance the offset | done | 1 |");
    // The report answers against the whole plan, including steps nobody selected.
    expect(calls[7]?.prompt).toContain(fixture.planText);
    expect(namedAnswers(artifactStore)).toEqual([
      "step-selection.json",
      "scope.md",
      "worker-S1-attempt-1.md",
      "review-S1-attempt-1.json",
      "worker-S2-attempt-1.md",
      "review-S2-attempt-1.json",
      "check-evidence.json",
      "implementation-verdict.json",
    ]);
    expect(namedPublished(artifactStore)).toEqual([
      "implementation-tasks.md",
      "implementation-tasks.md",
      "implementation-tasks.md",
      "implementation-tasks.md",
      "implementation-report.md",
      "workflow-summary.md",
    ]);
  });

  it.each([
    ["pasted plan text", (fixture: PlanFixture) => fixture.planText],
    [
      "project-relative plan path",
      (fixture: PlanFixture) => {
        writeFileSync(path.join(fixture.root, "accepted-plan.md"), fixture.planText, "utf8");
        return "accepted-plan.md";
      },
    ],
  ])("resolves %s without requiring a plan.md continuation", async (_case, inputFor) => {
    const fixture = createPlanFixture({ steps: [STEP_S1] });
    const input = inputFor(fixture);
    const terminalGrade = grade("complete", [{ id: "S1", status: "done" }]);
    const report = renderedReport(terminalGrade);
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWithoutContinuation(fixture, async (request) => {
      calls.push(request);
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }]));
      if (request.label === "review step S1 attempt 1") return completed(request, review("accept", "S1 passed."));
      if (request.label === "grade implementation") return completed(request, terminalGrade);
      return completed(request, `# ${request.label}\nDone.`);
    });

    await expect((await loadWorkflow())(dsl, input)).resolves.toBe(report);
    expect(calls[0]?.label).toBe("select plan steps");
    expect(calls[0]?.prompt).toContain(fixture.planText);
    expect(calls.some((call) => call.label === "resolve plan input")).toBe(false);
  });

  it("extracts routing structure without grading Outcome prose", async () => {
    const fixture = createPlanFixture({ steps: [STEP_S1] });
    const suppliedPlan = fixture.planText
      .replace("Outcome type: working delivery", "Outcome type: operator-defined result")
      .replace(
        "Consumer: Callers of the pagination API.",
        "Consumer: <chosen by the implementation agent>\nContext: Preserve this note for the agents.",
      );
    const terminalGrade = grade("complete", [{ id: "S1", status: "done" }]);
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWithoutContinuation(fixture, async (request) => {
      calls.push(request);
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }]));
      if (request.label === "review step S1 attempt 1") return completed(request, review("accept", "S1 passed."));
      if (request.label === "grade implementation") return completed(request, terminalGrade);
      return completed(request, `# ${request.label}\nDone.`);
    });

    await expect((await loadWorkflow())(dsl, suppliedPlan)).resolves.toBe(renderedReport(terminalGrade));
    expect(calls[0]?.prompt).toContain("Outcome type: operator-defined result");
    expect(calls[0]?.prompt).toContain("Context: Preserve this note for the agents.");
  });

  it("repairs the current task from review feedback before starting the next task", async () => {
    const fixture = createPlanFixture();
    const calls: WorkflowAgentRequest[] = [];
    const terminalGrade = grade("complete", [{ id: "S1", status: "done" }]);
    const report = renderedReport(terminalGrade, ["S1", "S2"]);
    const { dsl, artifactStore } = runtimeWith(fixture, async (request) => {
      calls.push(request);
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }]));
      if (request.label === "review step S1 attempt 1") {
        return completed(request, review("repair", "The final-page assertion still fails.", ["Fix the S1 assertion."]));
      }
      if (request.label === "review step S1 attempt 2") {
        return completed(request, review("accept", "S1 now passes its verification."));
      }
      if (request.label === "grade implementation") return completed(request, terminalGrade);
      return completed(request, `# ${request.label}\nDone.`);
    });

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).resolves.toBe(report);
    expect(calls.map((call) => call.label)).toEqual([
      "select plan steps",
      "resolve implementation scope",
      "implement step S1 attempt 1",
      "review step S1 attempt 1",
      "implement step S1 attempt 2",
      "review step S1 attempt 2",
      "collect check evidence",
      "grade implementation",
    ]);
    expect(calls[4]?.prompt).toContain("1. Fix the S1 assertion.");
    expect(calls[4]?.prompt).toContain("| S1 | Advance the offset | in-progress | 2 |");
    expect(calls[4]?.prompt).toContain("The final-page assertion still fails.");
    expect(calls.some((call) => call.label?.includes("S2"))).toBe(false);
    expect(namedAnswers(artifactStore)).toEqual([
      "step-selection.json",
      "scope.md",
      "worker-S1-attempt-1.md",
      "review-S1-attempt-1.json",
      "worker-S1-attempt-2.md",
      "review-S1-attempt-2.json",
      "check-evidence.json",
      "implementation-verdict.json",
    ]);
  });

  it("reconciles a final partial report once and gates success on the fresh report", async () => {
    const fixture = createPlanFixture({ steps: [STEP_S1] });
    const calls: WorkflowAgentRequest[] = [];
    const partialGrade = grade(
      "partial",
      [{ id: "S1", status: "partial", remaining: "Replace the assertion and rerun the focused check." }],
      "The final evidence still uses the wrong assertion.",
    );
    const completeGrade = grade(
      "complete",
      [{ id: "S1", status: "done" }],
      "The reconciliation closed the final evidence gap.",
    );
    const completeReport = renderedReport(completeGrade);
    const { dsl, artifactStore } = runtimeWith(fixture, async (request) => {
      calls.push(request);
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }]));
      if (request.label === "review step S1 attempt 1") {
        return completed(request, review("accept", "The isolated step review passed."));
      }
      if (request.label === "grade implementation") return completed(request, partialGrade);
      if (request.label === "reconcile implementation") {
        expect(request.prompt).toContain('"status": "partial"');
        expect(request.prompt).toContain("Replace the assertion");
        return completed(request, "# Reconciliation\nCorrected the assertion and reran the focused check.");
      }
      if (request.label === "grade reconciliation") {
        expect(request.prompt).toContain('"status": "partial"');
        expect(request.prompt).toContain("# Reconciliation");
        return completed(request, completeGrade);
      }
      return completed(request, `# ${request.label}\nDone.`);
    });

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).resolves.toBe(completeReport);
    expect(calls.map((call) => call.label)).toEqual([
      "select plan steps",
      "resolve implementation scope",
      "implement step S1 attempt 1",
      "review step S1 attempt 1",
      "collect check evidence",
      "grade implementation",
      "reconcile implementation",
      "collect reconciliation evidence",
      "grade reconciliation",
    ]);
    expect(calls.map((call) => call.phase)).toEqual([
      "select-steps",
      "resolve-implementation-scope",
      "apply-steps",
      "apply-steps",
      "collect-check-evidence",
      "report-implementation",
      "reconcile-implementation",
      "collect-reconciliation-evidence",
      "report-reconciliation",
    ]);
    expect(calls[6]?.readOnly).toBeUndefined();
    expect(calls[7]?.readOnly).toBe(true);
    expect(calls[8]?.readOnly).toBe(true);
    expect(namedAnswers(artifactStore)).toEqual([
      "step-selection.json",
      "scope.md",
      "worker-S1-attempt-1.md",
      "review-S1-attempt-1.json",
      "check-evidence.json",
      "implementation-verdict.json",
      "reconciliation.md",
      "reconciliation-check-evidence.json",
      "reconciliation-verdict.json",
    ]);
    expect(namedPublished(artifactStore)).toEqual([
      "implementation-tasks.md",
      "implementation-tasks.md",
      "implementation-tasks.md",
      "implementation-tasks.md",
      "implementation-report.md",
      "workflow-summary.md",
    ]);
  });

  it("returns non-success when the final report stays partial after reconciliation", async () => {
    const fixture = createPlanFixture({ steps: [STEP_S1] });
    const partialGrade = grade(
      "partial",
      [{ id: "S1", status: "partial", remaining: "Operator direction is required." }],
      "S1 remains incomplete.",
    );
    const { dsl } = runtimeWith(fixture, async (request) => {
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }]));
      if (request.label === "review step S1 attempt 1")
        return completed(request, review("accept", "Locally complete."));
      if (request.label === "grade implementation" || request.label === "grade reconciliation") {
        return completed(request, partialGrade);
      }
      return completed(request, `# ${request.label}\nDone.`);
    });

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).resolves.toMatchObject({
      ok: false,
      partial: true,
      appliedSteps: [],
      unresolvedRows: ["S1"],
    });
  });

  it("re-asks a contradictory complete grade instead of accepting Markdown-like control claims", async () => {
    const fixture = createPlanFixture({ steps: [STEP_S1] });
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(fixture, async (request) => {
      calls.push(request);
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }]));
      if (request.label === "review step S1 attempt 1") return completed(request, review("accept", "S1 passed."));
      if (request.label === "grade implementation") {
        return completed(
          request,
          grade("complete", [{ id: "S1", status: "partial", remaining: "The check still fails." }]),
        );
      }
      return completed(request, `# ${request.label}\nDone.`);
    });

    const rejection = (await loadWorkflow())(dsl, DEFAULT_INTENT);
    await expect(rejection).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(rejection).rejects.toThrow("outcome complete requires a ready primary deliverable");
    expect(calls.filter((call) => call.label === "grade implementation")).toHaveLength(3);
  });

  it("refuses a complete outcome after an observed repository check failure", async () => {
    const fixture = createPlanFixture({ steps: [STEP_S1] });
    const calls: WorkflowAgentRequest[] = [];
    const terminalGrade = grade("complete", [{ id: "S1", status: "done" }]);
    const { dsl } = runtimeWith(fixture, async (request) => {
      calls.push(request);
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }]));
      if (request.label === "review step S1 attempt 1") return completed(request, review("accept", "S1 passed."));
      if (request.label === "collect check evidence") {
        return completed(request, checkEvidence(["S1"], { repositoryStatus: "failed" }));
      }
      if (request.label === "grade implementation") return completed(request, terminalGrade);
      return completed(request, `# ${request.label}\nDone.`);
    });

    const rejection = (await loadWorkflow())(dsl, DEFAULT_INTENT);
    await expect(rejection).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(rejection).rejects.toThrow("every collected check passed");
    expect(calls.filter((call) => call.label === "grade implementation")).toHaveLength(3);
  });

  it("keeps unexpected run-attributable changes out of complete and shows them in the primary summary", async () => {
    const fixture = createPlanFixture({ steps: [STEP_S1] });
    const unexpected = "src/unrelated.ts — changed by this run outside S1.";
    const partialGrade = grade(
      "partial",
      [{ id: "S1", status: "done" }],
      "The selected step is done, but the run left an unexpected change.",
      "ready",
    );
    const { dsl } = runtimeWith(fixture, async (request) => {
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }]));
      if (request.label === "review step S1 attempt 1") return completed(request, review("accept", "S1 passed."));
      if (request.label === "collect check evidence" || request.label === "collect reconciliation evidence") {
        return completed(request, checkEvidence(["S1"], { unexpectedChanges: [unexpected] }));
      }
      if (request.label === "grade implementation" || request.label === "grade reconciliation") {
        return completed(request, partialGrade);
      }
      return completed(request, `# ${request.label}\nDone.`);
    });

    const result = (await (await loadWorkflow())(dsl, DEFAULT_INTENT)) as { summary: string };
    expect(result.summary).toContain("## Unexpected run-attributable changes");
    expect(result.summary).toContain(unexpected);
  });

  it("rejects a complete grade while an unexpected run-attributable change remains", async () => {
    const fixture = createPlanFixture({ steps: [STEP_S1] });
    const terminalGrade = grade("complete", [{ id: "S1", status: "done" }]);
    const { dsl } = runtimeWith(fixture, async (request) => {
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }]));
      if (request.label === "review step S1 attempt 1") return completed(request, review("accept", "S1 passed."));
      if (request.label === "collect check evidence") {
        return completed(
          request,
          checkEvidence(["S1"], { unexpectedChanges: ["src/unrelated.ts — changed outside S1."] }),
        );
      }
      if (request.label === "grade implementation") return completed(request, terminalGrade);
      return completed(request, `# ${request.label}\nDone.`);
    });

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).rejects.toThrow("no unexpected run-attributable changes");
  });

  it("reconciles a missing primary deliverable after all selected steps are done", async () => {
    const fixture = createPlanFixture({ steps: [STEP_S1] });
    const calls: WorkflowAgentRequest[] = [];
    const missingGrade = grade(
      "partial",
      [{ id: "S1", status: "done" }],
      "The implementation landed, but the declared result is missing.",
      "missing",
    );
    const completeGrade = grade("complete", [{ id: "S1", status: "done" }]);
    const { dsl } = runtimeWith(fixture, async (request) => {
      calls.push(request);
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }]));
      if (request.label === "review step S1 attempt 1") return completed(request, review("accept", "S1 passed."));
      if (request.label === "grade implementation") return completed(request, missingGrade);
      if (request.label === "grade reconciliation") return completed(request, completeGrade);
      return completed(request, `# ${request.label}\nDone.`);
    });

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).resolves.toBe(renderedReport(completeGrade));
    expect(calls.map((call) => call.label)).toContain("reconcile implementation");
  });

  it("rejects terminal rows that are unknown, out of order, or outside the selected set", async () => {
    const fixture = createPlanFixture();
    const calls: WorkflowAgentRequest[] = [];
    let gradeAttempt = 0;
    const { dsl } = runtimeWith(fixture, async (request) => {
      calls.push(request);
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }]));
      if (request.label === "review step S1 attempt 1") return completed(request, review("accept", "S1 passed."));
      if (request.label === "grade implementation") {
        gradeAttempt += 1;
        if (gradeAttempt === 1) {
          return completed(
            request,
            grade("complete", [
              { id: "S1", status: "done" },
              { id: "S9", status: "not-attempted" },
            ]),
          );
        }
        if (gradeAttempt === 2) {
          return completed(
            request,
            grade("complete", [
              { id: "S2", status: "not-attempted" },
              { id: "S1", status: "done" },
            ]),
          );
        }
        return completed(
          request,
          grade("complete", [
            { id: "S1", status: "done" },
            { id: "S2", status: "done" },
          ]),
        );
      }
      return completed(request, `# ${request.label}\nDone.`);
    });

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).rejects.toThrow(
      "steps: expected exactly 1 selected row(s), got 2",
    );
    expect(calls.filter((call) => call.label === "grade implementation")).toHaveLength(3);
  });

  it("skips the steps after a failed writer but still checks and reports what landed", async () => {
    // A plan's steps are ordered because each one builds on the last, so running
    // the rest on top of a failure is how a plan half-lands. The run still has to
    // describe a working tree it has already changed.
    const fixture = createPlanFixture();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, artifactStore } = runtimeWith(fixture, async (request) => {
      calls.push(request);
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }, { id: "S2" }]));
      if (request.label === "implement step S1 attempt 1") return failed(request, "writer failed");
      if (request.label === "grade implementation") {
        return completed(
          request,
          grade("blocked", [
            { id: "S1", status: "blocked", remaining: "The writer failed." },
            { id: "S2", status: "not-attempted", remaining: "S1 must finish first." },
          ]),
        );
      }
      return completed(request, `# ${request.label}\nDone.`);
    });

    const result = await (await loadWorkflow())(dsl, DEFAULT_INTENT);

    expect(result).toMatchObject({
      ok: false,
      partial: true,
      appliedSteps: [],
      failedStep: "S1",
      unresolvedRows: ["S1", "S2"],
    });
    expect((result as { reason: string }).reason).toContain("plan-implement stopped at step S1");
    expect(calls.map((call) => call.label)).toEqual([
      "select plan steps",
      "resolve implementation scope",
      "implement step S1 attempt 1",
      "collect check evidence",
      "grade implementation",
    ]);
    // The report is still retained: the operator's tree may have changed already.
    expect(namedAnswers(artifactStore)).toEqual([
      "step-selection.json",
      "scope.md",
      "check-evidence.json",
      "implementation-verdict.json",
    ]);
  });

  it("stops after a reviewer blocks a task and preserves earlier accepted tasks", async () => {
    const fixture = createPlanFixture();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, artifactStore } = runtimeWith(fixture, async (request) => {
      calls.push(request);
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S1" }, { id: "S2" }]));
      if (request.label === "review step S1 attempt 1") {
        return completed(request, review("accept", "S1 is complete."));
      }
      if (request.label === "review step S2 attempt 1") {
        return completed(
          request,
          review("blocked", "S2 names a removed API.", ["The accepted plan must be revised before S2 can continue."]),
        );
      }
      if (request.label === "grade implementation") {
        return completed(
          request,
          grade("blocked", [
            { id: "S1", status: "done" },
            { id: "S2", status: "blocked", remaining: "The accepted plan names a removed API." },
          ]),
        );
      }
      return completed(request, `# ${request.label}\nDone.`);
    });

    const result = await (await loadWorkflow())(dsl, DEFAULT_INTENT);

    expect(result).toMatchObject({
      ok: false,
      partial: true,
      appliedSteps: ["S1"],
      failedStep: "S2",
      unresolvedRows: ["S2"],
    });
    expect(calls.map((call) => call.label)).toEqual([
      "select plan steps",
      "resolve implementation scope",
      "implement step S1 attempt 1",
      "review step S1 attempt 1",
      "implement step S2 attempt 1",
      "review step S2 attempt 1",
      "collect check evidence",
      "grade implementation",
    ]);
    expect(namedPublished(artifactStore)).toEqual([
      "implementation-tasks.md",
      "implementation-tasks.md",
      "implementation-tasks.md",
      "implementation-tasks.md",
      "implementation-report.md",
      "workflow-summary.md",
    ]);
  });

  it("re-asks the selector when it omits a selected step's declared dependency", async () => {
    const fixture = createPlanFixture();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(fixture, async (request) => {
      calls.push(request);
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S2" }]));
      return completed(request, `# ${request.label}\nDone.`);
    });

    const rejection = (await loadWorkflow())(dsl, DEFAULT_INTENT);
    await expect(rejection).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(rejection).rejects.toThrow("step S2 requires selected dependency S1");
    expect(calls.map((call) => call.label)).toEqual(["select plan steps", "select plan steps", "select plan steps"]);
  });

  it("re-asks the selector for a step id the plan does not contain", async () => {
    const fixture = createPlanFixture();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(fixture, async (request) => {
      calls.push(request);
      if (request.label === "select plan steps") return completed(request, selection([{ id: "S9" }]));
      return completed(request, `# ${request.label}\nDone.`);
    });

    const rejection = (await loadWorkflow())(dsl, DEFAULT_INTENT);
    await expect(rejection).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(rejection).rejects.toThrow('steps[0].id: value "S9" is not a step id in the plan');
    // Three attempts: agreement with the host-parsed plan is repairable by the
    // child that produced it, so it is re-asked rather than ending the run.
    expect(calls.map((call) => call.label)).toEqual(["select plan steps", "select plan steps", "select plan steps"]);
    expect(calls[1]?.prompt).toContain('steps[0].id: value "S9" is not a step id in the plan');
  });

  it.each([
    ["# Implementation Plan\n## Steps\n### S1 — Change\nFiles: `a.ts`", 'supplied plan has no "## Outcome" section'],
    [planText([STEP_S1]).replace("## Steps", "## Work"), 'supplied plan has no "## Steps" section'],
    [planText([]), "found no steps in the supplied plan"],
    [planText(["### Advance the offset\nFiles: `a.ts`"]), "invalid step heading"],
    [
      planText([STEP_S1]).replace("## Steps", "## Outcome\nOutcome type: decision\n\n## Steps"),
      'exactly one "## Outcome" section',
    ],
  ])("fails closed on a malformed plan: %s", async (broken, message) => {
    // The plan was written by a previous run's agent: nobody in *this* run can be
    // re-asked for it, which is what makes a fatal error the right tier here.
    const root = mkdtempSync(path.join(tmpdir(), "locus-plan-implement-broken-"));
    const sourceRunDir = path.join(root, ".pi", "locus-pi", "workflows", "plan-source");
    mkdirSync(sourceRunDir, { recursive: true });
    const sourceStore = createWorkflowArtifactStore({
      projectRoot: root,
      runId: "plan-source",
      runDir: sourceRunDir,
    });
    const planRef = sourceStore.recordAgentEvidence({
      callId: "call-0003",
      name: "plan.md",
      stage: "draft-plan",
      text: broken,
      replayed: false,
    }).answer!;
    writeFileSync(
      workflowResultFile(sourceRunDir),
      `${JSON.stringify({
        ok: true,
        result: broken,
        artifactRefs: [planRef],
        target: { kind: "name", ref: "plan", source: "project" },
      })}\n`,
      "utf8",
    );
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith({ root, planRef, planText: broken }, async (request) => {
      calls.push(request);
      return completed(request, "unused");
    });

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it("accepts a plan of any length, and refuses only an empty one", async () => {
    // A length cap on the whole plan could only reject something somebody had
    // already accepted, after the run that wrote it was over. 201 ordinary
    // steps put this plan past both the old 256,000-character plan bound and the
    // old 200-row terminal-grade bound, while each block stays inside the
    // per-step budget that really does keep one writer's prompt in hand.
    const steps = Array.from({ length: 201 }, (_unused, index) =>
      [
        `### S${index + 1} — Rewrite pagination part ${index + 1}`,
        "Files: `src/page.ts`",
        `Change: ${"detail ".repeat(200)}`,
        "Verify: `npm test -- page`",
        index === 0 ? "Depends on: none" : `Depends on: S${index}`,
      ].join("\n"),
    );
    const fixture = createPlanFixture({ steps });
    expect(fixture.planText.length).toBeGreaterThan(256_000);

    const terminalGrade = grade("complete", [{ id: "S1", status: "done" }]);
    const report = renderedReport(
      terminalGrade,
      Array.from({ length: 201 }, (_unused, index) => `S${index + 1}`),
    );
    const { dsl } = runtimeWith(fixture, async (request) => {
      switch (request.label) {
        case "select plan steps":
          return completed(request, selection([{ id: "S1" }]));
        case "review step S1 attempt 1":
          return completed(request, review("accept", "S1 passed."));
        case "grade implementation":
          return completed(request, terminalGrade);
        default:
          return completed(request, `# ${request.label}\nDone.`);
      }
    });

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).resolves.toBe(report);
  });

  it("refuses missing plan input and empty continuation intent", async () => {
    const fixture = createPlanFixture();
    const runId = "plan-implement-no-continuation";
    const runDir = path.join(fixture.root, ".pi", "locus-pi", "workflows", runId);
    mkdirSync(runDir, { recursive: true });
    const artifactStore = createWorkflowArtifactStore({ projectRoot: fixture.root, runId, runDir });
    const { dsl } = createWorkflowRuntime({
      runId,
      projectRoot: fixture.root,
      artifactPorts: artifactStore,
      resourceLoader: createWorkflowResourceLoader({ workflowSourcePath: workflowPath, runDir }),
      agentRunner: async (request) => completed(request, "unused"),
    });

    await expect((await loadWorkflow())(dsl, "  ")).rejects.toThrow(
      "plan-implement plan input must be a non-empty string",
    );

    const withPlan = runtimeWith(fixture, async (request) => completed(request, "unused"));
    await expect((await loadWorkflow())(withPlan.dsl, "  ")).rejects.toThrow(
      "plan-implement intent must be a non-empty string",
    );
  });
});
