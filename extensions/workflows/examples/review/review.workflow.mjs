// review.workflow.mjs
// Six catalog-agent sessions exchange readable text. Each neighboring prompt
// owns both the stable role and the dynamic handoff for one stage.
//
// `promptFile()` renders the complete task for this run.
// Agent options enforce capabilities; prompt text never acts as a sandbox.
// `phase()` changes the visible/journal stage; `log()` explains the work inside it.

const REVIEW_AGENT_DEFAULTS = Object.freeze({
  maxToolCalls: 1_000,
  permissionMode: "agent-defined",
  workspaceMode: "project",
});

// Scope resolution and inventory only need Git and file reads.
const REVIEW_READ_OPTIONS = Object.freeze({
  ...REVIEW_AGENT_DEFAULTS,
  readOnly: true,
  tools: ["read", "git_read", "grep", "find"],
});

// Unit planning, interrogation, and verification also trace code symbols.
// `ast_index` is an allowlisted argv tool; a missing binary or index is a
// visible tool error and the prompts fall back to grep/find.
const REVIEW_NAVIGATE_OPTIONS = Object.freeze({
  ...REVIEW_AGENT_DEFAULTS,
  readOnly: true,
  tools: ["read", "git_read", "ast_index", "grep", "find"],
});

const REVIEW_PUBLISH_OPTIONS = Object.freeze({
  ...REVIEW_AGENT_DEFAULTS,
  tools: ["read", "write", "bash", "grep", "find"],
});

export const meta = {
  name: "review",
  description: "Runs a question-led agent review and publishes a readable review package plus an executive summary.",
  // Declared shape, read statically by /workflows info before any run starts.
  // Titles must equal the phase() calls below; a test enforces that.
  phases: [
    { title: "resolve-scope", detail: "Turn the operator request into one explicit, self-contained review scope." },
    { title: "inventory-changes", detail: "Prove complete coverage of the changed surface." },
    { title: "plan-units", detail: "Group the inventory into atomic units of meaning." },
    { title: "ask-questions", detail: "Write falsifiable questions per unit, without answering them." },
    { title: "verify-review", detail: "Reopen the evidence, answer the questions, and author the report." },
    { title: "publish-review", detail: "Write the review package and return an executive summary." },
  ],
};

/**
 * IDE-only type link: no runtime import is executed.
 * @param {import("../../../_shared/workflow-runtime.ts").WorkflowDsl} dsl
 * @param {unknown} input
 */
export default async function runWorkflow(dsl, input) {
  const { agent, phase, log, promptFile } = dsl;
  const originalRequest = typeof input === "string" ? input.trim() : "";

  // Stage 1: turn free-form operator intent into one explicit review scope.
  phase("resolve-scope");
  log("Resolving the review scope from the operator request.");
  const scopePrompt = await promptFile("./resources/scope-resolver.prompt.md", {
    ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
  });
  const scopeText = await agent(scopePrompt, {
    ...REVIEW_READ_OPTIONS,
    label: "resolve review scope",
  });

  // Stage 2: prove coverage of the changed surface before grouping anything.
  phase("inventory-changes");
  log("Inventorying every changed surface in the resolved scope.");
  const inventoryPrompt = await promptFile("./resources/change-inventory.prompt.md", {
    SCOPE_TEXT: scopeText,
  });
  const inventoryText = await agent(inventoryPrompt, {
    ...REVIEW_READ_OPTIONS,
    label: "inventory changes",
  });

  // Stage 3: group the inventory into material decisions, not into files.
  phase("plan-units");
  log("Grouping the inventory into material review units.");
  const unitsPrompt = await promptFile("./resources/unit-planner.prompt.md", {
    SCOPE_TEXT: scopeText,
    INVENTORY_TEXT: inventoryText,
  });
  const unitsText = await agent(unitsPrompt, {
    ...REVIEW_NAVIGATE_OPTIONS,
    label: "plan review units",
  });

  // Stage 4: ask the falsifiable questions that could change acceptance.
  phase("ask-questions");
  log("Formulating falsifiable questions for every review unit.");
  const questionsPrompt = await promptFile("./resources/interrogator.prompt.md", {
    SCOPE_TEXT: scopeText,
    UNITS_TEXT: unitsText,
  });
  const questionsText = await agent(questionsPrompt, {
    ...REVIEW_NAVIGATE_OPTIONS,
    label: "ask review questions",
  });

  // Stage 5: reopen the evidence, answer every question, and write the review.
  phase("verify-review");
  log("Independently verifying the questions and writing the review.");
  const verifierPrompt = await promptFile("./resources/verifier.prompt.md", {
    SCOPE_TEXT: scopeText,
    UNITS_TEXT: unitsText,
    QUESTIONS_TEXT: questionsText,
  });
  const reviewText = await agent(verifierPrompt, {
    ...REVIEW_NAVIGATE_OPTIONS,
    label: "verify and write review",
  });

  // Stage 6: the only write-capable session publishes and presents the result.
  phase("publish-review");
  log("Publishing the review package and returning the executive summary.");
  const publisherPrompt = await promptFile("./resources/publisher.prompt.md", {
    SCOPE_TEXT: scopeText,
    INVENTORY_TEXT: inventoryText,
    UNITS_TEXT: unitsText,
    QUESTIONS_TEXT: questionsText,
    REVIEW_TEXT: reviewText,
  });
  return agent(publisherPrompt, {
    ...REVIEW_PUBLISH_OPTIONS,
    label: "publish review package",
  });
}
