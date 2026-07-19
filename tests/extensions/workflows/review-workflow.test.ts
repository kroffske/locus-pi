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
  it("uses five neighboring prompts and no workflow-local agent or JSON/YAML protocol", () => {
    const source = readFileSync(workflowPath, "utf8");
    const resourceDirectory = path.join(path.dirname(workflowPath), "resources");

    expect(source).toContain('promptFile("./resources/');
    expect(source).toContain("const REVIEW_AGENT_DEFAULTS");
    expect(source.match(/maxToolCalls:/gu)).toHaveLength(1);
    expect(source.match(/workspaceMode:/gu)).toHaveLength(1);
    expect(source).toContain("readOnly: true");
    expect(source).toContain('tools: ["read", "git_read", "grep", "find"]');
    expect(source).toContain('@param {import("../../../_shared/workflow-runtime.ts").WorkflowDsl} dsl');
    expect(source).not.toContain("agentFile");
    expect(source).not.toContain(".agent.md");
    expect(source).not.toContain("agents.yaml");
    expect(source).not.toContain("review-config");
    expect(source).not.toContain("schema:");
    expect(source).not.toContain("JSON.parse");
    for (const name of [
      "target-resolver.prompt.md",
      "change-review.prompt.md",
      "context-review.prompt.md",
      "adjudicator.prompt.md",
    ]) {
      const promptSource = readFileSync(path.join(resourceDirectory, name), "utf8");
      expect(promptSource).toContain("This stage is host-enforced read-only.");
      expect(promptSource).toMatch(/publisher is the only review\s+stage allowed to write/iu);
      expect(promptSource).toContain("You have no shell");
      expect(promptSource).toContain("git_read");
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
    expect(calls.map((call) => call.agent)).toEqual(["default", "default", "default", "default", "default"]);
    expect(calls.map((call) => call.readOnly)).toEqual([true, true, true, true, undefined]);
    expect(calls.slice(0, 4).every((call) => call.tools?.join(",") === "read,git_read,grep,find")).toBe(true);
    expect(calls[4]?.tools).toEqual(["read", "write", "bash", "grep", "find"]);
    expect(calls.map((call) => call.maxToolCalls)).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
    expect(calls.map((call) => call.workspaceMode)).toEqual(["project", "project", "project", "project", "project"]);
    expect(calls.map((call) => call.phase)).toEqual([
      "resolve-target",
      "independent-review",
      "independent-review",
      "adjudicate",
      "publish-report",
    ]);
    expect(calls[1]?.prompt).toContain(outputs["resolve review target"]);
    expect(calls[2]?.prompt).toContain(outputs["resolve review target"]);
    expect(calls[3]?.prompt).toContain(outputs["review introduced changes"]);
    expect(calls[3]?.prompt).toContain(outputs["review whole-file context"]);
    expect(calls[4]?.prompt).toContain(outputs["adjudicate review findings"]);
    expect(resourceLoader.evidence()).toHaveLength(5);
    expect(resourceLoader.evidence().every((item) => item.kind === "prompt")).toBe(true);
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
