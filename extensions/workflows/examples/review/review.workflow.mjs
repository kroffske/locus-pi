// review.workflow.mjs
//
// Human intent arrives only as text. A clarifier agent decides whether the
// review can continue or must pause. Cross-run state arrives only through the
// host-owned, digest-verified continuation context.

const REVIEW_AGENT_DEFAULTS = Object.freeze({
  maxToolCalls: 1_000,
  permissionMode: "agent-defined",
  workspaceMode: "project",
});

const MAX_INTENT_CHARS = 16_000;
const MAX_CLARIFICATION_QUESTIONS_CHARS = 32_000;
const MAX_CLARIFICATION_ANSWERS_CHARS = 16_000;
const MAX_CLARIFICATION_CONTEXT_CHARS = 64_000;
const MAX_SCOPE_CHARS = 64_000;
const MAX_INVENTORY_CHARS = 128_000;
const MAX_UNITS_CHARS = 128_000;
const MAX_QUESTIONS_CHARS = 128_000;
const MAX_REVIEW_CHARS = 256_000;

const CLARIFIER_SCHEMA = freezeSchema({
  type: "object",
  additionalProperties: false,
  required: ["decision", "questions"],
  properties: {
    decision: { type: "string", enum: ["continue", "needs_operator"] },
    questions: { type: "array", items: { type: "string" } },
  },
});

function freezeSchema(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeSchema(child);
  return Object.freeze(value);
}

const REVIEW_READ_OPTIONS = Object.freeze({
  ...REVIEW_AGENT_DEFAULTS,
  readOnly: true,
  tools: ["read", "git_read", "grep", "find"],
});

const REVIEW_NAVIGATE_OPTIONS = Object.freeze({
  ...REVIEW_AGENT_DEFAULTS,
  readOnly: true,
  tools: ["read", "git_read", "ast_index", "grep", "find"],
});

export const meta = {
  name: "review",
  description: "Prepares clarification or runs a read-only question-led review with runtime-owned artifacts.",
  phases: [
    { title: "prepare-clarification", detail: "Persist the exact intent and prepare clarification questions." },
    { title: "consume-clarification", detail: "Verify prior-run intent and question references and persist answers." },
    { title: "resolve-scope", detail: "Turn the exact intent and clarification into one review scope." },
    { title: "inventory-changes", detail: "Prove complete coverage of the changed surface." },
    { title: "plan-units", detail: "Group the inventory into atomic units of meaning." },
    { title: "ask-questions", detail: "Write falsifiable review questions per unit, without answering them." },
    { title: "verify-review", detail: "Reopen the evidence, answer the questions, and author review.md." },
  ],
};

function requireNonEmptyText(value, field, maxChars = MAX_INTENT_CHARS) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`review ${field} must be a non-empty string`);
  }
  if (value.length > maxChars) {
    throw new Error(`review ${field} exceeds the ${maxChars}-character context limit`);
  }
  return value;
}

function inventoryCoverageIds(inventoryText) {
  const ids = [...inventoryText.matchAll(/^##[ \t]+(C[1-9][0-9]*)[ \t]*$/gmu)].map((match) => match[1]);
  if (ids.length === 0) throw new Error("review inventory has no C<n> coverage headings");
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) throw new Error(`review inventory repeats coverage id ${duplicate}`);
  return ids;
}

function requireExactUnitCoverage(unitsText, expectedIds) {
  const assignments = new Map();
  const headings = [...unitsText.matchAll(/^##[ \t]+(U[1-9][0-9]*)[ \t]*$/gmu)];
  for (const [index, heading] of headings.entries()) {
    const sectionStart = heading.index + heading[0].length;
    const sectionEnd = headings[index + 1]?.index ?? unitsText.length;
    const section = unitsText.slice(sectionStart, sectionEnd);
    for (const match of section.matchAll(/^Coverage:[ \t]*([^\n]+)$/gmu)) {
      for (const token of match[1].split(",").map((value) => value.trim())) {
        if (!/^C[1-9][0-9]*$/u.test(token)) {
          throw new Error(`review units contain invalid coverage token ${JSON.stringify(token)}`);
        }
        if (assignments.has(token)) {
          throw new Error(`review units assign coverage id ${token} more than once`);
        }
        assignments.set(token, heading[1]);
      }
    }
  }
  if (assignments.size === 0) throw new Error("review units have no Coverage: C<n> ledger");
  const expected = new Set(expectedIds);
  for (const [id] of assignments) {
    if (!expected.has(id)) throw new Error(`review units contain unknown coverage id ${id}`);
  }
  const missing = expectedIds.find((id) => !assignments.has(id));
  if (missing !== undefined) throw new Error(`review units dropped inventory coverage id ${missing}`);
  return assignments;
}

function requireCoverageSection(text, heading, assignments, field) {
  const sectionMatch = new RegExp(`^##[ \\t]+${heading.replaceAll(" ", "[ \\t]+")}[ \\t]*$`, "mu").exec(text);
  if (sectionMatch === null) throw new Error(`review ${field} has no ${heading} section`);
  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const nextHeading = /^##[ \t]+/gmu;
  nextHeading.lastIndex = sectionStart;
  const nextMatch = nextHeading.exec(text);
  const section = text.slice(sectionStart, nextMatch?.index ?? text.length);
  const ledger = new Map();
  for (const line of section
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)) {
    const match = /^(C[1-9][0-9]*):[ \t]+(.+)$/u.exec(line);
    if (match === null) {
      if (/\bC[1-9][0-9]*\b/u.test(line)) {
        throw new Error(`review ${field} has malformed coverage ledger line ${JSON.stringify(line)}`);
      }
      continue;
    }
    const [, id, detail] = match;
    if (!assignments.has(id)) throw new Error(`review ${field} contains unknown coverage id ${id}`);
    if (ledger.has(id)) throw new Error(`review ${field} repeats coverage id ${id}`);
    const expectedUnit = assignments.get(id);
    const units = [...detail.matchAll(/\bU[1-9][0-9]*\b/gu)].map((unit) => unit[0]);
    if (!units.includes(expectedUnit)) {
      throw new Error(`review ${field} assigns coverage id ${id} to the wrong unit`);
    }
    ledger.set(id, detail);
  }
  const missing = [...assignments.keys()].find((id) => !ledger.has(id));
  if (missing !== undefined) throw new Error(`review ${field} dropped inventory coverage id ${missing}`);
}

function sameArtifactRef(left, right) {
  if (
    typeof left !== "object" ||
    left === null ||
    Array.isArray(left) ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(right)
  ) {
    return false;
  }
  const allowedFields = ["runId", "artifactId", "name", "sha256"];
  if (
    Object.keys(left).some((field) => !allowedFields.includes(field)) ||
    Object.keys(right).some((field) => !allowedFields.includes(field))
  ) {
    return false;
  }
  return allowedFields.every((field) => typeof left[field] === "string" && left[field] === right[field]);
}

function exactPrepareResult(result, intentRef, questionsRef) {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const fields = Object.keys(result);
  if (fields.length !== 3 || fields.some((field) => !["mode", "intentRef", "questionsRef"].includes(field))) {
    return false;
  }
  return (
    result.mode === "prepared" &&
    sameArtifactRef(result.intentRef, intentRef) &&
    sameArtifactRef(result.questionsRef, questionsRef)
  );
}

function requirePrepareArtifact(consumed, sourceRef, expectedName, intentRef, questionsRef) {
  const source = consumed?.source;
  const target = source?.target;
  const artifact = source?.artifact;
  const terminal = source?.terminal;
  const projectedRefs = Array.isArray(terminal?.artifactRefs) ? terminal.artifactRefs : [];
  if (
    source?.runId !== sourceRef?.runId ||
    target?.kind !== "name" ||
    target?.ref !== "review" ||
    target?.source !== "package" ||
    artifact?.kind !== "published" ||
    artifact?.stage !== "prepare-clarification" ||
    consumed?.ref?.name !== expectedName ||
    !exactPrepareResult(terminal?.result, intentRef, questionsRef) ||
    !projectedRefs.some((ref) => sameArtifactRef(ref, sourceRef))
  ) {
    throw new Error(
      `review execute ${expectedName} reference must come from the verified terminal result of a Package review prepare-clarification run`,
    );
  }
}

function requireClarifierDecision(value) {
  const questions = value?.questions;
  if (!Array.isArray(questions)) throw new Error("review clarifier questions must be an array");
  if (value.decision === "continue") {
    if (questions.length !== 0) throw new Error("review clarifier continue decision requires no questions");
    return { decision: "continue", questions: [] };
  }
  if (value.decision !== "needs_operator") throw new Error("review clarifier decision is invalid");
  if (questions.length < 1 || questions.length > 8) {
    throw new Error("review clarifier needs_operator decision requires 1-8 questions");
  }
  const normalized = questions.map((question, index) => {
    if (typeof question !== "string" || question.trim() === "") {
      throw new Error(`review clarification question ${index + 1} must be non-blank`);
    }
    if (question.length > 1_000) {
      throw new Error(`review clarification question ${index + 1} exceeds 1000 characters`);
    }
    return question;
  });
  if (new Set(normalized.map((question) => question.trim())).size !== normalized.length) {
    throw new Error("review clarification questions must be unique");
  }
  if (normalized.reduce((total, question) => total + question.length, 0) > 4_000) {
    throw new Error("review clarification questions exceed 4000 combined characters");
  }
  return { decision: "needs_operator", questions: normalized };
}

async function decideClarification(dsl, intentText) {
  const { agent, phase, log, promptFile, publishArtifact, awaitOperator } = dsl;

  phase("prepare-clarification");
  log("Asking a read-only clarifier whether the exact operator intent is executable.");
  const prompt = await promptFile("./resources/clarifier.prompt.md", {
    INTENT_TEXT: intentText,
  });
  const decision = requireClarifierDecision(
    await agent(prompt, {
      ...REVIEW_READ_OPTIONS,
      label: "decide clarification",
      artifact: "clarifier-decision.json",
      schema: CLARIFIER_SCHEMA,
    }),
  );
  if (decision.decision === "continue") return decision;

  const intentRef = publishArtifact("intent.md", intentText);
  const questionsText = [
    "# Clarification Questions",
    "",
    ...decision.questions.map((question, index) => `${index + 1}. ${question}`),
  ].join("\n");
  const questionsRef = publishArtifact("clarification-questions.md", questionsText);
  awaitOperator({ reason: "review clarification required" });
  return { decision: "needs_operator", result: { mode: "prepared", intentRef, questionsRef } };
}

function consumeClarification(dsl, answers) {
  const pairs = dsl.continuationArtifacts();
  if (pairs.length !== 2) {
    throw new Error("review continuation requires exactly intent.md and clarification-questions.md");
  }
  const byName = new Map(pairs.map((pair) => [pair.sourceRef.name, pair]));
  if (byName.size !== 2 || !byName.has("intent.md") || !byName.has("clarification-questions.md")) {
    throw new Error("review continuation requires exactly intent.md and clarification-questions.md");
  }
  const intentPair = byName.get("intent.md");
  const questionsPair = byName.get("clarification-questions.md");
  const intentRef = intentPair.sourceRef;
  const questionsRef = questionsPair.sourceRef;
  const { phase, log, publishArtifact } = dsl;
  phase("consume-clarification");
  log("Verifying the prepare-run references and persisting operator answers.");
  const intent = intentPair.consumedArtifact;
  const questions = questionsPair.consumedArtifact;
  requirePrepareArtifact(intent, intentRef, "intent.md", intentRef, questionsRef);
  requirePrepareArtifact(questions, questionsRef, "clarification-questions.md", intentRef, questionsRef);
  const intentText = requireNonEmptyText(intent.text, "consumed intent");
  const questionsText = requireNonEmptyText(
    questions.text,
    "consumed clarification questions",
    MAX_CLARIFICATION_QUESTIONS_CHARS,
  );
  const answersText = requireNonEmptyText(answers, "clarification answers", MAX_CLARIFICATION_ANSWERS_CHARS);
  publishArtifact("clarification-answers.md", answersText);
  const clarificationText = [
    "--- BEGIN CLARIFICATION QUESTIONS ---",
    questionsText,
    "--- END CLARIFICATION QUESTIONS ---",
    "",
    "--- BEGIN OPERATOR ANSWERS ---",
    answersText,
    "--- END OPERATOR ANSWERS ---",
  ].join("\n");
  requireNonEmptyText(clarificationText, "combined clarification", MAX_CLARIFICATION_CONTEXT_CHARS);
  return {
    intentText,
    clarificationText,
  };
}

async function runFullReview(dsl, intentText, clarificationText, persistIntent = false) {
  const { agent, phase, log, promptFile, publishArtifact } = dsl;
  requireNonEmptyText(intentText, "intent");
  requireNonEmptyText(clarificationText, "clarification context", MAX_CLARIFICATION_CONTEXT_CHARS);

  phase("resolve-scope");
  if (persistIntent) publishArtifact("intent.md", intentText);
  log("Resolving the review scope from the exact operator intent.");
  const scopePrompt = await promptFile("./resources/scope-resolver.prompt.md", {
    INTENT_TEXT: intentText,
    CLARIFICATION_TEXT: clarificationText,
  });
  const scopeText = requireNonEmptyText(
    await agent(scopePrompt, {
      ...REVIEW_READ_OPTIONS,
      label: "resolve review scope",
      artifact: "scope.md",
    }),
    "scope handoff",
    MAX_SCOPE_CHARS,
  );

  phase("inventory-changes");
  log("Inventorying every changed surface in the resolved scope.");
  const inventoryPrompt = await promptFile("./resources/change-inventory.prompt.md", {
    INTENT_TEXT: intentText,
    SCOPE_TEXT: scopeText,
  });
  const inventoryText = requireNonEmptyText(
    await agent(inventoryPrompt, {
      ...REVIEW_READ_OPTIONS,
      label: "inventory changes",
      artifact: "inventory.md",
    }),
    "inventory handoff",
    MAX_INVENTORY_CHARS,
  );
  const coverageIds = inventoryCoverageIds(inventoryText);

  phase("plan-units");
  log("Grouping the inventory into material review units.");
  const unitsPrompt = await promptFile("./resources/unit-planner.prompt.md", {
    INTENT_TEXT: intentText,
    SCOPE_TEXT: scopeText,
    INVENTORY_TEXT: inventoryText,
  });
  const unitsText = requireNonEmptyText(
    await agent(unitsPrompt, {
      ...REVIEW_NAVIGATE_OPTIONS,
      label: "plan review units",
      artifact: "units.md",
    }),
    "units handoff",
    MAX_UNITS_CHARS,
  );
  const unitAssignments = requireExactUnitCoverage(unitsText, coverageIds);

  phase("ask-questions");
  log("Formulating falsifiable questions for every review unit.");
  const questionsPrompt = await promptFile("./resources/interrogator.prompt.md", {
    INTENT_TEXT: intentText,
    SCOPE_TEXT: scopeText,
    INVENTORY_TEXT: inventoryText,
    UNITS_TEXT: unitsText,
  });
  const questionsText = requireNonEmptyText(
    await agent(questionsPrompt, {
      ...REVIEW_NAVIGATE_OPTIONS,
      label: "ask review questions",
      artifact: "questions.md",
    }),
    "questions handoff",
    MAX_QUESTIONS_CHARS,
  );
  requireCoverageSection(questionsText, "Coverage reconciliation", unitAssignments, "questions handoff");

  phase("verify-review");
  log("Independently verifying the questions and writing the review.");
  const verifierPrompt = await promptFile("./resources/verifier.prompt.md", {
    INTENT_TEXT: intentText,
    SCOPE_TEXT: scopeText,
    INVENTORY_TEXT: inventoryText,
    UNITS_TEXT: unitsText,
    QUESTIONS_TEXT: questionsText,
  });
  const reviewText = requireNonEmptyText(
    await agent(verifierPrompt, {
      ...REVIEW_NAVIGATE_OPTIONS,
      label: "verify and write review",
      artifact: "review.md",
    }),
    "final review",
    MAX_REVIEW_CHARS,
  );
  requireCoverageSection(reviewText, "Coverage and limits", unitAssignments, "final review");
  return reviewText;
}

/**
 * IDE-only type link: no runtime import is executed.
 * @param {import("../../../_shared/workflow-runtime.ts").WorkflowDsl} dsl
 * @param {string | undefined} input
 */
export default async function runWorkflow(dsl, input) {
  const continuation = dsl.continuationArtifacts();
  if (continuation.length > 0) {
    const prepared = consumeClarification(dsl, input);
    return runFullReview(dsl, prepared.intentText, prepared.clarificationText);
  }

  const intentText = requireNonEmptyText(input, "intent");
  const clarification = await decideClarification(dsl, intentText);
  if (clarification.decision === "needs_operator") return clarification.result;
  return runFullReview(dsl, intentText, "The clarifier found no blocking operator decision.", true);
}
