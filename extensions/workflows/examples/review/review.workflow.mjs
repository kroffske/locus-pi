// review.workflow.mjs
// Five workflow-local agents exchange readable text. The coordinator owns only
// stage order; it never parses model text for verdicts, ids, paths, or status.

export const meta = {
  name: "review",
  description: "Runs independent agent review and publishes a reader report plus a human-gated fix plan.",
  identityCoverage: "entry-only",
};

export default async function runWorkflow(dsl, input) {
  const { agent, parallel, phase, log, promptFile } = dsl;
  const originalRequest = typeof input === "string" ? input.trim() : "";

  phase("resolve-target");
  log("Resolving the exact review target.");
  const targetText = await agent(
    await promptFile("./resources/target-resolver.prompt.md", {
      ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
    }),
    {
      agentFile: "./resources/target-resolver.agent.md",
      label: "resolve review target",
      maxToolCalls: 80,
      workspaceMode: "project",
    },
  );

  phase("review");
  log("Running independent change and whole-context review agents.");
  const [changesText, contextText] = await parallel([
    async () =>
      agent(
        await promptFile("./resources/change-review.prompt.md", {
          ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
          TARGET_TEXT: targetText,
        }),
        {
          agentFile: "./resources/change-review.agent.md",
          label: "review introduced changes",
          maxToolCalls: 100,
          workspaceMode: "project",
        },
      ),
    async () =>
      agent(
        await promptFile("./resources/context-review.prompt.md", {
          ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
          TARGET_TEXT: targetText,
        }),
        {
          agentFile: "./resources/context-review.agent.md",
          label: "review whole-file context",
          maxToolCalls: 100,
          workspaceMode: "project",
        },
      ),
  ]);

  phase("adjudicate");
  log("Re-checking and reconciling both review lanes.");
  const adjudicatedText = await agent(
    await promptFile("./resources/adjudicator.prompt.md", {
      ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
      TARGET_TEXT: targetText,
      CHANGES_TEXT: changesText,
      CONTEXT_TEXT: contextText,
    }),
    {
      agentFile: "./resources/adjudicator.agent.md",
      label: "adjudicate review findings",
      maxToolCalls: 100,
      workspaceMode: "project",
    },
  );

  phase("publish-report");
  log("Publishing review.md and the optional human approval plan.");
  return agent(
    await promptFile("./resources/publisher.prompt.md", {
      ORIGINAL_REQUEST: originalRequest || "(no explicit target supplied)",
      TARGET_TEXT: targetText,
      REVIEW_TEXT: adjudicatedText,
    }),
    {
      agentFile: "./resources/publisher.agent.md",
      label: "publish review report",
      maxToolCalls: 80,
      workspaceMode: "project",
    },
  );
}
