import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import type {
  WorkflowWorkspaceEvidence,
  WorkflowWorkspaceManager,
} from "../../../extensions/_shared/workflow-worktree.js";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/review-fix/review-fix.workflow.mjs");

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function createReviewFixture(disposition: "accepted" | "pending" = "accepted") {
  const root = mkdtempSync(path.join(tmpdir(), "locus-review-fix-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(path.join(root, "tracked.txt"), "reviewed\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const taskId = "T-201";
  const taskDirectory = path.join(root, ".tasks", `${taskId}-code-review`);
  const artifactsDirectory = path.join(taskDirectory, "artifacts");
  mkdirSync(artifactsDirectory, { recursive: true });
  const reviewRelative = `.tasks/${taskId}-code-review/artifacts/review.md`;
  const planRelative = `.tasks/${taskId}-code-review/artifacts/fix-plan.md`;
  const snapshot = `base=${head} head=${head}`;
  const target = "current branch against dev";
  const reviewText = [
    "# Code Review",
    "",
    "## Confirmed Target",
    "",
    `- Target: ${target}`,
    `- Snapshot: ${snapshot}`,
    "",
    "## Verdict",
    "",
    "Needs changes.",
    "",
    "## New Findings",
    "",
    "### F1 — [P1] Advance the pagination offset",
    "",
    "- Scope: introduced",
    "- Category: correctness",
    "- Location: `src/page.ts:41`",
    "- Evidence: Offset remains zero.",
    "- Impact: Loop repeats.",
    "- Recommended fix: Advance the offset.",
    "",
    "## Previous Findings Reconciliation",
    "",
    "None.",
  ].join("\n");
  const reviewSha = sha256(reviewText);
  const pendingPlanText = [
    "# Review Fix Plan",
    "",
    "## Source Review",
    "",
    `- Task: ${taskId}`,
    `- Review: ${reviewRelative}`,
    `- Review SHA-256: ${reviewSha}`,
    `- Target: ${target}`,
    `- Snapshot: ${snapshot}`,
    "",
    "## Human Approval Gate",
    "",
    "Edit dispositions explicitly.",
    "",
    "## Findings",
    "",
    "### F1 — Advance the pagination offset",
    "",
    "- Disposition: pending",
    "- Severity: P1",
    "- Scope: introduced",
    "- Category: correctness",
    "- Location: `src/page.ts:41`",
  ].join("\n");
  const planText = pendingPlanText.replace("- Disposition: pending", `- Disposition: ${disposition}`);
  const taskText = [
    "---",
    `id: ${taskId}`,
    "status: review",
    "---",
    "",
    "# Code review",
    "",
    "## Review Evidence",
    "",
    `- Review: ${reviewRelative}`,
    `- Review SHA-256: ${reviewSha}`,
    `- Fix Plan: ${planRelative}`,
    `- Published Fix Plan SHA-256: ${sha256(pendingPlanText)}`,
    `- Target: ${target}`,
    `- Snapshot: ${snapshot}`,
    "- Finding IDs: F1",
  ].join("\n");
  const reviewPath = path.join(root, reviewRelative);
  const fixPlanPath = path.join(root, planRelative);
  writeFileSync(reviewPath, reviewText, "utf8");
  writeFileSync(fixPlanPath, planText, "utf8");
  writeFileSync(path.join(taskDirectory, "task.md"), taskText, "utf8");
  return { root, head, planRelative, fixPlanPath, reviewText, planText };
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

function workspaceManager(root: string, head: string) {
  const calls: Array<{ label: string; ref: string }> = [];
  const evidence: WorkflowWorkspaceEvidence = {
    handle: "workflow-workspace:1",
    id: "review-fix-worktree",
    path: root,
    head,
    sourceRef: head,
    originalRepoRoot: root,
    originalHead: head,
  };
  const manager: WorkflowWorkspaceManager = {
    allocate(label, ref) {
      calls.push({ label, ref });
      return evidence.handle;
    },
    resolve(handle) {
      if (handle !== evidence.handle) throw new Error(`Unknown handle: ${handle}`);
      return { ...evidence };
    },
    evidence() {
      return calls.length === 0 ? [] : [{ ...evidence }];
    },
  };
  return { manager, calls };
}

describe("curated review remediation workflow", () => {
  it("uses deterministic plan validation, local Markdown agents, and one workspace handle", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(source).toContain('from "./review-fix-plan.mjs"');
    expect(source).toContain('agentFile: "./resources/implementer.agent.md"');
    expect(source).toContain('agentFile: "./resources/verifier.agent.md"');
    expect(source).toContain("workspaceHandle");
    expect(source).toContain("const REVIEW_FIX_AGENT_DEFAULTS");
    expect(source.match(/maxToolCalls:/gu)).toHaveLength(1);
    expect(source).toContain('@param {import("../../../_shared/workflow-runtime.ts").WorkflowDsl} dsl');
    expect(source).not.toContain("agents.yaml");
    expect(source).not.toContain("schema:");
    expect(source).not.toContain("JSON.parse");
  });

  it("validates approval before writes, reuses one handle, and hands implementation text verbatim", async () => {
    const fixture = createReviewFixture("accepted");
    const workspaces = workspaceManager(fixture.root, fixture.head);
    const resources = createWorkflowResourceLoader({
      workflowSourcePath: workflowPath,
      runDir: mkdtempSync(path.join(tmpdir(), "locus-review-fix-run-")),
    });
    const calls: WorkflowAgentRequest[] = [];
    const implementationText = '  Changed src/page.ts.\n{"fixed":["F1"]}\n';
    const verificationText = "Published .tasks/T-201-code-review/artifacts/fix-report.md";
    const { dsl } = createWorkflowRuntime({
      runId: "review-fix-test",
      projectRoot: fixture.root,
      resourceLoader: resources,
      workspaceManager: workspaces.manager,
      agentRunner: async (request) => {
        calls.push(request);
        return completed(
          request,
          request.label === "apply accepted review fixes" ? implementationText : verificationText,
        );
      },
    });

    const result = await (await loadWorkflow())(dsl, fixture.planRelative);

    expect(result).toBe(verificationText);
    expect(workspaces.calls).toEqual([{ label: "review-fix-T-201", ref: fixture.head }]);
    expect(calls.map((call) => call.agent)).toEqual(["review-fix-01-implementer", "review-fix-02-verifier"]);
    expect(calls.map((call) => call.workspaceHandle)).toEqual(["workflow-workspace:1", "workflow-workspace:1"]);
    expect(calls.map((call) => call.workspaceMode)).toEqual(["worktree", "worktree"]);
    expect(calls.map((call) => call.maxToolCalls)).toEqual([1_000, 1_000]);
    expect(calls[1]?.prompt).toContain(implementationText);
    expect(calls[0]?.prompt).toContain("F1");
    expect(calls[0]?.prompt).not.toContain("pending");
  });

  it("refuses an all-pending plan before allocating a workspace or spawning a write agent", async () => {
    const fixture = createReviewFixture("pending");
    const workspaces = workspaceManager(fixture.root, fixture.head);
    let agentCalls = 0;
    const resources = createWorkflowResourceLoader({
      workflowSourcePath: workflowPath,
      runDir: mkdtempSync(path.join(tmpdir(), "locus-review-fix-pending-")),
    });
    const { dsl } = createWorkflowRuntime({
      runId: "review-fix-pending",
      projectRoot: fixture.root,
      resourceLoader: resources,
      workspaceManager: workspaces.manager,
      agentRunner: async (request) => {
        agentCalls += 1;
        return completed(request, "should not run");
      },
    });

    await expect((await loadWorkflow())(dsl, fixture.planRelative)).rejects.toThrow("at least one accepted finding");
    expect(workspaces.calls).toEqual([]);
    expect(agentCalls).toBe(0);
  });

  it("detects approval-artifact mutation before verifier execution", async () => {
    const fixture = createReviewFixture("accepted");
    const workspaces = workspaceManager(fixture.root, fixture.head);
    const resources = createWorkflowResourceLoader({
      workflowSourcePath: workflowPath,
      runDir: mkdtempSync(path.join(tmpdir(), "locus-review-fix-mutation-")),
    });
    let agentCalls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "review-fix-mutation",
      projectRoot: fixture.root,
      resourceLoader: resources,
      workspaceManager: workspaces.manager,
      agentRunner: async (request) => {
        agentCalls += 1;
        writeFileSync(fixture.fixPlanPath, `${fixture.planText}\nmutated\n`, "utf8");
        return completed(request, "implementation complete");
      },
    });

    await expect((await loadWorkflow())(dsl, fixture.planRelative)).rejects.toThrow(
      "fix-plan.md changed after approval validation",
    );
    expect(agentCalls).toBe(1);
  });

  it("rejects absolute and escaping fix-plan paths", async () => {
    const fixture = createReviewFixture("accepted");
    const workspaces = workspaceManager(fixture.root, fixture.head);
    const resources = createWorkflowResourceLoader({
      workflowSourcePath: workflowPath,
      runDir: mkdtempSync(path.join(tmpdir(), "locus-review-fix-path-")),
    });
    const { dsl } = createWorkflowRuntime({
      runId: "review-fix-path",
      projectRoot: fixture.root,
      resourceLoader: resources,
      workspaceManager: workspaces.manager,
      agentRunner: async (request) => completed(request, "unused"),
    });
    const workflow = await loadWorkflow();

    await expect(workflow(dsl, fixture.fixPlanPath)).rejects.toThrow("must be project-relative");
    await expect(workflow(dsl, "../fix-plan.md")).rejects.toThrow("escapes project root");
    expect(workspaces.calls).toEqual([]);
  });
});
