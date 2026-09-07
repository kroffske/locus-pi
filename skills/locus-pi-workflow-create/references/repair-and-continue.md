# Repair + Continue: keep completed agent work

This is an existing runtime capability, not a new graph primitive. A resume reuses recorded answers for a matching completed prefix and executes the repaired source from the first fresh call onward. It is not deterministic LLM generation, a JavaScript stack snapshot, or a general per-node cache.

## Author's procedure

Read the stopped run diagnostic and the failing answer it names. Find the project-owned source and the original goal. Preserve the same workflow target and workspace contract. Change the failing prompt or contract and the required suffix; keep unaffected labels, prompts, order and phases unchanged. Do not rename every node while fixing one of them. Use stable business keys where the graph already has them, without claiming that keys bypass the prefix rule.

Validate the exact repaired source with the supported checker and the module/source checks. Report what changed and which prefix is expected to remain reusable. Do not run it as part of Build. Hand the source path, the diagnostic and the original run id to the [run skill](../../locus-pi-workflow-run/SKILL.md).

## Operator's procedure

Use the structured `workflow` field `resumeFromRunId`, or `--resume <runId>` on the operator surface. Preserve the source run's workspace and its exact original input; do not guess either. Continue from the repaired file at the same target. Then read the NEW run's `runtime/result.json` replay envelope and report `replayedCalls`, `divergedAtCall` and `divergedAtNode`. `freshCalls` alone proves nothing — a full restart reports it too. A run that reused nothing must not be described as proof of saved work.

For example, A completed, B failed, and C was never reached. Repair B: A is served from the record, B and C run fresh. Appending more work can preserve the completed prefix the same way. If A's request also changes, reuse ends at A. A label match without the matching request is not enough.

## Current limitations, by name

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
