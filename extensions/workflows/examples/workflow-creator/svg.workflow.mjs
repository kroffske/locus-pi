export const meta = {
  name: "workflow-creator/svg",
  description: "Create and independently accept a self-contained SVG of an accepted workflow Design.",
  profile: "standard",
  phases: [{ title: "author" }, { title: "review" }, { title: "revise" }, { title: "final-review" }],
};

const AGENTS = {
  author: {},
  reviewer: {},
  router: {},
  reviser: {},
};

export default async function runWorkflow(dsl, input) {
  const liveProjectRoot = dsl.projectRoot();

  dsl.phase("author");
  const initialSvgDocument = await dsl.agent(
    `Create the SVG diagram for an already accepted Locus Pi workflow Design.

Verified live project root: ${liveProjectRoot}
Original semantic request, preserved verbatim:
${input}

Reopen the complete accepted workflow.design.md in the injected shared workflow workspace. Treat it as the canonical graph, but reopen current project authoring contracts when needed to understand notation. Atomically replace only workflow.svg in the shared workflow workspace and return the same complete SVG text. Never edit workflow.design.md, tracked project source, or any .workflow.mjs file. Never run a workflow.

The file must be a self-contained SVG with a valid root element, explicit viewBox, embedded styles, readable title and legend, accessible title/description, and no external assets, scripts, network references, or foreignObject. Draw every Design-declared root/child entry, internal agent/review/choice node, sequential edge, revision edge, publication edge, failure exit, shared-workspace boundary, and relevant artifact handoff. Use stable labels, visible arrowheads, adequate contrast and font sizes, non-overlapping nodes and edges, and enough canvas space to avoid clipping. Preserve the Design semantics; do not redesign the workflow.`,
    { ...AGENTS.author, label: "author workflow svg" },
  );

  dsl.phase("review");
  const firstSvgCritique = await dsl.agent(
    `Independently review the target workflow SVG against the accepted Design.

Verified project root: ${liveProjectRoot}
Original semantic request, preserved verbatim:
${input}

Complete SVG returned by the author:
${initialSvgDocument}

Reopen workflow.design.md and workflow.svg from the injected shared workflow workspace. Do not trust the author summary. Check one-to-one semantic correspondence for entries, nodes, exact direction of edges, review/revision bounds, artifact handoffs, workspace boundary, publication and failure exits. Check basic SVG/XML integrity, self-containment, viewBox and canvas fit, title/description, labels, contrast, font size, arrow visibility, overlap, clipping, and reader comprehension. Use read-only inspection or rendering tools when available. Confirm no Design/source/project mutation and no workflow execution. Do not edit files.

Return one complete critique. Separate blocking defects from non-blocking suggestions and state explicitly whether any blocking defect remains.`,
    { ...AGENTS.reviewer, label: "review workflow svg 1" },
  );
  const firstSvgRoute = await dsl.agent(
    `Choose accept only when this independent SVG critique states that no blocking defect remains. Otherwise choose revise.

Exact critique:
${firstSvgCritique}`,
    { ...AGENTS.router, label: "route workflow svg 1", choice: ["accept", "revise"] },
  );
  if (firstSvgRoute === "accept") return dsl.publishPrimaryFile("workflow.svg");

  dsl.phase("revise");
  const revisedSvgDocument = await dsl.agent(
    `Write one complete corrected replacement SVG for the accepted workflow Design.

Verified project root: ${liveProjectRoot}
Original semantic request, preserved verbatim:
${input}

Current complete SVG:
${initialSvgDocument}

Exact independent critique:
${firstSvgCritique}

Reopen workflow.design.md and workflow.svg. Resolve every blocking defect while preserving correct content. Atomically replace only workflow.svg in the injected shared workflow workspace and return the same complete SVG text. Keep it self-contained and readable. Never edit the accepted Design, tracked project source, or any .workflow.mjs file, and never run a workflow.`,
    { ...AGENTS.reviser, label: "revise workflow svg" },
  );

  dsl.phase("final-review");
  const secondSvgCritique = await dsl.agent(
    `Perform a fresh final independent review of the complete replacement SVG.

Verified project root: ${liveProjectRoot}
Original semantic request, preserved verbatim:
${input}

Complete replacement SVG:
${revisedSvgDocument}

First-round critique that must be resolved:
${firstSvgCritique}

Reopen workflow.design.md and workflow.svg. Recheck every original semantic and SVG-integrity requirement plus every first-round defect. Confirm self-containment, readable layout, workspace-only writes, and no workflow execution. Do not edit files.

Return one complete final critique. Separate blocking defects from non-blocking suggestions and state explicitly whether any blocking defect remains.`,
    { ...AGENTS.reviewer, label: "review workflow svg 2" },
  );
  const secondSvgRoute = await dsl.agent(
    `Choose accept only when this final independent SVG critique states that no blocking defect remains. Otherwise choose revise.

Exact final critique:
${secondSvgCritique}`,
    { ...AGENTS.router, label: "route workflow svg 2", choice: ["accept", "revise"] },
  );
  if (secondSvgRoute === "accept") return dsl.publishPrimaryFile("workflow.svg");
  throw new Error("workflow SVG review limit reached without acceptance");
}
