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

  it("labels the six sequential review agents, their exact-text handoffs, and the single write-capable stage", () => {
    const text = diagramText("review");

    expect(text).toMatch(/Agent: R1.*scope resolver.*catalog default.*resolve review scope/su);
    expect(text).toMatch(/Agent: R2a.*change inventory.*catalog default.*inventory changes/su);
    expect(text).toMatch(/Agent: R2b.*review-unit planner.*catalog default.*plan review units/su);
    expect(text).toMatch(/Agent: R3.*interrogator.*catalog default.*ask review questions/su);
    expect(text).toMatch(/Agent: R4.*verifier and review author.*catalog default.*verify and write review/su);
    expect(text).toMatch(/Agent: R5.*publisher and presenter.*catalog default.*publish review package/su);
    expect(text).toMatch(/Workflow: forward each stage's exact text.*No JSON parse/su);
    expect(text).toMatch(/Workflow: return Agent R5 exact text.*executive summary is the result/su);

    for (const phase of [
      "phase resolve-scope",
      "phase inventory-changes",
      "phase plan-units",
      "phase ask-questions",
      "phase verify-review",
      "phase publish-review",
    ]) {
      expect(text).toContain(phase);
    }

    expect(text).toContain("resources/*.prompt.md");
    expect(text).not.toContain(".agent.md");

    expect(text).toContain("scopeText verbatim");
    expect(text).toContain("exact scopeText");
    expect(text).toContain("exact inventoryText");
    expect(text).toContain("exact unitsText");
    expect(text).toContain("exact questionsText");
    expect(text).toContain("exact reviewText");
    expect(text).toContain("exact executive summary text");

    // R1–R4 are host-enforced read-only; R2b/R3/R4 also get the allowlisted
    // argv tool, and only R5 may write.
    expect(text).toContain("Host-enforced read-only");
    expect(text).toContain("ast_index");
    expect(text).toMatch(/Write-capable: read, write, bash, grep, find/u);
    expect(text).toMatch(/Agent: R5.*only write-capable review stage/su);

    // The pipeline is strictly linear: no lanes, no barrier, no adjudicator.
    expect(text).toContain("no parallel lane and no adjudicator");
    expect(text).not.toContain("in parallel");
    expect(text).not.toContain("wait for both");

    expect(text).not.toContain("TARGET_SCHEMA");
    expect(text).not.toContain("LANE_SCHEMA");
    expect(text).not.toContain("REPORT_SCHEMA");
    expect(text).not.toContain("PUBLISH_SCHEMA");

    expect(text).toContain(".tasks/<task>/artifacts/review.md");
    expect(text).toMatch(/review\.md.*Primary reader-facing report/su);
    for (const supporting of ["review-scope.md", "review-inventory.md", "review-units.md", "review-questions.md"]) {
      expect(text).toContain(supporting);
    }
    expect(text).not.toContain("fix-plan.md");
    expect(text).not.toMatch(/disposition/iu);
    expect(text).toMatch(/Operator: edit review\.md.*Deleting a finding rejects it/su);
  });

  it("shows the review-fix gate, its five sequential agents, and the launch-checkout boundary", () => {
    const reviewFix = diagramText("review-fix");

    // One deterministic gate owns path confinement and the findings check; it
    // runs before any agent exists.
    expect(reviewFix).toMatch(/Workflow: resolve-review.*deterministic, no agent yet/su);
    expect(reviewFix).toMatch(/Extracts the one review\.md token from free text/u);
    expect(reviewFix).toMatch(/Confines it inside a project artifacts directory/u);
    expect(reviewFix).toMatch(/Rejects absolute paths and symlink escapes/u);
    expect(reviewFix).toMatch(/Workflow: require a non-empty finding list.*throw before any agent/su);

    for (const phase of [
      "phase resolve-review",
      "phase resolve-fix-scope",
      "phase plan-fix-units",
      "phase apply-fix-units",
      "phase verify-fixes",
      "phase publish-fix-report",
    ]) {
      expect(reviewFix, phase).toContain(phase);
    }

    // Five agent stages, each named with its prompt, phase, and capability policy.
    expect(reviewFix).toMatch(/Agent: F1 — fix-scope resolver.*resolve fix scope/su);
    expect(reviewFix).toMatch(/Agent: F2 — fix-unit planner.*plan fix units/su);
    expect(reviewFix).toMatch(/Agent: F3 — implementer.*apply fix units/su);
    expect(reviewFix).toMatch(/Agent: F4 — verifier and report author.*verify fixes and write report/su);
    expect(reviewFix).toMatch(/Agent: F5 — publisher and presenter.*publish fix package/su);
    expect(reviewFix).toContain("resources/*.prompt.md");
    expect(reviewFix).not.toContain(".agent.md");

    // Exact-text handoffs, never a parsed protocol.
    expect(reviewFix).toContain("exact scopeText");
    expect(reviewFix).toContain("exact unitsText");
    expect(reviewFix).toContain("exact implementationText");
    expect(reviewFix).toContain("exact reportText");
    expect(reviewFix).toContain("exact executive summary text");
    expect(reviewFix).toMatch(/Workflow: forward each stage's exact text.*No JSON parse/su);
    expect(reviewFix).toMatch(/Workflow: return Agent F5 exact text.*executive summary is the result/su);

    // No finding is edited before it is revalidated against live source.
    expect(reviewFix).toContain("Host-enforced read-only");
    expect(reviewFix).toMatch(/Agent: F2.*Revalidates every finding against live source/su);

    // Two distinct write privileges: F3 mutates source, F5 writes artifacts.
    expect(reviewFix).toContain("Write-capable: read, write, edit, bash, grep, find");
    expect(reviewFix).toContain("Write-capable: read, write, bash, grep, find");
    expect(reviewFix).toMatch(/Agent: F3.*Edits the operator's launch checkout in place/su);
    expect(reviewFix).toMatch(/Agent: F5.*only stage that writes task artifacts/su);

    // F4 is deliberately not host-enforced read-only: repository checks need a shell.
    expect(reviewFix).toContain("Shell exception: read, ast_index, bash, grep, find");
    expect(reviewFix).toMatch(/Agent: F4.*Not host-enforced read-only: checks need a shell/su);

    // The launch checkout is the whole workspace, and nothing is committed.
    expect(reviewFix).toMatch(/workspaceMode: project.*nothing is isolated/su);
    expect(reviewFix).toMatch(/Never committed, pushed, or stashed/u);
    expect(reviewFix).not.toMatch(/worktree/iu);
    expect(reviewFix).not.toContain("workspaceHandle");

    // The human gate is review.md itself; no plan, disposition, or hash survives.
    expect(reviewFix).toMatch(/Artifact: human-edited review\.md.*A deleted finding is a rejected finding/su);
    expect(reviewFix).toContain(".tasks/<task>/artifacts/fix-report.md");
    expect(reviewFix).toMatch(/fix-report\.md.*Primary reader-facing report/su);
    expect(reviewFix).toContain("fix-scope.md and fix-units.md");
    expect(reviewFix).not.toContain("_SCHEMA");
    expect(reviewFix).not.toContain("fix-plan.md");
    expect(reviewFix).not.toMatch(/disposition/iu);
    expect(reviewFix).not.toMatch(/SHA-?256/iu);
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
