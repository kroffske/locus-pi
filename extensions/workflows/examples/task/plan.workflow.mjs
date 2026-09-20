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
    { title: "verify", detail: "Check the workspace source and route at most one semantic correction." },
    { title: "publish", detail: "Publish workflow.mjs as the final result." },
  ],
};

const SOURCE_CONTRACT = `The generated module must declare literal meta.name,
meta.profile: "standard", and one default run function. Source contains only
author-known prompts, direct agent/DSL calls, visible control flow, exact text
handoffs, and in-memory text publication. Allowed DSL calls are agent,
parallel, pipeline, workflow, invokeWorkflow, items, phase, log,
awaitOperator, publishArtifact, and publishPrimaryArtifact. Every agent call
declares a literal label, and no two agent calls share one, so a stopped run can
be repaired in place and continued. Do not use imports,
consumeTextArtifact, continuationArtifacts, outputDir, projectRoot, promptFile,
publishPrimaryFile, workspace, now, random, parsers, renderers, custom retries,
or hidden agent wrappers. Follow the packaged locus-pi-workflow-create pattern index:
substantive implementation defaults to adaptive slices, with an owner re-cutting
the remaining handoffs queue after each accepted slice. Substantive implementation
needs a cumulative slice bound, addressed correction, independent recheck and final QA.
Fixed graphs remain valid for fixed work or explicit selection: preserve an accepted
one-worker task without inventing QA nodes or another owner approval. Preserve existing
scoped authorization; ask the owner only about a new material scope decision.
Prompts default to role, outcome, SOURCES and essential constraints; leave the
method to the worker. Task context starts at a directory, not a forced task.md
argument. Every call also has a descriptive title. Agent answers are opaque whole
values: do not inspect their type, length or contents, mutate them, or render final
reports from them in JavaScript. An agent produces the complete report for publication.
The host rejects empty answers and throws on execution/publication errors; do not
reimplement those checks or inspect publication references for success.
Semantic checks belong to agents. Design explicit choice edges for branching;
when both findings and routing are needed, declare separate report and choice
calls or a choice stage that writes its findings first. Never branch on free-form
report text. A skipped correction must really be skipped, not invoked to do nothing.
A refusal returns { ok: false, status: "failed" }; a string beginning with fail
is ordinary text, not a failure signal. A correction must receive the complete
review findings as text or an explicit evidence-file path, never only a choice.
Keep review evidence separate from routing. Preserve the accepted primary filename
and content contract; do not invent an extra report.md or publication. The primary
artifact must contain its promised data: publish a report under a report filename and name product
files separately, never publish an acceptance verdict as JSON or source.`;

/**
 * @param {import("../../runtime/workflow-runtime.js").WorkflowDsl} dsl
 * @param {string} [input]
 */
export default async function runWorkflow(dsl, input = "") {
  // Package admission guarantees this required semantic input before the module
  // executes. Keep it opaque here so the orchestration-only source contract can
  // prove the script only forwards author input to agents.
  const draftText = input;

  dsl.phase("design");
  const designText = await dsl.agent(
    `Turn the accepted draft below into one concrete workflow design.

Honor its selected pattern, reflection/review policy, agents, handoffs,
concurrency, bounds, and primary output. Resolve only routine authoring choices.
Do not broaden the task. Return a complete design that names every node, exact
input, exact output, consumer, branch, loop bound, and failure exit. Derive one
lowercase workflow name from the task. Return the complete text, not a path.
Do not write or edit files in this stage; do not create a saved workflow copy.

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
Return the complete text, not a path. Do not write or edit files in this stage;
do not create a saved workflow copy.

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
primary result. Do not write or edit files in this stage; do not create a saved
workflow copy. The designated verifier writes only the workspace candidate.

--- BEGIN REVIEWED DESIGN ---
${reviewedDesignText}
--- END REVIEWED DESIGN ---`,
    { label: "workflow-source-build" },
  );

  dsl.phase("verify");
  const verification = await dsl.agent(
    `Write and check one generated workflow; do not correct it in this stage.

Write the candidate bytes to workflow.mjs in the runtime-injected workflow
workspace. Change into that exact workspace and run node --check workflow.mjs.
Then call workflow_check_source for the exact project-relative workspace file
with mode: "orchestration-only". Never import or execute unchecked source.
Return the exact file path, check outcomes and diagnostics, not source bytes.
Leave failed source on disk. The next decision owns routing to correction;
your final prose is evidence, never the published source.

${SOURCE_CONTRACT}

--- BEGIN CANDIDATE SOURCE ---
${candidateSourceText}
--- END CANDIDATE SOURCE ---`,
    { label: "workflow-source-verify", result: "report" },
  );
  const decision = await dsl.agent(
    `Check the workspace workflow.mjs using workflow_check_source in orchestration-only mode.
Compare it with the reviewed design below. Choose publish only if the exact file
passes and implements the design, correct for an in-scope repair, or failed for
an unavailable prerequisite or scope conflict. A verifier's prose is not proof.
Use the project-relative file path for the checker, not its absolute path.
Before choosing, write the complete findings and exact check diagnostics to
workflow-source-decision.md in the workspace. Name unmet design criteria and
an applicable next action; a bare failed choice is not diagnostic evidence.
Do not edit or execute source.

${SOURCE_CONTRACT}

${reviewedDesignText}

Verification evidence:
${verification}`,
    { label: "workflow-source-decision", choice: ["publish", "correct", "failed"] },
  );
  if (decision === "failed")
    return {
      ok: false,
      status: "failed",
      stage: "verify",
      reason:
        "Source review refused publication. Inspect workspace workflow-source-decision.md, workflow.mjs and the workflow-source-decision transcript; repair the source or resolve the named prerequisite before continuing.",
    };
  if (decision === "correct") {
    const correction = await dsl.agent(
      `Correct the existing workspace workflow.mjs against this reviewed design.
Read the complete findings in workspace workflow-source-decision.md.
Preserve the previous bytes as workflow.failed.mjs before editing. Read the
checker diagnostics yourself; run node --check workflow.mjs and workflow_check_source
with mode: "orchestration-only" after correction. Do not import or execute source.
This is the one semantic correction stage. Return exact paths, checks and diagnostics;
leave the latest source on disk even if it still fails.

${SOURCE_CONTRACT}

${reviewedDesignText}

${verification}`,
      { label: "workflow-source-correct", result: "report" },
    );
    const recheck = await dsl.agent(
      `Independently recheck the exact workspace workflow.mjs with workflow_check_source
in orchestration-only mode and compare it to the design. Do not edit or run it.
Choose publish only for a passing file implementing the design; otherwise failed.
Use the project-relative file path for the checker, not its absolute path.
No more semantic corrections remain. Before choosing, write complete acceptance
findings, unmet design criteria, exact check diagnostics and the next action to
workflow-source-recheck.md in the workspace. Preserve tool evidence as well.

${SOURCE_CONTRACT}

${reviewedDesignText}

${correction}`,
      { label: "workflow-source-recheck", choice: ["publish", "failed"] },
    );
    if (recheck !== "publish")
      return {
        ok: false,
        status: "failed",
        stage: "verify",
        reason:
          "Source correction exhausted. Inspect workspace workflow-source-recheck.md, workflow.mjs, workflow.failed.mjs and the workflow-source-recheck transcript; use external Repair + Continue after addressing the findings.",
      };
  }

  dsl.phase("publish");
  return dsl.publishPrimaryArtifact("workflow.mjs", { workflowSource: "workflow.mjs" });
}
