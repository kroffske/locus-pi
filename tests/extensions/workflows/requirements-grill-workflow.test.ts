import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowAgentRunner,
} from "../../../extensions/_shared/workflow-runtime.js";

interface RequirementsGrillResult {
  ok: boolean;
  originalRequest: string;
  stoppedStage?: string;
  summary: string;
  handoff: Record<string, unknown> | null;
  repositoryContext?: { ok: boolean; lineCount: number; lines: string[] };
  stages: Record<string, { ok: boolean; childSessionId: string | null }>;
}

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const workflowPath = path.join(
    process.cwd(),
    "extensions/workflows/examples/requirements-grill.workflow.mjs",
  );
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function completed(
  request: WorkflowAgentRequest,
  output: Record<string, unknown>,
  index: number,
): WorkflowAgentResult {
  return {
    ok: true,
    status: "completed",
    summary: `${request.agent} completed`,
    output,
    diagnostics: [],
    agent: request.agent,
    childSessionId: `child-${index}`,
    model: "omlx/mlx-community--Qwen3.6-27B-4bit",
  };
}

describe("workflow example: requirements-grill.workflow.mjs", () => {
  it("fails at validation without spawning a child when input is empty", async () => {
    const runWorkflow = await loadWorkflow();
    let calls = 0;
    const agentRunner: WorkflowAgentRunner = async () => {
      calls += 1;
      throw new Error("agent should not run");
    };
    const { dsl } = createWorkflowRuntime({ runId: "requirements-empty", agentRunner });

    const result = (await runWorkflow(dsl, "   ")) as RequirementsGrillResult;

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      originalRequest: "",
      stoppedStage: "validate-input",
      handoff: null,
    });
  });

  it("hands original input and prior structured artifacts through all three stages", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs = [
      {
        summary: "recon-sentinel",
        relevantFiles: ["extensions/workflows/index.ts"],
        facts: ["fact-sentinel"],
        uncertainties: ["none"],
      },
      {
        revisedGoal: "challenge-sentinel",
        risks: ["risk"],
        ambiguities: ["ambiguity"],
        assumptions: ["assumption"],
        questions: ["none"],
      },
      {
        refinedRequirements: ["requirement"],
        acceptanceCriteria: ["criterion"],
        nonGoals: ["none"],
        implementationPlan: ["step"],
        unresolvedQuestions: ["none"],
        contextDigest: "digest-sentinel",
      },
    ];
    const agentRunner: WorkflowAgentRunner = async (request) => {
      const index = calls.length;
      calls.push(request);
      return completed(request, outputs[index]!, index);
    };
    const { dsl } = createWorkflowRuntime({ runId: "requirements-happy", agentRunner });

    const result = (await runWorkflow(dsl, "  Add workflow source visibility  ")) as RequirementsGrillResult;

    expect(calls.map((call) => call.agent)).toEqual(["default", "default", "default"]);
    expect(calls.map((call) => call.tools)).toEqual([[], [], []]);
    expect(calls.map((call) => call.maxToolCalls)).toEqual([0, 0, 0]);
    expect(calls[0]?.prompt).toContain("explicit artifact");
    expect(calls[0]?.prompt).toContain('"pattern": "workflows?|visibility"');
    expect(calls[0]?.prompt).toContain("extensions/workflows");
    expect(calls.map((call) => call.phase)).toEqual(["recon", "challenge", "synthesis"]);
    expect(calls[1]?.prompt).toContain("Add workflow source visibility");
    expect(calls[1]?.prompt).toContain("recon-sentinel");
    expect(calls[1]?.prompt).toContain("fact-sentinel");
    expect(calls[2]?.prompt).toContain("recon-sentinel");
    expect(calls[2]?.prompt).toContain("challenge-sentinel");
    expect(result).toMatchObject({
      ok: true,
      originalRequest: "Add workflow source visibility",
      handoff: { contextDigest: "digest-sentinel" },
      stages: {
        collectContext: { ok: true, childSessionId: null },
        recon: { ok: true, childSessionId: "child-0" },
        challenge: { ok: true, childSessionId: "child-1" },
        synthesis: { ok: true, childSessionId: "child-2" },
      },
    });
    expect(result.repositoryContext?.lineCount).toBeGreaterThan(0);
    expect(result.repositoryContext?.lines.length).toBe(result.repositoryContext?.lineCount);
  });

  it("fails closed at recon and does not call downstream stages", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const agentRunner: WorkflowAgentRunner = async (request) => {
      calls.push(request);
      return {
        ok: false,
        status: "failed",
        summary: "recon unavailable",
        diagnostics: ["test failure"],
        agent: request.agent,
      };
    };
    const { dsl } = createWorkflowRuntime({ runId: "requirements-recon-fail", agentRunner });

    const result = (await runWorkflow(dsl, "Inspect current behavior")) as RequirementsGrillResult;

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({
      ok: false,
      originalRequest: "Inspect current behavior",
      stoppedStage: "recon",
      handoff: null,
      stages: { collectContext: { ok: true }, recon: { ok: false } },
    });
  });
});
