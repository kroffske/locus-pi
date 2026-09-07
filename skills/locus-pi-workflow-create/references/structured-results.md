# Structured results and same-session format repair

Supported: exact `choice`, closed string `output`, `handoffs` and compatibility `schema` all go through the one `workflow_return` tool with `returnVia: "tool"`; strict standard source may use choice, output and handoffs, while raw `schema` stays compatibility-only.

Choose a choice for one routing decision, complete handoffs for independent worker instructions, and a schema record for several fields. Keep the payload limited to what downstream code needs; a bound on one answer is not a platform-wide agent cap. Do not parse Markdown fences or ask a second worker to rediscover facts solely because the first response has the wrong shape.

Extend the existing workflow_return path, not a second return tool. Format clarification stays in the same child session and uses bounded attempts and cumulative resources. Semantic improvement is a fresh worker with the original goal and exact feedback. A successful proposal followed by cancellation/provider failure is not an accepted result.

Shape validity does not prove factual correctness. A required verifier remains required. An unknown field is not a verified absence; a missing verifier is not a clean decision. Reused answers are marked as reused, not given invented new child receipts. See the canonical [output acceptance contract](../../../extensions/workflows/references/output-acceptance.md) for currently supported combinations and exact limits.
