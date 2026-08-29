import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { standardWorkflowSourceShapeErrors } from "../../../../../extensions/workflows/tool/workflow-source-shape.js";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/task/draft.workflow.mjs");

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

interface FakeCall {
  prompt: string;
  label: string;
  workspaceMode: string;
  ask?: true;
  choice?: string[];
}

describe("Package workflow: task/draft", () => {
  it("is a standard two-stage graph whose recon route gates live questions", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(standardWorkflowSourceShapeErrors(source)).toEqual([]);
    expect(source.match(/await agent\(/gu)).toHaveLength(2);
    expect(source).toContain('label: "draft recon"');
    expect(source).toContain('label: "task draft"');
    expect(source).toContain('choice: ["ready", "ask"]');
    expect(source).toContain('clarificationRoute === "ask"');
    expect(source).toContain("ask: true");
    expect(source).not.toMatch(/\b(?:parallel|pipeline|invokeWorkflow|awaitOperator)\s*\(/u);
    expect(source).not.toMatch(/\b(?:for|while)\s*\(/u);
  });

  it("keeps a ready request headless-compatible, publishes draft.md, and stops before planning", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: FakeCall[] = [];
    const phases: string[] = [];
    const published: string[] = [];
    const result = await runWorkflow(
      {
        phase: (name: string) => phases.push(name),
        log: () => undefined,
        agent: async (prompt: string, options: Omit<FakeCall, "prompt">) => {
          calls.push({ prompt, ...options });
          return options.label === "draft recon" ? "ready" : "draft.md written";
        },
        publishPrimaryFile: (relativePath: string) => {
          published.push(relativePath);
          return { relativePath };
        },
      },
      "Add a manual task drafting stage",
    );

    expect(phases).toEqual(["recon", "draft", "publish"]);
    expect(calls.map((call) => call.label)).toEqual(["draft recon", "task draft"]);
    expect(calls[0]?.prompt).toContain("Add a manual task drafting stage");
    expect(calls[0]?.prompt).toContain("Fully replace `draft-context.md`");
    expect(calls[0]).toMatchObject({ workspaceMode: "project", choice: ["ready", "ask"] });
    expect(calls[1]?.prompt).toContain("classified this request as `ready`");
    expect(calls[1]).toMatchObject({ workspaceMode: "project" });
    expect(calls[1]?.ask).toBeUndefined();
    expect(calls[1]?.prompt).toContain("Task:");
    expect(calls[1]?.prompt).toContain("Draft goal:");
    expect(calls[1]?.prompt).toContain("at most\nthree short questions");
    expect(published).toEqual(["draft.md"]);
    expect(result).toContain("stops before planning");
  });

  it("mounts workflow_ask only when recon classifies clarification as material", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: FakeCall[] = [];

    await runWorkflow(
      {
        phase: () => undefined,
        log: () => undefined,
        agent: async (prompt: string, options: Omit<FakeCall, "prompt">) => {
          calls.push({ prompt, ...options });
          return options.label === "draft recon" ? "ask" : "saved";
        },
        publishPrimaryFile: () => ({ relativePath: "draft.md" }),
      },
      "   ",
    );

    expect(calls[0]?.prompt).toContain("No request text was supplied");
    expect(calls[1]?.prompt).toContain("ask the operator for the intended task");
    expect(calls[1]).toMatchObject({ workspaceMode: "project", ask: true });
  });
});
