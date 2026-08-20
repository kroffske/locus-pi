export const meta = {
  name: "workflow-creator/design",
  description: "Author and independently accept the canonical Design for a requested Locus Pi workflow.",
  profile: "standard",
  phases: [{ title: "author" }, { title: "review" }, { title: "revise" }, { title: "final-review" }],
};

const AGENTS = {
  author: { agent: "default" },
  reviewer: { agent: "reviewer" },
  router: { agent: "default" },
  reviser: { agent: "default" },
};

export default async function runWorkflow(dsl, input) {
  const liveProjectRoot = dsl.projectRoot();

  dsl.phase("author");
  const initialDesignDocument = await dsl.agent(
    `Work in this verified live project root: ${liveProjectRoot}

Original semantic workflow request, preserved verbatim:
${input}

Design the requested Locus Pi workflow from current repository truth. Read the complete live workflow-authoring skill, pattern index and selected cards, extensions/workflows/AUTHORING.md, relevant workflow sources, and repository instructions before writing. Resolve a stable canonical target workflow name semantically; JavaScript will not parse it.

Atomically replace only workflow.design.md in the injected shared workflow workspace and return the same complete Markdown text. Never create, edit, or run any .workflow.mjs file in this stage. Never mutate tracked project source.

The target Design must be independently buildable by another agent. Include the original request, purpose, input, primary artifact, namespace and exact Entries table; exact generated paths below generated/<target>/; numbered algorithm and explicit graph; distinct agent roles, prompts/handoffs/consumers; choices, concurrency, loop bounds, durable keys, workspace and idempotence; live project revision and dirty-state evidence; drift policy; exact minimum and maximum physical-call formulas; failure exits; mechanisms; standard-profile and no-execution constraints. Select documented patterns from the actual requirement. Generated source paths must use the canonical folder namespace: generated/<target>/<target>.workflow.mjs for a runnable root when declared, plus direct generated/<target>/<child>.workflow.mjs entries. Do not declare prompt resources or other generated files unless the request truly requires them. State that Build must write exactly the declared source set, check every exact source with the Pi-native workflow_check_source tool, assess identity, import every module, compare source with Design and SVG, and never execute the target workflow.

If the request cannot be designed safely, do not invent a package. Write a complete blocking Design explaining the missing decision so independent review will reject it.`,
    { ...AGENTS.author, label: "author workflow design" },
  );

  dsl.phase("review");
  const firstDesignCritique = await dsl.agent(
    `Independently review the requested target workflow Design against live repository truth.

Verified project root: ${liveProjectRoot}
Original semantic request, preserved verbatim:
${input}

Complete Design returned by the author:
${initialDesignDocument}

Reopen workflow.design.md from the injected workflow workspace. Read the authoritative live authoring skill, selected pattern cards, extensions/workflows/AUTHORING.md, relevant repository instructions, and any source needed to verify claims. Do not trust the author summary. Check request coverage, target naming, namespace and exact Entries paths, node responsibilities and exact handoffs, source-shape feasibility, call bounds, durable keys, idempotence, drift policy, failure exits, workspace-only writes, and the strict separation between Design and Build. Confirm this stage wrote no .workflow.mjs source and ran no workflow. Do not edit files.

Return one complete critique. Separate blocking defects from non-blocking suggestions and state explicitly whether any blocking defect remains.`,
    { ...AGENTS.reviewer, label: "review workflow design 1" },
  );
  const firstDesignRoute = await dsl.agent(
    `Choose accept only when this independent critique states that no blocking defect remains. Otherwise choose revise.

Exact critique:
${firstDesignCritique}`,
    { ...AGENTS.router, label: "route workflow design 1", choice: ["accept", "revise"] },
  );
  if (firstDesignRoute === "accept") return dsl.publishPrimaryFile("workflow.design.md");

  dsl.phase("revise");
  const revisedDesignDocument = await dsl.agent(
    `Write one complete corrected replacement for the requested target workflow Design.

Verified project root: ${liveProjectRoot}
Original semantic request, preserved verbatim:
${input}

Current complete Design:
${initialDesignDocument}

Exact independent critique:
${firstDesignCritique}

Reopen workflow.design.md, live authoring contracts, selected pattern cards, and relevant project source. Resolve every blocking defect without losing supported content. Atomically replace only workflow.design.md in the injected shared workflow workspace and return the same complete Markdown text. Never write .workflow.mjs source, mutate tracked project source, or run any workflow.`,
    { ...AGENTS.reviser, label: "revise workflow design" },
  );

  dsl.phase("final-review");
  const secondDesignCritique = await dsl.agent(
    `Perform a fresh final independent review of the complete target workflow Design.

Verified project root: ${liveProjectRoot}
Original semantic request, preserved verbatim:
${input}

Complete replacement Design:
${revisedDesignDocument}

First-round critique that must be resolved:
${firstDesignCritique}

Reopen workflow.design.md and current authoritative project contracts. Recheck the full original request, all first-round defects, graph and handoffs, exact Entries/source paths, standard-profile feasibility, call bounds, workspace-only idempotence, drift and failure policy, and the no-source/no-execution boundary. Do not edit files.

Return one complete final critique. Separate blocking defects from non-blocking suggestions and state explicitly whether any blocking defect remains.`,
    { ...AGENTS.reviewer, label: "review workflow design 2" },
  );
  const secondDesignRoute = await dsl.agent(
    `Choose accept only when this final independent critique states that no blocking defect remains. Otherwise choose revise.

Exact final critique:
${secondDesignCritique}`,
    { ...AGENTS.router, label: "route workflow design 2", choice: ["accept", "revise"] },
  );
  if (secondDesignRoute === "accept") return dsl.publishPrimaryFile("workflow.design.md");
  throw new Error("workflow Design review limit reached without acceptance");
}
