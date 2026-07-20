# loop

## Purpose

`loop` is a default-loaded compat-wrapper for bounded continuation. It gives operators a visible `/loop` command and models a callable `loopControl` tool so the repo can continue work in one manual step without hidden auto-run.

## Who uses it

- The operator runs bare `/loop`, enters `goal [focus]` or `workflow <runId> [focus]`, and creates exactly one bounded continuation.
- The operator runs `/loop status` to see which source is available for continuation.
- The operator or the model runs `/loop once goal` for a bounded continuation on top of the current goal runtime.
- The operator or the model runs `/loop once workflow <runId>` for a bounded continuation on top of persisted workflow metadata.
- `review` continuation intentionally remains unsupported.

## Surface

- Command: `/loop`
- Tool: `loopControl`
- Hooks: none

Supported actions:

- bare `/loop` — opens an `[INPUT]` editor. Invalid text remains in the editor and is shown again with a `[WARN]` title.
- `status` — reports whether continuation is `idle`, `manual`, or `blocked` and which source is available.
- `once` — creates one bounded continuation artifact with `maxSteps: 1` and `autoDispatch: false`.
- Legacy `start`, `stop`, and `until` still parse but fail closed with a clear reason.
- Unsupported sources also fail closed with a clear reason.

## How it works

`extensions/loop/index.ts` registers only the tool and command. The runtime is intentionally manual:

- `/loop status` reads current goal state and the most recent workflow run metadata.
- Bare `/loop` is an operator input flow, not a status alias. Submit delegates to the existing `once` path exactly once. Escape returns a typed `[RESULT] ... [CANCELLED]` receipt and creates no artifact or model turn.
- `/loop once goal` reuses the same bounded continuation contract as `/goal continue` by writing `.locus/runtime/goal/continue.md` with goal source metadata (`goalId`, `objective`) and the bounded prompt text. The command-visible widget shows metadata/path and explicitly omits the prompt body.
- `/loop once workflow <runId>` writes a loop artifact under `.locus/runtime/loop/workflow/<runId>.json` from persisted workflow journal/result metadata; if the metadata is missing, it fails closed as blocked/unsupported and writes no artifact. The command-visible widget does not print the full source summary or prompt body.
- `review` is documented as unsupported and fails closed.

The command and tool both return compact text plus machine-readable details. Command output uses typed `INPUT`, `VIEW`, `RUN`, `RESULT`, and `WARN` blocks, so input, status, action, and failure do not collapse into one white text stream. A successful manual preparation contributes one bounded `loop.manual` activity label to the shared `status:locus` budget. Full prompt text remains in the artifact and in tool details, not in the TUI widget. No background auto-dispatch, hidden follow-up, or `agent_end` continuation hook is registered.

## Limitations

- No hidden endless loop.
- No automatic dispatch after `once`.
- No full OMP compaction/streaming parity.
- Pi `ctx.ui.input` / `ctx.ui.editor` facade types in `_shared/pi-api.ts` still describe an older object result. This extension calls the official string/`undefined` signature through `_shared/operator-input.ts`; a repository-wide facade repair is deferred.
- Review continuation is not implemented.
- Workflow continuation only becomes available when persisted run metadata exists; missing integration fails closed and does not auto-create a continuation.
- Historical beta shells are excluded from the clean release repository.

## Code map

- Entrypoint: `./extensions/loop/index.ts`
- Manifest: `extensions/loop/manifest.json`
- Commands: `loop`
- Tools: `loopControl`
- Hooks: none
- Permissions: fs.read=`.locus/runtime/goal/state.json`, `.locus/runtime/workflows/**`; fs.write=`.locus/runtime/goal/continue.md`, `.locus/runtime/loop/**`; subprocess=none; network=none; browser=false; models=false; ui=`editor`, `setWidget`, `setStatus`
- State: `.locus/runtime/goal/state.json`, `.locus/runtime/goal/continue.md`, `.locus/runtime/workflows/<runId>/journal.ndjson`, `.locus/runtime/workflows/<runId>/result.json`, `.locus/runtime/loop/workflow/*.json`
- Review: status=reviewed, source=copy-after-audit, reviewedBy=locus-pi, reviewedAt=2026-06-17, risk=medium
