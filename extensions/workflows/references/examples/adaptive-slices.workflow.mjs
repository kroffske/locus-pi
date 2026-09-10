export const meta = {
  name: "adaptive-slices",
  description: "Implement an accepted design one reviewed slice at a time; re-cut the remaining queue",
  profile: "standard",
};

// Teaching allowance: at most three implemented slices and one correction per slice.
// Derive these literals from the actual task when authoring; never truncate a queue to fit.
export default async function runWorkflow(dsl, input) {
  const acceptance = await dsl.agent(
    `Check whether the owner explicitly accepted the current design for implementation. SOURCES: task directory ${input}; ` +
      "read task.md, artifacts/design.md and artifacts/design-acceptance.md inside that directory. Match the accepted scope and design revision. " +
      "A path, existing file, generated plan or another agent's recommendation is not owner acceptance. " +
      "Return accepted only with that evidence; otherwise return needs_owner. Do not edit source.",
    { label: "acceptance", title: "Verify owner acceptance", choice: ["accepted", "needs_owner"], returnVia: "tool" },
  );
  if (acceptance !== "accepted") {
    return { ok: false, status: "needs_owner", summary: "The current design needs explicit owner acceptance." };
  }
  const baseline = await dsl.agent(
    `Record the baseline for the accepted design. SOURCES: task directory ${input}; task.md, accepted design, repository instructions. ` +
      "Identify the real checkout, HEAD, pre-existing changes and relevant test results. Preserve foreign work. " +
      "Write baseline.md in the workflow workspace. Return its path and key constraints for the implementer and reviewer. Environment preparation is not implementation.",
    { label: "baseline", title: "Record the implementation baseline" },
  );
  let previousQueue = [];
  let lastAccepted = "";
  let currentWork = "";
  // The fourth pass may prove completion or return the unconsumed queue, but cannot implement a fourth slice.
  for (let completed = 0; completed <= 3; completed += 1) {
    const queue = await dsl.agent(
      `You own the remaining plan. SOURCES: task directory ${input}; task.md, the accepted design, current diff and slice evidence. ` +
        `Baseline:\n${baseline}\nPrevious proposed queue:\n${previousQueue.join("\n---\n")}\nLast accepted slice:\n${lastAccepted}\n` +
        `Already implemented: ${completed}; total allowance: 3. Return the complete remaining queue in execution order. ` +
        "Each item is a self-contained slice brief: stable identity, goal, expected files, acceptance evidence and constraints. " +
        "Inspect what actually landed. Keep, reorder, merge, shrink or replace remaining slices within the accepted design. " +
        "Do not repeat completed work or drop unmet requirements to fit the allowance. Return no items only when no work remains. " +
        "Return proposed scope changes as explicit unresolved work for the owner; do not authorize them.",
      {
        label: "cut",
        title: `Re-cut remaining work after ${completed} slices`,
        handoffs: { maxItems: 100 },
        returnVia: "tool",
      },
    );
    const scope = await dsl.agent(
      `Check the proposed queue against the owner's accepted design and current repository. SOURCES: task directory ${input}. ` +
        `Baseline:\n${baseline}\nProposed queue:\n${queue.join("\n---\n")}\nLast accepted slice:\n${lastAccepted}\n` +
        "Choose work only for a complete, in-scope remaining queue. Choose complete only when every design requirement is met. " +
        "Choose needs_owner for a scope change, missing acceptance or a direction decision. Choose blocked for missing evidence. " +
        "An empty queue is not proof of completion. Do not implement or relax acceptance.",
      {
        label: "scope",
        title: "Check remaining scope",
        choice: ["work", "complete", "needs_owner", "blocked"],
        returnVia: "tool",
      },
    );
    if (scope === "needs_owner" || scope === "blocked") {
      return { ok: false, status: scope, remaining: queue, lastAccepted, baseline };
    }
    if (scope === "complete") {
      if (queue.length !== 0)
        return { ok: false, status: "blocked", summary: "Completion conflicts with remaining work.", remaining: queue };
      const checks = await dsl.parallel([
        () =>
          dsl.agent(
            `Verify the accepted behavior with focused tests against the baseline. SOURCES: task directory ${input}; accepted design and real diff. ` +
              `Baseline:\n${baseline}\nLast accepted slice:\n${lastAccepted}\n` +
              "Write verify-tests.md in the workflow workspace with commands, actual exits, test delta and uncovered requirements. Return its path, outcome and unresolved requirements. No source edits.",
            { label: "tests", title: "Verify behavior and test delta" },
          ),
        () =>
          dsl.agent(
            `Independently challenge whether the accepted design is implemented on the real caller path. SOURCES: task directory ${input}; ` +
              "accepted design, actual source and accumulated slice evidence. Check every requirement and preserved constraint. " +
              "Write verify-integration.md in the workflow workspace with evidence and remaining risks; return its path and outcome. A demonstration or unused implementation is not completion. Do not edit source.",
            { label: "integration", title: "Verify the real integration path" },
          ),
      ]);
      const verdict = await dsl.agent(
        `Decide whether all accepted requirements are verified. SOURCES: task directory ${input}; accepted design and real evidence. ` +
          `Required reports (tests and integration):\n${checks.join("\n---\n")}\n` +
          "Open both reports. Choose complete only when both reports establish success. Failed, absent or inconclusive required evidence means blocked. " +
          "Do not substitute a favorable summary for a missing check.",
        { label: "verdict", title: "Decide final acceptance", choice: ["complete", "blocked"], returnVia: "tool" },
      );
      return { ok: verdict === "complete", status: verdict, verification: checks, baseline, lastAccepted };
    }
    if (queue.length === 0) return { ok: false, status: "blocked", summary: "Work selected without a slice." };
    if (completed === 3)
      return {
        ok: false,
        status: "blocked",
        summary: "Total slice allowance exhausted.",
        remaining: queue,
        lastAccepted,
        baseline,
      };
    const slice = queue[0];
    const work = await dsl.agent(
      `Implement this one accepted slice. SOURCES: task directory ${input}; task.md, accepted design and repository instructions. ` +
        `Slice:\n${slice}\nAssigned note: slice-${completed + 1}-work.md. Baseline:\n${baseline}\n` +
        "Deliver the behavior and focused verification. Preserve foreign changes. Commit only owned paths when the task authorizes commits; " +
        "otherwise leave a reviewable working diff. Write the full implementation note, base/HEAD, changed paths, tests and limitations to the assigned slice note in the workflow workspace. Return its exact path, outcome and any concrete blocker. " +
        "Preparation alone is not completion. Do not widen the design.",
      { label: "implement", title: `Implement slice ${completed + 1}` },
    );
    currentWork = work;
    const review = await dsl.agent(
      `Review the real diff for this slice. SOURCES: task directory ${input}; accepted design, repository and baseline. ` +
        `Slice:\n${slice}\nImplementation:\n${work}\nBaseline:\n${baseline}\n` +
        "Inspect the full in-scope diff yourself. Verify the acceptance criteria, tests and preserved constraints. " +
        `Write review-${completed + 1}.md in the workflow workspace. Return its path and confirmed findings with bounded fix instructions. Do not edit source or accept a merely prepared environment.`,
      { label: "review", title: `Review slice ${completed + 1}` },
    );
    const route = await dsl.agent(
      `Route the slice review within the accepted design. SOURCES: task directory ${input}. Slice:\n${slice}\nWork:\n${work}\nReview:\n${review}\n` +
        "Accept only if the evidence meets the slice criteria. Choose fix for concrete in-scope defects; needs_owner for scope changes; " +
        "blocked for an unresolved obstacle. Do not dismiss failed acceptance as a note.",
      {
        label: "route",
        title: "Route slice findings",
        choice: ["accept", "fix", "needs_owner", "blocked"],
        returnVia: "tool",
      },
    );
    if (route === "needs_owner" || route === "blocked") {
      return { ok: false, status: route, remaining: queue, work, review, baseline };
    }
    if (route === "fix") {
      const correction = await dsl.agent(
        `Correct only the confirmed slice defects. SOURCES: task directory ${input}; accepted design and actual diff. ` +
          `Slice:\n${slice}\nWork:\n${work}\nReview:\n${review}\n` +
          `Verify the correction and preserve the already accepted behavior. Write correction-${completed + 1}.md in the workflow workspace with changed paths, base/HEAD, test evidence and unresolved findings. Return its path and outcome. ` +
          "Keep the same commit authorization and foreign-work boundary as implementation.",
        { label: "correct", title: `Correct slice ${completed + 1}` },
      );
      const recheck = await dsl.agent(
        `Independently recheck the corrected diff against every slice criterion and original finding. SOURCES: task directory ${input}; accepted design. ` +
          `Slice:\n${slice}\nOriginal review:\n${review}\nCorrection:\n${correction}\nBaseline:\n${baseline}\n` +
          "Return accept only with verified evidence. Missing evidence, regressions or unresolved defects mean blocked. " +
          "No second correction round is available in this example. Do not edit source.",
        { label: "recheck", title: `Recheck slice ${completed + 1}`, choice: ["accept", "blocked"], returnVia: "tool" },
      );
      currentWork = correction;
      dsl.publishArtifact(`slice-${completed + 1}-correction.md`, `Correction:\n${correction}\nRecheck: ${recheck}`);
      if (recheck !== "accept")
        return { ok: false, status: "blocked", remaining: queue, work, review, correction, recheck };
    }
    const accepted = await dsl.agent(
      `Record the accepted slice and cumulative progress for the next owner. SOURCES: task directory ${input}; current repository. ` +
        `Slice:\n${slice}\nCurrent implementation/correction:\n${currentWork}\nReview:\n${review}\nRoute: ${route}\nPrevious progress:\n${lastAccepted}\n` +
        `Write progress-${completed + 1}.md in the workflow workspace with cumulative completed identities, current HEAD/diff, verified criteria, evidence paths and outstanding requirements. Read prior progress by its path. Return the new progress path and current slice identity; do not paste cumulative history. ` +
        "Include correction evidence when present. Do not infer that unimplemented queue entries are done.",
      { label: "record", title: "Record accepted progress" },
    );
    dsl.publishArtifact(`slice-${completed + 1}.md`, accepted);
    previousQueue = queue;
    lastAccepted = accepted;
  }
}
