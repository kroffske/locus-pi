# Workflow file and run storage

Workflow-owned files and automatic run evidence are separate locations. They
must never resolve to the same directory.

```text
<pwd>/tmp/<workflow-name>/
  <agent-authored intermediate and final files>

<projectRoot>/.pi/locus-pi/
  runs/<runId>/
    outputs/    human-readable host projection
    runtime/    machine evidence and continuation authority
  workflow-state/v1/    workspace leases and completed-item checkpoints
```

`pwd` is Pi's session working directory. The runtime verifies both its lexical
and physical location inside the project root before creating the default
workspace. An explicit `outputDir` remains a safe project-relative override.

`extensions/workflows/runtime/workflow-run-layout.ts` owns `.pi/locus-pi/`, the
`runs/` and `workflow-state/` names, and every run-evidence path. Other runtime
modules use its constructors instead of rebuilding the prefix.

## Workflow workspace: agent-owned files

`dsl.outputDir()` returns the project-relative workspace identity. The default
is `tmp/<workflow-name>` below the verified Pi working directory. The runtime
creates the resolved absolute directory before the first child and prepends it
exactly once to every child task.

Agents write intermediate and final files there under their assigned names.
Workflow JavaScript passes exact text or file names between agents; it does not
parse, validate, render, repair, or reconstruct their semantic output. Writers
replace assigned files idempotently. The runtime does not clean, rename, or
move workspace files.

`publishPrimaryFile(relativePath)` validates one regular, non-symlink, non-empty
file below the workspace and returns its absolute/relative path, byte count, and
SHA-256 digest without copying or interpreting content.

One fenced lease owns each physical workspace. Concurrent runs targeting the
same default or explicit workspace fail closed. Parallel callers choose distinct
explicit directories. Saved children inherit the root workspace and lease.

`runWorkspaceDir()` is removed and throws
`WorkflowRunWorkspaceRemovedError`. A run-local `workspace/` directory is not
created.

## `outputs/`: human projection

`outputs/` is runtime-owned and may contain:

```text
README.md             status, workspace path, budget, documents, and links
workflow-result.md    exact terminal prose, when the workflow returns text
<artifact-name>       newest text explicitly published by workflow code
```

Only `publishArtifact()` and `publishPrimaryArtifact()` project semantic text
here. Automatic child answers remain under `runtime/artifacts/`.
`publishPrimaryFile()` records a safe file reference; it does not copy the file
into `outputs/`.

`/workflows result <runId>` reads `outputs/workflow-result.md` first and falls
back to `runtime/result.json` when the readable copy is missing.

## `runtime/`: machine evidence

| Path                                   | Purpose                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `runtime/journal.ndjson`               | phases, logs, agent starts/ends, usage, and errors                                         |
| `runtime/replay.ndjson`                | replay-safe answers plus recorded `dsl.now()`/`dsl.random()` values                        |
| `runtime/result.json`                  | terminal envelope, workspace/run paths, disposition, journal, identity, and projected refs |
| `runtime/script-<sha256>.workflow.mjs` | retained executed script snapshot                                                          |
| `runtime/resources/`                   | retained prompt resources                                                                  |
| `runtime/operator-handoff-claim.json`  | mutable continuation claim metadata; never answer content                                  |
| `runtime/worktrees/`                   | retained Git worktrees created by explicit isolation APIs                                  |
| `runtime/artifacts/index.json`         | canonical digest-bound artifact inventory                                                  |
| `runtime/artifacts/answers/`           | exact final answer from each agent attempt                                                 |
| `runtime/artifacts/published/`         | deterministic text explicitly published by workflow code                                   |
| `runtime/artifacts/inputs/`            | verified copies consumed from prior runs                                                   |
| `runtime/artifacts/transcripts/`       | fresh child Pi transcripts                                                                 |
| `runtime/artifacts/results/`           | fresh child result envelopes                                                               |

The artifact index, not `outputs/`, is continuation authority.

## Lookup and retention

- `/workflows status <runId>` shows both `workspaceDir` and `runDir` when the
  persisted envelope is available.
- New readers inspect only `.pi/locus-pi/runs/<runId>/`.
- Old `.pi/locus-pi/workflows/<runId>/` directories are left untouched. An exact
  lookup returns a named migration message; there is no fallback read or
  automatic migration.
- Removing a run directory removes automatic evidence but not its project-local
  workflow workspace. Removing a workspace does not remove run evidence.
- `tmp/` is a project convention in this repository. The runtime does not claim
  that every foreign repository ignores it.
