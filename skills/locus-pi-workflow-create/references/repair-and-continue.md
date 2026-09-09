# Repair + Continue: keep completed agent work

This is an existing runtime capability, not a new graph primitive. A resume reuses recorded answers for a matching completed prefix and executes the repaired source from the first fresh call onward. It is not deterministic LLM generation, a JavaScript stack snapshot, or a general per-node cache.

## Author's procedure

Read the stopped run diagnostic and the evidence it names: child result, transcript or answer; use the run journal when no child pointer is proven. Find the project-owned source and the original goal. Preserve the same workflow target and workspace contract. Change the failing prompt or contract and the required suffix; keep unaffected labels, prompts, order and phases unchanged. Do not rename every node while fixing one of them. Use stable business keys where the graph already has them, without claiming that keys bypass the prefix rule.

Validate the exact repaired source with the supported checker and the module/source checks. Report what changed and which prefix is expected to remain reusable. Do not run it as part of Build. Hand the source path, the diagnostic and the original run id to the [run skill](../../locus-pi-workflow-run/SKILL.md).

## Operator's procedure

Use the structured `workflow` field `resumeFromRunId`, or `--resume <runId>` on the operator surface. Preserve the source run's workspace and its exact original input; do not guess either. Continue from the repaired file at the same target. Then read the NEW run's `runtime/result.json` replay envelope and report `replayedCalls`, `divergedAtCall` and `divergedAtNode`. `freshCalls` alone proves nothing — a full restart reports it too. A run that reused nothing must not be described as proof of saved work.

For example, A completed, B failed, and C was never reached. Repair B: A is served from the record, B and C run fresh. Appending more work can preserve the completed prefix the same way. If A's request also changes, reuse ends at A. A label match without the matching request is not enough.

## Current limitations, by name

### Legitimate quality refusal

A correct quality refusal can identify a product defect, not a broken workflow.
Preserve its diagnostics and acceptance criteria; a generic "fix the workflow"
hint is not a reason to weaken the gate. Existing authorization for scoped
implementation covers repairing that feature; a refusal does not create a new
owner-approval requirement. New product scope or separately unauthorized
external effects retain their actual authorization boundary.

Give an explicit, bounded correction stage to a named tool-capable owner with
the full findings, diagnostic/probe evidence, current tree and original baseline.
Preserve only the valid completed prefix before that correction. Follow it with
fresh independent review and the original read-only gate, passing the correction
report and fresh review as current evidence. Do not replay an old blocked choice
or treat pre-correction review as acceptance of changed bytes. If prerequisites
drifted, move the fresh boundary earlier instead of claiming invalid reuse.

Validate the repaired graph, then resume through the run skill under the existing
authorization. A further refusal stays a refusal with fresh diagnostics. This
explicit continuation is not a hidden retry or an unbounded automatic loop.
The read-only gate records findings; it does not become the correction owner.

### Provider admission failures

Read the provider error and actual executed route before changing the workflow.
HTTP 402 with `limit_source: openrouter_key_limit` is a provider key allowance
failure, not a handoff-length error, an implementation verdict or missing repeat
owner approval. Raising `maxItemChars` or `maxTurns` cannot repair it. A requested
`max_tokens` may come from SDK model metadata rather than the workflow prompt.

First check whether that provider/transport was intended. Apply an already
authorized route correction only to the required unfinished work and verify the
completed prefix remains reusable. If the API route is still intended, report
the real key-limit/reset prerequisite; do not automatically change financial
limits, switch keys, invent a token cap or retry the same rejected request.
Neither a valid return shape nor a zero process exit converts admission failure
into acceptance. Preserve the failed result and require fresh terminal evidence
after the cause is resolved.

### Unconfirmed call after process loss

An absent process with no child completion or terminal result is an unconfirmed
call. Preserve its journal, replay, transcript and partial artifacts. Read the
canonical [reconciliation path](../../../extensions/workflows/references/recovery-and-continuation.md#reconcile-an-unconfirmed-call)
before editing source: it requires assessing current effects and any reusable
prerequisites. Direct interrupted recovery does not admit an unfinished child.

A stage ends with a commit, so its entry point is a commit too: review the whole
stage as `git diff <stage-base>..HEAD`. Keep no baseline archive or content
manifest beside it; the commit already carries that identity.

When a verified terminal ancestor remains usable, keep its completed prefix and
give the first fresh stage the accepted goal, current tree, preserved work and
reconciliation findings. Its job is to retain valid work, finish or repair what
is missing and produce fresh verification before ordinary review and QA. Do not
blindly rerun an effect, reset the tree to the ancestor, or accept a previous
child's self-report. Changed prerequisites may require an earlier fresh stage.
Use [external-locus-pi](../../external-locus-pi/SKILL.md) for an inspectable, retained Pi session
for long execution; creating a workflow still does not launch it.

### Read-only review evidence

A stage ends with a commit. The reviewer reads `git diff <stage-base>..HEAD` with
its own tools and accounts for every in-scope path in that diff — additions,
deletions, renames, tests, docs and diagrams — before a favorable verdict.
Current-source sampling is not complete change review, and a favorable verdict is
invalid while required coverage is missing.

The producer does not rebuild the change as a readable bundle: no evidence
entrypoint, locator list, content manifest or tree hash. If the reviewer cannot
read the diff, fix its tools or the stage boundary, not the handoff format. After
a repair, rerun the incomplete review and its dependent suffix through ordinary
resume, preserving the unaffected completed prefix.

### Unfinished implementation

Read the failed child's transcript and verification evidence before classifying
the stop. If an environment problem was repaired within the accepted scope,
reuse the prepared environment after checking it is still suitable and continue
the assigned implementation. Preparation and passing baseline tests do not prove
the requested behavior was implemented. Do not terminate a child voluntarily
just because work remains while an authorized next step is available.

A real blocker names the remaining obstacle, its evidence and why an in-scope
repair cannot resolve it. An observed budget, provider or resource stop retains
its exact machine reason and completed work; do not invent an owner-approval
gate. Preserve real authorization, scope and safety boundaries.

For example, missing dependencies fixed and baseline green, but implementation
absent means continue implementation; required access still denied means report
that obstacle; an actual turn-budget failure follows the section below. Keep
acceptance checks: a valid return shape or `[]` is not proof of completion.
Repair the unfinished source through the normal continuation route, preserving
completed calls. Do not add an unbounded retry or turn incomplete work into success.

### Repeated output-contract failures

Inspect the entire unfinished suffix, including reachable saved child workflows,
for the same defect before continuing. A narrative review wrapped in singleton
`handoffs` can fail again at the next review even after an explicit array example.
For each occurrence, check the actual downstream consumer: ordinary reports stay
plain text, and their next semantic reviewer receives the complete text. Keep
existing checks for completeness, verdict and blockers before subsequent writes.
Preserve genuine choices that route the graph and handoffs that schedule
independent work. Do not replace content review with text-length checks.

Keep completed calls' prompts and effective options unchanged, and verify their
replay identity. Do not redesign the graph or sweep completed stages as part of
this repair. A raw-value example is a correction aid, not proof that the next
model will submit the right shape; strict validation remains required.

### Turn-budget failures

`Child exceeded its cumulative ... assistant-turn budget` counts SDK model
cycles (`turn_start`) during the whole child session, including ordinary
tool use before its first result. It does not mean the workflow restarted or
the agent attempted that many `workflow_return` calls. Read the failing child's
transcript and journal to distinguish useful work from format repair or a loop.

For legitimate work, use the supported explicit `maxTurns` allowance on the
unfinished suffix. Keep other budgets and the original completion criteria.
When a runtime default changed, preserve each completed call's recorded
effective value explicitly: a prefix recorded with 20 turns needs `maxTurns: 20`
under the new default. Verify actual prefix reuse before resuming; changing all
calls to the new allowance would change their request keys. The
[runtime reference](../../../extensions/workflows/REFERENCE.md)
owns current values and timer constraints.

Ordinary narrative still uses plain text. A singleton `handoffs` report that
exceeds a guessed character limit is a separate authoring defect; increasing
turns does not fix it. Use `choice` for a routing decision and `handoffs` only
for independently scheduled work units.

### Prefix and invocation limits

Owned by [locus-pi-workflow-run](../../locus-pi-workflow-run/SKILL.md#declare-one-outcome-before-launching):
strict prefix matching and its named misses, `unnamed-node`, the `fusion()`
boundary, and the `totalAgents` fuse that replayed answers still spend.

## Do not promise stronger recovery

Saved answers do not recreate files, reset Git or repeat tool effects. Confirm that the needed artifacts and project state are still suitable, and require current verification before irreversible effects. An unconfirmed child may already have changed external state.

Ordinary terminal resume, a real `awaiting_operator` continuation, and explicit interrupted-run recovery are three different mechanisms. Do not add `recoverInterrupted: true` to bypass normal admission, invent an operator answer, modify journal or result evidence, or turn a mismatch into reuse of another node's answer.

## Work scope and limits

A larger legitimate work list is not a reason to erase completed agent work. Do not insert a new total-call cap and do not automatically raise an existing bound. Preserve user choices. Run-level operational changes and changes to one call's prompt, model or options have different identities; do not replace them with a blanket whole-source equality rule.

Canonical owners: [runtime reference](../../../extensions/workflows/REFERENCE.md#continuing-a-repaired-workflow), [recovery and continuation](../../../extensions/workflows/references/recovery-and-continuation.md) and [execution controls](../../../extensions/workflows/references/execution-controls.md).
