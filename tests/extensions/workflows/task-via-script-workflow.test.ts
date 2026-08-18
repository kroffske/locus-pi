import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { standardWorkflowSourceShapeErrors } from "../../../extensions/workflows/workflow-source-shape.js";

const workflowDirectory = path.join(process.cwd(), "extensions/workflows/examples/task-via-script");
const workflowPath = path.join(workflowDirectory, "task-via-script.workflow.mjs");
const templateRelativePath = "resources/implement-template.prompt.md";
const templatePath = path.join(workflowDirectory, templateRelativePath);

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

interface FakeInvocation {
  name?: string;
  child?: string;
  key: string;
  keys: string[];
  input?: unknown;
  outputDir: string;
}

function fakeDsl(record: {
  invocations: FakeInvocation[];
  calls: Array<{ prompt: string; label: string; choice?: string[]; choiceFallback?: string }>;
  phases: string[];
  published: string[];
  promptFiles: string[];
  routeAnswer: string;
}) {
  return {
    phase: (name: string) => record.phases.push(name),
    log: () => undefined,
    outputDir: () => "tmp/cron-to-dag",
    invokeWorkflow: async (invocation: FakeInvocation) => {
      record.invocations.push(invocation);
      return {
        status: "completed" as const,
        key: invocation.key,
        outputDir: invocation.outputDir,
      };
    },
    promptFile: async (relativePath: string) => {
      record.promptFiles.push(relativePath);
      return "RENDERED IMPLEMENT TEMPLATE";
    },
    agent: async (prompt: string, options: { label: string; choice?: string[]; choiceFallback?: string }) => {
      record.calls.push({ ...options, prompt });
      if (options.choice !== undefined) return record.routeAnswer;
      return "Wrote implement.workflow.mjs for S1, S2";
    },
    publishPrimaryFile: (relativePath: string) => {
      record.published.push(relativePath);
      return { relativePath };
    },
  };
}

/** Render the shipped template exactly as the scripting agent is told to. */
function renderImplementScript(steps: Array<{ id: string; title: string; block: string }>): string {
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

describe("Package workflow: task-via-script", () => {
  it("is a standard root that plans through task/plan and renders from the fixed template", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(standardWorkflowSourceShapeErrors(source)).toEqual([]);
    // One saved-child planning stage, one runtime readiness choice, one rendering agent.
    expect(source.match(/await invokeWorkflow\(/gu)).toHaveLength(1);
    expect(source).toContain('name: "task/plan"');
    expect(source.match(/await agent\(/gu)).toHaveLength(2);
    expect(source).toContain('choice: ["render", "blocked"]');
    expect(source).toContain('choiceFallback: "blocked"');
    expect(source).toContain('promptFile("./resources/implement-template.prompt.md")');
    expect(source).not.toContain("awaitOperator");
    expect(source).not.toMatch(/\bagent:/u);
    expect(source).not.toMatch(/\bmodel(?:Role)?:/u);
    expect(source).not.toMatch(/\bcritic\b/u);
    expect(source).not.toMatch(/\b(?:schema|validate|items)\s*:/u);
    expect(source).not.toMatch(/\bpipeline\s*\(/u);
    expect(source).not.toMatch(/\b(?:for|while)\s*\(/u);
    // The generated script name changed with the route; the old one must not resurface.
    expect(source).not.toContain("execute.workflow.mjs");
  });

  it("runs its own task/plan stage in the same workspace, then renders and publishes implement.workflow.mjs", async () => {
    const runWorkflow = await loadWorkflow();
    const record = {
      invocations: [] as FakeInvocation[],
      calls: [] as Array<{ prompt: string; label: string; choice?: string[] }>,
      phases: [] as string[],
      published: [] as string[],
      promptFiles: [] as string[],
      routeAnswer: "render",
    };
    const result = await runWorkflow(fakeDsl(record), "Move the cron job into a DAG");

    expect(record.phases).toEqual(["planning", "route", "scripting", "publish"]);
    expect(record.invocations).toEqual([
      {
        name: "task/plan",
        key: "plan",
        keys: ["plan"],
        input: "Move the cron job into a DAG",
        outputDir: "tmp/cron-to-dag",
      },
    ]);
    expect(record.promptFiles).toEqual([`./${templateRelativePath}`]);
    expect(record.calls.map((call) => call.label)).toEqual(["route", "scripting"]);
    expect(record.calls[0]?.prompt).toContain("'Conclusion: ready'");
    expect(record.calls[1]?.prompt).toBe("RENDERED IMPLEMENT TEMPLATE");
    expect(record.published).toEqual(["implement.workflow.mjs"]);
    expect(result).toContain("Planning and rendering are complete and nothing has been executed");
    expect(result).toContain("This run stops here");
    expect(result).toContain("Rendering is not approval to run");
    expect(result).toContain("one implementation node per step-<n>.md file");
    expect(result).toContain("/workflows run <workflow workspace>/implement.workflow.mjs");
  });

  it("fails closed without rendering when its planning stage published the blocker", async () => {
    const runWorkflow = await loadWorkflow();
    const record = {
      invocations: [] as FakeInvocation[],
      calls: [] as Array<{ prompt: string; label: string; choice?: string[] }>,
      phases: [] as string[],
      published: [] as string[],
      promptFiles: [] as string[],
      routeAnswer: "blocked",
    };
    const result = await runWorkflow(fakeDsl(record), "Move the cron job into a DAG");

    expect(record.phases).toEqual(["planning", "route"]);
    expect(record.calls.map((call) => call.label)).toEqual(["route"]);
    expect(record.promptFiles).toEqual([]);
    expect(record.published).toEqual(["planning-blocker.md"]);
    expect(result).toContain("Planning finished BLOCKED, so no script was rendered");
    expect(result).toContain("This run stops here");
    expect(result).toContain("rerun task-via-script on the same workspace");
  });

  it("reads the step catalog from step-<n>.md files, not from steps.md", () => {
    const template = readFileSync(templatePath, "utf8");

    expect(template).toContain("the Package workflow `task-via-script`");
    expect(template).toMatch(/Every `step-<n>\.md` file in the workflow workspace, in ascending `<n>`\s+order/u);
    expect(template).toContain("exactly one implementation node per `step-<n>.md` file");
    expect(template).toMatch(/copied verbatim from its\s+`step-<n>\.md` file/u);
    expect(template).not.toContain("`steps.md`");
  });

  it("renders standard-profile implement source from the shipped template", () => {
    const rendered = renderImplementScript([
      { id: "S1", title: "Add the DAG module", block: "## S1 — Add the DAG module\n\nGoal: add `src/dag.ts`." },
      {
        id: "S2",
        title: "Retire the cron entry",
        // Backticks and `${` in a real block must survive into the literal prompt.
        block: "## S2 — Retire the cron entry\n\nGoal: drop the `${CRON_ENV}` hook.",
      },
    ]);

    expect(standardWorkflowSourceShapeErrors(rendered)).toEqual([]);
    expect(rendered).toContain('name: "implement"');
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
    expect(template).toMatch(/Delete a stale generated `execute\.workflow\.mjs`/u);
  });
});
