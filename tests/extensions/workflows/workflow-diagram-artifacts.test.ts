import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURATED_PACKAGE_WORKFLOW_NAMES, packagedWorkflowPath } from "../../../extensions/_shared/workflow-runner.js";

interface ExcalidrawElement {
  type?: string;
  text?: string;
}

interface ExcalidrawDocument {
  type?: string;
  elements?: ExcalidrawElement[];
  files?: Record<string, unknown>;
}

function diagramText(name: string): string {
  const workflowPath = packagedWorkflowPath(name);
  const document = JSON.parse(
    readFileSync(path.join(path.dirname(workflowPath), `${name}-pipeline.excalidraw`), "utf8"),
  ) as ExcalidrawDocument;
  return (document.elements ?? [])
    .filter((element) => element.type === "text" && typeof element.text === "string")
    .map((element) => element.text)
    .join("\n");
}

describe("curated workflow diagram contract", () => {
  it("keeps an editable generator, Excalidraw source, and PNG preview beside every curated workflow", () => {
    for (const name of CURATED_PACKAGE_WORKFLOW_NAMES) {
      const workflowPath = packagedWorkflowPath(name);
      const directory = path.dirname(workflowPath);
      const generatorPath = path.join(directory, `${name}-pipeline.diagram.mjs`);
      const excalidrawPath = path.join(directory, `${name}-pipeline.excalidraw`);
      const pngPath = path.join(directory, `${name}-pipeline.png`);

      const generator = readFileSync(generatorPath, "utf8");
      expect(generator, generatorPath).toContain("@kroffske/excalidraw-diagrams");
      expect(generator, generatorPath).toContain("assertDiagramHealthy");

      const document = JSON.parse(readFileSync(excalidrawPath, "utf8")) as ExcalidrawDocument;
      expect(document.type, excalidrawPath).toBe("excalidraw");
      expect(document.elements?.length ?? 0, excalidrawPath).toBeGreaterThan(0);
      expect(Object.keys(document.files ?? {}).length, excalidrawPath).toBeGreaterThan(0);

      const png = readFileSync(pngPath);
      expect([...png.subarray(0, 8)], pngPath).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(png.readUInt32BE(16), pngPath).toBeGreaterThan(800);
      expect(png.readUInt32BE(20), pngPath).toBeGreaterThan(400);
    }
  });

  it("makes ownership, source, persistence, and the visual legend readable without opening workflow code", () => {
    for (const name of CURATED_PACKAGE_WORKFLOW_NAMES) {
      const text = diagramText(name);
      for (const prefix of ["Operator:", "Workflow:", "Agent:", "Direct LLM:", "Artifact:"]) {
        expect(text, name).toContain(prefix);
      }
      expect(text, name).toMatch(/Legend/u);
      expect(text, name).toContain(`${name}.workflow.mjs`);
      expect(text, name).toContain("result.json");
      expect(text, name).toContain("journal.ndjson");
    }
  });

  it("labels review agents, exact-text handoffs, and parallel control with their real owners", () => {
    const text = diagramText("review");

    expect(text).toMatch(/Agent: R1.*review-01-target-resolver.*resolve review target/su);
    expect(text).toMatch(/Workflow: forward Agent R1 exact text.*No JSON parse/su);
    expect(text).toMatch(/Workflow:.*launch Agents R2\+R3 in parallel/su);
    expect(text).toMatch(/Workflow:.*wait for both lane results/su);
    expect(text).toMatch(/Agent: R2.*review-02-change-review.*review introduced changes/su);
    expect(text).toMatch(/Agent: R3.*review-03-context-review.*review whole-file context/su);
    expect(text).toMatch(/Agent: R4.*review-04-adjudicator.*adjudicate review findings.*Markdown verdict/su);
    expect(text).toMatch(/Agent: R5.*review-05-publisher.*publish review report.*review\.md/su);
    expect(text).toContain("targetText verbatim");
    expect(text).toContain("exact changesText");
    expect(text).toContain("exact contextText");
    expect(text).toContain("exact adjudicatedText");
    expect(text).toContain("exact publisher text");
    expect(text).not.toContain("TARGET_SCHEMA");
    expect(text).not.toContain("LANE_SCHEMA");
    expect(text).not.toContain("REPORT_SCHEMA");
    expect(text).not.toContain("PUBLISH_SCHEMA");
    expect(text).toContain(".tasks/<task>/artifacts/review.md");
    expect(text).toContain(".tasks/<task>/artifacts/fix-plan.md");
    expect(text).toMatch(/review\.md.*Primary reader-facing report/su);
    expect(text).toMatch(/Operator: edit fix-plan dispositions.*accepted.*waived.*deferred.*pending/su);
  });

  it("shows the isolated fix boundary in the review family", () => {
    const reviewFix = diagramText("review-fix");
    expect(reviewFix).toMatch(/Workflow: deterministic approval validator.*at least one accepted finding/su);
    expect(reviewFix).toMatch(/Agent: F1.*review-fix-01-implementer.*apply accepted review fixes/su);
    expect(reviewFix).toMatch(/Agent: F2.*review-fix-02-verifier.*verify review fixes and publish report/su);
    expect(reviewFix).toContain("workspaceHandle");
    expect(reviewFix).toContain("exact implementationText");
    expect(reviewFix).toContain("exact verificationText");
    expect(reviewFix).not.toContain("APPROVED_PLAN_SCHEMA");
    expect(reviewFix).not.toContain("IMPLEMENTATION_SCHEMA");
    expect(reviewFix).not.toContain("FIX_REPORT_SCHEMA");
    expect(reviewFix).toMatch(/Only accepted ids cross to Agent F1/su);
    expect(reviewFix).toMatch(/Artifact: retained linked Git worktree.*Original checkout remains untouched/su);
    expect(reviewFix).toContain(".tasks/<task>/artifacts/fix-report.md");
  });

  it("does not disguise direct model calls or workflow-owned repository search as agents", () => {
    const llmSmoke = diagramText("llm-smoke");
    expect(llmSmoke).toMatch(/direct.*LLM|LLM.*direct/isu);
    expect(llmSmoke).toMatch(/no child agent/iu);

    const requirementsGrill = diagramText("requirements-grill");
    expect(requirementsGrill).toMatch(/Workflow.*rg|rg.*Workflow/su);
    expect(requirementsGrill).toMatch(/Agent.*recon/isu);
    expect(requirementsGrill).toMatch(/Agent.*challenge/isu);
    expect(requirementsGrill).toMatch(/Agent.*synth/isu);
  });
});
