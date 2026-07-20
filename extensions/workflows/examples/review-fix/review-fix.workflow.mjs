// review-fix.workflow.mjs
// Deterministic code extracts and confines the operator-supplied review path
// and proves it still lists findings. Five sequential agents then mirror the
// `review` shape: interpret intent, plan units, act, verify, publish.
//
// Each `promptFile()` call renders the complete stable role and dynamic task.
// Agent options enforce capabilities; prompt text never acts as a sandbox.

import { loadReviewFixRequest } from "./review-fix-input.mjs";

const REVIEW_FIX_AGENT_DEFAULTS = Object.freeze({
  maxToolCalls: 1_000,
  permissionMode: "agent-defined",
  workspaceMode: "project",
});

// Scope resolution reads the report and repository state only.
const FIX_READ_OPTIONS = Object.freeze({
  ...REVIEW_FIX_AGENT_DEFAULTS,
  readOnly: true,
  tools: ["read", "git_read", "grep", "find"],
});

// Unit planning also traces code symbols, with a grep/find fallback.
const FIX_NAVIGATE_OPTIONS = Object.freeze({
  ...REVIEW_FIX_AGENT_DEFAULTS,
  readOnly: true,
  tools: ["read", "git_read", "ast_index", "grep", "find"],
});

// Verification must run repository checks, so it keeps a shell. It is not
// host-enforced read-only; its no-edit rule is a prompt rule plus Pi approval.
const FIX_VERIFY_OPTIONS = Object.freeze({
  ...REVIEW_FIX_AGENT_DEFAULTS,
  tools: ["read", "ast_index", "bash", "grep", "find"],
});

export const meta = {
  name: "review-fix",
  description: "Applies the findings a human kept in review.md, after revalidating each one against live source.",
  identityCoverage: "entry-only",
};

/**
 * IDE-only type link: no runtime import is executed.
 * @param {import("../../../_shared/workflow-runtime.ts").WorkflowDsl} dsl
 * @param {unknown} input
 */
export default async function runWorkflow(dsl, input) {
  const { agent, phase, log, projectRoot, promptFile } = dsl;

  // Stage 1: confine the review path and refuse an empty finding list.
  phase("resolve-review");
  log("Resolving the human-edited review.md and its remaining findings.");
  const request = loadReviewFixRequest(projectRoot(), input);

  // Stage 2: turn the operator request and edited report into one fix scope.
  phase("resolve-fix-scope");
  log("Resolving which remaining findings this run should address.");
  const scopePrompt = await promptFile("./resources/scope-resolver.prompt.md", {
    ORIGINAL_REQUEST: request.originalRequest,
    REVIEW_PATH: request.reviewPath,
    FINDING_IDS: request.findingIds.join(", "),
    REVIEW_TEXT: request.reviewText,
  });
  const scopeText = await agent(scopePrompt, {
    ...FIX_READ_OPTIONS,
    label: "resolve fix scope",
  });

  // Stage 3: revalidate every in-scope finding and group it into fix units.
  phase("plan-fix-units");
  log("Revalidating the in-scope findings and planning atomic fix units.");
  const unitsPrompt = await promptFile("./resources/unit-planner.prompt.md", {
    SCOPE_TEXT: scopeText,
    REVIEW_TEXT: request.reviewText,
  });
  const unitsText = await agent(unitsPrompt, {
    ...FIX_NAVIGATE_OPTIONS,
    label: "plan fix units",
  });

  // Stage 4: apply the planned units in the operator's launch checkout.
  phase("apply-fix-units");
  log("Applying the planned fix units in the launch checkout.");
  const implementerPrompt = await promptFile("./resources/implementer.prompt.md", {
    SCOPE_TEXT: scopeText,
    UNITS_TEXT: unitsText,
    REVIEW_TEXT: request.reviewText,
  });
  const implementationText = await agent(implementerPrompt, {
    ...REVIEW_FIX_AGENT_DEFAULTS,
    label: "apply fix units",
    tools: ["read", "write", "edit", "bash", "grep", "find"],
  });

  // Stage 5: independently reopen the diff, run checks, and author the report.
  phase("verify-fixes");
  log("Independently verifying the applied changes and writing the fix report.");
  const verifierPrompt = await promptFile("./resources/verifier.prompt.md", {
    SCOPE_TEXT: scopeText,
    UNITS_TEXT: unitsText,
    IMPLEMENTATION_TEXT: implementationText,
  });
  const reportText = await agent(verifierPrompt, {
    ...FIX_VERIFY_OPTIONS,
    label: "verify fixes and write report",
  });

  // Stage 6: publish the package beside the review and present the result.
  phase("publish-fix-report");
  log("Publishing the fix package and returning the executive summary.");
  const publisherPrompt = await promptFile("./resources/publisher.prompt.md", {
    ARTIFACTS_PATH: request.artifactsPath,
    FIX_REPORT_PATH: request.fixReportPath,
    SCOPE_TEXT: scopeText,
    UNITS_TEXT: unitsText,
    REPORT_TEXT: reportText,
  });
  return agent(publisherPrompt, {
    ...REVIEW_FIX_AGENT_DEFAULTS,
    label: "publish fix package",
    tools: ["read", "write", "bash", "grep", "find"],
  });
}
