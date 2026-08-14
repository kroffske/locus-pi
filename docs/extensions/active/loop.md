# loop

## Purpose

`loop` is the canonical bounded continuation controller for goals and persisted workflow runs. The tool and slash command have the same name.

## Actions

- `status` reads the current session loop or reports eligible continuation sources.
- `once` prepares one manual continuation artifact without dispatching a model turn.
- `start` begins automatic bounded continuation.
- `until` begins the same controller with a model-evaluated stop condition.
- `stop` ends the active session loop and records a reason.

`start` and `until` dispatch one hidden Pi follow-up with `sendMessage`, then use `agent_settled` to schedule the next bounded step. The continuation prompt tells the model to call `loop { action: "stop" }` when the objective or `until` condition is satisfied. Only one loop may be active per Pi session.

Hard runtime stops are independent of model judgment: default 20 iterations and 30 minutes, configurable up to 100 iterations and 1440 minutes. Missing goal/workflow metadata, lost transport, deadline expiry, and iteration exhaustion persist a stopped state instead of silently continuing.

## Surface and state

- Tool: `loop`
- Command: `/loop` with `status`, `once`, `start`, `until`, and `stop`
- Hook: `agent_settled`
- Sources: `goal`, `workflow`
- State: `.locus/runtime/loop/sessions/<sessionId>.json`, plus existing goal/workflow continuation artifacts

The old `loopControl` name was removed. A bare `/loop` still opens the one-step manual continuation editor for compatibility.
