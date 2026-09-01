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

## Plan storage

Authored plans live in the current checkout at `.locus-pi/plans/<plan-slug>.md`. The first `/plan` read or write safely prepares that directory from the former `~/.pi/locus-pi/<project-slug>/plans/` location. Legacy-only regular Markdown files are copied atomically and verified byte-for-byte. Identical files are accepted, current-only files remain authoritative, and a differing file with the same slug stops migration before any copy. Symlinks and non-regular legacy entries are refused. Legacy files are never modified or deleted automatically, and new plans are never written to the home directory.

The checkout-local boundary is intentional: two worktrees no longer share one implicit plan library. Copy or reconcile a plan explicitly when it must exist in more than one checkout.

## Implementation

- Entrypoint and commands: `extensions/plan/index.ts`, `extensions/plan/command/command-router.ts`
- Plan mode and storage: `extensions/plan/mode/mode-state.ts`, `extensions/plan/mode/plan-storage.ts`, `extensions/plan/mode/system-prompt.ts`
- Goal tool/state: `extensions/plan/goal/goal-tool.ts`, `extensions/plan/goal/goal-command.ts`
- Manifest: `extensions/plan/manifest.json`
