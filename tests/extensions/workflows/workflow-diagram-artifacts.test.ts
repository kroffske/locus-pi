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

      // T-108 removed `llm()` from the DSL. A legend row naming it — or worse,
      // asserting it exists in order to say it is unused ("dsl.llm() is not
      // used") — describes a primitive the reader cannot find. The generator is
      // the source of truth for what the render will say, so the concept must
      // be absent here, not merely tolerated downstream.
      expect(generator, generatorPath).not.toMatch(/llm/iu);

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
      // T-108 deleted `llm()` from the DSL, so neither the source generator nor
      // the checked-in reader-facing render may advertise that primitive.
      expect(text, name).not.toMatch(/llm/iu);
      for (const prefix of ["Operator:", "Workflow:", "Agent:", "Artifact:"]) {
        expect(text, name).toContain(prefix);
      }
      expect(text, name).toMatch(/Legend/u);
      expect(text, name).toContain(`${name}.workflow.mjs`);
      expect(text, name).toContain("result.json");
      expect(text, name).toContain("journal.ndjson");
    }
  });

  it("labels split-run clarification, five read-only review agents, and runtime-owned artifacts", () => {
    const text = diagramText("review");

    expect(text).toMatch(/Agent: shaped clarification decider.*CLARIFIER_SCHEMA \{decision, questions\[\]\}/su);
    expect(text).toMatch(/Workflow: check clarifier output\.decision.*needs_operator publishes questions and stops/su);
    expect(text).toContain("input:string + optional continuation");
    expect(text).toContain("continued intent + questions + answers");
    expect(text).toMatch(/Agent: R1.*scope resolver.*catalog default.*resolve review scope/su);
    expect(text).toMatch(/Agent: R2a.*change inventory.*catalog default.*inventory changes/su);
    expect(text).toMatch(/Agent: R2b.*review-unit planner.*catalog default.*plan review units/su);
    expect(text).toMatch(/Agent: R3.*interrogator.*catalog default.*ask review questions/su);
    expect(text).toMatch(/Agent: R4.*verifier and review author.*catalog default.*verify and write review/su);
    expect(text).toMatch(/Workflow: return Agent R4 exact text.*review\.md contains the same exact bytes/su);

    for (const phase of [
      "prepare-clarification",
      "consume-clarification",
      "phase resolve-scope",
      "phase inventory-changes",
      "phase plan-units",
      "phase ask-questions",
      "phase verify-review",
    ]) {
      expect(text).toContain(phase);
    }

    // review keeps exactly the two role charters above the inline-prompt bar and
    // writes its four short stage tasks inline.
    expect(text).toContain("resources/*.prompt.md");
    expect(text).toContain("interrogator.prompt.md");
    expect(text).toContain("verifier.prompt.md");
    expect(text).toContain("Inline COMMON contract + 4 stage tasks");
    expect(text).not.toContain("scope-resolver.prompt.md");
    expect(text).not.toContain("change-inventory.prompt.md");
    expect(text).not.toContain("unit-planner.prompt.md");
    expect(text).not.toContain(".agent.md");

    expect(text).toContain("exact scopeText");
    expect(text).toContain("exact inventoryText");
    expect(text).toContain("exact unitsText");
    expect(text).toContain("exact questionsText");
    expect(text).toContain("exact reviewText");

    // Every review child is host-enforced read-only; the runtime, not a model
    // publisher, owns the named Markdown artifacts.
    expect(text).toContain("Host-enforced read-only");
    expect(text).toContain("ast_index");
    expect(text).toContain("runtime indexes every named answer");
    expect(text).toContain("runtime persists exact review.md");

    expect(text).not.toContain("TARGET_SCHEMA");
    expect(text).not.toContain("LANE_SCHEMA");
    expect(text).not.toContain("REPORT_SCHEMA");
    expect(text).not.toContain("PUBLISH_SCHEMA");

    expect(text).toContain("<runId>/artifacts/.../review.md");
    expect(text).toMatch(/review\.md.*Primary reader-facing runtime artifact/su);
    for (const supporting of ["scope.md", "inventory.md", "units.md", "questions.md"]) {
      expect(text).toContain(supporting);
    }
    expect(text).not.toContain("fix-plan.md");
    expect(text).not.toMatch(/disposition/iu);
    expect(text).toMatch(/Operator: inspect review\.md.*complete reference to remediation/su);
  });

  it("shows immutable review input, one writer per finding, checks, re-review, and launch-checkout mutation", () => {
    const reviewFix = diagramText("review-fix");

    expect(reviewFix).toMatch(
      /Workflow: consume immutable review.*verify full ref \+ digest \+ terminal result projection/su,
    );
    expect(reviewFix).toMatch(/Workflow: parse complete finding blocks.*malformed review fails before selector/su);
    expect(reviewFix).toContain("Full {runId, artifactId, name, sha256}");
    expect(reviewFix).toMatch(/Agent: finding graph selector.*Chooses 1–20 ids, notes, and dependsOn edges/su);
    expect(reviewFix).toMatch(
      /Workflow: validate and order finding DAG.*Reject unknown\/duplicate\/self edges.*Stable Kahn order/su,
    );

    for (const phase of [
      "phase resolve-fix-scope",
      "phase apply-kept-findings",
      "phase collect-check-evidence",
      "phase re-review-fixes",
    ]) {
      expect(reviewFix, phase).toContain(phase);
    }

    expect(reviewFix).toMatch(/Agent: scope resolver.*artifact: scope\.md.*Host-enforced read-only/su);
    expect(reviewFix).toMatch(
      /Agent: one writer for current F<n>.*Receives one full block \+ note \+ direct dependencies/su,
    );
    expect(reviewFix).toMatch(
      /Failure skips transitive dependents; independent writers continue.*Any failure skips checks and fresh re-review/su,
    );
    expect(reviewFix).not.toContain("Failure stops later writers and all downstream stages");
    expect(reviewFix).toMatch(
      /Workflow: launch independent checker.*baseline-frozen repository_check.*Agent: check-evidence collector.*Reads full diff; checks in disposable worktrees/su,
    );
    expect(reviewFix).toContain("source-state-*.json fingerprints");
    expect(reviewFix).toContain("Package review · verify-review answer only");
    expect(reviewFix).toMatch(
      /Agent: fresh read-only re-reviewer.*Rechecks every original finding and dependency surface/su,
    );
    // review-fix carries every stage prompt inline since 2026-07-25, so the
    // render must not advertise prompt resources it no longer ships.
    expect(reviewFix).not.toContain("resources/*.prompt.md");
    expect(reviewFix).toContain("no prompt resources");
    expect(reviewFix).toContain("COMMON");
    expect(reviewFix).not.toContain(".agent.md");

    expect(reviewFix).toContain("exact scopeText");
    expect(reviewFix).toContain("one block + direct dependency results");
    expect(reviewFix).toContain("all exact worker results");
    expect(reviewFix).toContain("exact check evidence");
    expect(reviewFix).toContain("exact re-review text");
    expect(reviewFix).toMatch(
      /Workflow: validate and order finding DAG.*No writer starts until the whole graph is valid/su,
    );
    expect(reviewFix).toMatch(/Workflow: return exact re-review text.*Runtime already stored it as re-review\.md/su);
    expect(reviewFix).toContain("runtime indexes all named answers");

    // Writers mutate the launch checkout; checks execute separately in disposable worktrees.
    expect(reviewFix).toMatch(/workspaceMode: project.*Each writer sees the whole launch workspace/su);
    expect(reviewFix).toContain("checks in disposable worktrees");
    expect(reviewFix).toMatch(/Never committed, pushed, or stashed/u);
    expect(reviewFix).not.toContain("workspaceHandle");

    expect(reviewFix).toMatch(/Artifact: immutable review\.md reference.*Host-consumed before workflow module/su);
    expect(reviewFix).toMatch(/Artifact: re-review\.md.*Primary reader-facing remediation verdict/su);
    expect(reviewFix).toContain("scope.md + worker-F<n>.md");
    expect(reviewFix).toContain("check-evidence.md + re-review.md");
    expect(reviewFix).toContain("FINDING_SELECTOR_SCHEMA");
    expect(reviewFix).not.toContain("fix-plan.md");
    expect(reviewFix).not.toMatch(/disposition/iu);
  });

  it("does not disguise workflow-owned repository search as agents", () => {
    const requirementsGrill = diagramText("requirements-grill");
    expect(requirementsGrill).toMatch(/Workflow.*rg|rg.*Workflow/su);
    expect(requirementsGrill).toMatch(/Agent.*recon/isu);
    expect(requirementsGrill).toMatch(/Agent.*challenge/isu);
    expect(requirementsGrill).toMatch(/Agent.*synth/isu);
  });
});
