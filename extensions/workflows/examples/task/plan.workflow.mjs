// task/plan.workflow.mjs
// Consumes one accepted draft and directly builds one reviewed workflow.mjs.
// There is no generic implementation stage after this workflow.

export const meta = {
  name: "task/plan",
  profile: "standard",
  description: "Turn an accepted workflow brief directly into a checked workflow.mjs.",
  phases: [
    { title: "design", detail: "Translate the accepted draft into one explicit agent graph." },
    { title: "review", detail: "Return one corrected replacement design with bounded orchestration." },
    { title: "build", detail: "Build the complete orchestration-only workflow source." },
    { title: "verify", detail: "Check and correct the exact source once before publication." },
    { title: "publish", detail: "Publish workflow.mjs as the final result." },
  ],
};

const SOURCE_CONTRACT = `The generated module must declare literal meta.name,
meta.profile: "standard", and one default run function. Source contains only
author-known prompts, direct agent/DSL calls, visible control flow, exact text
handoffs, and in-memory text publication. Allowed DSL calls are agent,
parallel, pipeline, workflow, invokeWorkflow, items, phase, log,
awaitOperator, publishArtifact, and publishPrimaryArtifact. Do not use imports,
consumeTextArtifact, continuationArtifacts, outputDir, projectRoot, promptFile,
publishPrimaryFile, workspace, now, random, parsers, renderers, custom retries,
or hidden agent wrappers.`;

/**
 * @param {import("../../runtime/workflow-runtime.js").WorkflowDsl} dsl
 * @param {string} [input]
 */
export default async function runWorkflow(dsl, input = "") {
  const draftText =
    typeof input === "string" && input.trim()
      ? input.trim()
      : "No accepted draft was supplied. Produce a fail-closed workflow whose only result explains this missing input.";

  dsl.phase("design");
  const designText = await dsl.agent(
    `Turn the accepted draft below into one concrete workflow design.

Honor its selected pattern, reflection/review policy, agents, handoffs,
concurrency, bounds, and primary output. Resolve only routine authoring choices.
Do not broaden the task. Return a complete design that names every node, exact
input, exact output, consumer, branch, loop bound, and failure exit. Derive one
lowercase workflow name from the task.

${SOURCE_CONTRACT}

--- BEGIN ACCEPTED DRAFT ---
${draftText}
--- END ACCEPTED DRAFT ---`,
    { label: "workflow-design" },
  );

  dsl.phase("review");
  const reviewedDesignText = await dsl.agent(
    `Return the complete corrected replacement design.

Check that the graph directly produces the draft's promised result. Remove
unused agents, fake manager layers, unconsumed acknowledgements, file transport,
and unbounded reflection. Preserve useful fan-out, review, or human gates only
when the draft gives them a real job. Every edge must remain visible.

${SOURCE_CONTRACT}

--- BEGIN ACCEPTED DRAFT ---
${draftText}
--- END ACCEPTED DRAFT ---

--- BEGIN PROPOSED DESIGN ---
${designText}
--- END PROPOSED DESIGN ---`,
    { label: "workflow-design-review" },
  );

  dsl.phase("build");
  const candidateSourceText = await dsl.agent(
    `Build the complete workflow.mjs source from the reviewed design.

${SOURCE_CONTRACT}

Return JavaScript bytes only. Do not wrap them in a Markdown fence. Keep every
prompt and agent edge readable where it executes. Agents return complete text;
the script passes it unchanged to its named consumer and publishes one concrete
primary result.

--- BEGIN REVIEWED DESIGN ---
${reviewedDesignText}
--- END REVIEWED DESIGN ---`,
    { label: "workflow-source-build" },
  );

  dsl.phase("verify");
  const verifiedSourceText = await dsl.agent(
    `You own the final source correction for one generated workflow.

Write the candidate bytes to workflow.mjs in the runtime-injected workflow
workspace. Change into that exact workspace and run node --check workflow.mjs.
Then call workflow_check_source for the exact project-relative workspace file
with mode: "orchestration-only". If either check fails, correct the source once
and rerun both checks. Return the exact final JavaScript bytes only after both
checks pass. Do not return Markdown fences, commentary, a report, or an
unchecked best effort.

${SOURCE_CONTRACT}

--- BEGIN CANDIDATE SOURCE ---
${candidateSourceText}
--- END CANDIDATE SOURCE ---`,
    { label: "workflow-source-verify" },
  );

  dsl.phase("publish");
  return dsl.publishPrimaryArtifact("workflow.mjs", verifiedSourceText);
}
