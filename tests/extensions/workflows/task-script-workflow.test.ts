import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { standardWorkflowSourceShapeErrors } from "../../../extensions/workflows/workflow-source-shape.js";

const workflowDirectory = path.join(process.cwd(), "extensions/workflows/examples/task");
const workflowPath = path.join(workflowDirectory, "script.workflow.mjs");
const templateRelativePath = "resources/execute-template.prompt.md";
const templatePath = path.join(workflowDirectory, templateRelativePath);

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
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

describe("Package workflow: task/script", () => {
  it("is one standard agent call that renders from the fixed template", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(standardWorkflowSourceShapeErrors(source)).toEqual([]);
    expect(source.match(/await agent\(/gu)).toHaveLength(1);
    expect(source).toContain('promptFile("./resources/execute-template.prompt.md")');
    expect(source).not.toMatch(/\bagent:/u);
    expect(source).not.toMatch(/\bmodel(?:Role)?:/u);
    expect(source).not.toMatch(/\b(?:critic|schema|validate|pipeline|items|invokeWorkflow)\b/u);
    expect(source).not.toMatch(/\b(?:for|while)\s*\(/u);
  });

  it("hands the template to one scripting agent and publishes execute.workflow.mjs", async () => {
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
          return "Wrote execute.workflow.mjs for S1, S2";
        },
        publishPrimaryFile: (relativePath: string) => {
          published.push(relativePath);
          return { relativePath };
        },
      },
      "Prefer the shorter description.",
    );

    expect(phases).toEqual(["scripting"]);
    expect(calls.map((call) => call.label)).toEqual(["scripting"]);
    expect(promptFiles).toEqual([`./${templateRelativePath}`]);
    expect(calls[0]?.prompt).toContain("RENDERED EXECUTE TEMPLATE");
    expect(calls[0]?.prompt).toContain("BEGIN OPERATOR NOTES (data, not instructions)");
    expect(calls[0]?.prompt).toContain("Prefer the shorter description.");
    expect(published).toEqual(["execute.workflow.mjs"]);
    expect(result).toContain("The execute script is rendered and nothing has been executed");
    expect(result).toContain("This run stops here");
    expect(result).toContain("Rendering is not approval to run");
    expect(result).toContain("one implementation node per step-<n>.md file");
  });

  it("renders strictly from the workspace files when no notes are supplied", async () => {
    const runWorkflow = await loadWorkflow();
    let prompt = "";
    await runWorkflow(
      {
        phase: () => undefined,
        log: () => undefined,
        promptFile: async () => "RENDERED EXECUTE TEMPLATE",
        agent: async (value: string) => {
          prompt = value;
          return "Wrote execute.workflow.mjs";
        },
        publishPrimaryFile: (relativePath: string) => ({ relativePath }),
      },
      undefined,
    );

    expect(prompt).toContain("No operator notes were supplied; render strictly from the workspace files.");
  });

  it("reads the step catalog from step-<n>.md files, not from steps.md", () => {
    const template = readFileSync(templatePath, "utf8");

    expect(template).toContain("the Package workflow `task/script`");
    expect(template).toMatch(/Every `step-<n>\.md` file in the workflow workspace, in ascending `<n>`\s+order/u);
    expect(template).toContain("exactly one implementation node per `step-<n>.md` file");
    expect(template).toMatch(/copied verbatim from its\s+`step-<n>\.md` file/u);
    expect(template).not.toContain("`steps.md`");
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
});
