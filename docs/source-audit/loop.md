# Source audit: loop

Decision: active compat-wrapper. The promoted `extensions/loop` entrypoint exposes a bounded manual continuation surface. Historical beta shells are excluded from the clean release.

## OMP source evidence

The T-138 brief names canonical upstream references under `/tmp/oh-my-pi-review`. This checkout also contains mirrored review copies under `.local/oh-my-pi-review/...`; those were reviewed here before the active wrapper was implemented.

Canonical paths from the brief:
- `/tmp/oh-my-pi-review/packages/coding-agent/src/modes/loop-limit.ts`
- `/tmp/oh-my-pi-review/packages/coding-agent/test/loop-limit.test.ts`
- `/tmp/oh-my-pi-review/packages/coding-agent/test/interactive-mode-loop.test.ts`
- `/tmp/oh-my-pi-review/packages/coding-agent/src/prompts/system/auto-continue.md`
- `/tmp/oh-my-pi-review/packages/coding-agent/src/prompts/goals/goal-continuation.md`

Mirrored review checkout actually inspected here:
- `.local/oh-my-pi-review/packages/coding-agent/src/modes/loop-limit.ts`
- `.local/oh-my-pi-review/packages/coding-agent/test/interactive-mode-loop.test.ts`
- `.local/oh-my-pi-review/packages/coding-agent/src/prompts/system/auto-continue.md`
- `.local/oh-my-pi-review/packages/coding-agent/src/prompts/goals/goal-continuation.md`
- `.local/oh-my-pi-review/packages/coding-agent/src/goals/runtime.ts`
- `.local/oh-my-pi-review/packages/coding-agent/src/goals/state.ts`
- `.local/oh-my-pi-review/packages/coding-agent/src/goals/tools/goal-tool.ts`
- `.local/oh-my-pi-review/packages/coding-agent/src/prompts/goals/goal-mode-active.md`
- `.local/oh-my-pi-review/LICENSE`

## What was adapted

- The OMP loop-limit split informed the local `status` / `once` split.
- The OMP interactive loop test informed the decision to keep continuation manual and bounded instead of auto-dispatched.
- The OMP goal continuation prompt shape was reused for `/loop once goal` through the existing `/goal continue` contract, and the local artifact retains goal source metadata (`goalId`, `objective`) plus bounded prompt text.
- Workflow continuation is handled by local `.locus/runtime/workflows/<runId>/` metadata; this is a bounded wrapper, not a port of OMP auto-submit. When that metadata is missing, `/loop once workflow <runId>` fails closed and does not create a continuation artifact.
- Bare `/loop` is a Locus-owned typed input flow. It intentionally keeps the local one-submit/one-artifact semantics and does not imitate OMP auto-repeat.
- Typed `INPUT`, `VIEW`, `RUN`, `RESULT`, and `WARN` presentation plus the bounded shared-status contribution are local operator-UI behavior, not copied OMP rendering code.

## Known gaps

- No hidden endless loop.
- No automatic dispatch after `once`.
- No full OMP compaction, streaming, or post-prompt background-work parity.
- `review` continuation is unsupported and fails closed.
- Unsupported loop actions and sources fail closed with a clear reason.
- This slice does not claim full OMP loop-mode parity.
- The local Pi facade still carries the older object-shaped dialog result. `_shared/operator-input.ts` contains the narrow official-signature adapter; a repository-wide facade migration remains deferred.

## License / attribution

License note: the reviewed OMP checkout is MIT-licensed; see `/tmp/oh-my-pi-review/LICENSE` and the mirrored `.local/oh-my-pi-review/LICENSE`.

OMP review sources were used as design evidence only. No OMP implementation code was copied into this slice.

## Local evidence owner

- `extensions/loop/index.ts`
- `extensions/_shared/loop-continuation.ts`
- `extensions/_shared/goal-mode.ts`
- `tests/extensions/loop/loop.test.ts`
- `tests/integration/registration.test.ts`
