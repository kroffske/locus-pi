# Where a workflow run writes

One workflow run writes everything under
`<project root>/.locus/runtime/workflows/<runId>/`, split by who produced it.
Two of those directories are addressed by name and are the ones a person opens:

```
.locus/runtime/workflows/<runId>/
  files/     what the run's AGENTS wrote, under their own names
  logs/      what the runtime CAPTURED, in order
  …          machine records (journal, replay, result envelope, artifacts)
```

The split exists because the two answer different questions. "Where is the plan
the planner wrote?" is answered by a file called `plan.md`. "What happened, and
in which order?" is answered by a numbered journal. Mixing them forced one of
the two to lose: the previous layout renamed `plan.md` to
`08-workflow-plan.md`, so a question the workflow printed could name a file that
existed nowhere on disk.

## `files/` — the run working directory

Created before the script starts, by
`extensions/workflows/runtime/workflow-run-layout.ts`. Its absolute path is
handed to the script as `dsl.runFilesDir()` and stated at the top of every child
agent's prompt ("create any file this run should leave behind there, under the
exact name it should have"). A read-only child is told where the directory is
and is not asked to create anything in it.

The runtime never writes here, never renames, never numbers. A file an agent
called `plan.md` is `plan.md`. An empty `files/` therefore means exactly one
thing: no agent wrote a file.

## `logs/` — the ordered run journal

Written once, at run finalization, by
`extensions/workflows/runtime/workflow-run-report.ts`. Everything here is
auto-captured and everything is for a person; nothing in the runtime reads it
back. Deleting this folder loses no evidence — every byte is a projection of the
machine records beside it.

```
.locus/runtime/workflows/<runId>/logs/
  README.md            table of contents: workflow, status, task, result,
                       the budget this run was held to beside the spend its
                       evidence can measure, the document list in creation
                       order, and pointers to `../files/` and the machine records
  task.md              the operator task, verbatim as the workflow received it
  result.md            the run's terminal text (present when the result is prose)
  01-scout-context.md              captured texts, in creation order:
  02-planner-round-1-plan.md       <NN>-<author>-<artifact name>, where the
  03-critic-round-1-plan-critique.md     author is the workflow's own stage
                                   label ("planner round 1") and the artifact
                                   extension is preserved — `.md` is appended
                                   only when the name carries none
```

The ordinal prefix lives here and only here: order and time are properties of a
journal, not of a file an author named. What is captured is every agent's final
ANSWER, every text the script published, and every text a continuation consumed
— never the files under `files/`.

A JSON document (a critic's verdict, any schema-shaped answer) is rendered as
Markdown here — a flat object becomes a key list with numbered items, anything
nested stays pretty-printed inside a fence — because this folder is for
reading. The verbatim JSON bytes remain in the artifact store below.

Documents published by the script itself use the author `workflow`; documents
consumed from a previous run (continuations) use `input`. Both directories are
held to the artifact store's path discipline: the run id must be a safe
component and no element of the chain below the physical project root may be a
symlink, checked before anything — including the directory itself — is created.

The `## Budget` section lists all seven axes of the applied
`DEFAULT_WORKFLOW_BUDGET` beside what this run actually spent. Only some of that
spend exists as evidence: agent invocations, run wall clock, longest child and
observed tokens come from the journal, and peak concurrency comes from the
concurrency gate itself — counting overlapping `agent_start`/`agent_end`
intervals would count queued children, because `agent_start` is written before
the gate is acquired. Per-child tool calls, turns and answer characters are
enforced and counted by nobody, so they print as "not recorded"; cost prints as
unavailable because the host reports a constant zero. None of those ever print
as `0`, which would claim a measurement nobody made.

A replayed call is counted where it really spends and nowhere else. It costs one
invocation against `totalAgents` — the runtime counts it before the replay
lookup — but no child starts, so the row says `N invocations (M replayed, no
child ran)` rather than `N started`, its duration is excluded from the longest
child, and it reports no tokens. A run served entirely from records prints its
longest child as "not recorded", because none ran.

Writing this folder is best effort: `writeWorkflowRunReport` never throws and
returns its failure as a value, and a failed write does not fail the run. It is
not silent, though — the runner writes an `error` line naming the path and the
reason, and that line reaches three places, not one: the append-only
`journal.ndjson`, the run's live event surface, and the journal copy inside
`result.json`. The report is written _before_ `result.json` precisely so the
failure line is part of the envelope that persists it. `journal.ndjson` alone
would not carry the guarantee — its sink swallows its own `mkdir`/append
failures by design, so that it can never throw into a running workflow — but
`result.json` reports its own persistence outcome, so a report failure that
vanishes everywhere would take a second, separately reported, write failure.

Log folders are not rotated: they are small, text-only, and the point is
that yesterday's run is still readable tomorrow. Delete them freely.

## The machine records

The rest of the run directory. Owned by the runtime; a person is never required
to open it. Layout, one owner per file:

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
| `artifacts/transcripts/call-NNNN/` | full child-session transcript per call: `.jsonl` plus its `.html` render                         | `workflow-artifacts.ts`       |
| `artifacts/results/call-NNNN/`     | child result envelope per call                                                                   | `workflow-artifacts.ts`       |

The artifact store stays the durable source of truth: replay, continuations,
and the live panel verify against its digests. The journal folder above is
derived from it and from the journal file, never the other way around.

Each child session is exported twice at the same capture point
(`extensions/_shared/agent-runtime/agent-sdk-host.ts`): `AgentSession.exportToJsonl`
writes the transcript that the artifact store adopts and hash-verifies, and
`AgentSession.exportToHtml` writes a readable render beside it under the same
base name. The render is additive — the Pi TUI reader stays the required
surface — but it is never silently skipped: the path is recorded on
`childTrace.htmlPath` in the call's result envelope only after the file has been
verified on disk, and every reason there is no render (a host without the
method, a renderer that threw, an unusable output) is a
`HTML transcript render …` warning in the same envelope's `diagnostics`. To
re-render an old transcript offline, run `pi --export <transcript>.jsonl <out>.html`.

## Retention and compatibility

- Nothing is pruned on disk. The "last five completed runs" bound applies
  to live-panel rows only (`RETAINED_COMPLETED_WORKFLOW_RUNS` in
  `workflow-journal.ts`), not to directories.
- Runs finished before the report writer existed have machine records only;
  they are left as they are, and nothing regenerates a report for them.
- Runs finished before this layout wrote their reader's copy to
  `<project root>/.locus-pi/<runId>/`. Nothing reads or writes that path any
  more; it is left where it is, and `.gitignore` still covers it.
- A report write failure never fails the run — the machine records remain
  authoritative. Ordering, since the two are easy to get backwards: the journal
  is appended throughout the run, then the report is written, then `result.json`
  closes the run. The report goes second on purpose, so that a failed report
  write is already recorded in the journal copy `result.json` persists.
