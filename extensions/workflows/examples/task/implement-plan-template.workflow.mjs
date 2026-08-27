// task/implement-plan-template.workflow.mjs
//
// Renders one reviewable implement-plan.workflow.mjs from the already approved
// plan.md and step-<n>.md catalog in the selected planning workspace. It does
// not plan, replan, implement, or run the generated file.

export const meta = {
  name: "task/implement-plan-template",
  profile: "standard",
  description: "Renders implement-plan.workflow.mjs from an approved plan and its ordered step files.",
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
  const implementPlanTemplate = await promptFile("./resources/implement-plan-template.prompt.md");
  await agent(implementPlanTemplate, { label: "render-plan", workspaceMode: "project" });

  phase("publish");
  publishPrimaryFile("implement-plan.workflow.mjs");
  return `The approved plan has been rendered and nothing has been executed.

Review implement-plan.workflow.mjs in the workflow workspace. It contains one
literal implementation node per step-<n>.md file in catalog order, each with a
single bounded blocked-repair branch, followed by one summary node.

Running the generated file is a separate explicit act. Use its exact path and
the same planning workspace. Workflow JavaScript runs in Pi's main Node.js
process with full filesystem, subprocess, and network authority, so read the
file before running it.`;
}
