// review.workflow.mjs
// Five workflow-local agents exchange readable text. The coordinator owns only
// stage order; it never parses model text for verdicts, ids, paths, or status.
//
// `agentFile` selects the agent definition (role, instructions, and tools).
// `promptFile()` renders that agent's task for this run, including prior-stage text.
// `phase()` changes the visible/journal stage; `log()` explains the work inside it.

const REVIEW_AGENT_DEFAULTS = Object.freeze({
  maxToolCalls: 1_000,
  workspaceMode: "project",
});

export const meta = {
  name: "review",
  description: "Runs independent agent review and publishes a reader report plus a human-gated fix plan.",
  identityCoverage: "entry-only",
};

/**
 * IDE-only type link: no runtime import is executed.
 * @param {import("../../../_shared/workflow-runtime.ts").WorkflowDsl} dsl
 * @param {unknown} input
 */
export default async function runWorkflow(dsl, input) {
  const { agent, parallel, phase, log, promptFile } = dsl;
  const originalRequest = typeof input === "string" ? input.trim() : "";

  // Stage 1: resolve one exact, immutable review target for all later agents.
  phase("resolve-target");
  log("Resolving the exact review target.");
  const targetPrompt = await promptFile("./resources/target-resolver.prompt.md", {
    ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
  });
  const targetText = await agent(targetPrompt, {
    ...REVIEW_AGENT_DEFAULTS,
    agentFile: "./resources/target-resolver.agent.md",
    label: "resolve review target",
  });

  // Stage 2: inspect the introduced diff and whole-file context independently.
  phase("independent-review");
  log("Running independent change and whole-context review agents.");
  const [changesText, contextText] = await parallel([
    async () => {
      const changesPrompt = await promptFile("./resources/change-review.prompt.md", {
        ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
        TARGET_TEXT: targetText,
      });
      return agent(changesPrompt, {
        ...REVIEW_AGENT_DEFAULTS,
        agentFile: "./resources/change-review.agent.md",
        label: "review introduced changes",
      });
    },
    async () => {
      const contextPrompt = await promptFile("./resources/context-review.prompt.md", {
        ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
        TARGET_TEXT: targetText,
      });
      return agent(contextPrompt, {
        ...REVIEW_AGENT_DEFAULTS,
        agentFile: "./resources/context-review.agent.md",
        label: "review whole-file context",
      });
    },
  ]);

  // Stage 3: reopen the target, verify both reports, and remove duplicate claims.
  phase("adjudicate");
  log("Re-checking and reconciling both review lanes.");
  const adjudicatorPrompt = await promptFile("./resources/adjudicator.prompt.md", {
    ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
    TARGET_TEXT: targetText,
    CHANGES_TEXT: changesText,
    CONTEXT_TEXT: contextText,
  });
  const adjudicatedText = await agent(adjudicatorPrompt, {
    ...REVIEW_AGENT_DEFAULTS,
    agentFile: "./resources/adjudicator.agent.md",
    label: "adjudicate review findings",
  });

  // Stage 4: let the only write-capable review agent publish durable artifacts.
  phase("publish-report");
  log("Publishing review.md and the optional human approval plan.");
  const publisherPrompt = await promptFile("./resources/publisher.prompt.md", {
    ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
    TARGET_TEXT: targetText,
    REVIEW_TEXT: adjudicatedText,
  });
  return agent(publisherPrompt, {
    ...REVIEW_AGENT_DEFAULTS,
    agentFile: "./resources/publisher.agent.md",
    label: "publish review report",
  });
}
