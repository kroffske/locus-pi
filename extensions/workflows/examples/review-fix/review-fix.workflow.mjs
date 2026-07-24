// review-fix.workflow.mjs
// The host supplies one immutable, digest-bound review artifact separately
// from the operator's text. A read-only selector agent proposes the remediation
// graph; deterministic code validates and orders it before any writer starts.

const REVIEW_FIX_AGENT_DEFAULTS = Object.freeze({
  maxToolCalls: 1_000,
  permissionMode: "agent-defined",
  workspaceMode: "project",
});

const MAX_SELECTED_FINDINGS = 20;
const MAX_INTENT_CHARS = 16_000;
const MAX_REVIEW_CHARS = 256_000;
const MAX_SCOPE_CHARS = 64_000;
const MAX_FINDING_BLOCK_CHARS = 32_000;
const MAX_SELECTED_FINDINGS_CHARS = 128_000;
const MAX_NOTE_CHARS = 8_000;
const MAX_ALL_NOTES_CHARS = 32_000;
const MAX_WORKER_RESULT_CHARS = 256_000;
const MAX_WORKER_EXCERPT_CHARS = 8_000;
const MAX_PREDECESSOR_CONTEXT_CHARS = 32_000;
const MAX_ALL_WORKER_CONTEXT_CHARS = 64_000;
const MAX_CHECK_EVIDENCE_CHARS = 32_000;
const MAX_RAW_CHECK_EVIDENCE_CHARS = 128_000;
const MAX_RE_REVIEW_CHARS = 256_000;

const FINDING_SELECTOR_SCHEMA = freezeSchema({
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "note", "dependsOn"],
        properties: {
          id: { type: "string" },
          note: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
});

function freezeSchema(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeSchema(child);
  return Object.freeze(value);
}

const FIX_SELECT_OPTIONS = Object.freeze({
  ...REVIEW_FIX_AGENT_DEFAULTS,
  readOnly: true,
  tools: [],
});

const FIX_READ_OPTIONS = Object.freeze({
  ...REVIEW_FIX_AGENT_DEFAULTS,
  readOnly: true,
  tools: ["read", "git_read", "ast_index", "grep", "find"],
});

const FIX_CHECK_OPTIONS = Object.freeze({
  ...REVIEW_FIX_AGENT_DEFAULTS,
  readOnly: true,
  maxToolCalls: 40,
  tools: ["read", "git_read", "ast_index", "repository_check", "grep", "find"],
});

export const meta = {
  name: "review-fix",
  description:
    "Plans a validated remediation graph from one continued review, applies one writer per finding, then independently re-reviews the result.",
  identityCoverage: "self-contained-static",
  phases: [
    { title: "resolve-fix-scope", detail: "Consume the immutable review and validate an agent-planned finding DAG." },
    { title: "apply-kept-findings", detail: "Run exactly one sequential write-capable agent per selected finding." },
    { title: "collect-check-evidence", detail: "Inspect the full diff and run repository checks without edit tools." },
    { title: "re-review-fixes", detail: "Freshly re-review every original finding and affected dependency read-only." },
  ],
};

/**
 * IDE-only type link: no runtime import is executed.
 * @param {import("../../../_shared/workflow-runtime.ts").WorkflowDsl} dsl
 * @param {string | undefined} input
 */
export default async function runWorkflow(dsl, input) {
  const { agent, captureSourceState, log, phase, promptFile } = dsl;
  const intent = requireBoundedText(input, "intent", MAX_INTENT_CHARS);
  const sourceProvenance = [];

  phase("resolve-fix-scope");
  log("Binding the immutable review and validating an agent-selected remediation graph.");
  let expectedState = captureSourceState("before-remediation");
  const continuation = dsl.continuationArtifacts();
  if (continuation.length !== 1 || continuation[0]?.sourceRef?.name !== "review.md") {
    throw new Error('review-fix continuation requires exactly one artifact named "review.md"');
  }
  const reviewRef = continuation[0].sourceRef;
  const consumedReview = continuation[0].consumedArtifact;
  requireReviewArtifact(consumedReview, reviewRef);
  const reviewText = requireBoundedText(consumedReview.text, "consumed review", MAX_REVIEW_CHARS);
  const findings = parseFindingBlocks(reviewText);
  const selectorPrompt = await promptFile("./resources/selector-planner.prompt.md", {
    OPERATOR_INTENT: intent,
    ORIGINAL_REVIEW: reviewText,
  });
  const selection = await agent(selectorPrompt, {
    ...FIX_SELECT_OPTIONS,
    artifact: "finding-plan.json",
    label: "plan finding graph",
    schema: FINDING_SELECTOR_SCHEMA,
  });
  const selected = validateAndOrderFindingPlan(findings, selection);
  const selectedText = requireBoundedText(
    selected.map(({ block, note, dependsOn }) => renderFindingInput(block, note, dependsOn)).join("\n\n"),
    "selected finding handoff",
    MAX_SELECTED_FINDINGS_CHARS,
  );
  const scopePrompt = await promptFile("./resources/scope-resolver.prompt.md", {
    OPERATOR_INTENT: intent,
    SELECTED_FINDINGS: selectedText,
  });
  const scopeText = requireBoundedText(
    await agent(scopePrompt, {
      ...FIX_READ_OPTIONS,
      artifact: "scope.md",
      label: "resolve fix scope",
    }),
    "scope handoff",
    MAX_SCOPE_CHARS,
  );

  phase("apply-kept-findings");
  log("Applying each kept finding with one sequential write-capable agent.");
  const workerResults = [];
  const blockedFindingIds = new Set();
  const writerFailures = [];
  for (const [index, finding] of selected.entries()) {
    const failedDependencies = finding.dependsOn.filter((id) => blockedFindingIds.has(id));
    if (failedDependencies.length > 0) {
      blockedFindingIds.add(finding.id);
      log(`Skipping finding ${finding.id}: blocked by failed dependency ${failedDependencies.join(", ")}.`);
      continue;
    }
    const beforeWriter = captureSourceState(`before-writer-${finding.id.toLowerCase()}`);
    sourceProvenance.push(
      classifySourceTransition(
        expectedState,
        beforeWriter,
        index === 0 ? "unexpected_pre_writer_drift" : "unexpected_inter_writer_drift",
      ),
    );
    const workerPrompt = await promptFile("./resources/implementer.prompt.md", {
      OPERATOR_INTENT: intent,
      SCOPE_TEXT: scopeText,
      FINDING_BLOCK: finding.block,
      FINDING_NOTE: finding.note ?? "(no operator note)",
      PREDECESSOR_RESULTS: renderDependencyResults(workerResults, finding.dependsOn),
      SOURCE_STATE_PROVENANCE: renderSourceProvenance(sourceProvenance, beforeWriter),
    });
    try {
      const text = requireBoundedText(
        await agent(workerPrompt, {
          ...REVIEW_FIX_AGENT_DEFAULTS,
          artifact: `worker-${finding.id}.md`,
          label: `apply finding ${finding.id}`,
          tools: ["read", "write", "edit", "bash", "ast_index", "grep", "find"],
        }),
        `worker ${finding.id} result`,
        MAX_WORKER_RESULT_CHARS,
      );
      workerResults.push({ id: finding.id, text });
    } catch (error) {
      blockedFindingIds.add(finding.id);
      writerFailures.push({ id: finding.id, error });
    }
    const afterWriter = captureSourceState(`after-writer-${finding.id.toLowerCase()}`);
    sourceProvenance.push(classifySourceTransition(beforeWriter, afterWriter, "writer_window_changed"));
    expectedState = afterWriter;
  }
  if (writerFailures.length > 0) throw writerFailures[0].error;

  phase("collect-check-evidence");
  log("Collecting independent diff evidence and running bounded checks in host-created disposable worktrees.");
  const beforeCheck = captureSourceState("before-check");
  sourceProvenance.push(classifySourceTransition(expectedState, beforeCheck, "unexpected_post_writer_drift"));
  const checkPrompt = await promptFile("./resources/check-evidence.prompt.md", {
    OPERATOR_INTENT: intent,
    SCOPE_TEXT: scopeText,
    WORKER_RESULTS: renderWorkerResults(workerResults, MAX_ALL_WORKER_CONTEXT_CHARS),
    SOURCE_STATE_PROVENANCE: renderSourceProvenance(sourceProvenance, beforeCheck),
  });
  const checkText = requireBoundedText(
    await agent(checkPrompt, {
      ...FIX_CHECK_OPTIONS,
      artifact: "check-evidence.md",
      label: "collect check evidence",
    }),
    "check evidence",
    MAX_RAW_CHECK_EVIDENCE_CHARS,
  );
  const afterCheck = captureSourceState("after-check");
  sourceProvenance.push(classifySourceTransition(beforeCheck, afterCheck, "unexpected_check_window_drift"));

  phase("re-review-fixes");
  log("Freshly re-reviewing the original findings, worker claims, dependencies, and regressions.");
  const beforeReReview = captureSourceState("before-re-review");
  sourceProvenance.push(classifySourceTransition(afterCheck, beforeReReview, "unexpected_post_check_drift"));
  const reReviewPrompt = await promptFile("./resources/re-review.prompt.md", {
    OPERATOR_INTENT: intent,
    ORIGINAL_REVIEW: reviewText,
    SCOPE_TEXT: scopeText,
    WORKER_RESULTS: renderWorkerResults(workerResults, MAX_ALL_WORKER_CONTEXT_CHARS),
    CHECK_EVIDENCE: truncateText(checkText, MAX_CHECK_EVIDENCE_CHARS),
    SOURCE_STATE_PROVENANCE: renderSourceProvenance(sourceProvenance, beforeReReview),
  });
  return requireBoundedText(
    await agent(reReviewPrompt, {
      ...FIX_READ_OPTIONS,
      artifact: "re-review.md",
      label: "re-review fixes",
    }),
    "re-review result",
    MAX_RE_REVIEW_CHARS,
  );
}

function requireReviewArtifact(consumed, sourceRef) {
  const source = consumed?.source;
  const target = source?.target;
  const artifact = source?.artifact;
  const terminal = source?.terminal;
  const projectedRefs = Array.isArray(terminal?.artifactRefs) ? terminal.artifactRefs : [];
  const projectedRef = projectedRefs.find((ref) => sameArtifactRef(ref, sourceRef));
  const terminalRef = projectedRefs.at(-1);
  if (
    source?.runId !== sourceRef?.runId ||
    target?.kind !== "name" ||
    target?.ref !== "review" ||
    target?.source !== "package" ||
    artifact?.kind !== "answer" ||
    artifact?.stage !== "verify-review" ||
    consumed?.ref?.name !== "review.md" ||
    terminal?.result !== consumed?.text ||
    projectedRef === undefined ||
    !sameArtifactRef(terminalRef, sourceRef)
  ) {
    throw new Error('review-fix reviewRef must be the terminal Package review verify-review answer named "review.md"');
  }
}

function sameArtifactRef(left, right) {
  return (
    left?.runId === right?.runId &&
    left?.artifactId === right?.artifactId &&
    left?.name === right?.name &&
    left?.sha256 === right?.sha256
  );
}

function parseFindingBlocks(reviewText) {
  const section = /^##[ \t]+Findings[ \t]*$/mu.exec(reviewText);
  if (section === null) throw new Error('review-fix review.md has no "## Findings" section');
  const afterHeading = section.index + section[0].length;
  const tail = reviewText.slice(afterHeading);
  const nextSection = /^##[ \t]+/mu.exec(tail);
  const body = nextSection === null ? tail : tail.slice(0, nextSection.index);
  const headings = [...body.matchAll(/^###[ \t]+([^\n]+)$/gmu)];
  if (headings.length === 0) throw new Error("review-fix found no findings in review.md");

  const findings = headings.map((heading, index) => {
    const idMatch = /^(F[1-9][0-9]*)(?:\s|—|-|$)/u.exec(heading[1].trim());
    if (idMatch === null) throw new Error(`review-fix invalid finding heading: ${heading[1].trim()}`);
    const start = heading.index;
    const end = headings[index + 1]?.index ?? body.length;
    return {
      id: idMatch[1],
      block: requireBoundedText(body.slice(start, end).trimEnd(), `finding ${idMatch[1]}`, MAX_FINDING_BLOCK_CHARS),
    };
  });
  const duplicate = findings.find(({ id }, index) => findings.findIndex((finding) => finding.id === id) !== index);
  if (duplicate !== undefined) throw new Error(`review-fix duplicate finding id in review.md: ${duplicate.id}`);
  return findings;
}

function validateAndOrderFindingPlan(findings, value) {
  if (!isRecord(value) || !Array.isArray(value.findings)) {
    throw new Error("review-fix selector result must contain findings");
  }
  if (value.findings.length < 1 || value.findings.length > MAX_SELECTED_FINDINGS) {
    throw new Error(`review-fix selector must choose 1-${MAX_SELECTED_FINDINGS} findings`);
  }

  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const originalOrder = new Map(findings.map((finding, index) => [finding.id, index]));
  const selectedIds = new Set();
  let allNotesChars = 0;
  const selected = value.findings.map((unit) => {
    if (!isRecord(unit)) throw new Error("review-fix selector finding must be an object");
    const { id, note, dependsOn } = unit;
    if (typeof id !== "string" || !/^F[1-9][0-9]*$/u.test(id)) {
      throw new Error(`review-fix selector finding id is invalid: ${String(id)}`);
    }
    if (!byId.has(id)) throw new Error(`review-fix selector finding id is unknown: ${id}`);
    if (selectedIds.has(id)) throw new Error(`review-fix selector repeats finding id: ${id}`);
    selectedIds.add(id);
    if (typeof note !== "string") throw new Error(`review-fix selector note for ${id} must be a string`);
    if (note.length > MAX_NOTE_CHARS) {
      throw new Error(`review-fix selector note for ${id} exceeds ${MAX_NOTE_CHARS} characters`);
    }
    allNotesChars += note.length;
    if (!Array.isArray(dependsOn)) throw new Error(`review-fix selector dependsOn for ${id} must be an array`);
    return { ...byId.get(id), id, note, dependsOn: [...dependsOn] };
  });
  if (allNotesChars > MAX_ALL_NOTES_CHARS) {
    throw new Error(`review-fix selector notes exceed ${MAX_ALL_NOTES_CHARS} combined characters`);
  }

  for (const unit of selected) {
    const edgeIds = new Set();
    for (const dependency of unit.dependsOn) {
      if (typeof dependency !== "string" || !/^F[1-9][0-9]*$/u.test(dependency)) {
        throw new Error(`review-fix selector dependency for ${unit.id} is invalid: ${String(dependency)}`);
      }
      if (dependency === unit.id) throw new Error(`review-fix selector finding ${unit.id} depends on itself`);
      if (edgeIds.has(dependency)) {
        throw new Error(`review-fix selector repeats dependency ${dependency} for ${unit.id}`);
      }
      edgeIds.add(dependency);
      if (!byId.has(dependency)) {
        throw new Error(`review-fix selector dependency is unknown: ${dependency}`);
      }
      if (!selectedIds.has(dependency)) {
        throw new Error(`review-fix selector dependency ${dependency} is not selected`);
      }
    }
  }

  const bySelectedId = new Map(selected.map((unit) => [unit.id, unit]));
  const indegree = new Map(selected.map((unit) => [unit.id, unit.dependsOn.length]));
  const dependents = new Map(selected.map((unit) => [unit.id, []]));
  for (const unit of selected) {
    for (const dependency of unit.dependsOn) dependents.get(dependency).push(unit.id);
  }
  const compareOriginalOrder = (left, right) => originalOrder.get(left) - originalOrder.get(right);
  const ready = selected
    .filter((unit) => indegree.get(unit.id) === 0)
    .map((unit) => unit.id)
    .sort(compareOriginalOrder);
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(bySelectedId.get(id));
    for (const dependent of dependents.get(id).sort(compareOriginalOrder)) {
      const next = indegree.get(dependent) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort(compareOriginalOrder);
      }
    }
  }
  if (ordered.length !== selected.length) throw new Error("review-fix selector dependency graph contains a cycle");
  return ordered;
}

function renderFindingInput(block, note, dependsOn) {
  return `${block}\nPlanner note: ${note || "(none)"}\nDepends on: ${dependsOn.length === 0 ? "(none)" : dependsOn.join(", ")}`;
}

function renderDependencyResults(results, dependencyIds) {
  if (dependencyIds.length === 0) return "(none; this finding has no direct dependencies)";
  const byId = new Map(results.map((result) => [result.id, result]));
  const dependencies = dependencyIds.map((id) => {
    const result = byId.get(id);
    if (result === undefined) throw new Error(`review-fix dependency result is missing: ${id}`);
    return result;
  });
  return renderWorkerResults(dependencies, MAX_PREDECESSOR_CONTEXT_CHARS);
}

function renderWorkerResults(results, maxChars) {
  if (results.length === 0) return "(none)";
  const headerChars = results.reduce((total, { id }) => total + `## Worker ${id}\n`.length + 2, 0);
  const perWorkerLimit = Math.max(
    256,
    Math.min(MAX_WORKER_EXCERPT_CHARS, Math.floor((maxChars - headerChars) / results.length)),
  );
  return truncateText(
    results.map(({ id, text }) => `## Worker ${id}\n${truncateText(text, perWorkerLimit)}`).join("\n\n"),
    maxChars,
  );
}

function classifySourceTransition(expected, observed, changedClassification) {
  const changed = expected.fingerprint !== observed.fingerprint;
  return {
    fromFingerprint: expected.fingerprint,
    toFingerprint: observed.fingerprint,
    changed,
    classification: changed ? changedClassification : "stable",
    fromHead: expected.head,
    toHead: observed.head,
  };
}

function renderSourceProvenance(transitions, current) {
  const transitionText = transitions.length === 0 ? "(none)" : JSON.stringify(transitions, null, 2);
  const status = current.status.length === 0 ? ["(clean)"] : current.status.slice(0, 40);
  return [
    transitionText,
    "",
    "Current host-owned source state:",
    JSON.stringify(
      {
        fingerprint: current.fingerprint,
        head: current.head,
        status,
        omittedStatusEntries: Math.max(0, current.status.length - status.length),
      },
      null,
      2,
    ),
  ].join("\n");
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const marker = `\n...[truncated by review-fix host contract; original chars=${text.length}]`;
  return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function requireBoundedText(value, field, maxChars) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`review-fix ${field} must be a non-empty string`);
  }
  if (value.length > maxChars) {
    throw new Error(`review-fix ${field} exceeds the ${maxChars}-character context limit`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
