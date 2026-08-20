export const meta = {
  name: "workflow-creator/build",
  description: "Build, check, and independently accept the exact source package declared by a workflow Design.",
  profile: "standard",
  phases: [{ title: "build" }, { title: "review" }, { title: "revise" }, { title: "final-review" }],
};

const AGENTS = {
  builder: { agent: "default" },
  reviewer: { agent: "reviewer" },
  router: { agent: "default" },
  reviser: { agent: "default" },
};

export default async function runWorkflow(dsl, input) {
  const liveProjectRoot = dsl.projectRoot();

  dsl.phase("build");
  const initialPackageManifest = await dsl.agent(
    `Build the exact Locus Pi workflow package declared by the accepted artifacts.

Verified live project root: ${liveProjectRoot}
Original semantic request, preserved verbatim:
${input}

Reopen accepted workflow.design.md and workflow.svg from the injected shared workflow workspace. Reopen the current live authoring skill, selected pattern cards, extensions/workflows/AUTHORING.md, repository instructions, checker, and identity implementation. Never edit the accepted Design or SVG. Never mutate tracked project source. Never execute any generated workflow.

Atomically create or replace exactly the Design-declared .workflow.mjs source files below generated/<target>/ in the shared workflow workspace. The final generated/ source set must contain no undeclared .workflow.mjs file; remove only obsolete generated .workflow.mjs files inside this workflow workspace when necessary to restore the exact declared set. Use meta.profile "standard", canonical folder identities, direct visible prompts and edges, and no imports, parsers, raw schema/validators, custom retry engine, manager simulation, or capability/tool list.

From the verified live project root, run ./bin/locus-pi check-workflow-source separately on every exact generated source. Assess every file with the repository's authoritative source-identity implementation. Import every module without calling its default export; require the exact Design-declared meta.name, meta.profile "standard", and one default function. Compare every source with the accepted Design and SVG: entries, nodes, roles, order, handoffs, choices, bounds, failure exits, artifact paths, and no-execution boundary must correspond. Treat any failed or skipped command as blocking.

Atomically replace workflow-package.md in the shared workflow workspace and return the same complete Markdown text. The reader-facing manifest must preserve the original request; name the derived target and namespace; list the exact accepted Design, SVG, and generated source paths; summarize the graph; record observed live revision and dirty state; record every checker, identity, import, and correspondence result with exact command/evidence; state that generated sources remain workspace-only and were not run; identify any blocker honestly. Do not claim success unless all exact checks passed.`,
    { ...AGENTS.builder, label: "build workflow package" },
  );

  dsl.phase("review");
  const firstBuildCritique = await dsl.agent(
    `Independently review and recheck the complete generated workflow package.

Verified live project root: ${liveProjectRoot}
Original semantic request, preserved verbatim:
${input}

Complete package manifest returned by the builder:
${initialPackageManifest}

Reopen workflow.design.md, workflow.svg, workflow-package.md, and every generated source from the injected shared workflow workspace. Reopen the authoritative live authoring contract and relevant repository source. Do not trust the builder's commands or summary: rerun ./bin/locus-pi check-workflow-source on every exact source, independently assess source identity, import every module without executing its default export, verify exact meta identities and standard profile, compare the complete source set and graph with Design and SVG, and inspect Git state for tracked-project mutation. Confirm the generated target workflow was never executed. Do not edit files or run any generated workflow.

Return one complete critique. Separate blocking defects from non-blocking suggestions, include exact fresh check evidence, and state explicitly whether any blocking defect remains.`,
    { ...AGENTS.reviewer, label: "review workflow package 1" },
  );
  const firstBuildRoute = await dsl.agent(
    `Choose accept only when this independent package critique states that no blocking defect remains and all required checks passed. Otherwise choose revise.

Exact critique:
${firstBuildCritique}`,
    { ...AGENTS.router, label: "route workflow package 1", choice: ["accept", "revise"] },
  );
  if (firstBuildRoute === "accept") return dsl.publishPrimaryFile("workflow-package.md");

  dsl.phase("revise");
  const revisedPackageManifest = await dsl.agent(
    `Make the single allowed complete correction of the generated workflow package.

Verified live project root: ${liveProjectRoot}
Original semantic request, preserved verbatim:
${input}

Current complete package manifest:
${initialPackageManifest}

Exact independent critique and fresh check evidence:
${firstBuildCritique}

Reopen the accepted workflow.design.md and workflow.svg, every generated source, workflow-package.md, current authoring contracts, checker, and identity implementation. Resolve every blocking defect. Atomically replace the complete Design-declared source set below generated/<target>/ and workflow-package.md; remove only obsolete generated .workflow.mjs files inside this workflow workspace when required for exact correspondence. Never edit accepted Design/SVG or tracked project source. Never execute a generated workflow.

Rerun ./bin/locus-pi check-workflow-source on every exact source, authoritative identity assessment, module imports without default-export calls, exact meta/profile checks, and Design/source/SVG correspondence. Return the same complete corrected workflow-package.md text, including exact new evidence and honest remaining blockers.`,
    { ...AGENTS.reviser, label: "revise workflow package" },
  );

  dsl.phase("final-review");
  const secondBuildCritique = await dsl.agent(
    `Perform a fresh final independent review and recheck of the corrected complete workflow package.

Verified live project root: ${liveProjectRoot}
Original semantic request, preserved verbatim:
${input}

Complete corrected package manifest:
${revisedPackageManifest}

First-round critique that must be resolved:
${firstBuildCritique}

Reopen every accepted and generated workspace file and the current authoritative project contracts. Rerun the source checker for every exact source, identity assessment, module imports without default-export calls, exact identities/profile checks, source-set and graph correspondence, workspace-only write check, and no-execution check. Recheck every first-round defect. Do not edit files or run any generated workflow.

Return one complete final critique with exact fresh evidence. Separate blocking defects from non-blocking suggestions and state explicitly whether any blocking defect remains.`,
    { ...AGENTS.reviewer, label: "review workflow package 2" },
  );
  const secondBuildRoute = await dsl.agent(
    `Choose accept only when this final independent package critique states that no blocking defect remains and all required checks passed. Otherwise choose revise.

Exact final critique:
${secondBuildCritique}`,
    { ...AGENTS.router, label: "route workflow package 2", choice: ["accept", "revise"] },
  );
  if (secondBuildRoute === "accept") return dsl.publishPrimaryFile("workflow-package.md");
  throw new Error("workflow package review limit reached without acceptance");
}
