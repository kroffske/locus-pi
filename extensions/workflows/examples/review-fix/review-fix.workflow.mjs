// review-fix.workflow.mjs
// Deterministic code validates the explicit approval artifact before any
// write-capable child or linked worktree exists.

import { loadApprovedReviewPlan, verifyApprovedReviewPlan } from "./review-fix-plan.mjs";

export const meta = {
  name: "review-fix",
  description: "Applies only human-accepted review findings in one retained linked worktree.",
  identityCoverage: "entry-only",
};

export default async function runWorkflow(dsl, input) {
  const { agent, phase, log, projectRoot, promptFile, workspace } = dsl;

  phase("validate-approved-plan");
  log("Validating the explicit fix-plan.md and immutable review evidence.");
  const plan = loadApprovedReviewPlan(projectRoot(), input);
  verifyApprovedReviewPlan(plan);

  phase("allocate-workspace");
  log("Allocating one retained linked worktree at the reviewed head.");
  const workspaceHandle = await workspace(`review-fix-${plan.taskId}`, plan.headCommit);
  verifyApprovedReviewPlan(plan);

  phase("apply-accepted-findings");
  log("Applying only accepted findings in the runtime-owned workspace.");
  const implementationText = await agent(
    await promptFile("./resources/implementer.prompt.md", {
      TASK_ID: plan.taskId,
      TARGET: plan.target,
      SNAPSHOT: plan.snapshot,
      REVIEW_SHA256: plan.reviewSha256,
      FIX_PLAN_SHA256: plan.fixPlanSha256,
      ACCEPTED_FINDING_IDS: plan.acceptedFindingIds.join(", "),
      IGNORED_FINDING_IDS: plan.ignoredFindingIds.join(", ") || "(none)",
      REVIEW_TEXT: plan.reviewText,
      FIX_PLAN_TEXT: plan.fixPlanText,
    }),
    {
      agentFile: "./resources/implementer.agent.md",
      label: "apply accepted review fixes",
      maxToolCalls: 100,
      workspaceHandle,
    },
  );
  verifyApprovedReviewPlan(plan);

  phase("verify-and-report");
  log("Independently verifying the same workspace and publishing fix-report.md.");
  const verificationText = await agent(
    await promptFile("./resources/verifier.prompt.md", {
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
    }),
    {
      agentFile: "./resources/verifier.agent.md",
      label: "verify review fixes and publish report",
      maxToolCalls: 100,
      workspaceHandle,
    },
  );
  verifyApprovedReviewPlan(plan);
  return verificationText;
}
