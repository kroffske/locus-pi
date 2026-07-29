# Where a workflow run writes

One workflow run produces two directory trees, split by who reads them. The
split exists because a single mixed folder made the one file worth opening
(`result.md`) indistinguishable from the machine evidence around it.

## `.locus-pi/<runId>/` — the reader's copy

Written once, at run finalization, by
`extensions/_shared/workflow-run-report.ts`. Everything here is for a person;
nothing in the runtime reads it back. Deleting this folder loses no evidence —
every byte is a projection of the machine records below.

```
<project root>/.locus-pi/<runId>/
  README.md            table of contents: workflow, status, task, result,
                       the document list in creation order, and a pointer
                       to the machine records
  task.md              the operator task, verbatim as the workflow received it
  result.md            the run's terminal text (present when the result is prose)
  01-scout-context.md              agent documents, in creation order:
  02-planner-round-1-plan.md       <NN>-<author>-<artifact name>, where the
  03-critic-round-1-plan-critique.md     author is the workflow's own stage
                                   label ("planner round 1") and the artifact
                                   extension is preserved — `.md` is appended
                                   only when the name carries none
```

A JSON document (a critic's verdict, any schema-shaped answer) is rendered as
Markdown here — a flat object becomes a key list with numbered items, anything
nested stays pretty-printed inside a fence — because this folder is for
reading. The verbatim JSON bytes remain in the artifact store below.

Documents published by the script itself use the author `workflow`; documents
consumed from a previous run (continuations) use `input`. The writer mirrors
the artifact store's path discipline: the run id must be a safe component and
no element of `.locus-pi/<runId>` may be a symlink, checked before anything —
including the directory itself — is created.

Report folders are not rotated: they are small, text-only, and the point is
that yesterday's run is still readable tomorrow. Delete them freely.

## `.locus/runtime/workflows/<runId>/` — the machine records

Owned by the runtime; a person is never required to open it. Layout, one owner
per file:

| Path                               | What it is                                                                                       | Owner                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------- |
| `journal.ndjson`                   | append-only event journal: phases, agent start/end, script logs                                  | `workflow-journal.ts`         |
| `replay.ndjson`                    | per-call record that lets a run be resumed or replayed                                           | `workflow-replay.ts`          |
| `result.json`                      | machine terminal envelope: ok, disposition, result, journal copy, script identity, artifact refs | `workflow-result.ts`          |
| `result.md`                        | verbatim terminal text (the copy `/workflows result` opens)                                      | `workflow-result.ts`          |
| `script-<sha256>.workflow.mjs`     | snapshot of the executed script, hash-named                                                      | `workflow-script-identity.ts` |
| `resources/<sha>-<name>.prompt.md` | snapshots of external prompt files a stage loaded                                                | `workflow-resources.ts`       |
| `artifacts/index.json`             | hash-verified index of every artifact below                                                      | `workflow-artifacts.ts`       |
| `artifacts/answers/`               | each agent call's final answer                                                                   | `workflow-artifacts.ts`       |
| `artifacts/published/`             | documents the script published (task, questions, state snapshots)                                | `workflow-artifacts.ts`       |
| `artifacts/inputs/`                | texts consumed from a previous run as a continuation                                             | `workflow-artifacts.ts`       |
| `artifacts/transcripts/call-NNNN/` | full child-session transcript per call                                                           | `workflow-artifacts.ts`       |
| `artifacts/results/call-NNNN/`     | child result envelope per call                                                                   | `workflow-artifacts.ts`       |

The artifact store stays the durable source of truth: replay, continuations,
and the live panel verify against its digests. The reader's copy above is
derived from it and from the journal, never the other way around.

## Retention and compatibility

- Neither tree is pruned on disk. The "last five completed runs" bound applies
  to live-panel rows only (`RETAINED_COMPLETED_WORKFLOW_RUNS` in
  `workflow-journal.ts`), not to directories.
- Runs finished before the report writer existed have machine records only;
  they are left as they are, and nothing regenerates a report for them.
- A report write failure never fails the run — the machine envelope is written
  first and remains authoritative.
