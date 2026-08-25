# plan

`plan` owns behavioral planning mode, local goal state, and project/task prompt shelves.

Beta: disabled by default. Nothing below is registered until the project enables `plan` — see [beta extensions](../../docs/getting-started.md#beta-extensions).

## Commands and tool

```text
/plan [<request>|exit|list|open <slug>|help]
/mode [plan|default|show]
/goal <objective|set|show|pause|resume|drop|complete|continue|budget|prompt>
/goal-ai [--task <task-id>] <request>
/review [show|read|set ...]
/todos [show|read|set ...]
```

The model-callable `goal` tool creates, reads, updates, pauses, resumes, completes, or drops local goal state.

## Important boundary

Plan mode is behavioral: it injects planning guidance into the model context. It does not restrict tools, filesystem writes, subprocesses, or the operator shell. Use Pi approvals and explicit workflow/tool boundaries for enforcement.

Prompt-shelf commands write project-local prompt files or an explicitly resolved `.tasks/<task>/artifacts/` target. A missing task ID fails closed rather than silently selecting another task.

Interactive prompts and the plan-to-execution handoff require an interactive host. Headless calls must provide the request explicitly and cannot simulate the selector.

## Implementation

- Entrypoint and commands: `extensions/plan/index.ts`, `extensions/plan/command/command-router.ts`
- Plan mode: `extensions/plan/mode/mode-state.ts`, `extensions/plan/mode/system-prompt.ts`
- Goal tool/state: `extensions/plan/goal/goal-tool.ts`, `extensions/plan/goal/goal-command.ts`
- Manifest: `extensions/plan/manifest.json`
