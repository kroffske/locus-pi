# Structured results and same-session format repair

Start with plain `agent()` text for a report, review or narrative handoff. Running
commands or writing files does not by itself require structured output. Add a
contract only when the next consumer needs one: `choice` for code branching,
`handoffs` for independently scheduled discovered work units, or `output` for an
actual string-format requirement. Raw `schema` remains compatibility-only.

When a structured result follows commands or file writes, use
`returnVia: "tool"` for same-session correction. A schema-only echo selects no
value and must not become success. Do not parse Markdown fences or ask a fresh
worker to rediscover facts solely because the first answer has the wrong shape.

For example, rejecting a complete 37,000-character review because a guessed
singleton `handoffs` contract allows only 32,000 is an authoring defect. Raising
that number to another guess preserves the defect. The review should return
plain text; a separate routing decision retains its real contract:

```js
const review = await agent(`Review the proposed change against its acceptance criteria.\n${input}`, {
  label: "review",
  title: "Review the proposed change",
});
const decision = await agent(`Decide whether the acceptance criteria are met.\n${input}\n${review}`, {
  label: "acceptance",
  title: "Check acceptance",
  choice: ["ready", "blocked"],
  returnVia: "tool",
});
```

The load-bearing distinction is prose versus code-consumed control, not these
labels or this number of agents. Add a separate decision only if the graph needs
to branch. A real output limit names its consumer, unit and source; ordinary
narrative needs no author-selected cap. Keep platform safety budgets under their
runtime owner, and never silently truncate complete work to pass validation.

Extend the existing workflow_return path, not a second return tool. Format clarification stays in the same child session and uses bounded attempts and cumulative resources. Semantic improvement is a fresh worker with the original goal and exact feedback. A successful proposal followed by cancellation/provider failure is not an accepted result.

Shape validity does not prove factual correctness. A required verifier remains required. An unknown field is not a verified absence; a missing verifier is not a clean decision. Reused answers are marked as reused, not given invented new child receipts. See the canonical [output acceptance contract](../../../extensions/workflows/references/output-acceptance.md) for currently supported combinations and exact limits.
