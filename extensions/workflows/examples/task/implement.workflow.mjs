// task/implement.workflow.mjs
//
// Executes one approved plan through one implementation agent. JavaScript does
// not parse the plan, choose steps, loop over work, grade the answer, or build a
// report. The agent reads the live planning files and owns ordered execution.

export const meta = {
  name: "task/implement",
  profile: "standard",
  description: "Executes an approved plan and its step files through one implementation agent.",
  phases: [
    {
      title: "implement-plan",
      detail: "One agent reads the approved plan and step catalog, then implements and records every step in order.",
    },
  ],
};

export default async function runWorkflow(dsl) {
  const { agent, log, phase } = dsl;

  phase("implement-plan");
  log("Agent implementation: executing the approved plan from its step files.");
  return await agent(
    `You are the implementation agent in the Package workflow \`task/implement\`.

From the filesystem note above, use \`pwd\` for project changes and the workflow
workspace for plan, step, and history files. Read \`plan.md\`, every
\`step-<n>.md\` file in ascending numeric order, and every existing
\`history/*.md\` before acting. If \`plan.md\` is missing or empty, no step file
exists, the numbering is not contiguous from 1, or a file's \`S<n>\` heading
does not match its number, do not modify project files. Fully replace
\`history/implementation.md\` with a blocked record naming the catalog problem.

The planning files as they exist on disk — including owner edits made after
planning — are the implementation contract. Reinspect the live project before
each step; the plan is context, not authority. Execute the catalog in ascending
numeric order. Do not start a later step until every earlier step has completed
and its required checks pass.

The step file is one complete flat \`## S<n> — ...\` block. New plans label its
work-unit identity, boundary, goal, paths and evidence, dependencies, allowed
ownership, verification, and done condition.
Older saved step files may carry fewer labels; treat every field that is
present as one coherent task contract and implement it directly. Do not
decompose it into nested tasks or reinterpret labeled fields as permission to
widen ownership.

Rules for every step:
- Preserve unrelated dirty work. Never stage, commit, push, create a pull
  request, merge, deploy, mutate a remote, stash, or discard user changes.
- Stay inside the active step while implementing it. Do not rewrite the plan or
  any step file.
- If the block declares \`Allowed ownership:\`, respect it. If the goal cannot
  be completed within it, record a blocker instead of editing another owner.
  If that label is absent, make only the narrow edits required by the stated
  goal and the repository's existing ownership boundaries.
- Run the narrowest meaningful checks for the work you perform.
- Take the stable \`S<n>\` key from the step file's heading. Fully replace
  \`history/S<n>.md\` in the workflow workspace; create \`history/\` when
  needed.
- The history file must include: step title, \`Status: completed\` or
  \`Status: blocked\`, files or evidence produced, checks with outcomes, and
  remaining risks or blockers. A failed required check means blocked.
- Write the complete history Markdown for each step before continuing.
- Treat an existing credible \`Status: completed\` history as prior evidence,
  not an instruction to repeat project edits. Reinspect the live state and
  rerun or replace the narrow verification needed to prove the step remains
  complete. Replace stale or incomplete history with current evidence.
- On the first blocked step or failed required check, write its blocked history
  and stop. Do not start later steps.

After the final step completes, return one concise Markdown summary that lists
every \`S<n>\` status, the checks that establish the final outcome, and any
remaining risks. Do not return JSON.`,
    { label: "implementation", workspaceMode: "project" },
  );
}
