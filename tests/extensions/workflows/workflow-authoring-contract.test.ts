import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

describe("approval-first readable workflow authoring", () => {
  const approvalSurfaces = [
    "skills/locus-pi-workflows/SKILL.md",
    ".agents/agents/workflow-author.md",
    "extensions/workflows/AUTHORING.md",
    "docs/extensions/active/workflows.md",
    "extensions/workflows/workflow-tool.ts",
  ];

  it.each(approvalSurfaces)("keeps Design -> explicit approval -> Build on %s", (relativePath) => {
    const text = source(relativePath);
    expect(text).toContain(".design.md");
    expect(text).toContain("Build approved design:");
  });

  it("makes a raw request design-only and keeps Build from running", () => {
    const author = source(".agents/agents/workflow-author.md");
    expect(author).toContain("tools: read, search, find, write, edit, bash");
    expect(author).toContain("Any plain request to create, write, or author a workflow is Design");
    expect(author).toContain("Design writes only `.pi/workflows/<name>.design.md`");
    expect(author).toContain("You never run a workflow");
    expect(author).toContain("material\nchange");

    const designRoute = author.split("### Design\n")[1]?.split("### Revise\n")[0] ?? "";
    const buildRoute = author.split("### Build\n")[1]?.split("## Design method\n")[0] ?? "";
    expect(designRoute).toContain("writes only `.pi/workflows/<name>.design.md`");
    expect(designRoute).toContain("must not create or edit a\n`.workflow.mjs`");
    expect(designRoute).not.toContain("Build creates one matching");
    expect(buildRoute).toContain("Build creates one matching `.pi/workflows/<name>.workflow.mjs`");
    expect(buildRoute).toContain("and stops");
  });

  it("teaches exact text, choice, and handoffs as the standard answer forms", () => {
    for (const relativePath of [
      "skills/locus-pi-workflows/SKILL.md",
      ".agents/agents/workflow-author.md",
      "extensions/workflows/AUTHORING.md",
    ]) {
      const text = source(relativePath);
      expect(text).toContain("exact text");
      expect(text).toContain("choice:");
      expect(text).toContain("handoffs:");
      expect(text).toMatch(/raw `schema`|Raw `schema`/u);
      expect(text).toMatch(/advanced compatibility/u);
    }
  });

  it("keeps the source graph visible and rejects hidden orchestration machinery", () => {
    const author = source(".agents/agents/workflow-author.md");
    expect(author).toContain("Keep direct `agent()` calls, prompts, exact text handoffs, branches, and edges");
    for (const smell of [
      "input splitting",
      "JSON/prose parsers",
      "domain validators",
      "render helpers",
      "manual\nretries",
      "branch-local `try/catch`",
      "wrappers around\n`agent()`",
    ]) {
      expect(author).toContain(smell);
    }
  });

  it("keeps semantic input out of hidden branch protocols", () => {
    const skill = source("skills/locus-pi-workflows/SKILL.md");
    const card = source("skills/locus-pi-workflows/references/fixed-fan-out.md");
    expect(skill).toContain("does not encode a hidden");
    expect(skill).toContain("`split`, regex-match, or parse");
    expect(card).toContain("author-known");
    expect(card).toContain("Do not encode them as newline/CSV/JSON");
  });

  it("ships compact progressive-disclosure cards with the required decision facts", () => {
    const referencesDir = path.join(root, "skills/locus-pi-workflows/references");
    const cards = readdirSync(referencesDir)
      .filter((name) => name.endsWith(".md") && name !== "INDEX.md")
      .sort();
    expect(cards).toEqual([
      "bounded-candidate-search.md",
      "bounded-review-loop.md",
      "dynamic-orchestrator-workers.md",
      "fixed-fan-out.md",
      "human-gate.md",
      "sequential-text.md",
    ]);
    for (const name of cards) {
      const text = source(`skills/locus-pi-workflows/references/${name}`);
      expect(text).toMatch(/Use |Use this card/u);
      expect(text).toMatch(/Avoid |Allowed redesigns/u);
      expect(text).toContain("Graph");
      expect(text).toContain("Cost");
      expect(text).toContain("Handoff");
      expect(text).toContain("Failure");
      expect(text).toMatch(/Primitive|Required primitives/u);
    }
  });

  it("teaches bounded dynamic handoffs without manufacturing a recursive manager", () => {
    const card = source("skills/locus-pi-workflows/references/dynamic-orchestrator-workers.md");
    expect(card).toContain("agent({ handoffs })");
    expect(card).toContain("complete non-blank unique text unit");
    expect(card).toContain("child `spawn_agent`/`task`, which remains unavailable");
  });

  it("reviews every paid bounded-loop revision and reports truthful call cost", () => {
    const card = source("skills/locus-pi-workflows/references/bounded-review-loop.md");
    expect(card).toContain("maximum\nis `1 + 2R + (R - 1) = 3R` calls");
    expect(card).toContain("every paid revision is reviewed");
    expect(card.indexOf("if (round === MAX_REVIEWS) break;")).toBeLessThan(
      card.indexOf("document = await agent(`Return a complete revision"),
    );
  });
});
