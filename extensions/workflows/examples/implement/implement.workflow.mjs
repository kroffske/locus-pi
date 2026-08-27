export const meta = {
  name: "implement",
  description: "Apply authorized work from a prepared plan or review, then independently verify it once.",
  profile: "standard",
  phases: [
    { title: "prepare", detail: "Normalize the source into one bounded implementation plan." },
    { title: "readiness", detail: "Classify the plan as executable, no-work, or operator-blocked." },
    { title: "report", detail: "Publish the terminal outcome for any completed route." },
    { title: "operator-decision", detail: "Stop with a precise handoff when owner input is required." },
    { title: "implement", detail: "Apply only the selected action level and record focused checks." },
    { title: "verify", detail: "Inspect the live result independently before acceptance." },
    { title: "correct", detail: "Apply at most one bounded corrective pass." },
    { title: "verify-correction", detail: "Verify the corrected result without widening scope." },
  ],
};

export default async function runWorkflow(dsl, input) {
  dsl.phase("prepare");
  const implementationPlan = await dsl.agent(
    `Prepare or continue the Package workflow \`implement\` for this semantic request or operator answer:
${input}

Read the existing implementation-plan.md when it exists. If the input names a new source plan or review, normalize that new source. Otherwise treat the input as an answer or refinement for the existing plan. Locate the source in the runtime-injected workflow workspace, then inspect the live project, repository guidance, relevant source, tests, and current Git state needed to determine whether it remains executable. Fully replace implementation-plan.md in the workflow workspace with one complete normalized Markdown plan and return exactly the same complete text. Do not modify project source in this stage.

The plan must state: source file and scope; current top-level decision when present; selected action threshold; exact retained work; allowed ownership and exclusions; ordered implementation steps; focused checks and done conditions; unresolved owner/product decisions; and live drift or dirty-worktree risks. Default to REQUIRED actions only. Include RECOMMENDED actions only when this semantic request explicitly opts into them. Never execute NO_ACTION, rejected, duplicate, unsupported, or merely illustrative snippet content. When the source is post-code-review.md, preserve its action levels and necessity-gate decisions: do not promote a recommendation, restore a rejected proposal, or treat an illustrative fix snippet as a literal patch. If there is no selected work, say so. If the source is incomplete, contradictory, too broad for one bounded run, or needs an owner/product choice, state the single decision needed instead of inventing it.

Preserve existing source identity, finding dispositions, action levels, exclusions, and allowed ownership when processing an answer. An answer may resolve an ambiguity or explicitly opt into RECOMMENDED work, but it may not restore REJECTED or NO_ACTION items, silently add work, or weaken verification. Do not stage, commit, push, open a pull request, merge, deploy, mutate a remote, stash, discard user changes, or add work outside the supplied source.`,
    { label: "prepare implementation plan", workspaceMode: "project" },
  );

  dsl.phase("readiness");
  const readiness = await dsl.agent(
    `Classify this exact implementation plan.

Return execute only when selected work exists, every required technical detail can be derived from the live repository, the requested action level authorizes it, and no owner/product decision remains. Return no-work when there is intentionally nothing selected, including a READY review or recommendations without explicit opt-in. Return needs-operator when a missing owner/product decision, contradiction, unsafe scope, or unresolved blocker prevents bounded execution.

Do not reinterpret action levels or assess code quality again.

--- BEGIN IMPLEMENTATION PLAN ---
${implementationPlan}
--- END IMPLEMENTATION PLAN ---`,
    {
      label: "classify implementation readiness",
      choice: ["execute", "no-work", "needs-operator"],
    },
  );

  if (readiness === "no-work") {
    dsl.phase("report");
    await dsl.agent(
      `Write the terminal no-op report for Package workflow \`implement\`.

Fully replace implementation-report.md in the runtime-injected workflow workspace and return exactly the same complete Markdown. State \`Status: NO_WORK\`, identify the source and selected action threshold, explain why no project edit is authorized or needed, list any unselected recommendations, and record evidence limits. Do not modify project source or any other workspace artifact.

--- BEGIN IMPLEMENTATION PLAN ---
${implementationPlan}
--- END IMPLEMENTATION PLAN ---`,
      { label: "write no-work implementation report", workspaceMode: "project" },
    );
    return dsl.publishPrimaryFile("implementation-report.md");
  }

  if (readiness === "needs-operator") {
    dsl.phase("operator-decision");
    const implementationPlanRef = dsl.publishArtifact("implementation-plan.md", implementationPlan);
    dsl.awaitOperator({
      reason: "implementation requires one owner or product decision",
      operatorHandoff: {
        title: "Resolve implementation scope",
        questions: [
          {
            kind: "text",
            id: "implementation_decision",
            prompt:
              "Resolve the single blocker named in implementation-plan.md, or say that work should remain blocked.",
          },
        ],
        continuationArtifactRefs: [implementationPlanRef],
      },
    });
    return implementationPlanRef;
  }

  dsl.phase("implement");
  const implementationWork = await dsl.agent(
    `Implement this exact prepared plan in the live project.

Reinspect every target before editing. Apply only the selected authorized actions and stay inside Allowed ownership. Preserve unrelated dirty work. Illustrative snippets in a source review explain intent; they are not literal patches and must be adapted to the live code. Prefer the smallest change that closes each proven risk. Run the narrowest meaningful checks for the edits.

Fully replace implementation-work.md in the runtime-injected workflow workspace and return exactly the same complete Markdown. Record status, changed files, action items completed, checks with exact outcomes, unresolved items, and residual risks. A failed required check or scope blocker must be recorded as blocked. Do not stage, commit, push, open a pull request, merge, deploy, mutate a remote, stash, or discard user changes.

--- BEGIN IMPLEMENTATION PLAN ---
${implementationPlan}
--- END IMPLEMENTATION PLAN ---`,
    { label: "apply implementation plan", workspaceMode: "project" },
  );

  dsl.phase("verify");
  const firstReview = await dsl.agent(
    `Independently verify the live implementation against this exact plan and work record. Do not trust completion claims without inspecting the current diff, affected consumers, and check evidence. Run additional read-only or non-mutating checks when useful. Do not modify project source.

Fully replace implementation-review.md in the runtime-injected workflow workspace and return exactly the same complete Markdown. State whether every selected action is complete, whether unrelated work was touched, whether required checks passed, concrete defects that still need correction, and whether the result is safe to accept. Do not request extra cleanup outside the plan and do not promote unselected recommendations.

--- BEGIN IMPLEMENTATION PLAN ---
${implementationPlan}
--- END IMPLEMENTATION PLAN ---

--- BEGIN IMPLEMENTATION WORK ---
${implementationWork}
--- END IMPLEMENTATION WORK ---`,
    { label: "verify implementation", workspaceMode: "project" },
  );
  const firstRoute = await dsl.agent(
    `Choose accept only when the live implementation satisfies every selected action and required check. Choose revise only for concrete, bounded implementation defects that can be corrected inside the same plan. Choose blocked when acceptance requires a new owner/product decision, wider scope, unavailable evidence, or a second implementation campaign.

--- BEGIN IMPLEMENTATION PLAN ---
${implementationPlan}
--- END IMPLEMENTATION PLAN ---

--- BEGIN IMPLEMENTATION WORK ---
${implementationWork}
--- END IMPLEMENTATION WORK ---

--- BEGIN INDEPENDENT REVIEW ---
${firstReview}
--- END INDEPENDENT REVIEW ---`,
    { label: "route implementation review", choice: ["accept", "revise", "blocked"] },
  );

  if (firstRoute === "accept") {
    dsl.phase("report");
    await dsl.agent(
      `Write the terminal implementation report from these exact records. Fully replace implementation-report.md in the runtime-injected workflow workspace and return exactly the same complete Markdown. State \`Status: COMPLETED\`, source identity and selected action level, changed files, completed actions, check evidence, unselected recommendations, and residual risks. Recommend a separate post-code-review rerun when useful. Do not modify project source or other artifacts.

--- BEGIN IMPLEMENTATION PLAN ---
${implementationPlan}
--- END IMPLEMENTATION PLAN ---

--- BEGIN IMPLEMENTATION WORK ---
${implementationWork}
--- END IMPLEMENTATION WORK ---

--- BEGIN INDEPENDENT REVIEW ---
${firstReview}
--- END INDEPENDENT REVIEW ---`,
      { label: "write completed implementation report", workspaceMode: "project" },
    );
    return dsl.publishPrimaryFile("implementation-report.md");
  }

  if (firstRoute === "blocked") {
    dsl.phase("report");
    await dsl.agent(
      `Write the terminal blocked implementation report from these exact records. Fully replace implementation-report.md in the runtime-injected workflow workspace and return exactly the same complete Markdown. State \`Status: BLOCKED\`, source identity and selected action level, any project changes already made, check evidence, the exact blocker, safe recovery or continuation guidance, unselected recommendations, and residual risks. Do not modify project source or other artifacts.

--- BEGIN IMPLEMENTATION PLAN ---
${implementationPlan}
--- END IMPLEMENTATION PLAN ---

--- BEGIN IMPLEMENTATION WORK ---
${implementationWork}
--- END IMPLEMENTATION WORK ---

--- BEGIN INDEPENDENT REVIEW ---
${firstReview}
--- END INDEPENDENT REVIEW ---`,
      { label: "write blocked implementation report", workspaceMode: "project" },
    );
    return dsl.publishPrimaryFile("implementation-report.md");
  }

  dsl.phase("correct");
  const correctedWork = await dsl.agent(
    `Apply one and only one corrective pass for the concrete defects in this independent review. Reinspect the live diff first. Change only what is needed to satisfy the original selected actions and checks; do not add cleanup, promote recommendations, or widen ownership. Run the focused checks again.

Fully replace implementation-work.md in the runtime-injected workflow workspace and return exactly the same complete Markdown. Record the correction, final changed files, checks with exact outcomes, unresolved items, and residual risks. Do not stage, commit, push, open a pull request, merge, deploy, mutate a remote, stash, or discard user changes.

--- BEGIN IMPLEMENTATION PLAN ---
${implementationPlan}
--- END IMPLEMENTATION PLAN ---

--- BEGIN PRIOR IMPLEMENTATION WORK ---
${implementationWork}
--- END PRIOR IMPLEMENTATION WORK ---

--- BEGIN INDEPENDENT REVIEW ---
${firstReview}
--- END INDEPENDENT REVIEW ---`,
    { label: "correct verified implementation defects", workspaceMode: "project" },
  );

  dsl.phase("verify-correction");
  const finalReview = await dsl.agent(
    `Independently verify the live result after the sole corrective pass. Inspect the current diff, affected consumers, and check evidence. Do not modify project source.

Fully replace implementation-review.md in the runtime-injected workflow workspace and return exactly the same complete Markdown. State whether every originally selected action and required check now passes, whether unrelated work was touched, and any remaining blocker. This is the final review: do not propose another correction cycle or add work outside the plan.

--- BEGIN IMPLEMENTATION PLAN ---
${implementationPlan}
--- END IMPLEMENTATION PLAN ---

--- BEGIN CORRECTED IMPLEMENTATION WORK ---
${correctedWork}
--- END CORRECTED IMPLEMENTATION WORK ---`,
    { label: "verify corrected implementation", workspaceMode: "project" },
  );
  const finalRoute = await dsl.agent(
    `Choose accept only when the live corrected implementation satisfies every originally selected action and required check. Otherwise choose blocked; there is no second correction.

--- BEGIN IMPLEMENTATION PLAN ---
${implementationPlan}
--- END IMPLEMENTATION PLAN ---

--- BEGIN CORRECTED IMPLEMENTATION WORK ---
${correctedWork}
--- END CORRECTED IMPLEMENTATION WORK ---

--- BEGIN FINAL INDEPENDENT REVIEW ---
${finalReview}
--- END FINAL INDEPENDENT REVIEW ---`,
    { label: "route final implementation review", choice: ["accept", "blocked"] },
  );

  dsl.phase("report");
  await dsl.agent(
    `Write the terminal implementation report from these exact final records. Fully replace implementation-report.md in the runtime-injected workflow workspace and return exactly the same complete Markdown. Use \`Status: COMPLETED\` when the route is accept and \`Status: BLOCKED\` when it is blocked. Include source identity and selected action level, changed files, completed actions, check evidence, the correction performed, remaining blockers or unselected recommendations, and residual risks. Recommend a separate post-code-review rerun when useful. Do not modify project source or other artifacts.

Final route: ${finalRoute}

--- BEGIN IMPLEMENTATION PLAN ---
${implementationPlan}
--- END IMPLEMENTATION PLAN ---

--- BEGIN CORRECTED IMPLEMENTATION WORK ---
${correctedWork}
--- END CORRECTED IMPLEMENTATION WORK ---

--- BEGIN FINAL INDEPENDENT REVIEW ---
${finalReview}
--- END FINAL INDEPENDENT REVIEW ---`,
    { label: "write final implementation report", workspaceMode: "project" },
  );
  return dsl.publishPrimaryFile("implementation-report.md");
}
