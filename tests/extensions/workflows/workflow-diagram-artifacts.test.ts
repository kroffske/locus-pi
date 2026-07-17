import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURATED_PACKAGE_WORKFLOW_NAMES } from "../../../extensions/_shared/workflow-runner.js";

interface ExcalidrawElement {
  type?: string;
  text?: string;
}

interface ExcalidrawDocument {
  type?: string;
  elements?: ExcalidrawElement[];
  files?: Record<string, unknown>;
}

const root = process.cwd();
const examples = path.join(root, "extensions", "workflows", "examples");

function diagramText(name: string): string {
  const document = JSON.parse(
    readFileSync(path.join(examples, `${name}-pipeline.excalidraw`), "utf8"),
  ) as ExcalidrawDocument;
  return (document.elements ?? [])
    .filter((element) => element.type === "text" && typeof element.text === "string")
    .map((element) => element.text)
    .join("\n");
}

describe("curated workflow diagram contract", () => {
  it("keeps an editable generator, Excalidraw source, and PNG preview beside every curated workflow", () => {
    for (const name of CURATED_PACKAGE_WORKFLOW_NAMES) {
      const generatorPath = path.join(examples, `${name}-pipeline.diagram.mjs`);
      const excalidrawPath = path.join(examples, `${name}-pipeline.excalidraw`);
      const pngPath = path.join(examples, `${name}-pipeline.png`);

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

  it("labels review decisions and parallel control with their real owners", () => {
    const text = diagramText("review");

    expect(text).toMatch(/Agent: 1.*resolve target/su);
    expect(text).toMatch(/Workflow:.*Agent 1.*output\.status.*TARGET_SCHEMA/su);
    expect(text).toMatch(/Workflow:.*launch Agents 2\+3 in parallel/su);
    expect(text).toMatch(/Workflow:.*wait for both lane results/su);
    expect(text).toMatch(/Agent: 4.*adjudicate.*Decides verdict/su);
    expect(text).toContain("TARGET_SCHEMA");
    expect(text).toContain("LANE_SCHEMA");
    expect(text).toContain("REPORT_SCHEMA");
    expect(text).toMatch(/reportMarkdown.*result\.json/su);
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
