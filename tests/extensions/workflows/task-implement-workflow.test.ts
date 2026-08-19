import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { standardWorkflowSourceShapeErrors } from "../../../extensions/workflows/workflow-source-shape.js";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/task/implement.workflow.mjs");

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

describe("Package workflow: task/implement", () => {
  it("is one standard agent call with no parser, loop, reviewer, or model pin", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(standardWorkflowSourceShapeErrors(source)).toEqual([]);
    expect(source.match(/await agent\(/gu)).toHaveLength(1);
    expect(source).not.toMatch(/\bagent:/u);
    expect(source).not.toMatch(/\bmodel(?:Role)?:/u);
    expect(source).not.toMatch(/\b(?:JSON\.parse|schema|validate|reviewer|pipeline|items|invokeWorkflow)\b/u);
    expect(source).not.toMatch(/\b(?:for|while)\s*\(/u);
  });

  it("passes the complete saved plan to one implementation agent and returns its text unchanged", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: Array<{ prompt: string; options: { label: string } }> = [];
    const summary = [
      "# Implementation summary",
      "- S1: completed",
      "- S2: completed",
      "Checks: npm test — passed",
    ].join("\n");

    const result = await runWorkflow({
      phase: () => undefined,
      log: () => undefined,
      agent: async (prompt: string, options: { label: string }) => {
        calls.push({ prompt, options });
        return summary;
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({ label: "implementation", workspaceMode: "project" });
    expect(calls[0]?.prompt).not.toContain("STEP SELECTOR");
    expect(calls[0]?.prompt).toMatch(/Read `plan\.md`, every\s+`step-<n>\.md` file in ascending numeric order/u);
    expect(calls[0]?.prompt).toContain("Execute the catalog in ascending");
    expect(calls[0]?.prompt).toMatch(/including owner edits made after\s+planning/u);
    expect(calls[0]?.prompt).toMatch(/are the implementation contract/u);
    expect(calls[0]?.prompt).toContain("`history/S<n>.md`");
    expect(calls[0]?.prompt).toContain("`history/implementation.md`");
    expect(calls[0]?.prompt).toContain("one complete flat `## S<n> — ...` block");
    expect(calls[0]?.prompt).toContain("Older saved step files may carry fewer labels");
    expect(calls[0]?.prompt).toContain("present as one coherent task contract");
    expect(calls[0]?.prompt).toContain("If the block declares `Allowed ownership:`");
    expect(calls[0]?.prompt).toMatch(/Do not\s+decompose it into nested tasks/u);
    expect(calls[0]?.prompt).toMatch(/On the first blocked step or failed required check/u);
    expect(result).toBe(summary);
  });

  it("routes an invalid or missing plan catalog to a blocked record instead of project edits", async () => {
    const runWorkflow = await loadWorkflow();
    let prompt = "";

    await runWorkflow({
      phase: () => undefined,
      log: () => undefined,
      agent: async (value: string) => {
        prompt = value;
        return "# unkeyed-step\nStatus: blocked";
      },
    });

    expect(prompt).toMatch(/If `plan\.md` is missing or empty, no step file\s+exists/u);
    expect(prompt).toContain("`history/implementation.md`");
    expect(prompt).toContain("do not modify project files");
  });

  it("does not reinterpret the implementation agent result or spawn another agent", async () => {
    const runWorkflow = await loadWorkflow();
    let calls = 0;
    const blocked = "# S3\nStatus: blocked\nChecks: required test failed";
    const result = await runWorkflow({
      phase: () => undefined,
      log: () => undefined,
      agent: async () => {
        calls += 1;
        return blocked;
      },
    });

    expect(calls).toBe(1);
    expect(result).toBe(blocked);
  });
});
