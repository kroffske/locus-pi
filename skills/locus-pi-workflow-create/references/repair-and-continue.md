# Repair + Continue: keep completed agent work

This is an existing runtime capability, not a new graph primitive. A resume reuses recorded answers for a matching completed prefix and executes the repaired source from the first fresh call onward. It is not deterministic LLM generation, a JavaScript stack snapshot, or a general per-node cache.

## Author's procedure

Read the stopped run diagnostic and the evidence it names: child result, transcript or answer; use the run journal when no child pointer is proven. Find the project-owned source and the original goal. Preserve the same workflow target and workspace contract. Change the failing prompt or contract and the required suffix; keep unaffected labels, prompts, order and phases unchanged. Do not rename every node while fixing one of them. Use stable business keys where the graph already has them, without claiming that keys bypass the prefix rule.

Validate the exact repaired source with the supported checker and the module/source checks. Report what changed and which prefix is expected to remain reusable. Do not run it as part of Build. Hand the source path, the diagnostic and the original run id to the [run skill](../../locus-pi-workflow-run/SKILL.md).

## Operator's procedure

Use the structured `workflow` field `resumeFromRunId`, or `--resume <runId>` on the operator surface. Preserve the source run's workspace and its exact original input; do not guess either. Continue from the repaired file at the same target. Then read the NEW run's `runtime/result.json` replay envelope and report `replayedCalls`, `divergedAtCall` and `divergedAtNode`. `freshCalls` alone proves nothing — a full restart reports it too. A run that reused nothing must not be described as proof of saved work.

For example, A completed, B failed, and C was never reached. Repair B: A is served from the record, B and C run fresh. Appending more work can preserve the completed prefix the same way. If A's request also changes, reuse ends at A. A label match without the matching request is not enough.

## Current limitations, by name

### Unconfirmed call after process loss

An absent process with no child completion or terminal result is an unconfirmed
call. Preserve its journal, replay, transcript and partial artifacts. Read the
canonical [reconciliation path](../../../extensions/workflows/references/recovery-and-continuation.md#reconcile-an-unconfirmed-call)
before editing source: it requires assessing current effects and any reusable
prerequisites. Direct interrupted recovery does not admit an unfinished child.

For a checkpoint between attempts, retain the step-entry baseline tar/manifest
and follow that contract's separate content-versus-Git reconciliation. Review the
whole step against its original baseline, not only the post-checkpoint Git diff.

When a verified terminal ancestor remains usable, keep its completed prefix and
give the first fresh stage the accepted goal, current tree, preserved work and
reconciliation findings. Its job is to retain valid work, finish or repair what
is missing and produce fresh verification before ordinary review and QA. Do not
blindly rerun an effect, reset the tree to the ancestor, or accept a previous
child's self-report. Changed prerequisites may require an earlier fresh stage.
Use [external-locus-pi](../../external-locus-pi/SKILL.md) for an inspectable, retained Pi session
for long execution; creating a workflow still does not launch it.

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

The match is a strict completed prefix. The first miss — `no-record`, `unnamed-node`, `node-mismatch`, `key-mismatch`, `recorded-failure` or `side-effecting-call` — latches divergence, and every later call reports `diverged` even when its own prompt is unchanged.

A call without a literal `label` cannot be located once the bytes changed: it misses with `unnamed-node` and takes the rest of the run with it. A recorded failure is re-run, never served back as an answer. A worktree or otherwise side-effecting call never replays.

A `fusion()` group standing after the divergence point ends the run with `fusion resume cannot mix recorded and fresh agent calls`. This is a named limitation of the current runtime, not a bug to work around in generated source: split the panel out, or accept a fully fresh run.

Replayed answers still spend the run's `totalAgents` invocation fuse: an attempt is charged to the counter whether its answer comes from the record or from a child. A continuation that would cross that fuse needs an explicit operator `budget.totalAgents` override on the structured `workflow` tool; never raise a default automatically.

Parallel scheduling changes may reduce the usable recorded prefix, and independently completed branches are not recovered by business key. Stable `keys` prevent item mismatch; they create no per-item checkpoint.

In the source repository, regression evidence for these limits lives in `tests/extensions/workflows/runtime/workflow-replay.test.ts` and `tests/extensions/workflows/runtime/workflow-fusion.test.ts`.

## Do not promise stronger recovery

Saved answers do not recreate files, reset Git or repeat tool effects. Confirm that the needed artifacts and project state are still suitable, and require current verification before irreversible effects. An unconfirmed child may already have changed external state.

Ordinary terminal resume, a real `awaiting_operator` continuation, and explicit interrupted-run recovery are three different mechanisms. Do not add `recoverInterrupted: true` to bypass normal admission, invent an operator answer, modify journal or result evidence, or turn a mismatch into reuse of another node's answer.

## Work scope and limits

A larger legitimate work list is not a reason to erase completed agent work. Do not insert a new total-call cap and do not automatically raise an existing bound. Preserve user choices. Run-level operational changes and changes to one call's prompt, model or options have different identities; do not replace them with a blanket whole-source equality rule.

Canonical owners: [runtime reference](../../../extensions/workflows/REFERENCE.md#continuing-a-repaired-workflow), [recovery and continuation](../../../extensions/workflows/references/recovery-and-continuation.md) and [execution controls](../../../extensions/workflows/references/execution-controls.md).
