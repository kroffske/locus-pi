import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import { runWorkflowScript } from "../../../extensions/workflows/runtime/workflow-runner.js";
import { standardWorkflowSourceShapeErrors } from "../../../extensions/workflows/workflow-source-shape.js";
import { createHarness } from "../../test-harness.js";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/plan/plan.workflow.mjs");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function temporaryProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-plan-minimal-"));
  temporaryRoots.push(root);
  const agentDir = path.join(root, ".agents", "agents");
  const workflowDir = path.join(root, ".pi", "workflows");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "default.md"),
    "---\nname: default\ndescription: Test default agent\nevidence:\n  mode: none\n---\nFollow the task.\n",
    "utf8",
  );
  writeFileSync(path.join(workflowDir, "plan.workflow.mjs"), readFileSync(workflowPath, "utf8"), "utf8");
  return root;
}

function completed(request: AgentRunRequest, text: string) {
  return {
    status: "completed" as const,
    agentName: request.agent.name,
    reason: text,
    text,
    diagnostics: [],
    lifecycleEntryIds: [],
  };
}

function failed(request: AgentRunRequest, reason: string) {
  return {
    status: "failed" as const,
    agentName: request.agent.name,
    reason,
    diagnostics: [],
    lifecycleEntryIds: [],
  };
}

describe("Package workflow: plan", () => {
  it("is a standard two-agent graph with no model pin or script-owned planning logic", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(standardWorkflowSourceShapeErrors(source)).toEqual([]);
    expect(source.match(/await agent\(/gu)).toHaveLength(2);
    expect(source).not.toMatch(/\bagent:/u);
    expect(source).not.toMatch(/\bmodel(?:Role)?:/u);
    expect(source).not.toMatch(/\b(?:critic|schema|validate|pipeline|items|invokeWorkflow)\b/u);
    expect(source).not.toMatch(/\b(?:for|while)\s*\(/u);
  });

  it("hands reconnaissance text unchanged to the planner and publishes plan.md", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: Array<{ prompt: string; label: string }> = [];
    const phases: string[] = [];
    const published: string[] = [];
    const result = await runWorkflow(
      {
        phase: (name: string) => phases.push(name),
        log: () => undefined,
        agent: async (prompt: string, options: { label: string }) => {
          calls.push({ prompt, label: options.label });
          return options.label === "reconnaissance" ? "# Context\nconfirmed repository map" : "Planning complete";
        },
        publishPrimaryFile: (relativePath: string) => {
          published.push(relativePath);
          return { relativePath };
        },
      },
      "Move the cron job into a DAG",
    );

    expect(phases).toEqual(["reconnaissance", "planning"]);
    expect(calls.map((call) => call.label)).toEqual(["reconnaissance", "planning"]);
    expect(calls[0]?.prompt).toContain("Move the cron job into a DAG");
    expect(calls[1]?.prompt).toContain("# Context\nconfirmed repository map");
    expect(calls[1]?.prompt).toContain("Fully replace both files");
    expect(calls[1]?.prompt).toContain("`plan.md`");
    expect(calls[1]?.prompt).toContain("`steps.md`");
    expect(published).toEqual(["plan.md"]);
    expect(result).toEqual({ relativePath: "plan.md" });
  });

  it("resumes after a planner failure without executing reconnaissance again", async () => {
    const root = temporaryProject();
    const workspace = path.join(root, "tmp", "cron-to-dag");
    const task = "Move the cron job into a DAG";
    const firstHarness = createHarness(root, { sessionId: "plan-first" });
    const firstCalls: string[] = [];
    const firstExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        const role = request.task.includes("You are the reconnaissance agent") ? "reconnaissance" : "planning";
        firstCalls.push(role);
        mkdirSync(workspace, { recursive: true });
        if (role === "reconnaissance") {
          writeFileSync(path.join(workspace, "context.md"), "# Context\nrepository map\n", "utf8");
          return completed(request, "# Context\nrepository map");
        }
        return failed(request, "planner interrupted");
      },
    });
    const first = await runWorkflowScript({
      pi: firstHarness.pi,
      ctx: firstHarness.ctx,
      signal: new AbortController().signal,
      name: "plan",
      input: task,
      outputDir: "tmp/cron-to-dag",
      createExecutor: firstExecutor,
    });

    expect(first.ok).toBe(false);
    expect(firstCalls).toEqual(["reconnaissance", "planning"]);
    expect(existsSync(path.join(workspace, "context.md"))).toBe(true);

    const resumedHarness = createHarness(root, { sessionId: "plan-resumed" });
    const resumedCalls: string[] = [];
    const resumedExecutor = (): AgentExecutor => ({
      async run(request: AgentRunRequest) {
        resumedCalls.push(request.task.includes("You are the planning agent") ? "planning" : "unexpected");
        writeFileSync(path.join(workspace, "plan.md"), "# Plan\nMove the cron job.\n", "utf8");
        writeFileSync(path.join(workspace, "steps.md"), "# Steps\n## S1 — Add the DAG\n", "utf8");
        return completed(request, "Planning complete");
      },
    });
    const resumed = await runWorkflowScript({
      pi: resumedHarness.pi,
      ctx: resumedHarness.ctx,
      signal: new AbortController().signal,
      name: "plan",
      input: task,
      outputDir: "tmp/cron-to-dag",
      resumeFromRunId: first.runId,
      createExecutor: resumedExecutor,
    });

    expect(resumed.ok).toBe(true);
    expect(resumedCalls).toEqual(["planning"]);
    expect(resumed.replay).toMatchObject({
      replayed: true,
      sourceRunId: first.runId,
      replayedCalls: 1,
      freshCalls: 1,
    });
    expect(resumed.primaryFile?.relativePath).toBe("plan.md");
    expect(readFileSync(path.join(workspace, "steps.md"), "utf8")).toContain("## S1");
  });
});
