import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkflowRuntime,
  WorkflowAgentExecutionError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/requirements-grill.workflow.mjs");
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
    childSessionId: `child-${request.phase}`,
  };
}

describe("workflow example: requirements-grill.workflow.mjs", () => {
  it("fails validation without spawning a child when input is empty", async () => {
    let calls = 0;
    const { dsl } = createWorkflowRuntime({
      runId: "requirements-empty",
      agentRunner: async () => {
        calls += 1;
        throw new Error("agent should not run");
      },
    });

    const result = await (await loadWorkflow())(dsl, "   ");

    expect(calls).toBe(0);
    expect(result).toEqual({ ok: false, summary: "A non-empty request is required." });
  });

  it("hands original input and prior agent text verbatim through all stages", async () => {
    const calls: WorkflowAgentRequest[] = [];
    const texts = ["  # Recon\nfact-sentinel\n", '{"challenge":"risk-sentinel"}', "# Handoff\ncriterion-sentinel"];
    const { dsl } = createWorkflowRuntime({
      runId: "requirements-happy",
      agentRunner: async (request) => {
        const text = texts[calls.length]!;
        calls.push(request);
        return completed(request, text);
      },
    });

    const result = await (await loadWorkflow())(dsl, "  Add workflow source visibility  ");

    expect(result).toBe(texts[2]);
    expect(calls.map((call) => call.agent)).toEqual(["default", "default", "default"]);
    expect(calls.map((call) => call.tools)).toEqual([[], [], []]);
    expect(calls.map((call) => call.maxToolCalls)).toEqual([0, 0, 0]);
    expect(calls.map((call) => call.phase)).toEqual(["recon", "challenge", "synthesis"]);
    expect(calls[0]?.prompt).toContain("explicit artifact");
    expect(calls[0]?.prompt).toContain('"pattern": "workflows?|visibility"');
    expect(calls[1]?.prompt).toContain("Add workflow source visibility");
    expect(calls[1]?.prompt).toContain(texts[0]);
    expect(calls[2]?.prompt).toContain(texts[0]);
    expect(calls[2]?.prompt).toContain(texts[1]);
  });

  it("throws a typed child failure and does not call downstream stages", async () => {
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = createWorkflowRuntime({
      runId: "requirements-recon-fail",
      agentRunner: async (request) => {
        calls.push(request);
        return {
          ok: false,
          status: "failed",
          summary: "recon unavailable",
          diagnostics: ["test failure"],
          agent: request.agent,
        };
      },
    });

    await expect((await loadWorkflow())(dsl, "Inspect current behavior")).rejects.toBeInstanceOf(
      WorkflowAgentExecutionError,
    );
    expect(calls).toHaveLength(1);
  });
});
