import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowAgentRunner,
} from "../../../extensions/_shared/workflow-runtime.js";

interface TargetResolution {
  status: "ready" | "blocked";
  target: string;
  summary: string;
  question: string;
  constraints: string[];
}

interface ReviewFinding {
  id: string;
  title: string;
  category: string;
  scope: string;
  severity: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  evidence: string;
  impact: string;
  fix: string;
}

interface ReviewReport {
  verdict: "pass" | "needs_changes" | "blocked";
  summary: string;
  findings: ReviewFinding[];
  reviewedFiles: string[];
  limitations: string[];
  reportMarkdown?: string;
}

interface ReviewWorkflowResult {
  ok: boolean;
  status: string;
  summary: string;
  question?: string;
  stoppedStage?: string;
  target?: TargetResolution;
  verdict?: string;
  review: ReviewReport | null;
  stages?: Record<string, { childSessionId: string | null }>;
}

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/review.workflow.mjs");

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function finding(scope: "introduced" | "pre-existing", id: string): ReviewFinding {
  return {
    id,
    title: "Advance the pagination offset",
    category: "correctness",
    scope,
    severity: "P1",
    file: "dags/customer_snapshot_dag.py",
    lineStart: 41,
    lineEnd: 59,
    evidence: "The loop reuses offset=0 for every query.",
    impact: "A full page causes an infinite loop over the first batch.",
    fix: "Increment the offset after each successful page.",
  };
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

function failedAgent(request: WorkflowAgentRequest, status: "failed" | "blocked") {
  return {
    ok: false,
    status,
    summary: `${request.label} ${status}`,
    output: null,
    diagnostics: [`${request.label} ${status}`],
    agent: request.agent,
    ...(request.label !== undefined ? { label: request.label } : {}),
  } satisfies WorkflowAgentResult;
}

const readyTarget: TargetResolution = {
  status: "ready",
  target: "current branch against dev",
  summary: "Resolved the local branch comparison and verified both refs.",
  question: "",
  constraints: ["Review is read-only."],
};

const changesLane: ReviewReport = {
  verdict: "needs_changes",
  summary: "One introduced defect.",
  findings: [finding("introduced", "C1")],
  reviewedFiles: ["dags/customer_snapshot_dag.py"],
  limitations: [],
};

const contextLane: ReviewReport = {
  verdict: "needs_changes",
  summary: "One related pre-existing defect.",
  findings: [finding("pre-existing", "X1")],
  reviewedFiles: ["dags/customer_snapshot_dag.py", "DAG_STANDARDS.md"],
  limitations: [],
};

const finalReport: ReviewReport = {
  verdict: "needs_changes",
  summary: "The pagination defect must be fixed before merge.",
  findings: [finding("introduced", "F1")],
  reviewedFiles: ["dags/customer_snapshot_dag.py", "DAG_STANDARDS.md"],
  limitations: [],
  reportMarkdown: "# Review Report\n\n## Verdict\nneeds_changes",
};

describe("workflow example: review.workflow.mjs", () => {
  it("contains only workflow orchestration and no host-owned evidence adapter", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(source).not.toContain('from "node:');
    expect(source).not.toContain("execFile");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("api.bitbucket.org");
    expect(source).not.toMatch(/\bllm\s*\(/u);
    expect(source).toContain("const { agent, parallel, phase, log } = dsl");
  });

  it("delegates free-form target resolution to a full tool-using agent", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const blockedTarget: TargetResolution = {
      status: "blocked",
      target: "",
      summary: "No unambiguous comparison target was available.",
      question: "Which branch or pull request should be reviewed?",
      constraints: [],
    };
    const { dsl } = createWorkflowRuntime({
      runId: "review-agent-owned-target",
      agentRunner: async (request) => {
        calls.push(request);
        return completedAgent(request, blockedTarget, "target-child");
      },
    });

    const result = (await runWorkflow(dsl, "")) as ReviewWorkflowResult;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agent: "oracle",
      label: "resolve review target",
      permissionMode: "agent-defined",
      workspaceMode: "project",
      maxToolCalls: 40,
    });
    expect(calls[0]?.tools).toBeUndefined();
    expect(calls[0]?.prompt).toContain("Use your tools now");
    expect(calls[0]?.prompt).toContain("private forge");
    expect(calls[0]?.prompt).toContain("No diff or file contents will be supplied");
    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      stoppedStage: "resolve-target",
      question: "Which branch or pull request should be reviewed?",
      review: null,
    });
  });

  it("runs target, independent review, and adjudication as four agent sessions", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const agentRunner: WorkflowAgentRunner = async (request) => {
      calls.push(request);
      switch (request.label) {
        case "resolve review target":
          return completedAgent(request, readyTarget, "target-child");
        case "review introduced changes":
          return completedAgent(request, changesLane, "changes-child");
        case "review whole-file context":
          return completedAgent(request, contextLane, "context-child");
        case "adjudicate review findings":
          return completedAgent(request, finalReport, "adjudicator-child");
        default:
          throw new Error(`Unexpected agent label: ${request.label}`);
      }
    };
    let llmCalls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "review-agent-pipeline",
      agentRunner,
      llmRunner: async () => {
        llmCalls += 1;
        throw new Error("review workflow must not call the direct model path");
      },
    });

    const request = "Review https://private.example/pull-requests/17 against repository standards";
    const result = (await runWorkflow(dsl, request)) as ReviewWorkflowResult;

    expect(calls.map(({ label }) => label)).toEqual([
      "resolve review target",
      "review introduced changes",
      "review whole-file context",
      "adjudicate review findings",
    ]);
    expect(llmCalls).toBe(0);
    for (const call of calls) {
      expect(call).toMatchObject({
        agent: "oracle",
        permissionMode: "agent-defined",
        workspaceMode: "project",
        maxToolCalls: 40,
      });
      expect(call.tools).toBeUndefined();
      expect(call.prompt).toContain("LOCUS_AGENT_RESULT_V1");
      expect(call.prompt).toContain(request);
    }
    for (const call of calls.slice(1)) {
      expect(call.prompt).toMatch(/The workflow\s+will not/u);
    }
    expect(calls[1]?.prompt).toContain("Obtain the diff yourself");
    expect(calls[2]?.prompt).toContain("Explicit\nrepository standards are review contracts");
    expect(calls[3]?.prompt).toContain("Use your own tools to reopen the target");
    expect(calls[3]?.prompt).toContain("# Review Report");
    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      verdict: "needs_changes",
      target: readyTarget,
      review: {
        reportMarkdown: expect.stringContaining("# Review Report"),
      },
      stages: {
        target: { childSessionId: "target-child" },
        changes: { childSessionId: "changes-child" },
        context: { childSessionId: "context-child" },
        adjudication: { childSessionId: "adjudicator-child" },
      },
    });
  });

  it("passes an opaque private-PR request without parsing forge-specific fields", async () => {
    const runWorkflow = await loadWorkflow();
    const prompts: string[] = [];
    const privateTarget: TargetResolution = {
      ...readyTarget,
      target: "private pull request resolved by authenticated local tooling",
    };
    const { dsl } = createWorkflowRuntime({
      runId: "review-private-pr",
      agentRunner: async (request) => {
        prompts.push(request.prompt);
        if (request.label === "resolve review target") {
          return completedAgent(request, privateTarget, "target");
        }
        if (request.label === "review introduced changes") {
          return completedAgent(request, changesLane, "changes");
        }
        if (request.label === "review whole-file context") {
          return completedAgent(request, contextLane, "context");
        }
        return completedAgent(request, finalReport, "final");
      },
    });
    const opaqueRequest = "Review PR ACME/private-repo#918 using my existing login";

    const result = (await runWorkflow(dsl, opaqueRequest)) as ReviewWorkflowResult;

    expect(prompts).toHaveLength(4);
    expect(prompts.every((prompt) => prompt.includes(opaqueRequest))).toBe(true);
    expect(result.target).toEqual(privateTarget);
  });

  it("leaves a failed parallel review lane as a typed fail-closed group error", async () => {
    const runWorkflow = await loadWorkflow();
    let adjudicationCalls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "review-lane-failure",
      agentRunner: async (request) => {
        if (request.label === "resolve review target") {
          return completedAgent(request, readyTarget, "target");
        }
        if (request.label === "review introduced changes") {
          return failedAgent(request, "failed");
        }
        if (request.label === "review whole-file context") {
          return completedAgent(request, contextLane, "context");
        }
        adjudicationCalls += 1;
        return completedAgent(request, finalReport, "final");
      },
    });

    await expect(runWorkflow(dsl, "Review current branch against dev")).rejects.toMatchObject({
      code: "WORKFLOW_GROUP_FAILURE",
      failed: 1,
      completed: 1,
    });
    expect(adjudicationCalls).toBe(0);
  });

  it("fails honestly when the adjudication agent cannot produce a report", async () => {
    const runWorkflow = await loadWorkflow();
    const { dsl } = createWorkflowRuntime({
      runId: "review-adjudication-failure",
      agentRunner: async (request) => {
        if (request.label === "resolve review target") {
          return completedAgent(request, readyTarget, "target");
        }
        if (request.label === "review introduced changes") {
          return completedAgent(request, changesLane, "changes");
        }
        if (request.label === "review whole-file context") {
          return completedAgent(request, contextLane, "context");
        }
        return failedAgent(request, "failed");
      },
    });

    const result = (await runWorkflow(dsl, "Review current branch against dev")) as ReviewWorkflowResult;

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      stoppedStage: "adjudicate",
      review: null,
    });
  });

  it("projects an adjudicator-blocked verdict as a blocked workflow result", async () => {
    const runWorkflow = await loadWorkflow();
    const blockedReport: ReviewReport = {
      verdict: "blocked",
      summary: "The private PR could not be opened with available authentication.",
      findings: [],
      reviewedFiles: [],
      limitations: ["PR contents unavailable."],
      reportMarkdown: "# Review Report\n\n## Verdict\nblocked",
    };
    const { dsl } = createWorkflowRuntime({
      runId: "review-final-blocked",
      agentRunner: async (request) => {
        if (request.label === "resolve review target") {
          return completedAgent(request, readyTarget, "target");
        }
        if (request.label === "review introduced changes") {
          return completedAgent(request, changesLane, "changes");
        }
        if (request.label === "review whole-file context") {
          return completedAgent(request, contextLane, "context");
        }
        return completedAgent(request, blockedReport, "final");
      },
    });

    const result = (await runWorkflow(dsl, "Review private PR")) as ReviewWorkflowResult;

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      verdict: "blocked",
      review: blockedReport,
    });
  });
});
