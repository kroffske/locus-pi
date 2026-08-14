# Source audit: loop

Decision: active compat-wrapper. `extensions/loop` exposes one canonical `loop` tool plus `/loop`: manual `once` remains available, while `start` and `until` use a persisted session state machine with hard iteration and duration limits.

## OMP source evidence

The references below are relative to the reviewed Oh My Pi checkout and use the
portable `oh-my-pi:<path>` notation.

Reviewed source paths:

- `oh-my-pi:packages/coding-agent/src/modes/loop-limit.ts`
- `oh-my-pi:packages/coding-agent/test/loop-limit.test.ts`
- `oh-my-pi:packages/coding-agent/test/interactive-mode-loop.test.ts`
- `oh-my-pi:packages/coding-agent/src/prompts/system/auto-continue.md`
- `oh-my-pi:packages/coding-agent/src/prompts/goals/goal-continuation.md`
- `oh-my-pi:packages/coding-agent/src/goals/runtime.ts`
- `oh-my-pi:packages/coding-agent/src/goals/state.ts`
- `oh-my-pi:packages/coding-agent/src/goals/tools/goal-tool.ts`
- `oh-my-pi:packages/coding-agent/src/prompts/goals/goal-mode-active.md`
- `oh-my-pi:LICENSE`

## What was adapted

- The OMP loop-limit split informed the local hard iteration and duration stops.
- Automatic continuation is Locus-owned: Pi `sendMessage` dispatches one follow-up and `agent_settled` schedules the next only while the session state remains active.
- The OMP goal continuation prompt shape was reused for `/loop once goal` through the existing `/goal continue` contract, and the local artifact retains goal source metadata (`goalId`, `objective`) plus bounded prompt text.
- Workflow continuation is handled by local `.pi/locus-pi/runs/<runId>/` metadata; this is a bounded wrapper, not a port of OMP auto-submit. When that metadata is missing, `/loop once workflow <runId>` fails closed and does not create a continuation artifact.
- Bare `/loop` is a Locus-owned typed input flow. It intentionally keeps the local one-submit/one-artifact semantics and does not imitate OMP auto-repeat.
- Typed `INPUT`, `VIEW`, `RUN`, `RESULT`, and `WARN` presentation plus the bounded shared-status contribution are local operator-UI behavior, not copied OMP rendering code.

## Known gaps

- No hidden endless loop.
- `once` is intentionally manual; `start` and `until` dispatch automatically.
- No full OMP compaction, streaming, or post-prompt background-work parity.
- `review` continuation is unsupported and fails closed.
- Missing sources, transport failures, deadline expiry, and iteration exhaustion persist a stopped state with a clear reason.
- This slice does not claim full OMP loop-mode parity.
- The local Pi facade still carries the older object-shaped dialog result. `_shared/operator/operator-input.ts` contains the narrow official-signature adapter; a repository-wide facade migration remains deferred.

## License / attribution

License note: the reviewed OMP checkout is MIT-licensed; see `oh-my-pi:LICENSE`.

OMP review sources were used as design evidence only. No OMP implementation code was copied into this slice.

## Local evidence owner

- `extensions/loop/index.ts`
- `extensions/loop/loop-continuation.ts`
- `extensions/loop/loop-controller.ts`
- `extensions/_shared/project/goal-mode.ts`
- `tests/extensions/loop/loop.test.ts`
- `tests/integration/public-registration.test.ts`
