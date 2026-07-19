// review-fix.workflow.mjs
// Deterministic code validates the explicit approval artifact before any
// write-capable child or linked worktree exists.
//
// `agentFile` selects the agent definition; `promptFile()` renders its task.
// The shared `workspaceHandle` selects one worktree, so these calls do not set
// a separate static workspaceMode.

import { loadApprovedReviewPlan, verifyApprovedReviewPlan } from "./review-fix-plan.mjs";

const REVIEW_FIX_AGENT_DEFAULTS = Object.freeze({
  maxToolCalls: 1_000,
});

export const meta = {
  name: "review-fix",
  description: "Applies only human-accepted review findings in one retained linked worktree.",
  identityCoverage: "entry-only",
};

/**
 * IDE-only type link: no runtime import is executed.
 * @param {import("../../../_shared/workflow-runtime.ts").WorkflowDsl} dsl
 * @param {unknown} input
 */
export default async function runWorkflow(dsl, input) {
  const { agent, phase, log, projectRoot, promptFile, workspace } = dsl;

  // Stage 1: prove that the human-edited fix plan still matches immutable review evidence.
  phase("validate-approved-plan");
  log("Validating the explicit fix-plan.md and immutable review evidence.");
  const plan = loadApprovedReviewPlan(projectRoot(), input);
  verifyApprovedReviewPlan(plan);

  // Stage 2: allocate one worktree at the reviewed commit and retain only its opaque handle.
  phase("allocate-workspace");
  log("Allocating one retained linked worktree at the reviewed head.");
  const workspaceHandle = await workspace(`review-fix-${plan.taskId}`, plan.headCommit);
  verifyApprovedReviewPlan(plan);

  // Stage 3: apply only findings whose human disposition is `accepted`.
  phase("apply-accepted-findings");
  log("Applying only accepted findings in the runtime-owned workspace.");
  const implementerPrompt = await promptFile("./resources/implementer.prompt.md", {
    TASK_ID: plan.taskId,
    TARGET: plan.target,
    SNAPSHOT: plan.snapshot,
    REVIEW_SHA256: plan.reviewSha256,
    FIX_PLAN_SHA256: plan.fixPlanSha256,
    ACCEPTED_FINDING_IDS: plan.acceptedFindingIds.join(", "),
    IGNORED_FINDING_IDS: plan.ignoredFindingIds.join(", ") || "(none)",
    REVIEW_TEXT: plan.reviewText,
    FIX_PLAN_TEXT: plan.fixPlanText,
  });
  const implementationText = await agent(implementerPrompt, {
    ...REVIEW_FIX_AGENT_DEFAULTS,
    agentFile: "./resources/implementer.agent.md",
    label: "apply accepted review fixes",
    workspaceHandle,
  });
  verifyApprovedReviewPlan(plan);

  // Stage 4: independently inspect the same worktree and publish fix-report.md.
  phase("verify-and-report");
  log("Independently verifying the same workspace and publishing fix-report.md.");
  const verifierPrompt = await promptFile("./resources/verifier.prompt.md", {
    PROJECT_ROOT: plan.projectRoot,
    TASK_ID: plan.taskId,
    TASK_PATH: plan.taskPath,
    FIX_REPORT_PATH: plan.fixReportPath,
    TARGET: plan.target,
    SNAPSHOT: plan.snapshot,
    WORKSPACE_HEAD: plan.headCommit,
    REVIEW_SHA256: plan.reviewSha256,
    FIX_PLAN_SHA256: plan.fixPlanSha256,
    ACCEPTED_FINDING_IDS: plan.acceptedFindingIds.join(", "),
    IGNORED_FINDING_IDS: plan.ignoredFindingIds.join(", ") || "(none)",
    REVIEW_TEXT: plan.reviewText,
    FIX_PLAN_TEXT: plan.fixPlanText,
    IMPLEMENTATION_TEXT: implementationText,
  });
  const verificationText = await agent(verifierPrompt, {
    ...REVIEW_FIX_AGENT_DEFAULTS,
    agentFile: "./resources/verifier.agent.md",
    label: "verify review fixes and publish report",
    workspaceHandle,
  });
  verifyApprovedReviewPlan(plan);
  return verificationText;
}
