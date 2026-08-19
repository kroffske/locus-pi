// task-via-script.workflow.mjs
//
// The one-run planning route: run the full task/plan pipeline as this
// workflow's own planning stage, then render the sequential
// implement.workflow.mjs from the approved planning files in the same
// workspace. JavaScript owns the one saved-child call, one runtime-owned
// readiness choice, and the single rendering agent call.
//
// Nothing is executed here. The generated script is a reviewable draft that
// resolves only by explicit path; running it is the owner's separate, explicit
// act after reading it. When planning fails closed, no script is rendered.

export const meta = {
  name: "task-via-script",
  profile: "standard",
  description: "Runs its own task/plan pipeline, then renders implement.workflow.mjs from the planned files.",
  phases: [
    { title: "planning", detail: "The full task/plan pipeline runs as this workflow's own planning stage." },
    { title: "route", detail: "A runtime choice renders only when the planning stage published a ready plan." },
    {
      title: "scripting",
      detail: "One agent renders implement.workflow.mjs from the fixed template and the step files.",
    },
    {
      title: "publish",
      detail: "Publish implement.workflow.mjs, or the planning blocker when planning failed closed.",
    },
  ],
};

const CHILD_KEYS = ["plan"];

export default async function runWorkflow(dsl, input) {
  const { agent, invokeWorkflow, log, outputDir, phase, promptFile, publishPrimaryFile } = dsl;

  phase("planning");
  log("Running the task/plan pipeline as this workflow's own planning stage.");
  await invokeWorkflow({
    name: "task/plan",
    key: "plan",
    keys: CHILD_KEYS,
    input,
    outputDir: outputDir(),
  });

  phase("route");
  const readiness = await agent(
    `Route the task-via-script planning result.

Read the current planning files in the injected workflow workspace. Return
render only when plan.md exists, at least step-1.md exists, and
verification.md from this planning run ends with 'Conclusion: ready'. Return
blocked when planning-blocker.md is the planning result, verification.md
concludes blocked, or the step catalog is missing. Do not write files and do
not explain the choice.`,
    {
      label: "route",
      choice: ["render", "blocked"],
      choiceFallback: "blocked",
    },
  );

  if (readiness === "blocked") {
    log("Planning failed closed; publishing the blocker instead of a script.");
    publishPrimaryFile("planning-blocker.md");
    return `Planning finished BLOCKED, so no script was rendered and nothing has been executed. This run stops here.

Read planning-blocker.md in the workflow workspace: it names what failed and
what to change. Edit the task statement or the planning files on disk, then
rerun task-via-script on the same workspace; neither the planning stage nor
this workflow waits for an operator answer mid-run.`;
  }

  phase("scripting");
  log("Agent scripting: rendering implement.workflow.mjs from the fixed template.");
  const implementTemplate = await promptFile("./resources/implement-template.prompt.md");
  await agent(implementTemplate, { label: "scripting", workspaceMode: "project" });

  phase("publish");
  publishPrimaryFile("implement.workflow.mjs");
  return `Planning and rendering are complete and nothing has been executed. This run stops here.

Review the files in the workflow workspace shown in the completion card:
- plan.md and the step-<n>.md catalog — this run's own planning result, with analysis/, reviews/, and verification.md as its evidence trail
- implement.workflow.mjs — one implementation node per step-<n>.md file, in catalog order, each step block carried verbatim

Running the generated script is the owner's separate explicit act, by explicit path: /workflows run <workflow workspace>/implement.workflow.mjs. Workflow JavaScript runs in Pi's main Node.js process with full filesystem, subprocess, and network authority — read the file before running it. Rendering is not approval to run.`;
}
