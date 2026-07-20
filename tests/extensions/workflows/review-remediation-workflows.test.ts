import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowResourceLoader } from "../../../extensions/_shared/workflow-resources.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/review-fix/review-fix.workflow.mjs");
const resourceDirectory = path.join(path.dirname(workflowPath), "resources");

const READ_ONLY_PROMPTS = ["scope-resolver.prompt.md", "unit-planner.prompt.md"];
const ALL_PROMPTS = [...READ_ONLY_PROMPTS, "implementer.prompt.md", "verifier.prompt.md", "publisher.prompt.md"];

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function promptSource(name: string): string {
  return readFileSync(path.join(resourceDirectory, name), "utf8");
}

function reviewText(findings: string[]): string {
  return [
    "# Code Review",
    "",
    "## Reviewed scope",
    "",
    "Target: `origin/main...HEAD`",
    "",
    "## Verdict",
    "",
    "Needs changes.",
    "",
    "## Findings",
    "",
    ...findings,
    "## Question resolutions",
    "",
    "### U1-Q1",
    "",
    "Answer: Confirmed.",
  ].join("\n");
}

const FINDING_F1 = [
  "### F1 — [P1] Advance the pagination offset",
  "",
  "Path: `src/page.ts`",
  "Anchor: `loadPage`",
  "Evidence: Offset remains zero.",
  "Recommended change: Advance the offset.",
  "",
  "User note:",
  "Rename the helper while you are there.",
  "",
];

function createReviewFixture(findings: string[] = FINDING_F1) {
  const root = mkdtempSync(path.join(tmpdir(), "locus-review-fix-"));
  const taskId = "T-201-code-review";
  const artifactsDirectory = path.join(root, ".tasks", taskId, "artifacts");
  mkdirSync(artifactsDirectory, { recursive: true });
  const reviewRelative = `.tasks/${taskId}/artifacts/review.md`;
  const text = reviewText(findings);
  writeFileSync(path.join(root, reviewRelative), text, "utf8");
  return { root, taskId, reviewRelative, reviewPath: path.join(root, reviewRelative), reviewText: text };
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

function runtimeWith(root: string, agentRunner: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult>) {
  return createWorkflowRuntime({
    runId: "review-fix-test",
    projectRoot: root,
    resourceLoader: createWorkflowResourceLoader({
      workflowSourcePath: workflowPath,
      runDir: mkdtempSync(path.join(tmpdir(), "locus-review-fix-run-")),
    }),
    agentRunner,
  });
}

describe("curated review remediation workflow", () => {
  it("keeps deterministic path confinement, prompt-only stages, and no hash or disposition protocol", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(source).toContain('from "./review-fix-input.mjs"');
    for (const name of ALL_PROMPTS) {
      expect(source, name).toContain(`promptFile("./resources/${name}"`);
    }
    expect(source).toContain("const REVIEW_FIX_AGENT_DEFAULTS");
    expect(source.match(/maxToolCalls:/gu)).toHaveLength(1);
    expect(source.match(/workspaceMode:/gu)).toHaveLength(1);
    expect(source.match(/readOnly: true/gu)).toHaveLength(2);
    expect(source).toContain('@param {import("../../../_shared/workflow-runtime.ts").WorkflowDsl} dsl');
    expect(source).not.toContain("agentFile");
    expect(source).not.toContain(".agent.md");
    expect(source).not.toContain("schema:");
    expect(source).not.toContain("JSON.parse");
    expect(source).not.toContain("workspaceHandle");
    expect(source).not.toContain("SHA256");
    for (const name of READ_ONLY_PROMPTS) {
      const prompt = promptSource(name);
      expect(prompt, name).toContain("This stage is host-enforced read-only.");
      expect(prompt, name).toContain("You have no shell");
    }
    for (const name of ALL_PROMPTS) {
      const prompt = promptSource(name);
      expect(prompt, name).not.toContain("SHA-256");
      expect(prompt, name).not.toContain("Disposition");
      expect(prompt, name).not.toContain("fix-plan.md");
      expect(prompt, name).not.toContain("worktree");
    }
    for (const name of ["implementer.prompt.md", "verifier.prompt.md", "publisher.prompt.md"]) {
      expect(promptSource(name), name).toMatch(
        /commit, push, create a\s+pull request|commit, push, create a pull request|checkout branches, commit, push/u,
      );
    }
    expect(promptSource("unit-planner.prompt.md")).toMatch(/A finding\s+that\s+no longer holds is stale/u);
    expect(promptSource("verifier.prompt.md")).toMatch(/this stage is not\s+host-enforced read-only/u);
  });

  it("runs six sequential stages and returns the publisher summary exactly", async () => {
    const fixture = createReviewFixture();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      "resolve fix scope": "  # Fix Scope\nIn scope:\n- F1 — still requested\n",
      "plan fix units": "# Fix Units\n## X1\nFindings: F1",
      "apply fix units": '  Changed src/page.ts.\n{"applied":["X1"]}\n',
      "verify fixes and write report": "# Fix Report\n\n## Applied\n### X1 — offset",
      "publish fix package": "  Fixes published.\nPrimary report: .tasks/T-201-code-review/artifacts/fix-report.md\n",
    };
    const { dsl } = runtimeWith(fixture.root, async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    const result = await (await loadWorkflow())(dsl, `apply only the P1 items in ${fixture.reviewRelative}`);

    expect(result).toBe(outputs["publish fix package"]);
    expect(calls.map((call) => call.label)).toEqual([
      "resolve fix scope",
      "plan fix units",
      "apply fix units",
      "verify fixes and write report",
      "publish fix package",
    ]);
    expect(calls.map((call) => call.phase)).toEqual([
      "resolve-fix-scope",
      "plan-fix-units",
      "apply-fix-units",
      "verify-fixes",
      "publish-fix-report",
    ]);
    expect(calls.map((call) => call.readOnly)).toEqual([true, true, undefined, undefined, undefined]);
    expect(calls.map((call) => call.tools?.join(","))).toEqual([
      "read,git_read,grep,find",
      "read,git_read,ast_index,grep,find",
      "read,write,edit,bash,grep,find",
      "read,ast_index,bash,grep,find",
      "read,write,bash,grep,find",
    ]);
    expect(calls.every((call) => call.workspaceMode === "project")).toBe(true);
    expect(calls.every((call) => call.workspaceHandle === undefined)).toBe(true);
    expect(calls[0]?.prompt).toContain("apply only the P1 items");
    expect(calls[0]?.prompt).toContain("Remaining finding IDs: F1");
    expect(calls[0]?.prompt).toContain("Rename the helper while you are there.");
    expect(calls[1]?.prompt).toContain(outputs["resolve fix scope"]);
    expect(calls[2]?.prompt).toContain(outputs["plan fix units"]);
    expect(calls[3]?.prompt).toContain(outputs["apply fix units"]);
    expect(calls[3]?.prompt).not.toContain(fixture.reviewText);
    expect(calls[4]?.prompt).toContain(outputs["verify fixes and write report"]);
    expect(calls[4]?.prompt).toContain(".tasks/T-201-code-review/artifacts/fix-report.md");
  });

  it("refuses a review whose findings the operator removed, before any agent runs", async () => {
    const fixture = createReviewFixture(["None.", ""]);
    let agentCalls = 0;
    const { dsl } = runtimeWith(fixture.root, async (request) => {
      agentCalls += 1;
      return completed(request, "should not run");
    });

    await expect((await loadWorkflow())(dsl, fixture.reviewRelative)).rejects.toThrow(
      "found no remaining findings to apply",
    );
    expect(agentCalls).toBe(0);
  });

  it("rejects a review without a findings section and duplicate finding ids", async () => {
    const missing = createReviewFixture();
    writeFileSync(missing.reviewPath, "# Code Review\n\n## Verdict\n\nNeeds changes.\n", "utf8");
    const duplicate = createReviewFixture([...FINDING_F1, ...FINDING_F1]);
    let agentCalls = 0;
    const workflow = await loadWorkflow();

    await expect(
      workflow(runtimeWith(missing.root, async () => (agentCalls += 1) as never).dsl, missing.reviewRelative),
    ).rejects.toThrow('has no "## Findings" section');
    await expect(
      workflow(runtimeWith(duplicate.root, async () => (agentCalls += 1) as never).dsl, duplicate.reviewRelative),
    ).rejects.toThrow("duplicate finding id");
    expect(agentCalls).toBe(0);
  });

  it("rejects absolute, escaping, ambiguous, and missing review paths", async () => {
    const fixture = createReviewFixture();
    let agentCalls = 0;
    const { dsl } = runtimeWith(fixture.root, async (request) => {
      agentCalls += 1;
      return completed(request, "unused");
    });
    const workflow = await loadWorkflow();

    await expect(workflow(dsl, fixture.reviewPath)).rejects.toThrow("must be project-relative");
    await expect(workflow(dsl, "../review.md")).rejects.toThrow("escapes project root");
    await expect(workflow(dsl, ".tasks/T-201-code-review/artifacts/fix-plan.md")).rejects.toThrow(
      "must name one review.md path",
    );
    await expect(workflow(dsl, `${fixture.reviewRelative} and other/artifacts/review.md`)).rejects.toThrow(
      "names more than one review.md path",
    );
    await expect(workflow(dsl, "")).rejects.toThrow("requires one explicit project-relative review.md path");
    expect(agentCalls).toBe(0);
  });
});
