import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

const examples = path.join(process.cwd(), "extensions/workflows/examples/review-fix");
const reviewFixPath = path.join(examples, "review-fix.workflow.mjs");

async function loadWorkflow(workflowPath: string): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function completedAgent<T>(request: WorkflowAgentRequest, output: T, childSessionId: string): WorkflowAgentResult {
  return {
    ok: true,
    status: "completed",
    summary:
      typeof output === "object" && output !== null && "summary" in output && typeof output.summary === "string"
        ? output.summary
        : "completed",
    output,
    diagnostics: [],
    agent: request.agent,
    ...(request.label !== undefined ? { label: request.label } : {}),
    childSessionId,
  };
}

const reviewTask = {
  status: "ready",
  summary: "Resolved one immutable review task.",
  question: "",
  taskId: "T-201",
  taskPath: ".tasks/T-201-code-review/task.md",
  reviewPath: ".tasks/T-201-code-review/artifacts/review.md",
  reviewSha256: "a".repeat(64),
  target: "dev...feature",
  snapshot: "base=abc123 head=def456",
  findingIds: ["F1", "F2"],
  constraints: ["Keep source read-only while planning."],
};

const approvedPlan = {
  status: "ready",
  summary: "One finding was explicitly accepted.",
  question: "",
  taskId: "T-201",
  taskPath: reviewTask.taskPath,
  reviewPath: reviewTask.reviewPath,
  reviewSha256: reviewTask.reviewSha256,
  fixPlanPath: ".tasks/T-201-code-review/artifacts/fix-plan.md",
  approvedPlanSha256: "c".repeat(64),
  target: reviewTask.target,
  snapshot: reviewTask.snapshot,
  acceptedFindings: [
    {
      id: "F1",
      title: "Advance the pagination offset",
      scope: "introduced",
      file: "dags/customer_snapshot_dag.py",
    },
  ],
  ignoredFindingIds: ["F2"],
  constraints: ["Do not modify the original checkout."],
};

const implementation = {
  status: "completed",
  summary: "Applied F1 in a retained linked worktree.",
  question: "",
  taskId: "T-201",
  worktreePath: "/tmp/locus-review-fix-T-201",
  targetHeadBefore: "def456",
  targetHeadAfter: "def456",
  changedFiles: ["dags/customer_snapshot_dag.py"],
  fixedIds: ["F1"],
  unresolvedIds: [],
  checks: ["pytest dags/tests/test_customer_snapshot.py passed"],
};

const fixReport = {
  status: "completed",
  summary: "F1 is fixed and independently verified.",
  question: "",
  taskId: "T-201",
  worktreePath: implementation.worktreePath,
  fixReportPath: ".tasks/T-201-code-review/artifacts/fix-report.md",
  fixReportSha256: "d".repeat(64),
  fixedIds: ["F1"],
  unresolvedIds: [],
  checks: ["pytest dags/tests/test_customer_snapshot.py passed"],
};

describe("curated review remediation workflow", () => {
  it("keeps remediation agent-owned while loading prompts from the review manifest", () => {
    const source = readFileSync(reviewFixPath, "utf8");
    expect(source).toContain('from "../review-family/review-config.mjs"');
    expect(source).toContain('identityCoverage: "entry-only"');
    expect(source).not.toContain("You resolve one human-approved review fix plan");
    expect(source).not.toContain("execFile");
    expect(source).not.toContain("fetch(");
    expect(source).not.toMatch(/\bllm\s*\(/u);
    expect(source).toContain('renderAgentPrompt("reviewFix"');
  });

  it("applies only accepted findings in a linked worktree and publishes verification", async () => {
    const runWorkflow = await loadWorkflow(reviewFixPath);
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "review-fix-pipeline",
      agentRunner: async (request) => {
        calls.push(request);
        if (request.label === "resolve approved review plan") {
          return completedAgent(request, approvedPlan, "resolve-child");
        }
        if (request.label === "apply accepted review fixes") {
          return completedAgent(request, implementation, "implementation-child");
        }
        return completedAgent(request, fixReport, "verification-child");
      },
    });

    const result = (await runWorkflow(dsl, "Fix accepted findings from T-201")) as Record<string, unknown>;

    expect(calls.map(({ label }) => label)).toEqual([
      "resolve approved review plan",
      "apply accepted review fixes",
      "verify review fixes and publish report",
    ]);
    expect(calls[0]?.prompt).toMatch(/Only explicit accepted values authorize source\s+changes/u);
    expect(calls[1]?.prompt).toContain("Never edit the original checkout");
    expect(calls[1]?.prompt).toContain("new linked Git worktree");
    expect(calls[1]?.prompt).toMatch(/Do not commit, push,\s+create a pull request/u);
    expect(calls[2]?.prompt).toContain("artifacts/fix-report.md");
    expect(calls[2]?.prompt).toContain("Original checkout was not modified");
    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      implementation,
      verification: fixReport,
      stages: {
        resolve: { childSessionId: "resolve-child" },
        implementation: { childSessionId: "implementation-child" },
        verification: { childSessionId: "verification-child" },
      },
    });
  });

  it("refuses review-fix when no finding is explicitly accepted", async () => {
    const runWorkflow = await loadWorkflow(reviewFixPath);
    const noApproval = {
      ...approvedPlan,
      status: "blocked",
      summary: "No finding is accepted.",
      question: "Mark at least one finding accepted in fix-plan.md.",
      acceptedFindings: [],
      ignoredFindingIds: ["F1", "F2"],
    };
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "review-fix-no-approval",
      agentRunner: async (request) => {
        calls += 1;
        return completedAgent(request, noApproval, "resolve-child");
      },
    });

    const result = (await runWorkflow(dsl, "Fix T-201")) as Record<string, unknown>;

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      stoppedStage: "resolve-approved-plan",
      question: "Mark at least one finding accepted in fix-plan.md.",
    });
  });

  it("projects independently verified partial remediation as semantic non-success", async () => {
    const runWorkflow = await loadWorkflow(reviewFixPath);
    const partialImplementation = {
      ...implementation,
      status: "partial",
      summary: "F1 changed but its integration test is unavailable.",
      fixedIds: [],
      unresolvedIds: ["F1"],
    };
    const partialReport = {
      ...fixReport,
      status: "partial",
      summary: "F1 remains unverified.",
      fixedIds: [],
      unresolvedIds: ["F1"],
    };
    const { dsl } = createWorkflowRuntime({
      runId: "review-fix-partial",
      agentRunner: async (request) => {
        if (request.label === "resolve approved review plan") {
          return completedAgent(request, approvedPlan, "resolve-child");
        }
        if (request.label === "apply accepted review fixes") {
          return completedAgent(request, partialImplementation, "implementation-child");
        }
        return completedAgent(request, partialReport, "verification-child");
      },
    });

    const result = (await runWorkflow(dsl, "Fix T-201")) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: false,
      partial: true,
      status: "partial",
      verification: partialReport,
    });
  });
});
