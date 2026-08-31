# locus-pi workflow skills

The npm package is the canonical source for two action-named workflow skills.
Pi loads them directly from `package.json#pi.skills`. External agents use managed
symlinks; they do not receive copied skill text that can drift from the package.

| Skill                      | Owns                                                           | Native Pi/API route                                                     | External agent route                                            |
| -------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `locus-pi-workflow-create` | Design, review, Build, source validation; never run            | Follow the packaged skill directly                                      | Follow the managed packaged skill directly                      |
| `locus-pi-workflow-run`    | One existing reviewed workflow run, receipts, evidence, resume | Call the structured `workflow` tool; the skill is only routing guidance | Invoke literal `/workflows run ...` through `pi --mode json -p` |

## Install for Codex and Claude Code

Run these commands inside Pi after installing the locus-pi package:

```text
/workflows skills status --host all --scope user
/workflows skills sync --host codex --scope user
/workflows skills sync --host claude --scope user
```

`--host all` manages both hosts. `--scope project` writes under the current
project instead of the user home. Codex entries live in `.agents/skills`;
Claude Code entries live in `.claude/skills`.

`sync` creates or refreshes only locus-pi-managed symlinks. It removes managed
links under the retired names, including `locus-pi-workflow-implement-task`. A real directory or foreign symlink is a
conflict and is never overwritten. Ownership comes only from the adjacent
`.locus-pi-workflow-skills.v1.json` provenance file, never from a suggestive
symlink target. `remove` has the same ownership check. The command snapshots
managed links and provenance before mutation and rolls the whole selected host
set back after an unexpected filesystem error.

## Model selection

For an external Pi invocation, select the main Pi model and reasoning level on
the command line:

```bash
pi --mode json -p --no-session --approve \
  --model '<provider/model>' --thinking high \
  '/workflows run <name> -- <semantic input>'
```

Child model routing is separate. Configure roles through `/model-roles` or
`~/.pi/agent/model-roles/config.json`. An unassigned role inherits the main Pi
model.
`--approve` is broad project trust, not workflow-only approval.
