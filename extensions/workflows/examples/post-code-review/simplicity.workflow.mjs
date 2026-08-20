export const meta = {
  name: "post-code-review/simplicity",
  description: "Audit a frozen review scope for avoidable complexity and publish simplicity findings.",
  profile: "standard",
};

export default async function runWorkflow(dsl, input) {
  await dsl.agent(
    `Perform the simplicity lane of a post-code review.

Semantic review target and intent:
${input}

The runtime-injected absolute workflow workspace is authoritative. Read review-scope.md there first, and do not read sibling lane reports. Then read the live project source and the evidence named by review-scope.md.

Audit only duplication, wrappers or helpers that add no value, redundant guards or fallbacks, dead or unreachable paths, unnecessary depth, and delete-first alternatives. Do not modify project/source files.

Perform this lane within this assigned Pi session. Do not invoke or delegate to another agent, saved workflow, Fusion, Claude, Codex, or any other outside model/session through a tool or shell command.

Filesystem contract (apply to every tool action and command, including implicit writes): every filesystem write caused by you must stay under the runtime-injected workflow workspace. This includes tool-generated caches, bytecode, indexes, reports, fixtures, logs, build/state/evidence directories, and lock/dependency metadata. Do not run a command that writes elsewhere. If a useful check has implicit output, redirect all output and cache under the workflow workspace or use a no-cache/read-only mode; otherwise record that evidence limit in the report.

Replace only review-simplicity.md in the workflow workspace. Write a complete Markdown report with scope, evidence boundary, useful positive evidence, limits, and actionable findings. Each finding must include severity, precise path:line evidence, concrete risk, and required change. If evidence is insufficient or live evidence drift prevents a trustworthy conclusion, write a truthful BLOCKED report instead of guessing. Write no other artifact. Finish only after review-simplicity.md is complete.`,
    { modelRole: "smol:high", label: "simplicity audit" },
  );
  return dsl.publishPrimaryFile("review-simplicity.md");
}
