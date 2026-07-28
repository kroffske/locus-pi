import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkflowArtifactStore,
  type WorkflowArtifactRef,
} from "../../../extensions/_shared/workflow-artifacts.js";
import { createWorkflowResourceLoader } from "../../../extensions/_shared/workflow-resources.js";
import {
  createWorkflowRuntime,
  SchemaValidationError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

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
    "## Goal",
    "",
    "Pagination advances past the first page.",
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

function createPlanFixture(options: { steps?: string[] } = {}): PlanFixture {
  const root = mkdtempSync(path.join(tmpdir(), "locus-plan-implement-"));
  const sourceRunId = "plan-source";
  const sourceRunDir = path.join(root, ".locus", "runtime", "workflows", sourceRunId);
  mkdirSync(sourceRunDir, { recursive: true });
  const sourceStore = createWorkflowArtifactStore({ projectRoot: root, runId: sourceRunId, runDir: sourceRunDir });
  const text = planText(options.steps);
  const planRef = sourceStore.recordAgentEvidence({
    callId: "call-0003",
    name: "plan.md",
    stage: "draft-plan",
    text,
    replayed: false,
  }).answer!;
  writeFileSync(
    path.join(sourceRunDir, "result.json"),
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

function sourceState(fingerprint = "a".repeat(64)) {
  return {
    schema: "locus.workflow-source-state.v1" as const,
    fingerprint,
    head: "1".repeat(40),
    indexFingerprint: "2".repeat(64),
    worktreeFingerprint: fingerprint,
    status: [" M src/page.ts"],
  };
}

let runtimeOrdinal = 0;

function runtimeWith(
  fixture: PlanFixture,
  agentRunner: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult>,
  sourceStates: ReturnType<typeof sourceState>[] = [sourceState()],
) {
  const runId = `plan-implement-test-${++runtimeOrdinal}`;
  let sourceStateIndex = 0;
  const runDir = path.join(fixture.root, ".locus", "runtime", "workflows", runId);
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
      sourceState: {
        capture: () => sourceStates[Math.min(sourceStateIndex++, sourceStates.length - 1)] ?? sourceState(),
      },
      resourceLoader: createWorkflowResourceLoader({ workflowSourcePath: workflowPath, runDir }),
      agentRunner,
    }),
  };
}

/** Named answers only: the source-state fingerprints are host-published noise here. */
function namedAnswers(store: ReturnType<typeof createWorkflowArtifactStore>): string[] {
  return store
    .list()
    .filter((record) => record.kind === "answer")
    .map((record) => record.name);
}

const DEFAULT_INTENT = "Implement the accepted plan.";

function selection(steps: Array<{ id: string; note?: string }>): string {
  return JSON.stringify({ steps: steps.map(({ id, note = "" }) => ({ id, note })) });
}

describe("workflow example: plan-implement.workflow.mjs", () => {
  it("puts every read-only stage before the one write-capable role and lets the runtime own artifacts", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(source).toContain("continuationArtifacts()");
    expect(source).toContain("function parseStepBlocks");
    expect(source).toContain("STEP_SELECTOR_SCHEMA");
    // Split the same way the curated examples are: one function decides and never
    // throws, the other merges and orders and never rejects.
    expect(source).toContain("function stepSelectionErrors");
    expect(source).toContain("function orderStepSelection");
    expect(source).toContain("validate: (value) => stepSelectionErrors(steps, value)");
    expect(source).toContain("captureSourceState");
    expect(source).not.toContain("promptFile");
    expect(source).not.toContain("JSON.parse");

    // Exactly one write-capable options constant, and it is the only place the
    // edit tools appear.
    expect(source.match(/readOnly: true/gu)).toHaveLength(3);
    expect(source.match(/"write", "edit"/gu)).toHaveLength(1);

    for (const name of ["step-selection.json", "scope.md", "check-evidence.md", "implementation-report.md"]) {
      expect(source, name).toContain(`artifact: "${name}"`);
    }
    expect(source).toContain("artifact: `worker-${step.id}.md`");
    for (const bound of [
      "maxAnswerChars: MAX_SCOPE_CHARS",
      "maxAnswerChars: MAX_WORKER_RESULT_CHARS",
      "maxAnswerChars: MAX_RAW_CHECK_EVIDENCE_CHARS",
      "maxAnswerChars: MAX_REPORT_CHARS",
    ]) {
      expect(source, bound).toContain(bound);
    }
  });

  it("runs one writer per selected step, in the plan's order, and returns the report", async () => {
    const fixture = createPlanFixture();
    const calls: WorkflowAgentRequest[] = [];
    const report = "# Implementation Report\n## Outcome\nPlan implemented — both steps landed.";
    const { dsl, artifactStore } = runtimeWith(fixture, async (request) => {
      calls.push(request);
      switch (request.label) {
        case "select plan steps":
          // Deliberately reversed: the plan's order is authority, not this list.
          return completed(request, selection([{ id: "S2" }, { id: "S1", note: "keep the signature" }]));
        case "resolve implementation scope":
          return completed(request, "# Scope\nS1 touches `src/page.ts`.");
        case "collect check evidence":
          return completed(request, "# Checks\n`npm test -- page` passed.");
        case "report implementation":
          return completed(request, report);
        default:
          return completed(request, `# ${request.label}\nDone.`);
      }
    });

    const result = await (await loadWorkflow())(dsl, DEFAULT_INTENT);

    expect(result).toBe(report);
    expect(calls.map((call) => call.label)).toEqual([
      "select plan steps",
      "resolve implementation scope",
      "implement step S1",
      "implement step S2",
      "collect check evidence",
      "report implementation",
    ]);
    expect(calls.map((call) => call.phase)).toEqual([
      "select-steps",
      "resolve-implementation-scope",
      "apply-steps",
      "apply-steps",
      "collect-check-evidence",
      "report-implementation",
    ]);
    // The selector has no tools at all; every stage but the writers is read-only.
    expect(calls[0]?.tools).toEqual([]);
    expect(calls[0]?.readOnly).toBe(true);
    expect(calls[2]?.readOnly).toBeUndefined();
    expect(calls[3]?.readOnly).toBeUndefined();
    expect(calls[4]?.readOnly).toBe(true);
    expect(calls[5]?.readOnly).toBe(true);
    // Each writer receives exactly its own step block plus the operator note.
    expect(calls[2]?.prompt).toContain(STEP_S1);
    expect(calls[2]?.prompt).not.toContain("### S2 — Cover the final page");
    expect(calls[2]?.prompt).toContain("keep the signature");
    expect(calls[3]?.prompt).toContain(STEP_S2);
    expect(calls[3]?.prompt).toContain("## Step S1");
    // The report answers against the whole plan, including steps nobody selected.
    expect(calls[5]?.prompt).toContain(fixture.planText);
    expect(namedAnswers(artifactStore)).toEqual([
      "step-selection.json",
      "scope.md",
      "worker-S1.md",
      "worker-S2.md",
      "check-evidence.md",
      "implementation-report.md",
    ]);
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
      if (request.label === "implement step S1") return failed(request, "writer failed");
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
    expect((result as { summary: string }).summary).toContain("plan-implement stopped at step S1");
    expect(calls.map((call) => call.label)).toEqual([
      "select plan steps",
      "resolve implementation scope",
      "implement step S1",
      "collect check evidence",
      "report implementation",
    ]);
    // The report is still retained: the operator's tree may have changed already.
    expect(namedAnswers(artifactStore)).toEqual([
      "step-selection.json",
      "scope.md",
      "check-evidence.md",
      "implementation-report.md",
    ]);
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
    ["# Implementation Plan\n## Goal\nNo steps section here.", 'plan.md has no "## Steps" section'],
    ["# Implementation Plan\n## Steps\n\nProse, but no step headings.", "found no steps in plan.md"],
    ["# Implementation Plan\n## Steps\n### Advance the offset\nFiles: `a.ts`", "invalid step heading"],
  ])("fails closed on a malformed plan: %s", async (broken, message) => {
    // The plan was written by a previous run's agent: nobody in *this* run can be
    // re-asked for it, which is what makes a fatal error the right tier here.
    const root = mkdtempSync(path.join(tmpdir(), "locus-plan-implement-broken-"));
    const sourceRunDir = path.join(root, ".locus", "runtime", "workflows", "plan-source");
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
      path.join(sourceRunDir, "result.json"),
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
    // already accepted, after the run that wrote it was over. Twelve ordinary
    // steps put this plan past the 256,000-character bound the entry used to
    // impose, while each block stays inside the per-step budget that really does
    // keep one writer's prompt in hand.
    const steps = Array.from({ length: 12 }, (_unused, index) =>
      [
        `### S${index + 1} — Rewrite pagination part ${index + 1}`,
        "Files: `src/page.ts`",
        `Change: ${"detail ".repeat(3_500)}`,
        "Verify: `npm test -- page`",
        index === 0 ? "Depends on: none" : `Depends on: S${index}`,
      ].join("\n"),
    );
    const fixture = createPlanFixture({ steps });
    expect(fixture.planText.length).toBeGreaterThan(256_000);

    const report = "# Implementation Report\n## Outcome\nThe one step landed.";
    const { dsl } = runtimeWith(fixture, async (request) => {
      switch (request.label) {
        case "select plan steps":
          return completed(request, selection([{ id: "S1" }]));
        case "report implementation":
          return completed(request, report);
        default:
          return completed(request, `# ${request.label}\nDone.`);
      }
    });

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).resolves.toBe(report);
  });

  it("refuses a continuation that is not exactly one plan.md, and refuses empty input", async () => {
    const fixture = createPlanFixture();
    const runId = "plan-implement-no-continuation";
    const runDir = path.join(fixture.root, ".locus", "runtime", "workflows", runId);
    mkdirSync(runDir, { recursive: true });
    const artifactStore = createWorkflowArtifactStore({ projectRoot: fixture.root, runId, runDir });
    const { dsl } = createWorkflowRuntime({
      runId,
      projectRoot: fixture.root,
      artifactPorts: artifactStore,
      sourceState: { capture: () => sourceState() },
      resourceLoader: createWorkflowResourceLoader({ workflowSourcePath: workflowPath, runDir }),
      agentRunner: async (request) => completed(request, "unused"),
    });

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).rejects.toThrow(
      'plan-implement continuation requires exactly one artifact named "plan.md"',
    );

    const withPlan = runtimeWith(fixture, async (request) => completed(request, "unused"));
    await expect((await loadWorkflow())(withPlan.dsl, "  ")).rejects.toThrow(
      "plan-implement intent must be a non-empty string",
    );
  });
});
