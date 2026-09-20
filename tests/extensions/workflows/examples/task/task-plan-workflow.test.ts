import { describe, expect, it, vi } from "vitest";
import runPlanWorkflow from "../../../../../extensions/workflows/examples/task/plan.workflow.mjs";

function fixture(decision = "publish", recheck = "publish") {
  const calls: Array<{ prompt: string; options: { label: string } }> = [];
  const phases: string[] = [];
  const answers: Record<string, string> = {
    "workflow-design": "Complete design.",
    "workflow-design-review": "Corrected complete design.",
    "workflow-source-build": "candidate source",
    "workflow-source-verify": "All checks passed. This is prose, not JavaScript.",
    "workflow-source-decision": decision,
    "workflow-source-correct": "Correction diagnostics.",
    "workflow-source-recheck": recheck,
  };
  const publish = vi.fn((name, source) => ({ name, source }));
  const dsl = {
    agent: async (prompt: string, options: { label: string }) => {
      calls.push({ prompt, options });
      return answers[options.label] ?? "";
    },
    phase: (name: string) => phases.push(name),
    publishPrimaryArtifact: publish,
  };
  return {
    calls,
    phases,
    publish,
    run: () => runPlanWorkflow(dsl as unknown as Parameters<typeof runPlanWorkflow>[0], "Accepted brief."),
  };
}

describe("Package workflow: task/plan", () => {
  it("publishes the checked workspace source, never verifier prose", async () => {
    const fixtureRun = fixture();
    expect(await fixtureRun.run()).toEqual({ name: "workflow.mjs", source: { workflowSource: "workflow.mjs" } });
    expect(fixtureRun.phases).toEqual(["design", "review", "build", "verify", "publish"]);
    expect(fixtureRun.calls.map((call) => call.options.label)).toEqual([
      "workflow-design",
      "workflow-design-review",
      "workflow-source-build",
      "workflow-source-verify",
      "workflow-source-decision",
    ]);
    for (const call of fixtureRun.calls.slice(0, 3)) {
      expect(call.prompt).toContain("Do not write or edit files in this stage");
      expect(call.prompt).toMatch(/saved\s+workflow copy/);
    }
    for (const call of fixtureRun.calls) {
      expect(call.prompt).toContain('A refusal returns { ok: false, status: "failed" }');
      expect(call.prompt).toContain("review findings as text or an explicit evidence-file path, never only a choice");
      expect(call.prompt).toContain("never publish an acceptance verdict as JSON or source");
      expect(call.prompt).toContain("one-worker task without inventing QA nodes or another owner approval");
      expect(call.prompt).toContain("The host rejects empty answers and throws on execution/publication errors");
      expect(call.prompt).toContain("do not invent an extra report.md or publication");
      expect(call.prompt).toContain("A skipped correction must really be skipped");
    }
    expect(fixtureRun.calls[3]?.prompt).toContain("node --check workflow.mjs");
    expect(fixtureRun.calls[3]?.prompt).toContain('mode: "orchestration-only"');
    expect(fixtureRun.calls[4]?.prompt).toContain("All checks passed. This is prose, not JavaScript.");
    for (const call of fixtureRun.calls.slice(0, 4))
      expect(call.prompt).toContain("Every agent call\ndeclares a literal label, and no two agent calls share one");
  });

  it.each(["publish", "failed"])("routes one correction and independent recheck to %s", async (recheck) => {
    const fixtureRun = fixture("correct", recheck);
    const result = await fixtureRun.run();
    expect(fixtureRun.calls.map((call) => call.options.label).slice(-2)).toEqual([
      "workflow-source-correct",
      "workflow-source-recheck",
    ]);
    expect(fixtureRun.publish).toHaveBeenCalledTimes(recheck === "publish" ? 1 : 0);
    if (recheck === "failed")
      expect(result).toMatchObject({
        ok: false,
        status: "failed",
        stage: "verify",
        reason: expect.stringContaining("workflow-source-recheck.md"),
      });
  });

  it("stops without publication or correction on an unavailable prerequisite", async () => {
    const fixtureRun = fixture("failed");
    expect(await fixtureRun.run()).toMatchObject({
      ok: false,
      status: "failed",
      stage: "verify",
      reason: expect.stringContaining("workflow-source-decision.md"),
    });
    expect(fixtureRun.publish).not.toHaveBeenCalled();
    expect(fixtureRun.calls).toHaveLength(5);
  });
});
