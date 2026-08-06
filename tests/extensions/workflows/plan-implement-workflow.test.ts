import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { standardWorkflowSourceShapeErrors } from "../../../extensions/workflows/workflow-source-shape.js";

const workflowPath = path.join(
  process.cwd(),
  "extensions/workflows/examples/plan-implement/plan-implement.workflow.mjs",
);

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

describe("Package workflow: plan-implement", () => {
  it("is one standard agent call with no parser, loop, reviewer, or model pin", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(standardWorkflowSourceShapeErrors(source)).toEqual([]);
    expect(source.match(/await agent\(/gu)).toHaveLength(1);
    expect(source).not.toMatch(/\bagent:/u);
    expect(source).not.toMatch(/\bmodel(?:Role)?:/u);
    expect(source).not.toMatch(/\b(?:JSON\.parse|schema|validate|reviewer|pipeline|items|invokeWorkflow)\b/u);
    expect(source).not.toMatch(/\b(?:for|while)\s*\(/u);
  });

  it("passes one exact step to one implementation agent and returns its text unchanged", async () => {
    const runWorkflow = await loadWorkflow();
    const calls: Array<{ prompt: string; options: { label: string } }> = [];
    const step = [
      "## S3 — Add the DAG configuration",
      "Work unit: W2 — Project configuration",
      "Boundary: ownership — configuration module",
      "Goal: Create the project config.",
      "Paths and evidence: src/dag-config.ts and its tests.",
      "Dependencies: S1 completed.",
      "Allowed ownership: src/dag-config.ts and tests/dag-config.test.ts.",
      "Verification: npm test -- dag-config",
      "Done when: the configuration behavior passes its focused test.",
    ].join("\n");
    const history = [
      "# S3 — Add the DAG configuration",
      "Status: completed",
      "Checks: npm test -- dag-config — passed",
    ].join("\n");

    const result = await runWorkflow(
      {
        phase: () => undefined,
        log: () => undefined,
        agent: async (prompt: string, options: { label: string }) => {
          calls.push({ prompt, options });
          return history;
        },
      },
      step,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({ label: "implementation", workspaceMode: "project" });
    expect(calls[0]?.prompt).toContain(step);
    expect(calls[0]?.prompt).toContain("`history/S<n>.md`");
    expect(calls[0]?.prompt).toContain("Execute exactly the one step below");
    expect(calls[0]?.prompt).toContain("one complete flat `## S<n> — ...` block");
    expect(calls[0]?.prompt).toContain("Older saved blocks may carry fewer labels");
    expect(calls[0]?.prompt).toContain("present as one coherent task contract");
    expect(calls[0]?.prompt).toContain("If the block declares `Allowed ownership:`");
    expect(calls[0]?.prompt).toMatch(/Do not\s+decompose it into nested tasks/u);
    expect(result).toBe(history);
  });

  it("keeps older saved steps without ownership labels executable", async () => {
    const runWorkflow = await loadWorkflow();
    const legacyStep = [
      "## S2 — Preserve the legacy migration",
      "Goal: Keep the existing migration behavior.",
      "Verification: npm test -- migration",
    ].join("\n");
    let prompt = "";

    await runWorkflow(
      {
        phase: () => undefined,
        log: () => undefined,
        agent: async (value: string) => {
          prompt = value;
          return "# S2\nStatus: completed";
        },
      },
      legacyStep,
    );

    expect(prompt).toContain(legacyStep);
    expect(prompt).toContain("Older saved blocks may carry fewer labels");
    expect(prompt).toContain("If that label is absent");
    expect(prompt).not.toContain("malformed");
  });

  it("does not reinterpret a blocked implementation result or start another step", async () => {
    const runWorkflow = await loadWorkflow();
    let calls = 0;
    const blocked = "# S3\nStatus: blocked\nChecks: required test failed";
    const result = await runWorkflow(
      {
        phase: () => undefined,
        log: () => undefined,
        agent: async () => {
          calls += 1;
          return blocked;
        },
      },
      "## S3 — Add the DAG configuration",
    );

    expect(calls).toBe(1);
    expect(result).toBe(blocked);
  });
});
