// review-fix.workflow.mjs
// Human-gated remediation. Agent identities, options, and prompt templates live
// in agents.yaml; this trusted entry module owns schemas and routing.

import { agentOptions, renderAgentPrompt, resultEnvelope } from "../review-family/review-config.mjs";

export const meta = {
  name: "review-fix",
  description: "Applies only human-accepted review findings in a linked worktree and publishes verification.",
  identityCoverage: "entry-only",
};

const ACCEPTED_FINDING_SCHEMA = {
  type: "object",
  required: ["id", "title", "scope", "file"],
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    scope: { type: "string", enum: ["introduced", "pre-existing"] },
    file: { type: "string" },
  },
};

const APPROVED_PLAN_SCHEMA = {
  type: "object",
  required: [
    "status",
    "summary",
    "question",
    "taskId",
    "taskPath",
    "reviewPath",
    "reviewSha256",
    "fixPlanPath",
    "approvedPlanSha256",
    "target",
    "snapshot",
    "acceptedFindings",
    "ignoredFindingIds",
    "constraints",
  ],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["ready", "blocked"] },
    summary: { type: "string" },
    question: { type: "string" },
    taskId: { type: "string" },
    taskPath: { type: "string" },
    reviewPath: { type: "string" },
    reviewSha256: { type: "string" },
    fixPlanPath: { type: "string" },
    approvedPlanSha256: { type: "string" },
    target: { type: "string" },
    snapshot: { type: "string" },
    acceptedFindings: { type: "array", items: ACCEPTED_FINDING_SCHEMA },
    ignoredFindingIds: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
  },
};

const IMPLEMENTATION_SCHEMA = {
  type: "object",
  required: [
    "status",
    "summary",
    "question",
    "taskId",
    "worktreePath",
    "targetHeadBefore",
    "targetHeadAfter",
    "changedFiles",
    "fixedIds",
    "unresolvedIds",
    "checks",
  ],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["completed", "partial", "blocked"] },
    summary: { type: "string" },
    question: { type: "string" },
    taskId: { type: "string" },
    worktreePath: { type: "string" },
    targetHeadBefore: { type: "string" },
    targetHeadAfter: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    fixedIds: { type: "array", items: { type: "string" } },
    unresolvedIds: { type: "array", items: { type: "string" } },
    checks: { type: "array", items: { type: "string" } },
  },
};

const FIX_REPORT_SCHEMA = {
  type: "object",
  required: [
    "status",
    "summary",
    "question",
    "taskId",
    "worktreePath",
    "fixReportPath",
    "fixReportSha256",
    "fixedIds",
    "unresolvedIds",
    "checks",
  ],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["completed", "partial", "blocked"] },
    summary: { type: "string" },
    question: { type: "string" },
    taskId: { type: "string" },
    worktreePath: { type: "string" },
    fixReportPath: { type: "string" },
    fixReportSha256: { type: "string" },
    fixedIds: { type: "array", items: { type: "string" } },
    unresolvedIds: { type: "array", items: { type: "string" } },
    checks: { type: "array", items: { type: "string" } },
  },
};

function resolvePrompt(originalRequest) {
  return renderAgentPrompt("reviewFix", "planResolver", {
    ORIGINAL_REQUEST: originalRequest || "(use the only unambiguous review task with a fix-plan.md)",
    RESULT_ENVELOPE: resultEnvelope({
      status: "ready|blocked",
      summary: "<what was approved and verified>",
      question: "<operator question or empty>",
      taskId: "<task id or empty>",
      taskPath: "<.tasks/.../task.md or empty>",
      reviewPath: "<.tasks/.../artifacts/review.md or empty>",
      reviewSha256: "<sha256 or empty>",
      fixPlanPath: "<.tasks/.../artifacts/fix-plan.md or empty>",
      approvedPlanSha256: "<current sha256 or empty>",
      target: "<exact target or empty>",
      snapshot: "<exact reviewed snapshot or empty>",
      acceptedFindings: [
        {
          id: "F1",
          title: "<finding title>",
          scope: "introduced|pre-existing",
          file: "<repository-relative path>",
        },
      ],
      ignoredFindingIds: ["F2"],
      constraints: ["<repository or review constraint>"],
    }),
  });
}

function implementationPrompt(originalRequest, approvedPlan) {
  return renderAgentPrompt("reviewFix", "implementer", {
    ORIGINAL_REQUEST: originalRequest || "(apply every accepted finding and nothing else)",
    APPROVED_PLAN_JSON: JSON.stringify(approvedPlan, null, 2),
    RESULT_ENVELOPE: resultEnvelope({
      status: "completed|partial|blocked",
      summary: "<implementation outcome>",
      question: "<operator question or empty>",
      taskId: "<task id>",
      worktreePath: "<absolute linked worktree path or empty>",
      targetHeadBefore: "<commit sha or empty>",
      targetHeadAfter: "<same commit sha or empty>",
      changedFiles: ["<repository-relative path>"],
      fixedIds: ["F1"],
      unresolvedIds: [],
      checks: ["<command/check and observed result>"],
    }),
  });
}

function verificationPrompt(approvedPlan, implementation) {
  return renderAgentPrompt("reviewFix", "verifier", {
    APPROVED_PLAN_JSON: JSON.stringify(approvedPlan, null, 2),
    IMPLEMENTATION_JSON: JSON.stringify(implementation, null, 2),
    RESULT_ENVELOPE: resultEnvelope({
      status: "completed|partial|blocked",
      summary: "<verification and publication outcome>",
      question: "<operator question or empty>",
      taskId: "<task id>",
      worktreePath: "<absolute linked worktree path>",
      fixReportPath: "<.tasks/.../artifacts/fix-report.md>",
      fixReportSha256: "<sha256>",
      fixedIds: ["F1"],
      unresolvedIds: [],
      checks: ["<command/check and observed result>"],
    }),
  });
}

function stageEvidence(result) {
  return {
    ok: Boolean(result?.ok),
    status: result?.status ?? "failed",
    summary: result?.summary ?? null,
    childSessionId: result?.childSessionId ?? null,
    model: result?.model ?? null,
  };
}

function failedStage(stage, result, stages) {
  return {
    ok: false,
    status: result?.status === "blocked" ? "blocked" : "failed",
    summary: result?.summary ?? result?.diagnostics?.[0] ?? `Review-fix agent did not complete the ${stage} stage.`,
    stoppedStage: stage,
    stages,
  };
}

export default async function runWorkflow(dsl, input) {
  const { agent, phase, log } = dsl;
  const originalRequest = typeof input === "string" ? input.trim() : "";
  const stages = {};

  phase("resolve-approved-plan");
  log("Delegating review-task and human-disposition validation to an agent.");
  const resolveResult = await agent(
    resolvePrompt(originalRequest),
    agentOptions("reviewFix", "planResolver", "APPROVED_PLAN_SCHEMA", APPROVED_PLAN_SCHEMA),
  );
  stages.resolve = stageEvidence(resolveResult);
  if (!resolveResult?.ok || !resolveResult.output) {
    return { ...failedStage("resolve-approved-plan", resolveResult, stages), originalRequest };
  }
  if (resolveResult.output.status === "blocked") {
    return {
      ok: false,
      status: "blocked",
      summary: resolveResult.output.summary,
      question: resolveResult.output.question,
      stoppedStage: "resolve-approved-plan",
      originalRequest,
      approvedPlan: resolveResult.output,
      stages,
    };
  }

  phase("apply-accepted-findings");
  log("Delegating accepted fixes to an agent in a new linked worktree.");
  const implementationResult = await agent(
    implementationPrompt(originalRequest, resolveResult.output),
    agentOptions("reviewFix", "implementer", "IMPLEMENTATION_SCHEMA", IMPLEMENTATION_SCHEMA),
  );
  stages.implementation = stageEvidence(implementationResult);
  if (!implementationResult?.ok || !implementationResult.output) {
    return {
      ...failedStage("apply-accepted-findings", implementationResult, stages),
      originalRequest,
      approvedPlan: resolveResult.output,
    };
  }
  if (implementationResult.output.status === "blocked") {
    return {
      ok: false,
      status: "blocked",
      summary: implementationResult.output.summary,
      question: implementationResult.output.question,
      stoppedStage: "apply-accepted-findings",
      originalRequest,
      approvedPlan: resolveResult.output,
      implementation: implementationResult.output,
      stages,
    };
  }

  phase("verify-and-report");
  log("Delegating independent diff verification and fix-report publication to an agent.");
  const verificationResult = await agent(
    verificationPrompt(resolveResult.output, implementationResult.output),
    agentOptions("reviewFix", "verifier", "FIX_REPORT_SCHEMA", FIX_REPORT_SCHEMA),
  );
  stages.verification = stageEvidence(verificationResult);
  if (!verificationResult?.ok || !verificationResult.output) {
    return {
      ...failedStage("verify-and-report", verificationResult, stages),
      originalRequest,
      approvedPlan: resolveResult.output,
      implementation: implementationResult.output,
    };
  }

  const verification = verificationResult.output;
  const completed =
    implementationResult.output.status === "completed" &&
    verification.status === "completed" &&
    verification.unresolvedIds.length === 0;
  return {
    ok: completed,
    partial: !completed && verification.status === "partial",
    status: completed ? "completed" : verification.status,
    summary: verification.fixReportPath
      ? `${verification.summary} Report: ${verification.fixReportPath}`
      : verification.summary,
    question: verification.question,
    originalRequest,
    approvedPlan: resolveResult.output,
    implementation: implementationResult.output,
    verification,
    stages,
  };
}
