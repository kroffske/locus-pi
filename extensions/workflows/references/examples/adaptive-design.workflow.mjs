export const meta = {
  name: "adaptive-design",
  description: "Design and review a slice plan, then return it to the owner without implementation",
  profile: "standard",
};
export default async function runWorkflow(dsl, input) {
  const design = await dsl.agent(
    `Design the smallest complete change for the task. SOURCES: task directory ${input}; read task.md, referenced evidence, repository instructions and real source. ` +
      "Write artifacts/design-proposal.md under the task directory with proposed behavior, owners, constraints, ordered slices, acceptance evidence and open decisions. Return its path and open questions. " +
      "Keep each slice independently reviewable. Explain what may change when the remaining plan is re-cut. Do not implement.",
    { label: "design", title: "Design the change and initial slices" },
  );
  const review = await dsl.agent(
    `Independently review this design against the task and real source. SOURCES: task directory ${input}. Design:\n${design}\n` +
      "Read the full proposed design. Write artifacts/design-review.md under the task directory with confirmed defects, missing acceptance evidence and owner decisions. Check all required work fits the slices. Return its path and findings. Do not implement.",
    { label: "design-review", title: "Review the proposed design" },
  );
  const proposal = await dsl.agent(
    `Reconcile the design review. SOURCES: task directory ${input}. Design:\n${design}\nReview:\n${review}\n` +
      "Read the full design and review. Produce the complete revised design, disposition of findings, slice plan and unresolved owner questions. " +
      "Write the same proposal to artifacts/design.md under the task directory. The owner records acceptance of its exact revision and scope in artifacts/design-acceptance.md; do not write that acceptance yourself. Return the final design path, open questions and acceptance instructions. Do not claim acceptance or implement.",
    { label: "reconcile", title: "Prepare the owner proposal" },
  );
  const evidence = dsl.publishPrimaryArtifact("design-handoff.md", proposal);
  // Manual cross-workflow handoff: this command is guidance, never automatic execution or approval.
  return {
    ok: true,
    status: "needs_owner",
    summary: "Review this design and record acceptance of its exact revision before launching implementation.",
    design: evidence,
    review,
    next_command: "/workflows run adaptive-slices -- <task-directory>",
  };
}
