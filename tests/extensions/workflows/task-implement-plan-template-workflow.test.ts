import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { standardWorkflowSourceShapeErrors } from "../../../extensions/workflows/workflow-source-shape.js";

const workflowDirectory = path.join(process.cwd(), "extensions/workflows/examples/task");
const workflowPath = path.join(workflowDirectory, "implement-plan-template.workflow.mjs");
const templateRelativePath = "resources/implement-plan-template.prompt.md";
const templatePath = path.join(workflowDirectory, templateRelativePath);

async function loadWorkflow(): Promise<(dsl: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as { default?: (dsl: unknown) => Promise<unknown> };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function fakeDsl(record: {
  calls: Array<{ prompt: string; label: string; workspaceMode: string }>;
  phases: string[];
  published: string[];
  promptFiles: string[];
}) {
  return {
    phase: (name: string) => record.phases.push(name),
    log: () => undefined,
    promptFile: async (relativePath: string) => {
      record.promptFiles.push(relativePath);
      return "RENDERED IMPLEMENT PLAN TEMPLATE";
    },
    agent: async (prompt: string, options: { label: string; workspaceMode: string }) => {
      record.calls.push({ ...options, prompt });
      return "Wrote implement-plan.workflow.mjs for S1, S2";
    },
    publishPrimaryFile: (relativePath: string) => {
      record.published.push(relativePath);
      return { relativePath };
    },
  };
}

function renderImplementPlan(steps: Array<{ id: string; title: string; block: string }>): string {
  const blocks = [...readFileSync(templatePath, "utf8").matchAll(/```js\n([\s\S]*?)```/gu)].map((match) => match[1]!);
  expect(blocks).toHaveLength(4);
  const [header, phaseEntry, stepTemplate, footer] = blocks as [string, string, string, string];
  const escapeDoubleQuoted = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const fill = (template: string, step: { id: string; title: string }) =>
    template.replaceAll("<<STEP_ID>>", step.id).replaceAll("<<STEP_TITLE>>", escapeDoubleQuoted(step.title));
  const escapeBlock = (block: string) => block.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
  const entries = steps.map((step) => fill(phaseEntry, step).replace(/\n$/u, "")).join("\n");
  return (
    header
      .replace("<<DESCRIPTION>>", escapeDoubleQuoted('Runs the approved "catalog" end to end.'))
      .replace("<<PHASE_ENTRIES>>", entries) +
    steps.map((step) => fill(stepTemplate, step).replace("<<STEP_BLOCK>>", escapeBlock(step.block))).join("") +
    footer
  );
}

describe("Package workflow: task/implement-plan-template", () => {
  it("is one standard rendering agent with no planning child, parser, or model pin", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(standardWorkflowSourceShapeErrors(source)).toEqual([]);
    expect(source.match(/await agent\(/gu)).toHaveLength(1);
    expect(source).toContain('promptFile("./resources/implement-plan-template.prompt.md")');
    expect(source).not.toMatch(/\binvokeWorkflow\b/u);
    expect(source).not.toMatch(/\bchoice\s*:/u);
    expect(source).not.toMatch(/\bagent:/u);
    expect(source).not.toMatch(/\bmodel(?:Role)?:/u);
    expect(source).not.toMatch(/\b(?:schema|validate|items)\s*:/u);
    expect(source).not.toMatch(/\b(?:for|while)\s*\(/u);
  });

  it("renders and publishes the approved plan without replanning or executing it", async () => {
    const runWorkflow = await loadWorkflow();
    const record = {
      calls: [] as Array<{ prompt: string; label: string; workspaceMode: string }>,
      phases: [] as string[],
      published: [] as string[],
      promptFiles: [] as string[],
    };

    const result = await runWorkflow(fakeDsl(record));

    expect(record.phases).toEqual(["render", "publish"]);
    expect(record.promptFiles).toEqual([`./${templateRelativePath}`]);
    expect(record.calls).toEqual([
      { prompt: "RENDERED IMPLEMENT PLAN TEMPLATE", label: "render-plan", workspaceMode: "project" },
    ]);
    expect(record.published).toEqual(["implement-plan.workflow.mjs"]);
    expect(result).toContain("approved plan has been rendered");
    expect(result).toContain("nothing has been executed");
    expect(result).toContain("same planning workspace");
  });

  it("renders a standard sequential plan with one literal node per step", () => {
    const rendered = renderImplementPlan([
      {
        id: "S1",
        title: 'Add the "DAG" module',
        block: "## S1 — Add the DAG module\n\nGoal: add `src\\dag.ts`.",
      },
      {
        id: "S2",
        title: "Retire the cron entry",
        block: "## S2 — Retire the cron entry\n\nGoal: drop the `${CRON_ENV}` hook.",
      },
    ]);

    expect(standardWorkflowSourceShapeErrors(rendered)).toEqual([]);
    expect(rendered).toContain('name: "implement-plan"');
    expect(rendered).toContain('profile: "standard"');
    expect(rendered.match(/await agent\(/gu)).toHaveLength(3);
    expect(rendered.match(/phase\("/gu)).toHaveLength(3);
    expect(rendered).toContain('{ title: "S1", detail: "Add the \\"DAG\\" module" }');
    expect(rendered).toContain('{ title: "S2", detail: "Retire the cron entry" }');
    expect(rendered).toContain("history/S1.md");
    expect(rendered).toContain("history/S2.md");
    expect(rendered).toContain("Goal: add \\`src\\\\dag.ts\\`.");
    expect(rendered).toContain("Goal: drop the \\`\\${CRON_ENV}\\` hook.");
    expect(rendered.match(/choice: \["completed", "blocked"\]/gu)).toHaveLength(2);
    expect(rendered).toContain('if (S1Status === "blocked")');
    expect(rendered).toContain('if (S2Status === "blocked")');
    expect(rendered).toContain("throw new Error");
    expect(rendered).toContain('return publishPrimaryFile("result.md");');
    expect(rendered).not.toMatch(/\b(?:try|catch|schema|validate|invokeWorkflow|pipeline|items)\b/u);
    expect(rendered).not.toMatch(/\b(?:for|while)\s*\(/u);
  });

  it("turns a blocked step into a workflow failure before the next literal node", async () => {
    const rendered = renderImplementPlan([
      { id: "S1", title: "Create the DAG", block: "## S1 — Create the DAG\n\nGoal: add the DAG." },
      { id: "S2", title: "Remove cron", block: "## S2 — Remove cron\n\nGoal: remove cron." },
    ]);
    const module = (await import(`data:text/javascript;base64,${Buffer.from(rendered).toString("base64")}`)) as {
      default: (dsl: unknown) => Promise<unknown>;
    };
    const blockedLabels: string[] = [];

    await expect(
      module.default({
        phase: () => undefined,
        log: () => undefined,
        agent: async (_prompt: string, options: { label: string }) => {
          blockedLabels.push(options.label);
          return options.label === "S1" ? "blocked" : "completed";
        },
        publishPrimaryFile: () => ({ relativePath: "result.md" }),
      }),
    ).rejects.toThrow("Step S1 — Create the DAG is blocked; read history/S1.md.");
    expect(blockedLabels).toEqual(["S1"]);

    const completedLabels: string[] = [];
    const published: string[] = [];
    const result = await module.default({
      phase: () => undefined,
      log: () => undefined,
      agent: async (_prompt: string, options: { label: string }) => {
        completedLabels.push(options.label);
        return options.label === "summary" ? "summary written" : "completed";
      },
      publishPrimaryFile: (relativePath: string) => {
        published.push(relativePath);
        return { relativePath };
      },
    });
    expect(completedLabels).toEqual(["S1", "S2", "summary"]);
    expect(published).toEqual(["result.md"]);
    expect(result).toEqual({ relativePath: "result.md" });
  });

  it("keeps the generated plan out of registered directories and removes stale targets before rendering", () => {
    const template = readFileSync(templatePath, "utf8");

    expect(template).toContain("the Package workflow `task/implement-plan-template`");
    expect(template).toMatch(/Every `step-<n>\.md` file in the workflow workspace, in ascending `<n>`\s+order/u);
    expect(template).toContain("exactly one implementation node per `step-<n>.md` file");
    expect(template).toContain("Never write to `.pi/workflows/`");
    expect(template).toContain("resolves only by explicit path");
    expect(template).toContain("delete any existing\n`implement-plan.workflow.mjs`");
    expect(template).toContain("leave the new target absent");
    expect(template).toContain("file numbers must be contiguous from 1");
    expect(template).toContain("return exactly \\`completed\\`");
    // The runtime appends a JSON answer contract to every choice call; the step prompt must not
    // forbid the JSON that contract then asks for, or the child is told two different things.
    expect(template).toContain("Do not return the\n  history Markdown or any other text.");
    expect(template).not.toContain("Markdown, JSON");
  });
});
