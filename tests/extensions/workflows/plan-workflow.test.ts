import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentExecutor, AgentRunRequest } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import { runWorkflowScript } from "../../../extensions/workflows/runtime/workflow-runner.js";
import { standardWorkflowSourceShapeErrors } from "../../../extensions/workflows/workflow-source-shape.js";
import { createHarness } from "../../test-harness.js";

const workflowDirectory = path.join(process.cwd(), "extensions/workflows/examples/plan");
const workflowPath = path.join(workflowDirectory, "plan.workflow.mjs");
const templateRelativePath = "resources/execute-template.prompt.md";
const templatePath = path.join(workflowDirectory, templateRelativePath);
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
  mkdirSync(path.join(workflowDir, path.dirname(templateRelativePath)), { recursive: true });
  writeFileSync(
    path.join(agentDir, "default.md"),
    "---\nname: default\ndescription: Test default agent\nevidence:\n  mode: none\n---\nFollow the task.\n",
    "utf8",
  );
  writeFileSync(path.join(workflowDir, "plan.workflow.mjs"), readFileSync(workflowPath, "utf8"), "utf8");
  // `promptFile()` resolves beside the workflow entry, so the template travels with it.
  writeFileSync(path.join(workflowDir, templateRelativePath), readFileSync(templatePath, "utf8"), "utf8");
  return root;
}

/** Render the shipped template exactly as the scripting agent is told to. */
function renderExecuteScript(steps: Array<{ id: string; title: string; block: string }>): string {
  const blocks = [...readFileSync(templatePath, "utf8").matchAll(/```js\n([\s\S]*?)```/gu)].map((match) => match[1]!);
  expect(blocks).toHaveLength(4);
  const [header, phaseEntry, stepTemplate, footer] = blocks as [string, string, string, string];
  const fill = (template: string, step: { id: string; title: string }) =>
    template.replaceAll("<<STEP_ID>>", step.id).replaceAll("<<STEP_TITLE>>", step.title);
  const escapeBlock = (block: string) => block.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
  const entries = steps.map((step) => fill(phaseEntry, step).replace(/\n$/u, "")).join("\n");
  return (
    header.replace("<<DESCRIPTION>>", "Runs the approved catalog end to end.").replace("<<PHASE_ENTRIES>>", entries) +
    steps.map((step) => fill(stepTemplate, step).replace("<<STEP_BLOCK>>", escapeBlock(step.block))).join("") +
    footer
  );
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
  it("is a standard three-agent graph with no model pin or script-owned planning logic", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(standardWorkflowSourceShapeErrors(source)).toEqual([]);
    expect(source.match(/await agent\(/gu)).toHaveLength(3);
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
    const promptFiles: string[] = [];
    const result = await runWorkflow(
      {
        phase: (name: string) => phases.push(name),
        log: () => undefined,
        promptFile: async (relativePath: string) => {
          promptFiles.push(relativePath);
          return "RENDERED EXECUTE TEMPLATE";
        },
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

    expect(phases).toEqual(["reconnaissance", "planning", "scripting"]);
    expect(calls.map((call) => call.label)).toEqual(["reconnaissance", "planning", "scripting"]);
    expect(promptFiles).toEqual([`./${templateRelativePath}`]);
    expect(calls[2]?.prompt).toContain("RENDERED EXECUTE TEMPLATE");
    expect(calls[2]?.prompt).toContain("Move the cron job into a DAG");
    expect(calls[0]?.prompt).toContain("Move the cron job into a DAG");
    expect(calls[1]?.prompt).toContain("# Context\nconfirmed repository map");
    expect(calls[1]?.prompt).toContain("Fully replace both files");
    expect(calls[1]?.prompt).toContain("`plan.md`");
    expect(calls[1]?.prompt).toContain("`steps.md`");
    expect(calls[1]?.prompt).toContain("first define coherent top-level work units");
    expect(calls[1]?.prompt).toContain("the only executable task catalog");
    expect(calls[1]?.prompt).toMatch(/Do not create\s+`tasks\.md`/u);
    expect(calls[1]?.prompt).toContain("one complete flat block");
    expect(calls[1]?.prompt).toContain("use no nested structural headings");
    for (const field of [
      "Work unit:",
      "Boundary:",
      "Goal:",
      "Paths and evidence:",
      "Dependencies:",
      "Allowed ownership:",
      "Verification:",
      "Done when:",
    ]) {
      expect(calls[1]?.prompt, field).toContain(field);
    }
    for (const boundary of [
      /file boundary for isolated file ownership/u,
      /function boundary for one\s+behavior with local callers/u,
      /behavior boundary when one observable contract\s+crosses files/u,
      /side-effect boundary for database, API, email, file, or\s+subprocess operations/u,
      /ownership boundary for configuration, common, or\s+platform modules/u,
    ]) {
      expect(calls[1]?.prompt, boundary.source).toMatch(boundary);
    }
    expect(calls[1]?.prompt).toMatch(/one frozen\s+`steps\.md` catalog before execution/u);
    expect(calls[1]?.prompt).toContain("one Plan Implement run per step");
    expect(calls[1]?.prompt).toContain("`workflow-author` Design");
    expect(calls[1]?.prompt).toMatch(/nothing is\s+executed until the owner reviews/u);
    expect(calls[1]?.prompt).toMatch(/plan approval never implies `workflow-author`\s+Build approval/u);
    expect(calls[1]?.prompt).toMatch(/optional reviewer after a generated step belongs to that\s+Design/u);
    expect(published).toEqual(["plan.md"]);
    expect(result).toContain("Planning is complete and nothing has been implemented");
    expect(result).toContain("This run stops here");
    expect(result).toContain("Reading this result is not approval");
    expect(result).toMatch(/Do not start implementation, do not create implementation todos/u);
    expect(result).toContain("execute.workflow.mjs");
    expect(result).toContain("workflow-author");
    expect(result).toContain("Design workflow:");
    expect(result).toContain("Build approved design: <exact design path>");
  });

  it("renders standard-profile execute source from the shipped template", () => {
    const rendered = renderExecuteScript([
      { id: "S1", title: "Add the DAG module", block: "## S1 — Add the DAG module\n\nGoal: add `src/dag.ts`." },
      {
        id: "S2",
        title: "Retire the cron entry",
        // Backticks and `${` in a real block must survive into the literal prompt.
        block: "## S2 — Retire the cron entry\n\nGoal: drop the `${CRON_ENV}` hook.",
      },
    ]);

    expect(standardWorkflowSourceShapeErrors(rendered)).toEqual([]);
    expect(rendered).toContain('name: "execute"');
    expect(rendered).toContain('profile: "standard"');
    expect(rendered.match(/await agent\(/gu)).toHaveLength(3);
    expect(rendered.match(/phase\("/gu)).toHaveLength(3);
    expect(rendered).toContain('{ title: "S1", detail: "Add the DAG module" }');
    expect(rendered).toContain('{ title: "S2", detail: "Retire the cron entry" }');
    expect(rendered).toContain("history/S1.md");
    expect(rendered).toContain("history/S2.md");
    // Backtick and `${` inside the block arrive escaped, so the prompt stays literal text.
    expect(rendered).toContain("Goal: drop the \\`\\${CRON_ENV}\\` hook.");
    expect(rendered).toContain('return publishPrimaryFile("result.md");');
    // Each node sits one level inside the run function. Reformatting the fenced
    // blocks in the template file flattens this, so the generated file is only
    // readable while the template keeps its exact bytes.
    expect(rendered).toContain('\n\n  phase("S1");\n  log("Step S1 — Add the DAG module");\n  await agent(\n');
    expect(rendered).toContain('\n\n  phase("summary");\n');
    expect(rendered).toContain('\n    { label: "S1", workspaceMode: "project" },\n  );\n');
    // The template must not smuggle in machinery the standard profile forbids.
    expect(rendered).not.toMatch(/\b(?:try|catch|schema|validate|invokeWorkflow|pipeline|items)\b/u);
    expect(rendered).not.toMatch(/\b(?:for|while)\s*\(/u);
  });

  it("keeps the generated script out of every registered workflow directory", () => {
    const template = readFileSync(templatePath, "utf8");

    expect(template).toContain("Never write to `.pi/workflows/`");
    expect(template).toContain("resolves only by explicit path");
    expect(template).toMatch(/Do not invent, merge, split, renumber, summarize, reorder, or reword steps/u);
    expect(template).toContain("Review this file before running it");
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
        if (request.task.includes("You are the planning agent")) {
          resumedCalls.push("planning");
          writeFileSync(path.join(workspace, "plan.md"), "# Plan\nMove the cron job.\n", "utf8");
          writeFileSync(path.join(workspace, "steps.md"), "# Steps\n## S1 — Add the DAG\n", "utf8");
          return completed(request, "Planning complete");
        }
        if (request.task.includes("You are the scripting agent")) {
          resumedCalls.push("scripting");
          writeFileSync(path.join(workspace, "execute.workflow.mjs"), "// generated\n", "utf8");
          return completed(request, "Wrote execute.workflow.mjs for S1");
        }
        resumedCalls.push("unexpected");
        return failed(request, "unexpected call");
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
    expect(resumedCalls).toEqual(["planning", "scripting"]);
    expect(resumed.replay).toMatchObject({
      replayed: true,
      sourceRunId: first.runId,
      replayedCalls: 1,
      freshCalls: 2,
    });
    expect(resumed.primaryFile?.relativePath).toBe("plan.md");
    expect(readFileSync(path.join(workspace, "steps.md"), "utf8")).toContain("## S1");
    expect(existsSync(path.join(workspace, "execute.workflow.mjs"))).toBe(true);
    expect(String(resumed.result)).toContain("This run stops here");
  });
});
