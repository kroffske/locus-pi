import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowResourceLoader } from "../../../extensions/_shared/workflow-resources.js";
import {
  createWorkflowRuntime,
  WorkflowGroupFailureError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/review/review.workflow.mjs");

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

function runtimeWith(runner: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult>) {
  const runDir = mkdtempSync(path.join(tmpdir(), "locus-review-workflow-"));
  const resourceLoader = createWorkflowResourceLoader({
    workflowSourcePath: workflowPath,
    runDir,
  });
  return {
    ...createWorkflowRuntime({
      runId: "review-test",
      agentRunner: runner,
      resourceLoader,
      projectRoot: process.cwd(),
    }),
    resourceLoader,
  };
}

describe("workflow example: review.workflow.mjs", () => {
  it("declares five neighboring Markdown agents and no agent JSON/YAML protocol", () => {
    const source = readFileSync(workflowPath, "utf8");
    const resourceDirectory = path.join(path.dirname(workflowPath), "resources");

    expect(source).toContain('agentFile: "./resources/target-resolver.agent.md"');
    expect(source).toContain('agentFile: "./resources/change-review.agent.md"');
    expect(source).toContain('agentFile: "./resources/context-review.agent.md"');
    expect(source).toContain('agentFile: "./resources/adjudicator.agent.md"');
    expect(source).toContain('agentFile: "./resources/publisher.agent.md"');
    expect(source).toContain('promptFile("./resources/');
    expect(source).not.toContain("agents.yaml");
    expect(source).not.toContain("review-config");
    expect(source).not.toContain("schema:");
    expect(source).not.toContain("JSON.parse");
    for (const name of [
      "target-resolver.agent.md",
      "change-review.agent.md",
      "context-review.agent.md",
      "adjudicator.agent.md",
    ]) {
      const agentSource = readFileSync(path.join(resourceDirectory, name), "utf8");
      expect(agentSource).toContain("This stage is host-enforced read-only.");
      expect(agentSource).toMatch(/publisher is the only review agent allowed\s+to write/iu);
      expect(agentSource).toContain("You have no shell");
      expect(agentSource).toMatch(/allowedTools:.*\bgit_read\b/u);
      expect(agentSource).not.toMatch(/allowedTools:.*\b(bash|write|edit|workflow)\b/u);
      expect(agentSource).toContain("requireAnyOf: [git_read]");
    }
  });

  it("passes every agent result verbatim and returns publisher text exactly", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      "resolve review target": "  TARGET\nbase=abc head=def\n",
      "review introduced changes": '{"lane":"changes","status":"failed-looking"}',
      "review whole-file context": "# Context lane\nNo envelope.",
      "adjudicate review findings": "# Code Review\n\n## Verdict\nNeeds changes.",
      "publish review report": "  Published: .tasks/T-201/artifacts/review.md\n",
    };
    const { dsl, resourceLoader } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    const result = await runWorkflow(dsl, "review current branch");

    expect(result).toBe(outputs["publish review report"]);
    expect(calls.map((call) => call.label)).toEqual([
      "resolve review target",
      "review introduced changes",
      "review whole-file context",
      "adjudicate review findings",
      "publish review report",
    ]);
    expect(calls.map((call) => call.agent)).toEqual([
      "review-01-target-resolver",
      "review-02-change-review",
      "review-03-context-review",
      "review-04-adjudicator",
      "review-05-publisher",
    ]);
    expect(calls[1]?.prompt).toContain(outputs["resolve review target"]);
    expect(calls[2]?.prompt).toContain(outputs["resolve review target"]);
    expect(calls[3]?.prompt).toContain(outputs["review introduced changes"]);
    expect(calls[3]?.prompt).toContain(outputs["review whole-file context"]);
    expect(calls[4]?.prompt).toContain(outputs["adjudicate review findings"]);
    expect(resourceLoader.evidence()).toHaveLength(10);
    expect(resourceLoader.evidence().every((item) => /^[0-9a-f]{64}$/.test(item.sha256))).toBe(true);
  });

  it("fails the parallel barrier when either independent reviewer fails", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      if (request.label === "review introduced changes") {
        return {
          ok: false,
          status: "failed",
          summary: "changes reviewer failed",
          diagnostics: ["provider unavailable"],
          agent: request.agent,
          label: request.label,
        };
      }
      return completed(request, `${request.label} text`);
    });

    await expect(runWorkflow(dsl, "review current branch")).rejects.toBeInstanceOf(WorkflowGroupFailureError);
    expect(calls.map((call) => call.label)).toEqual([
      "resolve review target",
      "review introduced changes",
      "review whole-file context",
    ]);
  });
});
