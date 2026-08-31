import { describe, expect, it } from "vitest";
import runPlanWorkflow from "../../../../../extensions/workflows/examples/task/plan.workflow.mjs";

describe("Package workflow: task/plan", () => {
  it("turns the accepted draft directly into checked workflow.mjs source", async () => {
    const draft = "Task:\nBuild a reviewed workflow.\n\nWorkflow direction:\n- Pattern: bounded review loop";
    const calls: Array<{ prompt: string; options: { label: string } }> = [];
    const phases: string[] = [];
    const source =
      'export const meta = { name: "reviewed-workflow", profile: "standard" };\nexport default function run({ agent }) { return agent("Do the work"); }\n';
    const answers: Record<string, string> = {
      "workflow-design": "Complete design.",
      "workflow-design-review": "Corrected complete design.",
      "workflow-source-build": source,
      "workflow-source-verify": source,
    };
    const dsl = {
      agent: async (prompt: string, options: { label: string }) => {
        calls.push({ prompt, options });
        return answers[options.label] ?? "";
      },
      phase: (name: string) => phases.push(name),
      publishPrimaryArtifact: (name: string, text: string) => ({ name, text }),
    };

    const result = await runPlanWorkflow(dsl as unknown as Parameters<typeof runPlanWorkflow>[0], draft);

    expect(phases).toEqual(["design", "review", "build", "verify", "publish"]);
    expect(calls.map((call) => call.options.label)).toEqual([
      "workflow-design",
      "workflow-design-review",
      "workflow-source-build",
      "workflow-source-verify",
    ]);
    expect(calls[0]?.prompt).toContain(draft);
    expect(calls[1]?.prompt).toContain("unbounded reflection");
    expect(calls[2]?.prompt).toContain("JavaScript bytes only");
    expect(calls[3]?.prompt).toContain("node --check workflow.mjs");
    expect(calls[3]?.prompt).toContain('mode: "orchestration-only"');
    expect(result).toEqual({ name: "workflow.mjs", text: source });
  });
});
