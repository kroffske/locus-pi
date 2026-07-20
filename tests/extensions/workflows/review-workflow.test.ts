import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkflowResourceLoader } from "../../../extensions/_shared/workflow-resources.js";
import {
  createWorkflowRuntime,
  WorkflowAgentExecutionError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/_shared/workflow-runtime.js";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/review/review.workflow.mjs");

const READ_ONLY_PROMPTS = [
  "scope-resolver.prompt.md",
  "change-inventory.prompt.md",
  "unit-planner.prompt.md",
  "interrogator.prompt.md",
  "verifier.prompt.md",
];
const NAVIGATING_PROMPTS = ["unit-planner.prompt.md", "interrogator.prompt.md", "verifier.prompt.md"];

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

function promptSource(name: string): string {
  return readFileSync(path.join(path.dirname(workflowPath), "resources", name), "utf8");
}

describe("workflow example: review.workflow.mjs", () => {
  it("uses six neighboring prompts and no workflow-local agent or JSON/YAML protocol", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(source).toContain('promptFile("./resources/');
    expect(source).toContain("const REVIEW_AGENT_DEFAULTS");
    expect(source.match(/maxToolCalls:/gu)).toHaveLength(1);
    expect(source.match(/workspaceMode:/gu)).toHaveLength(1);
    expect(source.match(/readOnly: true/gu)).toHaveLength(2);
    expect(source).toContain('tools: ["read", "git_read", "grep", "find"]');
    expect(source).toContain('tools: ["read", "git_read", "ast_index", "grep", "find"]');
    expect(source).toContain('@param {import("../../../_shared/workflow-runtime.ts").WorkflowDsl} dsl');
    expect(source).not.toContain("agentFile");
    expect(source).not.toContain(".agent.md");
    expect(source).not.toContain("agents.yaml");
    expect(source).not.toContain("review-config");
    expect(source).not.toContain("schema:");
    expect(source).not.toContain("JSON.parse");
    expect(source).not.toContain("parallel");
    for (const name of READ_ONLY_PROMPTS) {
      const prompt = promptSource(name);
      expect(prompt, name).toContain("This stage is host-enforced read-only.");
      expect(prompt, name).toMatch(/publisher is the only review\s+stage allowed to write/iu);
      expect(prompt, name).toContain("You have no shell");
      expect(prompt, name).toContain("git_read");
    }
  });

  it("keeps the AST Index preference bounded by a grep fallback and only where symbols matter", () => {
    for (const name of NAVIGATING_PROMPTS) {
      const prompt = promptSource(name);
      expect(prompt, name).toContain("ast_index");
      expect(prompt, name).toMatch(/A missing AST Index never blocks a\s+review\./u);
      expect(prompt, name).toMatch(/continue with\s+`grep`, `find`, and direct reads/u);
    }
    for (const name of ["scope-resolver.prompt.md", "change-inventory.prompt.md"]) {
      expect(promptSource(name), name).not.toContain("ast_index");
    }
  });

  it("requires a reachable path, root-cause dedup, and concern-relative answers from the verifier", () => {
    const verifier = promptSource("verifier.prompt.md");

    expect(verifier).toMatch(/confirmed only\s+when you can name a reachable input/u);
    expect(verifier).toMatch(/"There is no\s+validation here" is not a finding/u);
    expect(verifier).toMatch(/Missing defence in depth is not a defect/u);
    expect(verifier).toMatch(/Deduplicate by root cause before writing findings/u);
    expect(verifier).toMatch(/never `Rejected` for a question whose answer produced a finding/u);
  });

  it("keeps hashes, snapshots, fix plans, and dispositions out of the review contract", () => {
    for (const name of READ_ONLY_PROMPTS) {
      const prompt = promptSource(name);
      expect(prompt, name).not.toContain("SHA-256");
      expect(prompt, name).not.toContain("Snapshot:");
      expect(prompt, name).not.toMatch(/base=<commit>/u);
      expect(prompt, name).not.toContain("fix-plan.md");
    }
    const publisher = promptSource("publisher.prompt.md");
    expect(publisher).toContain("artifacts/review.md");
    expect(publisher).toContain("executive summary");
    expect(publisher).toMatch(/Do not write a fix plan, dispositions, commit hashes, snapshots, or SHA-256\s+values/u);
    expect(publisher).toMatch(/Only `review\.md` is mandatory/u);
  });

  it("passes every agent result verbatim and returns the publisher summary exactly", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const outputs: Record<string, string> = {
      "resolve review scope": "  # Review Scope\nTarget: `origin/main...HEAD`\n",
      "inventory changes": '{"lane":"inventory","status":"failed-looking"}',
      "plan review units": "# Review Units\n## U1\nPath: `src/a.ts`",
      "ask review questions": "# Review Questions\n## U1-Q1\nQuestion: Does it hold?",
      "verify and write review": "# Code Review\n\n## Verdict\nNeeds changes.",
      "publish review package": "  Review published.\nPrimary report: .tasks/T-201/artifacts/review.md\n",
    };
    const { dsl, resourceLoader } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, outputs[request.label!]!);
    });

    const result = await runWorkflow(dsl, "review current branch");

    expect(result).toBe(outputs["publish review package"]);
    expect(calls.map((call) => call.label)).toEqual([
      "resolve review scope",
      "inventory changes",
      "plan review units",
      "ask review questions",
      "verify and write review",
      "publish review package",
    ]);
    expect(calls.map((call) => call.agent)).toEqual(["default", "default", "default", "default", "default", "default"]);
    expect(calls.map((call) => call.readOnly)).toEqual([true, true, true, true, true, undefined]);
    expect(calls.slice(0, 2).map((call) => call.tools?.join(","))).toEqual([
      "read,git_read,grep,find",
      "read,git_read,grep,find",
    ]);
    expect(calls.slice(2, 5).every((call) => call.tools?.join(",") === "read,git_read,ast_index,grep,find")).toBe(true);
    expect(calls[5]?.tools).toEqual(["read", "write", "bash", "grep", "find"]);
    expect(calls.every((call) => call.maxToolCalls === 1_000)).toBe(true);
    expect(calls.every((call) => call.workspaceMode === "project")).toBe(true);
    expect(calls.map((call) => call.phase)).toEqual([
      "resolve-scope",
      "inventory-changes",
      "plan-units",
      "ask-questions",
      "verify-review",
      "publish-review",
    ]);
    expect(calls[1]?.prompt).toContain(outputs["resolve review scope"]);
    expect(calls[1]?.prompt).not.toContain("review current branch");
    expect(calls[2]?.prompt).toContain(outputs["inventory changes"]);
    expect(calls[3]?.prompt).toContain(outputs["plan review units"]);
    expect(calls[3]?.prompt).not.toContain(outputs["inventory changes"]);
    expect(calls[4]?.prompt).toContain(outputs["ask review questions"]);
    expect(calls[5]?.prompt).toContain(outputs["verify and write review"]);
    expect(calls[5]?.prompt).toContain(outputs["ask review questions"]);
    expect(resourceLoader.evidence()).toHaveLength(6);
    expect(resourceLoader.evidence().every((item) => item.kind === "prompt")).toBe(true);
    expect(resourceLoader.evidence().every((item) => /^[0-9a-f]{64}$/.test(item.sha256))).toBe(true);
  });

  it("stops the pipeline at the first failing stage", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      if (request.label === "plan review units") {
        return {
          ok: false,
          status: "failed",
          summary: "unit planner failed",
          diagnostics: ["provider unavailable"],
          agent: request.agent,
          label: request.label,
        };
      }
      return completed(request, `${request.label} text`);
    });

    await expect(runWorkflow(dsl, "review current branch")).rejects.toBeInstanceOf(WorkflowAgentExecutionError);
    expect(calls.map((call) => call.label)).toEqual(["resolve review scope", "inventory changes", "plan review units"]);
  });
});
