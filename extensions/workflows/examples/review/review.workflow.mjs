// review.workflow.mjs
// Agent-owned review pipeline. Agent identities, options, and prompt templates
// live in agents.yaml; this trusted entry module owns schemas and routing.

import { agentOptions, renderAgentPrompt, resultEnvelope } from "../review-family/review-config.mjs";

export const meta = {
  name: "review",
  description: "Runs agent review and publishes a reader report plus a human-gated fix plan.",
  identityCoverage: "entry-only",
};

const FINDING_SCHEMA = {
  type: "object",
  required: [
    "id",
    "title",
    "category",
    "scope",
    "severity",
    "file",
    "lineStart",
    "lineEnd",
    "evidence",
    "impact",
    "fix",
  ],
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    category: {
      type: "string",
      enum: ["correctness", "security", "architecture", "maintainability", "documentation", "testing"],
    },
    scope: { type: "string", enum: ["introduced", "pre-existing"] },
    severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
    file: { type: "string" },
    lineStart: { type: "number" },
    lineEnd: { type: "number" },
    evidence: { type: "string" },
    impact: { type: "string" },
    fix: { type: "string" },
  },
};

const TARGET_SCHEMA = {
  type: "object",
  required: ["status", "target", "snapshot", "summary", "question", "constraints"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["ready", "blocked"] },
    target: { type: "string" },
    snapshot: { type: "string" },
    summary: { type: "string" },
    question: { type: "string" },
    constraints: { type: "array", items: { type: "string" } },
  },
};

const PREVIOUS_FINDING_SCHEMA = {
  type: "object",
  required: ["claim", "classification", "evidence"],
  additionalProperties: false,
  properties: {
    claim: { type: "string" },
    classification: {
      type: "string",
      enum: ["current", "fixed", "stale", "other_branch", "not_reproduced"],
    },
    evidence: { type: "string" },
  },
};

const CHECK_SCHEMA = {
  type: "object",
  required: ["check", "status", "evidence"],
  additionalProperties: false,
  properties: {
    check: { type: "string" },
    status: { type: "string", enum: ["passed", "failed", "not_run"] },
    evidence: { type: "string" },
  },
};

const LANE_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "findings", "previousFindings", "checks", "reviewedFiles", "limitations"],
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "needs_changes", "blocked"] },
    summary: { type: "string" },
    findings: { type: "array", items: FINDING_SCHEMA },
    previousFindings: { type: "array", items: PREVIOUS_FINDING_SCHEMA },
    checks: { type: "array", items: CHECK_SCHEMA },
    reviewedFiles: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } },
  },
};

const REPORT_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "findings", "previousFindings", "checks", "reviewedFiles", "limitations"],
  additionalProperties: false,
  properties: LANE_SCHEMA.properties,
};

const PUBLISH_SCHEMA = {
  type: "object",
  required: [
    "status",
    "summary",
    "question",
    "taskId",
    "taskPath",
    "reportPath",
    "reportSha256",
    "fixPlanPath",
    "fixPlanSha256",
    "findingIds",
    "pendingCount",
  ],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string" },
    question: { type: "string" },
    taskId: { type: "string" },
    taskPath: { type: "string" },
    reportPath: { type: "string" },
    reportSha256: { type: "string" },
    fixPlanPath: { type: "string" },
    fixPlanSha256: { type: "string" },
    findingIds: { type: "array", items: { type: "string" } },
    pendingCount: { type: "number" },
  },
};

function targetPrompt(originalRequest) {
  return renderAgentPrompt("review", "targetResolver", {
    ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
    RESULT_ENVELOPE: resultEnvelope({
      status: "ready|blocked",
      target: "<exact resolved target or empty>",
      snapshot: "<resolved commit hashes or exact working-tree state, or empty>",
      summary: "<what was resolved and verified>",
      question: "<operator question or empty>",
      constraints: ["<repository rule or access constraint>"],
    }),
  });
}

function reviewPrompt(originalRequest, target, lane) {
  const agentName = lane === "changes" ? "changeReviewer" : "contextReviewer";
  return renderAgentPrompt("review", agentName, {
    ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
    TARGET_JSON: JSON.stringify(target, null, 2),
    RESULT_ENVELOPE: resultEnvelope({
      verdict: "pass|needs_changes|blocked",
      summary: "<one-line lane result>",
      findings: [
        {
          id: "F1",
          title: "<actionable title>",
          category: "correctness|security|architecture|maintainability|documentation|testing",
          scope: "introduced|pre-existing",
          severity: "P0|P1|P2|P3",
          file: "<repository-relative path>",
          lineStart: 1,
          lineEnd: 1,
          evidence: "<specific observed evidence>",
          impact: "<concrete impact>",
          fix: "<discrete fix>",
        },
      ],
      previousFindings: [
        {
          claim: "<previous finding named by the operator>",
          classification: "current|fixed|stale|other_branch|not_reproduced",
          evidence: "<current-target evidence for the classification>",
        },
      ],
      checks: [
        {
          check: "<independently attempted command or verification>",
          status: "passed|failed|not_run",
          evidence: "<observed result or reason not run>",
        },
      ],
      reviewedFiles: ["<repository-relative path>"],
      limitations: ["<unverified surface or none>"],
    }),
  });
}

function adjudicationPrompt(originalRequest, target, changesLane, contextLane) {
  return renderAgentPrompt("review", "adjudicator", {
    ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
    TARGET_JSON: JSON.stringify(target, null, 2),
    CHANGES_LANE_JSON: JSON.stringify(changesLane, null, 2),
    CONTEXT_LANE_JSON: JSON.stringify(contextLane, null, 2),
    RESULT_ENVELOPE: resultEnvelope({
      verdict: "pass|needs_changes|blocked",
      summary: "<final review summary>",
      findings: [
        {
          id: "F1",
          title: "<actionable title>",
          category: "correctness|security|architecture|maintainability|documentation|testing",
          scope: "introduced|pre-existing",
          severity: "P0|P1|P2|P3",
          file: "<repository-relative path>",
          lineStart: 1,
          lineEnd: 1,
          evidence: "<verified evidence>",
          impact: "<concrete impact>",
          fix: "<discrete fix>",
        },
      ],
      previousFindings: [
        {
          claim: "<previous finding named by the operator>",
          classification: "current|fixed|stale|other_branch|not_reproduced",
          evidence: "<verified current-target evidence>",
        },
      ],
      checks: [
        {
          check: "<independently attempted command or verification>",
          status: "passed|failed|not_run",
          evidence: "<observed result or reason not run>",
        },
      ],
      reviewedFiles: ["<repository-relative path>"],
      limitations: ["<unverified surface or none>"],
    }),
  });
}

function publishPrompt(originalRequest, target, review) {
  return renderAgentPrompt("review", "publisher", {
    ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
    TARGET_JSON: JSON.stringify(target, null, 2),
    REVIEW_JSON: JSON.stringify(review, null, 2),
    RESULT_ENVELOPE: resultEnvelope({
      status: "completed|blocked",
      summary: "<what was persisted and verified>",
      question: "<operator question or empty>",
      taskId: "<task id or empty>",
      taskPath: "<.tasks/.../task.md or empty>",
      reportPath: "<.tasks/.../artifacts/review.md or empty>",
      reportSha256: "<sha256 or empty>",
      fixPlanPath: "<.tasks/.../artifacts/fix-plan.md or empty>",
      fixPlanSha256: "<sha256 or empty>",
      findingIds: ["F1"],
      pendingCount: 1,
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

function failedStage(stage, result) {
  return {
    ok: false,
    status: result?.status === "blocked" ? "blocked" : "failed",
    summary: result?.summary ?? result?.diagnostics?.[0] ?? `Review agent did not complete the ${stage} stage.`,
    stoppedStage: stage,
    review: null,
    stages: { [stage]: stageEvidence(result) },
  };
}

export default async function runWorkflow(dsl, input) {
  const { agent, parallel, phase, log } = dsl;
  const originalRequest = typeof input === "string" ? input.trim() : "";
  const stages = {};

  phase("resolve-target");
  log("Delegating target resolution and access proof to an agent.");
  const targetResult = await agent(
    targetPrompt(originalRequest),
    agentOptions("review", "targetResolver", "TARGET_SCHEMA", TARGET_SCHEMA),
  );
  stages.target = stageEvidence(targetResult);
  if (!targetResult?.ok || !targetResult.output) {
    return { ...failedStage("resolve-target", targetResult), originalRequest, stages };
  }
  if (targetResult.output.status === "blocked") {
    return {
      ok: false,
      status: "blocked",
      summary: targetResult.output.summary,
      question: targetResult.output.question,
      stoppedStage: "resolve-target",
      originalRequest,
      target: targetResult.output,
      review: null,
      stages,
    };
  }

  phase("review");
  log("Running independent change and whole-context review agents.");
  const [changesResult, contextResult] = await parallel([
    () =>
      agent(
        reviewPrompt(originalRequest, targetResult.output, "changes"),
        agentOptions("review", "changeReviewer", "LANE_SCHEMA", LANE_SCHEMA),
      ),
    () =>
      agent(
        reviewPrompt(originalRequest, targetResult.output, "context"),
        agentOptions("review", "contextReviewer", "LANE_SCHEMA", LANE_SCHEMA),
      ),
  ]);
  stages.changes = stageEvidence(changesResult);
  stages.context = stageEvidence(contextResult);

  phase("adjudicate");
  log("Delegating evidence re-check and final findings to an adjudication agent.");
  const finalResult = await agent(
    adjudicationPrompt(originalRequest, targetResult.output, changesResult.output, contextResult.output),
    agentOptions("review", "adjudicator", "REPORT_SCHEMA", REPORT_SCHEMA),
  );
  stages.adjudication = stageEvidence(finalResult);
  if (!finalResult?.ok || !finalResult.output) {
    return { ...failedStage("adjudicate", finalResult), originalRequest, target: targetResult.output, stages };
  }

  const review = finalResult.output;
  phase("publish-report");
  log("Delegating review-task, report, and pending fix-plan publication to an agent.");
  const publishResult = await agent(
    publishPrompt(originalRequest, targetResult.output, review),
    agentOptions("review", "publisher", "PUBLISH_SCHEMA", PUBLISH_SCHEMA),
  );
  stages.publish = stageEvidence(publishResult);
  if (!publishResult?.ok || !publishResult.output) {
    return {
      ...failedStage("publish-report", publishResult),
      originalRequest,
      target: targetResult.output,
      verdict: review.verdict,
      review,
      stages,
    };
  }

  const publication = publishResult.output;
  const blocked = review.verdict === "blocked" || publication.status === "blocked";
  log(
    `Review verdict=${review.verdict} findings=${review.findings.length} report=${publication.reportPath || "blocked"}.`,
  );
  return {
    ok: !blocked,
    status: blocked ? "blocked" : "completed",
    summary:
      publication.status === "completed"
        ? `${review.summary} Report: ${publication.reportPath}${
            publication.fixPlanPath ? ` Approval plan: ${publication.fixPlanPath}` : ""
          }`
        : publication.summary,
    question: publication.question,
    originalRequest,
    target: targetResult.output,
    verdict: review.verdict,
    review,
    publication,
    stages,
  };
}
