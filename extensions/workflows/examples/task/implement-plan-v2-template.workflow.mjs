// task/implement-plan-v2-template.workflow.mjs
//
// Renders one reviewable implement-plan.workflow.mjs from the already approved
// plan.md and step-<n>.md catalog in the selected planning workspace. V2 keeps
// the normal literal step graph and adds one bounded agent-owned recovery path
// per blocked step. It does
// not plan, replan, implement, or run the generated file.

export const meta = {
  name: "task/implement-plan-v2-template",
  profile: "standard",
  description: "Renders implement-plan-v2.workflow.mjs with one bounded agent-owned recovery per blocked step.",
  phases: [
    {
      title: "render",
      detail: "One agent applies the fixed template to the approved plan and ordered step catalog.",
    },
    {
      title: "publish",
      detail: "Publish implement-plan.workflow.mjs without running it.",
    },
  ],
};

export default async function runWorkflow(dsl) {
  const { agent, log, phase, promptFile, publishPrimaryFile } = dsl;

  phase("render");
  log("Agent rendering: applying the implement-plan template to the approved step catalog.");
  const implementPlanV2Template = await promptFile("./resources/implement-plan-v2-template.prompt.md");
  await agent(implementPlanV2Template, { label: "render-plan-v2", workspaceMode: "project" });

  phase("publish");
  publishPrimaryFile("implement-plan-v2.workflow.mjs");
  return `The approved plan has been rendered and nothing has been executed.

Review implement-plan-v2.workflow.mjs in the workflow workspace. It contains
one literal normal implementation node per step-<n>.md file in catalog order.
Each blocked step gets one recovery agent, one read-only recovery reviewer, and
one retry before terminal failure. A summary node runs only after every step
completes.

Running the generated file is a separate explicit act. Use its exact path and
the same planning workspace. Workflow JavaScript runs in Pi's main Node.js
process with full filesystem, subprocess, and network authority, so read the
file before running it.`;
}
