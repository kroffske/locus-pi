# Workflow run storage

Every workflow run owns one direct child of the project-local runtime root:

```text
.pi/locus-pi/workflows/<runId>/
  outputs/     readable run results produced from the terminal result and evidence
  workspace/   files written deliberately by workflow agents
  runtime/     machine state used by replay, continuation, status, and diagnostics
```

`extensions/workflows/runtime/workflow-run-layout.ts` owns every directory name,
path constructor, initialization rule, and confinement check. Callers must use
that module instead of rebuilding the layout with string literals.

The runner creates all three directories and initializes
`runtime/journal.ndjson` before announcing the RunID. Initialization failure
announces no start and launches no child. Every path is confined below the
physical project root; unsafe run ids, symlinks, and non-directory components
fail closed.

No compatibility reader exists for the former flat layout or its `files/` and
`logs/` directories. Old local runs may be deleted.

## `outputs/`: results for people

`outputs/` is the first directory to open after a run:

```text
outputs/
  README.md             run status, task, documents, revisions, budget, and links
  workflow-result.md    exact terminal prose, when the workflow returns text
  plan.md               latest semantic document named `plan.md`, when present
  task.md               input/task document, when present
  <artifact-name>       latest revision of another workflow-published document
```

`workflow-result.md` is runtime-owned and always means “the exact text returned
by the workflow.” A successful prose run must persist it; failure to do so makes
the run fail. The interactive workflow tool renders the same full text for the
operator without truncation, while the tool content sent back into model context
remains bounded.

Only text deliberately published by workflow code becomes a readable document.
Automatic child answers and consumed continuation copies remain evidence under
`runtime/artifacts/`; this prevents call-by-call traces from crowding the result
folder. Repeated published names are revisions of one document: the newest
revision occupies the readable file and `README.md` links every digest-bound
historical revision. `publishPrimaryArtifact(name, text)` explicitly marks one
semantic result; identity is never inferred by comparing its bytes with the
terminal answer. A completed `plan` workflow therefore exposes
`outputs/plan.md` and also keeps its exact terminal answer in
`outputs/workflow-result.md`. Duplication here is deliberate: one file is the
semantic document, the other is the workflow boundary result.

Structured terminal results stay in `runtime/result.json`. A failed or stalled
draft is not marked as the final result. Report materialization is best effort;
failure is recorded in the journal and result envelope. Exact terminal prose and
the machine result envelope are mandatory finalization records.

## `workspace/`: agent working files

`workspace/` replaces the former `files/` directory. The runtime creates it
before workflow code runs, returns its absolute path from
`dsl.runWorkspaceDir()`, and includes that path in every child prompt.

The runtime never renames, numbers, or projects files in this directory. An
agent that writes `plan.md` leaves `workspace/plan.md`; an empty workspace means
no agent deliberately wrote a working file. Read-only calls are told where the
directory is but are not asked to write there.

Workflow scripts should use `workspace/` for files they explicitly ask an agent
to create. They should use `publishArtifact()` for readable supporting documents,
`publishPrimaryArtifact()` for the single semantic result, and digest-bound
artifact references for continuation.

## `runtime/`: machine state

Everything needed by the host, replay, continuation, status, or forensic
inspection stays below `runtime/`:

| Path                                   | Purpose                                                                                     | Owner                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------- |
| `runtime/journal.ndjson`               | append-only phases, logs, agent starts/ends, usage, and errors                              | `workflow-journal.ts`         |
| `runtime/replay.ndjson`                | replay-safe agent answers plus `dsl.now()`/`dsl.random()` values                            | `workflow-replay.ts`          |
| `runtime/result.json`                  | terminal machine envelope, disposition, journal copy, identity, and projected artifact refs | `workflow-result.ts`          |
| `runtime/script-<sha256>.workflow.mjs` | immutable hash-named executed script snapshot                                               | `workflow-script-identity.ts` |
| `runtime/resources/`                   | immutable copies of loaded prompt resources                                                 | `workflow-resources.ts`       |
| `runtime/operator-handoff-claim.json`  | mutable continuation claim metadata; never answer content                                   | `workflow-handoff.ts`         |
| `runtime/artifacts/index.json`         | canonical digest-bound artifact inventory                                                   | `workflow-artifacts.ts`       |
| `runtime/artifacts/answers/`           | exact final answer from each agent attempt                                                  | `workflow-artifacts.ts`       |
| `runtime/artifacts/published/`         | deterministic text published by workflow code                                               | `workflow-artifacts.ts`       |
| `runtime/artifacts/inputs/`            | verified copies consumed from prior runs                                                    | `workflow-artifacts.ts`       |
| `runtime/artifacts/transcripts/`       | fresh child Pi JSONL transcripts and readable HTML renders                                  | `workflow-artifacts.ts`       |
| `runtime/artifacts/results/`           | fresh child result envelopes                                                                | `workflow-artifacts.ts`       |

The artifact index, not `outputs/`, is continuation authority. A later run must
receive the complete terminally projected `{ runId, artifactId, name, sha256 }`
reference. The host then verifies projection membership, index identity, size,
digest, confinement, and bytes before copying the input into the new run.

## Finding and retaining runs

- The canonical root is always
  `<projectRoot>/.pi/locus-pi/workflows/<runId>/`, where `projectRoot` comes from
  the Pi session rather than necessarily the terminal's current directory.
- `/workflows status <runId>` shows machine status and evidence.
- `/workflows result <runId>` opens the exact prose result from
  `outputs/workflow-result.md`.
- Nothing is pruned automatically. Live UI retention limits do not delete run
  directories.
- Deleting an entire run removes its readable outputs, working files, replay
  records, and continuation evidence. Delete only runs that are no longer needed
  as continuation sources.
