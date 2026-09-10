# Adaptive slices — default implementation pattern

Use for substantive implementation whose remaining work can change after a reviewed slice. The owner agent revises the queue; the source visibly schedules it. Do not replace the queue with a fixed roster renamed “dynamic”. Use a fixed graph when work is genuinely fixed or explicitly requested.

Design and implementation are separate entries and separate runs. The owner accepts the task-change design in `artifacts/design.md`, not the authoring `.design.md` that describes the workflow graph.

Graph: accepted task-change design → baseline → owner cut → scope decision → implement one slice → independent review → route → optional addressed correction → independent recheck → record progress → owner re-cut. An empty queue goes through completion evidence and required final QA. A scope change returns to the human owner.

## Queue and brief contracts

Pi supports raw schemas in compatibility workflows. Standard authoring uses the existing `handoffs` array of complete text briefs and `choice` identities. No JSON parsing, domain schema or new queue API is needed: JavaScript consumes array order and length, while agents consume each brief's meaning.

Each slice includes its stable identity, goal, source context, acceptance evidence and essential constraints. The owner receives the previous complete queue, accepted progress and live source evidence. It may reorder, merge, shrink or replace remaining work within the accepted design. Only the first item runs before the next re-cut. Done work is never silently reintroduced; unmet work is never dropped to make the list fit.

Carry the whole queue in a `let` initialized with `[]` inside a finite literal `for` loop. Items stay opaque. Forward `queue[0]` whole to an agent; do not parse fields, mutate the array or truncate it. Source-side validation belongs to the existing checker, shape acceptance to `handoffs`, semantic completeness to the reviewing agents.

## Bounds and evidence

Derive the total slice allowance and correction rounds from the actual task. Count implemented slices cumulatively across every re-cut. A per-response `maxItems` is transport shape, not the total allowance. The teaching example permits three slices and one correction per slice; its `maxItems: 100` uses the existing response ceiling so an oversized remaining queue can be reported rather than silently sliced away. Neither number is a default for new tasks.

After the final allowed slice, permit a completion/re-cut check but no additional implementation. Return the remaining queue on exhaustion. An empty queue cannot itself establish success; a separate evidence-based scope decision and required QA still run. The example's maximum is 31 logical agent calls: 2 initial + 4 cuts/scopes (8) + 3 slice cycles with correction (18) + 3 final QA/verdict calls. Output clarification attempts are separate runtime resources.

Do not filter failed or missing QA branches. Pi's `parallel` barrier preserves sibling evidence and rejects failed required branches. Every adverse report reaches the closing decision. Review and recheck inspect the real diff, actual tests and original criteria. A favorable agent decision is still model judgment; source shape alone cannot prove acceptance quality.

## Executable references

- [Design and owner pause](../../../extensions/workflows/references/examples/adaptive-design.workflow.mjs) returns the reviewed proposal and manual next command. It completes the design run successfully but does not approve, implement or launch the next workflow.
- [Adaptive implementation](../../../extensions/workflows/references/examples/adaptive-slices.workflow.mjs) accepts a task directory, verifies actual owner acceptance, re-cuts the queue and handles adverse exits.

These are packaged source references, not registered commands. Copy them into a reviewed project workflow folder and set matching `meta.name` values before using the shown commands. Customize task-derived limits, roles, criteria and output location in the design. Baseline preparation is not a slice. Commit only when the task already authorizes it.

For a host-managed operator UI use [human continuation](human-continuation.md). Manual cross-workflow handoff and host continuation are distinct choices; never simulate approval with a nonempty path or `next_command` string.

## Owner acceptance convention

The design entry writes `artifacts/design.md` under the task directory. The owner records acceptance in `artifacts/design-acceptance.md`, naming the exact design revision or content identity and accepted scope. A note written by the designer or a reviewer is not owner acceptance. The implementation entry checks the actual record and current design before doing work; it does not manufacture a human decision. This is an example convention, not a second host continuation protocol. If copied with different entry names, update the manual next command to match those names.

Implementation refusals such as `needs_owner` return `ok: false` and are non-successful runs. The design entry returns `ok: true` because its proposal deliverable is complete; its `needs_owner` field describes the manual next step, not an automatic host pause or authorization.
