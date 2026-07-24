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
  WorkflowAgentExecutionError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/review-fix/review-fix.workflow.mjs");
const workflowDirectory = path.dirname(workflowPath);
const resourceDirectory = path.join(workflowDirectory, "resources");
const PROMPTS = [
  "selector-planner.prompt.md",
  "scope-resolver.prompt.md",
  "implementer.prompt.md",
  "check-evidence.prompt.md",
  "re-review.prompt.md",
];

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as { default?: (dsl: unknown, input?: unknown) => Promise<unknown> };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function promptSource(name: string): string {
  return readFileSync(path.join(resourceDirectory, name), "utf8");
}

const FINDING_F1 = [
  "### F1 — [P1] Advance the pagination offset",
  "",
  "Path: `src/page.ts`",
  "Anchor: `loadPage`",
  "Evidence: F1 offset remains zero.",
  "Recommended change: Advance the offset.",
].join("\n");

const FINDING_F2 = [
  "### F2 — [P2] Cover the final page",
  "",
  "Path: `tests/page.test.ts`",
  "Anchor: `last page`",
  "Evidence: F2 final-page behavior is untested.",
  "Recommended change: Add the missing case.",
].join("\n");

const FINDING_F3 = [
  "### F3 — [P2] Preserve the cursor contract",
  "",
  "Path: `src/cursor.ts`",
  "Anchor: `nextCursor`",
  "Evidence: F3 cursor behavior needs revalidation.",
  "Recommended change: Preserve the public cursor contract.",
].join("\n");

const FINDING_F4 = [
  "### F4 — [P2] Keep cursor callers aligned",
  "",
  "Path: `src/caller.ts`",
  "Anchor: `loadNextPage`",
  "Evidence: F4 callers depend on the cursor remediation.",
  "Recommended change: Update only after F3 succeeds.",
].join("\n");

function reviewText(findings: string[] = [FINDING_F1, FINDING_F2]): string {
  return [
    "# Code Review",
    "",
    "## Reviewed scope",
    "",
    "Target: `origin/main...HEAD`",
    "",
    "## Findings",
    "",
    ...findings.flatMap((finding) => [finding, ""]),
    "## Question resolutions",
    "",
    "None.",
  ].join("\n");
}

interface ReviewFixture {
  root: string;
  reviewRef: WorkflowArtifactRef;
  reviewText: string;
  sourceStore: ReturnType<typeof createWorkflowArtifactStore>;
}

function createReviewFixture(findings?: string[], targetRef = "review", stage = "verify-review"): ReviewFixture {
  const root = mkdtempSync(path.join(tmpdir(), "locus-review-fix-"));
  const sourceRunId = "review-source";
  const sourceRunDir = path.join(root, ".locus", "runtime", "workflows", sourceRunId);
  mkdirSync(sourceRunDir, { recursive: true });
  const sourceStore = createWorkflowArtifactStore({ projectRoot: root, runId: sourceRunId, runDir: sourceRunDir });
  const text = reviewText(findings);
  const reviewRef = sourceStore.recordAgentEvidence({
    callId: "call-0005",
    name: "review.md",
    stage,
    text,
    replayed: false,
  }).answer!;
  writeFileSync(
    path.join(sourceRunDir, "result.json"),
    `${JSON.stringify({
      ok: true,
      result: text,
      artifactRefs: [reviewRef],
      target: { kind: "name", ref: targetRef, source: "package" },
    })}\n`,
    "utf8",
  );
  return { root, reviewRef, reviewText: text, sourceStore };
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
  root: string,
  reviewRef: WorkflowArtifactRef,
  agentRunner: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult>,
  sourceStates: ReturnType<typeof sourceState>[] = [sourceState()],
) {
  const runId = `review-fix-test-${++runtimeOrdinal}`;
  let sourceStateIndex = 0;
  const runDir = path.join(root, ".locus", "runtime", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  const artifactStore = createWorkflowArtifactStore({ projectRoot: root, runId, runDir });
  const consumedReview = artifactStore.consumeText(reviewRef);
  return {
    artifactStore,
    ...createWorkflowRuntime({
      runId,
      projectRoot: root,
      artifactPorts: artifactStore,
      continuation: {
        originRunId: reviewRef.runId,
        artifacts: [{ sourceRef: reviewRef, consumedArtifact: consumedReview }],
      },
      sourceState: {
        capture: () => sourceStates[Math.min(sourceStateIndex++, sourceStates.length - 1)] ?? sourceState(),
      },
      resourceLoader: createWorkflowResourceLoader({ workflowSourcePath: workflowPath, runDir }),
      agentRunner,
    }),
  };
}

const DEFAULT_INTENT = "Fix the selected findings without changing public behavior.";

function plan(findings: Array<{ id: string; note?: string; dependsOn?: string[] }>): string {
  return JSON.stringify({
    findings: findings.map(({ id, note = "", dependsOn = [] }) => ({ id, note, dependsOn })),
  });
}

describe("curated review remediation workflow", () => {
  it("keeps selection and complete-block parsing deterministic and delegates artifact persistence to the runtime", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(source).not.toContain("review-fix-input.mjs");
    expect(source).toContain('identityCoverage: "self-contained-static"');
    expect(source).toContain("function parseFindingBlocks");
    expect(source).toContain("continuationArtifacts()");
    expect(source).toContain("requireReviewArtifact(consumedReview, reviewRef)");
    expect(source).toContain("FINDING_SELECTOR_SCHEMA");
    expect(source).toContain("validateAndOrderFindingPlan");
    expect(source).toContain('artifact: "scope.md"');
    expect(source).toContain("artifact: `worker-${finding.id}.md`");
    expect(source).toContain('artifact: "check-evidence.md"');
    expect(source).toContain('artifact: "re-review.md"');
    expect(source).toContain("captureSourceState");
    expect(source).toContain("MAX_SELECTED_FINDINGS");
    expect(source).toContain("MAX_PREDECESSOR_CONTEXT_CHARS");
    for (const name of PROMPTS) expect(source, name).toContain(`promptFile("./resources/${name}"`);
    expect(source).not.toContain("publisher.prompt.md");
    expect(source).not.toContain("unit-planner.prompt.md");
    expect(source).not.toContain("JSON.parse");
    expect(source).toContain("schema: FINDING_SELECTOR_SCHEMA");
    expect(source).not.toMatch(/\bask\s*\(/u);
    expect(source).not.toContain("workspaceHandle");

    expect(promptSource("scope-resolver.prompt.md")).toContain("This stage is host-enforced read-only.");
    expect(promptSource("re-review.prompt.md")).toContain("This stage is host-enforced read-only.");
    expect(promptSource("implementer.prompt.md")).toContain("exactly the one");
    expect(promptSource("check-evidence.prompt.md")).toContain("host-enforced read-only");
    expect(promptSource("check-evidence.prompt.md")).toContain("`repository_check`");
    expect(promptSource("check-evidence.prompt.md")).not.toMatch(/have a shell/iu);
    expect(promptSource("re-review.prompt.md")).toMatch(/callers, dependents, tests, configuration/iu);
    for (const name of PROMPTS) {
      expect(promptSource(name), name).not.toMatch(/\$locus|installed skill/iu);
    }
  });

  it("refuses a same-name report that did not come from the Package review verifier", async () => {
    const fixture = createReviewFixture(undefined, "lookalike-review");
    const { dsl } = runtimeWith(fixture.root, fixture.reviewRef, async (agentRequest) =>
      completed(agentRequest, "unused"),
    );

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).rejects.toThrow(
      'Package review verify-review answer named "review.md"',
    );
  });

  it("rejects metadata-only provenance forgery and a terminal result that omits the exact ref", async () => {
    const workflow = await loadWorkflow();
    for (const mode of ["different-result", "missing-ref"] as const) {
      const fixture = createReviewFixture(
        undefined,
        "review",
        mode === "different-result" ? "resolve-scope" : "verify-review",
      );
      const sourceRunDir = path.join(fixture.root, ".locus", "runtime", "workflows", fixture.reviewRef.runId);
      if (mode === "different-result") {
        const indexPath = path.join(sourceRunDir, "artifacts", "index.json");
        const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
          artifacts: Array<{ artifactId: string; stage?: string }>;
        };
        index.artifacts.find(({ artifactId }) => artifactId === fixture.reviewRef.artifactId)!.stage = "verify-review";
        writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
      }
      writeFileSync(
        path.join(sourceRunDir, "result.json"),
        `${JSON.stringify({
          ok: true,
          result: mode === "different-result" ? "an unrelated terminal answer" : fixture.reviewText,
          artifactRefs: mode === "missing-ref" ? [] : [fixture.reviewRef],
          target: { kind: "name", ref: "review", source: "package" },
        })}\n`,
      );
      let agentCalls = 0;
      if (mode === "missing-ref") {
        expect(() =>
          runtimeWith(fixture.root, fixture.reviewRef, async (agentRequest) => {
            agentCalls += 1;
            return completed(agentRequest, "unused");
          }),
        ).toThrow("not present in the source run terminal projection");
        expect(agentCalls).toBe(0);
        continue;
      }
      const { dsl } = runtimeWith(fixture.root, fixture.reviewRef, async (agentRequest) => {
        agentCalls += 1;
        return completed(agentRequest, "unused");
      });

      await expect(workflow(dsl, DEFAULT_INTENT)).rejects.toThrow("terminal Package review verify-review answer");
      expect(agentCalls).toBe(0);
    }
  });

  it("runs one sequential writer per kept complete block and returns the exact runtime-owned re-review", async () => {
    const fixture = createReviewFixture();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      "plan finding graph": plan([{ id: "F2", note: "Use a table-driven test.", dependsOn: ["F1"] }, { id: "F1" }]),
      "resolve fix scope": "# Remediation Scope\nDependency: src/cursor.ts",
      "apply finding F1": "Changed src/page.ts for the pagination offset.",
      "apply finding F2": "Changed tests/page.test.ts after checking the direct dependency result.",
      "collect check evidence": "# Check Evidence\n- npm test — passed",
      "re-review fixes": "# Re-review\n\nF1 and F2 are resolved; dependency coverage is present.\n",
    };
    const { dsl, artifactStore } = runtimeWith(
      fixture.root,
      fixture.reviewRef,
      async (agentRequest) => {
        calls.push(agentRequest);
        return completed(agentRequest, outputs[agentRequest.label!]!);
      },
      [
        sourceState("a".repeat(64)),
        sourceState("a".repeat(64)),
        sourceState("b".repeat(64)),
        sourceState("b".repeat(64)),
        sourceState("c".repeat(64)),
        sourceState("c".repeat(64)),
        sourceState("c".repeat(64)),
        sourceState("c".repeat(64)),
      ],
    );
    const intent = "  Fix only these findings; retain the cursor API exactly.  ";

    const result = await (await loadWorkflow())(dsl, intent);

    expect(result).toBe(outputs["re-review fixes"]);
    expect(calls.map((call) => call.label)).toEqual([
      "plan finding graph",
      "resolve fix scope",
      "apply finding F1",
      "apply finding F2",
      "collect check evidence",
      "re-review fixes",
    ]);
    expect(calls.map((call) => call.phase)).toEqual([
      "resolve-fix-scope",
      "resolve-fix-scope",
      "apply-kept-findings",
      "apply-kept-findings",
      "collect-check-evidence",
      "re-review-fixes",
    ]);
    expect(calls.map((call) => call.readOnly)).toEqual([true, true, undefined, undefined, true, true]);
    expect(calls.map((call) => call.tools?.join(","))).toEqual([
      "",
      "read,git_read,ast_index,grep,find",
      "read,write,edit,bash,ast_index,grep,find",
      "read,write,edit,bash,ast_index,grep,find",
      "read,git_read,ast_index,repository_check,grep,find",
      "read,git_read,ast_index,grep,find",
    ]);
    expect(calls.every((call) => call.prompt.includes(intent))).toBe(true);
    expect(calls[0]?.prompt).toContain(fixture.reviewText);
    expect(calls[2]?.prompt).toContain(FINDING_F1);
    expect(calls[2]?.prompt).not.toContain("F2 final-page behavior is untested");
    expect(calls[3]?.prompt).toContain(FINDING_F2);
    expect(calls[3]?.prompt).toContain("Use a table-driven test.");
    expect(calls[3]?.prompt).toContain(outputs["apply finding F1"]);
    expect(calls[4]?.prompt).toContain(outputs["apply finding F2"]);
    expect(calls[4]?.prompt).toContain(outputs["apply finding F1"]);
    expect(calls[5]?.prompt).toContain(fixture.reviewText);
    expect(calls[5]?.prompt).toContain(outputs["collect check evidence"]);
    expect(calls[5]?.prompt).toMatch(/callers, dependents, tests, configuration/iu);
    expect(calls[5]?.prompt).toContain("writer_window_changed");

    expect(artifactStore.list().map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      "input:review.md",
      "published:source-state-before-remediation.json",
      "answer:finding-plan.json",
      "answer:scope.md",
      "published:source-state-before-writer-f1.json",
      "answer:worker-F1.md",
      "published:source-state-after-writer-f1.json",
      "published:source-state-before-writer-f2.json",
      "answer:worker-F2.md",
      "published:source-state-after-writer-f2.json",
      "published:source-state-before-check.json",
      "answer:check-evidence.md",
      "published:source-state-after-check.json",
      "published:source-state-before-re-review.json",
      "answer:re-review.md",
    ]);
    expect(fixture.sourceStore.read(fixture.reviewRef).toString("utf8")).toBe(fixture.reviewText);
  });

  it("rejects invalid selector graphs before scope resolution or any writer runs", async () => {
    const fixture = createReviewFixture();
    const workflow = await loadWorkflow();

    for (const [selectorOutput, message] of [
      [plan([]), "must choose 1-20 findings"],
      [plan(Array.from({ length: 21 }, (_, index) => ({ id: `F${String(index + 1)}` }))), "must choose 1-20"],
      [plan([{ id: "F1" }, { id: "F1" }]), "repeats finding id: F1"],
      [plan([{ id: "F9" }]), "finding id is unknown: F9"],
      [plan([{ id: "F1", note: "x".repeat(8_001) }]), "note for F1 exceeds 8000"],
      [plan([{ id: "F1", dependsOn: ["F1"] }]), "F1 depends on itself"],
      [plan([{ id: "F1" }, { id: "F2", dependsOn: ["F1", "F1"] }]), "repeats dependency F1"],
      [plan([{ id: "F1", dependsOn: ["F9"] }]), "dependency is unknown: F9"],
      [plan([{ id: "F2", dependsOn: ["F1"] }]), "dependency F1 is not selected"],
      [
        plan([
          { id: "F1", dependsOn: ["F2"] },
          { id: "F2", dependsOn: ["F1"] },
        ]),
        "contains a cycle",
      ],
    ] as const) {
      const calls: WorkflowAgentRequest[] = [];
      const { dsl } = runtimeWith(fixture.root, fixture.reviewRef, async (request) => {
        calls.push(request);
        if (request.label !== "plan finding graph") throw new Error("scope/writer must not run");
        return completed(request, selectorOutput);
      });
      await expect(workflow(dsl, DEFAULT_INTENT)).rejects.toThrow(message);
      expect(calls.map((call) => call.label)).toEqual(["plan finding graph"]);
    }
  });

  it("bounds direct-dependency handoffs while preserving every dependency id", async () => {
    const fixture = createReviewFixture([FINDING_F1, FINDING_F2, FINDING_F3]);
    const calls: WorkflowAgentRequest[] = [];
    const largeResult = "worker evidence ".repeat(2_000);
    const { dsl } = runtimeWith(fixture.root, fixture.reviewRef, async (agentRequest) => {
      calls.push(agentRequest);
      return completed(
        agentRequest,
        agentRequest.label === "plan finding graph"
          ? plan([{ id: "F1" }, { id: "F2" }, { id: "F3", dependsOn: ["F1", "F2"] }])
          : agentRequest.label?.startsWith("apply finding")
            ? largeResult
            : "evidence",
      );
    });

    await (
      await loadWorkflow()
    )(dsl, DEFAULT_INTENT);

    const thirdWriterPrompt = calls.find((call) => call.label === "apply finding F3")?.prompt ?? "";
    const predecessorContext =
      /--- BEGIN DIRECT DEPENDENCY WORKER RESULTS ---\n([\s\S]*?)\n--- END DIRECT DEPENDENCY WORKER RESULTS ---/u.exec(
        thirdWriterPrompt,
      )?.[1];
    expect(predecessorContext).toBeDefined();
    expect(predecessorContext!.length).toBeLessThanOrEqual(32_000);
    expect(predecessorContext).toContain("## Worker F1");
    expect(predecessorContext).toContain("## Worker F2");
    expect(predecessorContext).toContain("truncated by review-fix host contract");
  });

  it("stops dependents, checker, and re-review when a writer fails", async () => {
    const fixture = createReviewFixture();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(fixture.root, fixture.reviewRef, async (request) => {
      calls.push(request);
      if (request.label === "plan finding graph") {
        return completed(request, plan([{ id: "F1" }, { id: "F2", dependsOn: ["F1"] }]));
      }
      if (request.label === "resolve fix scope") return completed(request, "# Scope");
      if (request.label === "apply finding F1") {
        return {
          ok: false,
          status: "failed",
          summary: "writer failed",
          diagnostics: ["writer failed"],
          agent: request.agent,
          label: request.label,
        };
      }
      throw new Error("dependent/checker/re-review must not run");
    });

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).rejects.toBeInstanceOf(WorkflowAgentExecutionError);
    expect(calls.map((call) => call.label)).toEqual(["plan finding graph", "resolve fix scope", "apply finding F1"]);
  });

  it("continues independent writers after a failure but skips transitive dependents and final phases", async () => {
    const fixture = createReviewFixture([FINDING_F1, FINDING_F2, FINDING_F3, FINDING_F4]);
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, artifactStore } = runtimeWith(fixture.root, fixture.reviewRef, async (request) => {
      calls.push(request);
      if (request.label === "plan finding graph") {
        return completed(
          request,
          plan([{ id: "F1" }, { id: "F2" }, { id: "F3", dependsOn: ["F1"] }, { id: "F4", dependsOn: ["F3"] }]),
        );
      }
      if (request.label === "resolve fix scope") return completed(request, "# Scope");
      if (request.label === "apply finding F1") {
        return {
          ok: false,
          status: "failed",
          summary: "writer failed",
          diagnostics: ["writer failed"],
          agent: request.agent,
          label: request.label,
        };
      }
      if (request.label === "apply finding F2") return completed(request, "independent fix complete");
      throw new Error("dependent/checker/re-review must not run");
    });

    await expect((await loadWorkflow())(dsl, DEFAULT_INTENT)).rejects.toBeInstanceOf(WorkflowAgentExecutionError);
    expect(calls.map((call) => call.label)).toEqual([
      "plan finding graph",
      "resolve fix scope",
      "apply finding F1",
      "apply finding F2",
    ]);
    expect(artifactStore.list().map(({ kind, name }) => `${kind}:${name}`)).toContain(
      "published:source-state-after-writer-f1.json",
    );
  });

  it("rejects invalid review structure and duplicate ids before any agent runs", async () => {
    const missing = createReviewFixture(["No findings."]);
    const duplicate = createReviewFixture([FINDING_F1, FINDING_F1]);
    const workflow = await loadWorkflow();

    for (const [fixture, message] of [
      [missing, "found no findings"],
      [duplicate, "duplicate finding id in review.md: F1"],
    ] as const) {
      let agentCalls = 0;
      const { dsl } = runtimeWith(fixture.root, fixture.reviewRef, async () => {
        agentCalls += 1;
        throw new Error("should not run");
      });
      await expect(workflow(dsl, DEFAULT_INTENT)).rejects.toThrow(message);
      expect(agentCalls).toBe(0);
    }
  });

  it("requires a complete digest-bound review.md reference", async () => {
    const fixture = createReviewFixture();
    const workflow = await loadWorkflow();
    const runId = "review-fix-without-continuation";
    const runDir = path.join(fixture.root, ".locus", "runtime", "workflows", runId);
    mkdirSync(runDir, { recursive: true });
    const artifactStore = createWorkflowArtifactStore({ projectRoot: fixture.root, runId, runDir });
    const { dsl } = createWorkflowRuntime({
      runId,
      projectRoot: fixture.root,
      artifactPorts: artifactStore,
      sourceState: { capture: () => sourceState() },
      resourceLoader: createWorkflowResourceLoader({ workflowSourcePath: workflowPath, runDir }),
      agentRunner: async () => {
        throw new Error("should not run");
      },
    });

    await expect(workflow(dsl, DEFAULT_INTENT)).rejects.toThrow("requires exactly one artifact");
    expect(() =>
      runtimeWith(fixture.root, { ...fixture.reviewRef, name: "other.md" }, async () => {
        throw new Error("should not run");
      }),
    ).toThrow("does not match its source index");
    expect(() =>
      runtimeWith(fixture.root, { ...fixture.reviewRef, sha256: "0".repeat(64) }, async () => {
        throw new Error("should not run");
      }),
    ).toThrow("does not match its source index");
  });
});
