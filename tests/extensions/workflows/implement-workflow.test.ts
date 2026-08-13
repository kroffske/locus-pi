import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { standardWorkflowSourceShapeErrors } from "../../../extensions/workflows/workflow-source-shape.js";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/implement/implement.workflow.mjs");

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function fakeDsl(answers: string[]) {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const handoffs: unknown[] = [];
  const publications: string[] = [];
  return {
    calls,
    handoffs,
    publications,
    dsl: {
      continuationArtifacts: () => [],
      phase: () => undefined,
      agent: async (prompt: string, options: Record<string, unknown>) => {
        calls.push({ prompt, options });
        const answer = answers.shift();
        if (answer === undefined) throw new Error("missing fake agent answer");
        return answer;
      },
      publishArtifact: (name: string, text: string) => ({ path: name, bytes: text.length, sha256: "plan" }),
      awaitOperator: (declaration: unknown) => handoffs.push(declaration),
      publishPrimaryFile: (name: string) => {
        publications.push(name);
        return { relativePath: name, bytes: 1, sha256: "primary" };
      },
    },
  };
}

describe("Package workflow: implement", () => {
  it("uses the standard profile with visible finite routes and no prose parser", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(standardWorkflowSourceShapeErrors(source)).toEqual([]);
    expect(source).not.toMatch(/\b(?:JSON\.parse|schema|validate|invokeWorkflow|pipeline|handoffs:)\b/u);
    expect(source).not.toMatch(/\b(?:for|while)\s*\(/u);
    expect(source).toContain('choice: ["execute", "no-work", "needs-operator"]');
    expect(source).toContain('choice: ["accept", "revise", "blocked"]');
    expect(source).toContain('choice: ["accept", "blocked"]');
    expect(source.match(/correct verified implementation defects/gu)).toHaveLength(1);
  });

  it("publishes an intentional no-op when no selected action needs implementation", async () => {
    const runWorkflow = await loadWorkflow();
    const harness = fakeDsl([
      "# Implementation plan\nSelected work: none",
      "no-work",
      "# Implementation report\nStatus: NO_WORK",
    ]);

    const result = await runWorkflow(harness.dsl, "read post-code-review.md and apply REQUIRED fixes");

    expect(harness.calls).toHaveLength(3);
    expect(harness.calls[0]?.prompt).toContain("Default to REQUIRED actions only");
    expect(harness.calls[0]?.prompt).toContain("Never execute NO_ACTION");
    expect(harness.calls[2]?.prompt).toContain("Status: NO_WORK");
    expect(harness.publications).toEqual(["implementation-report.md"]);
    expect(result).toMatchObject({ relativePath: "implementation-report.md" });
  });

  it("pauses for one operator decision and carries the prepared plan as a verified artifact", async () => {
    const runWorkflow = await loadWorkflow();
    const harness = fakeDsl(["# Implementation plan\nDecision needed: choose API owner", "needs-operator"]);

    const result = await runWorkflow(harness.dsl, "implement plan.md");

    expect(harness.calls).toHaveLength(2);
    expect(harness.handoffs).toHaveLength(1);
    expect(harness.handoffs[0]).toMatchObject({
      reason: "implementation requires one owner or product decision",
      operatorHandoff: {
        title: "Resolve implementation scope",
        continuationArtifactRefs: [{ path: "implementation-plan.md", sha256: "plan" }],
      },
    });
    expect(result).toMatchObject({ path: "implementation-plan.md", sha256: "plan" });
    expect(harness.publications).toEqual([]);
  });

  it("implements, independently verifies, and reports an accepted result", async () => {
    const runWorkflow = await loadWorkflow();
    const harness = fakeDsl([
      "# Implementation plan\nSelected: F1 REQUIRED",
      "execute",
      "# Implementation work\nStatus: completed",
      "# Implementation review\nSafe to accept",
      "accept",
      "# Implementation report\nStatus: COMPLETED",
    ]);

    await runWorkflow(harness.dsl, "apply REQUIRED fixes from post-code-review.md");

    expect(harness.calls).toHaveLength(6);
    expect(harness.calls[2]?.options).toMatchObject({ label: "apply implementation plan", workspaceMode: "project" });
    expect(harness.calls[2]?.prompt).toContain("Illustrative snippets");
    expect(harness.calls[3]?.options).toMatchObject({ label: "verify implementation", workspaceMode: "project" });
    expect(harness.calls[4]?.options).toMatchObject({ choice: ["accept", "revise", "blocked"] });
    expect(harness.publications).toEqual(["implementation-report.md"]);
  });

  it("allows exactly one correction and then accepts or blocks without another revision", async () => {
    const runWorkflow = await loadWorkflow();
    const harness = fakeDsl([
      "# Implementation plan\nSelected: F1 REQUIRED",
      "execute",
      "# Implementation work\nStatus: completed",
      "# Implementation review\nFocused test still fails",
      "revise",
      "# Implementation work\nStatus: corrected",
      "# Implementation review\nFailure remains",
      "blocked",
      "# Implementation report\nStatus: BLOCKED",
    ]);

    await runWorkflow(harness.dsl, "apply REQUIRED fixes from post-code-review.md");

    expect(harness.calls).toHaveLength(9);
    expect(
      harness.calls.filter((call) => call.options.label === "correct verified implementation defects"),
    ).toHaveLength(1);
    expect(harness.calls[7]?.options).toMatchObject({ choice: ["accept", "blocked"] });
    expect(harness.calls[8]?.prompt).toContain("Final route: blocked");
    expect(harness.publications).toEqual(["implementation-report.md"]);
  });
});
