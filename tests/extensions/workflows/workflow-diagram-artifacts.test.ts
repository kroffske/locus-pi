import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packagedExamplesDir, packagedWorkflowPath } from "../../../extensions/workflows/runtime/workflow-runner.js";

/**
 * Diagrams used to be a generated triple — an `@kroffske/excalidraw-diagrams`
 * generator, its `.excalidraw` document, and an exported `.png`. Three files had
 * to agree, only the render was read, and the render said little the workflow
 * source did not already say. The replacement is one hand-authored SVG per
 * example, so what a reader sees is what a reviewer diffs.
 */
const RETIRED_DIAGRAM_SUFFIXES = [".diagram.mjs", ".excalidraw", ".png"];

/** Every example that has been redrawn in the hand-authored shape so far. */
const DRAWN = ["plan", "requirements-grill"] as const;

function diagramPath(name: string): string {
  const workflowPath = packagedWorkflowPath(name);
  return path.join(path.dirname(workflowPath), `${name}-pipeline.svg`);
}

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

  it.each(DRAWN)("ships one self-contained SVG beside %s, with nothing to fetch and nothing to run", (name) => {
    const svgPath = diagramPath(name);
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

  it.each(DRAWN)("names every phase, artifact and agent the %s workflow actually declares", (name) => {
    const source = readFileSync(packagedWorkflowPath(name), "utf8");
    const svg = readFileSync(diagramPath(name), "utf8");

    const phases = declaredNames(source, /\bphase\("([^"]+)"\)/gu);
    const artifacts = declaredNames(source, /\bartifact:\s*"([^"]+)"/gu).concat(
      declaredNames(source, /\bpublishArtifact\("([^"]+)"/gu),
    );

    // The point of pinning both lists: a stage renamed or an artifact added in
    // the workflow leaves the picture quietly wrong, and a wrong picture is
    // read as truth longer than missing prose would be.
    expect(phases.length, `${name} should declare phases`).toBeGreaterThan(0);
    for (const phase of phases) expect(svg, `${name} diagram omits phase ${phase}`).toContain(phase);
    for (const artifact of new Set(artifacts)) {
      expect(svg, `${name} diagram omits artifact ${artifact}`).toContain(artifact);
    }

    // The agents are the point of these diagrams, so each one is named on it.
    const agents = declaredNames(source, /\bid:\s*"([^"]+)"/gu);
    expect(agents.length, `${name} should declare an agent roster`).toBeGreaterThan(0);
    for (const agent of agents) expect(svg, `${name} diagram omits agent ${agent}`).toContain(agent);
  });

  it("shows both ways a plan run can end", () => {
    const svg = readFileSync(diagramPath("plan"), "utf8");

    expect(svg).toMatch(/round cap|4th revise/u);
    expect(svg).toMatch(/plan-implement/u);
  });

  it("shows that requirements-grill refuses an empty request before it spends an agent", () => {
    const svg = readFileSync(diagramPath("requirements-grill"), "utf8");

    expect(svg).toMatch(/Empty request/u);
    expect(svg).toMatch(/before the first agent is spawned|before any agent runs/u);
  });
});
