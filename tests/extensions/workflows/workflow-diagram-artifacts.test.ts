import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packagedExamplesDir, packagedWorkflowPath } from "../../../extensions/_shared/workflow-runner.js";

/**
 * Diagrams used to be a generated triple — an `@kroffske/excalidraw-diagrams`
 * generator, its `.excalidraw` document, and an exported `.png`. Three files had
 * to agree, only the render was read, and the render said little the workflow
 * source did not already say. The replacement is one hand-authored SVG per
 * example, so what a reader sees is what a reviewer diffs.
 */
const RETIRED_DIAGRAM_SUFFIXES = [".diagram.mjs", ".excalidraw", ".png"];

function listFilesRecursively(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  visit(root);
  return found;
}

/** Every `phase("…")` and `artifact: "…"` literal the workflow source declares. */
function declaredNames(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]!))];
}

describe("curated workflow diagrams", () => {
  it("keeps no generated Excalidraw triple anywhere under the examples directory", () => {
    const stale = listFilesRecursively(packagedExamplesDir()).filter((file) =>
      RETIRED_DIAGRAM_SUFFIXES.some((suffix) => file.endsWith(suffix)),
    );
    expect(stale).toEqual([]);
  });

  it("ships one self-contained SVG beside plan, with nothing to fetch and nothing to run", () => {
    const svgPath = path.join(path.dirname(packagedWorkflowPath("plan")), "plan-pipeline.svg");
    const svg = readFileSync(svgPath, "utf8");

    expect(svg.trimStart().startsWith("<svg"), svgPath).toBe(true);
    expect(svg, svgPath).toContain("viewBox=");
    // A diagram a screen reader cannot describe is a picture, not documentation.
    expect(svg, svgPath).toMatch(/<title>/u);
    expect(svg, svgPath).toMatch(/<desc>/u);

    // Self-contained: an SVG that pulls a font, an image, or a script is not a
    // file a reviewer can read, and in a published package it is a request the
    // reader never asked to make.
    expect(svg, svgPath).not.toMatch(/<script/iu);
    expect(svg, svgPath).not.toMatch(/<image/iu);
    expect(svg, svgPath).not.toMatch(/\shref=|xlink:href=/u);
    // `url(#marker)` points inside this file; anything else points outside it.
    expect(svg, svgPath).not.toMatch(/@import|url\(\s*['"]?(?!#)/u);
    // Namespace declarations are the one allowed absolute URL: they name the
    // dialect, they are never fetched.
    expect(svg.replace(/xmlns(:[a-z]+)?="[^"]*"/gu, ""), svgPath).not.toMatch(/https?:\/\//u);

    // T-108 removed `llm()` from the DSL; a diagram may not advertise a
    // primitive the reader cannot find.
    expect(svg, svgPath).not.toMatch(/llm\(/iu);
  });

  it("names every phase and every persisted artifact the plan workflow actually declares", () => {
    const workflowPath = packagedWorkflowPath("plan");
    const source = readFileSync(workflowPath, "utf8");
    const svg = readFileSync(path.join(path.dirname(workflowPath), "plan-pipeline.svg"), "utf8");

    const phases = declaredNames(source, /\bphase\("([^"]+)"\)/gu);
    const artifacts = declaredNames(source, /\bartifact:\s*"([^"]+)"/gu).concat(
      declaredNames(source, /\bpublishArtifact\("([^"]+)"/gu),
    );

    // The point of pinning both lists: a stage renamed or an artifact added in
    // the workflow leaves the picture quietly wrong, and a wrong picture is
    // read as truth longer than missing prose would be.
    expect(phases.length, "plan should declare phases").toBeGreaterThan(0);
    for (const phase of phases) expect(svg, `diagram omits phase ${phase}`).toContain(phase);
    for (const artifact of new Set(artifacts)) {
      expect(svg, `diagram omits artifact ${artifact}`).toContain(artifact);
    }

    // The agents are the point of this diagram, so each one is named on it, and
    // the two outcomes a reader needs before running anything are both there.
    for (const agent of declaredNames(source, /\bid:\s*"([^"]+)"/gu)) {
      expect(svg, `diagram omits agent ${agent}`).toContain(agent);
    }
    expect(svg).toMatch(/round cap|4th revise/u);
    expect(svg).toMatch(/plan-implement/u);
  });
});
