# PRD: Session Todo Auto-Continuation

## Problem Statement

Session todos currently describe ordered work but do not execute it across
assistant responses. A planner or operator can populate a queue, and completing
one item promotes the next item to active, but Pi stops after returning an
answer. The operator must manually send `Continue` for every remaining todo.

The operator command also accepts only one todo per invocation, even though
planning agents naturally return ordered lists and the model-facing
`todo_write` tool already accepts arrays.

This makes todos useful as a checklist but not as the bounded session execution
queue users expect.

## Solution

Add an explicit autonomous execution mode to session todos.

An agent or operator can enqueue an ordered list, attach a short shared queue
context, and start the queue. Pi completes only the active todo during one
assistant response. When the agent has fully settled, the extension checks the
persisted queue. If autonomous mode is enabled and a successful todo progress
operation left another active item, the extension injects one hidden
continuation message and triggers the next response.

The queue stops when it is empty, paused, blocked, fails to record todo
progress, reaches its continuation limit, or cannot use the Pi message
transport. Remaining items stay visible and recoverable.

The operator `/todo append` command accepts multiple tasks separated by `;;`.
The existing single-item syntax and structured `todo_write` operations remain
compatible.

## User Stories

1. As an operator, I want to enqueue a planner-produced task list in one command, so that I do not repeat `/todo append` for every item.
2. As an agent, I want to submit an array of todos through `todo_write`, so that structured task decomposition maps directly to the execution queue.
3. As an operator, I want to attach a short queue context, so that every todo is executed against the same parent objective.
4. As an agent, I want the queue context before the active todo, so that I do not lose the reason for the work between responses.
5. As an operator, I want queue execution to be explicit, so that creating a checklist does not unexpectedly spend model time.
6. As an operator, I want `/todo run` to start the active item, so that an operator-created queue can execute without a separate natural-language prompt.
7. As an operator, I want `/todo pause` to stop future continuations without deleting tasks, so that I can inspect or redirect work safely.
8. As a model, I want exactly one active todo in each continuation prompt, so that later items do not collapse into one assistant response.
9. As a model, I want permission to complete the active todo directly or delegate it through available agent tools, so that queue policy does not constrain execution strategy.
10. As an operator, I want each completed todo to produce its own assistant response, so that intermediate results remain visible.
11. As an operator, I want the next todo to begin without manually sending `Continue`, so that bounded autonomous work can progress unattended.
12. As an operator, I want the queue to stop if the agent returns without updating todo state, so that an ignored instruction does not create an infinite loop.
13. As an operator, I want a hard continuation limit, so that malformed queues or repeated partial work cannot run indefinitely.
14. As an operator, I want the remaining queue preserved after a dispatch failure, so that transport problems do not lose planned work.
15. As an operator, I want batch validation to be atomic, so that a malformed separator or empty item does not append a partial list.
16. As an existing user, I want old `todo_write` calls and single-item `/todo append` commands to keep working, so that the feature does not break checklist workflows.
17. As an operator, I want restored sessions to retain queue context and execution mode, so that persisted todo state remains coherent after resume.
18. As an operator, I want an empty queue to disable autonomous execution, so that stale run mode cannot trigger unrelated future work.
19. As a maintainer, I want continuation behavior owned by `todo-context`, so that session queue policy is not duplicated across extensions.
20. As a future maintainer, I want completed task notes and queue context preserved, so that later transcript compaction can summarize task turns without replacing the queue schema.

## Implementation Decisions

- Session todo state remains the single queue source of truth.
- Queue execution is opt-in through `autoContinue: true` on `todo_write` or the operator `/todo run` command.
- Queue execution can be disabled through `autoContinue: false` or `/todo pause`.
- Queue context and autonomous-mode state are stored in backward-compatible metadata on existing todo session entries.
- The continuation hook uses Pi's settled-agent lifecycle boundary, which occurs after retries, compaction retries, and previously queued follow-ups have completed.
- Continuations use hidden custom messages that participate in model context without appearing as user-authored messages.
- Each hidden prompt contains the queue context, exactly one active todo, direct-or-delegate guidance, and the requirement to record a terminal todo transition before ending.
- A continuation is armed only by successful progress operations that leave an active task. Notes alone do not re-arm execution.
- The arm is cleared before dispatch. A response that makes no todo progress therefore stops the chain.
- One explicit run is limited to 20 automatic continuations. Limit exhaustion pauses the queue and preserves remaining items.
- Transport errors fail closed, pause automatic execution, and preserve remaining queue state.
- `/todo append` accepts `;;` as a literal item separator with a maximum of 20 tasks. The entire batch is validated before mutation.
- Task text containing `;;` must be entered through the Markdown editor rather than the batch command.
- The queue controller does not import the child-agent implementation. The model may use any already-available tools to complete the active todo.
- Empty queues automatically leave autonomous mode disabled.

## Testing Decisions

- Tests assert public state transitions, sent continuation messages, operator output, and persisted restore behavior rather than private helper calls.
- The existing todo extension harness remains the primary behavior seam because it records lifecycle handlers, session entries, and Pi message deliveries.
- Focused tests cover opt-in/default behavior, run, pause, single-item progression, batch append, atomic rejection, context persistence, no-progress stop, empty completion, continuation cap, and unavailable transport.
- Session-core tests prove that old phase-only todo entries still load and new metadata round-trips through memory and JSONL backends.
- A real interactive Pi test is required because unit tests cannot prove that `agent_settled` plus a hidden triggered message creates separate visible assistant responses.
- Runtime acceptance requires three ordered arithmetic todos to produce three assistant answers without operator input between them, followed by `/todo` showing all three completed.
- The full repository check remains required because the extension manifest, public docs, package boundary, and shared Pi API shim are release surfaces.

## Out of Scope

- Automatic transcript compaction or per-task token reclamation.
- Model-generated compression summaries between todo items.
- Automatic synchronization with project `.tasks` status.
- A persistent background worker or cross-session scheduler.
- Parallel todo execution.
- Automatic agent-role or model selection.
- Changes to the manual goal/workflow `/loop` extension.
- Removal of existing OMP-compatible todo operations.

## Further Notes

Pi 0.80.x exposes a settled-agent lifecycle event and triggered hidden custom
messages, so the feature can be implemented as an extension without patching Pi
core. The official extension API remains the external behavior source:
https://pi.dev/docs/latest/extensions

The remote `dev` branch was absent during planning. The implementation branch
uses the last known `origin/dev` content, which is file-identical to the current
stable `main` content. Remote delivery must wait for `dev` to be restored.
