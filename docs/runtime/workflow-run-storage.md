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
workspace. An explicit `outputDir` remains a safe project-relative override,
selected programmatically or with
`/workflows run <name|path> --output-dir <path>`.

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
Lease acquisition, stale-owner replacement, and release prove the complete
`workflow-state/<namespace>/lease/owner.json` ancestor chain before reading or
mutating it. A symlinked or dangling lease directory is unsafe evidence, never
an absent owner, and cannot redirect cleanup to an external sentinel.

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

| Path                                   | Purpose                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `runtime/journal.ndjson`               | phases, logs, agent starts/ends, usage, and errors                                                                       |
| `runtime/replay.ndjson`                | replay-safe answers plus recorded `dsl.now()`/`dsl.random()` values                                                      |
| `runtime/result.json`                  | terminal envelope, workspace/run paths, disposition, journal, identity, and projected refs                               |
| `runtime/launch-binding.json`          | write-once host-owned source/target/workspace/input binding used for exact post-code-review resume and handoff admission |
| `runtime/script-<sha256>.workflow.mjs` | retained executed script snapshot                                                                                        |
| `runtime/resources/`                   | retained prompt resources                                                                                                |
| `runtime/operator-handoff-claim.json`  | mutable continuation claim metadata; never answer content                                                                |
| `runtime/worktrees/`                   | retained Git worktrees created by explicit isolation APIs                                                                |
| `runtime/artifacts/index.json`         | canonical digest-bound artifact inventory                                                                                |
| `runtime/artifacts/answers/`           | exact final answer from each agent attempt                                                                               |
| `runtime/artifacts/published/`         | deterministic text explicitly published by workflow code                                                                 |
| `runtime/artifacts/inputs/`            | verified copies consumed from prior runs                                                                                 |
| `runtime/artifacts/transcripts/`       | fresh child Pi transcripts                                                                                               |
| `runtime/artifacts/results/`           | fresh child result envelopes                                                                                             |

The artifact index, not `outputs/`, is continuation authority.

## Direct Pi observability

An external agent that invokes `/workflows run` through
`pi --mode json -p --no-session --approve` reuses this storage contract. The
typed `workflow_start` receipt reports the absolute existing paths:

```text
/workflows run <name|path> --output-dir <path>
```

```text
runDir       <projectRoot>/.pi/locus-pi/runs/<runId>
journalPath  <runDir>/runtime/journal.ndjson
resultPath   <runDir>/runtime/result.json
```

The calling agent may tail `journalPath` to inspect real phases, logs, and agent
events, then read `resultPath` for terminal truth when `workflow_end` reports
`resultPersisted:true`. The start receipt names the canonical expected path
before that file exists; a post-identity runner escape or failed result write
reports `resultPersisted:false`. Direct Pi invocation creates no duplicate log,
receipt, or cache directory. The durable journal, not a spinner or process exit
code, is the source for deciding whether work progressed.

`runtime/result.json` is a readable, mutable projection. For the owner-specific
`post-code-review` resume and operator handoff paths, the runtime also writes
`launch-binding.json` once after validated launch state is established. Those
paths require the binding and reject any result projection whose run, target,
script, workspace, explicit-selection bit, or semantic-input digest differs.
Generic workflows and legacy runs without this sidecar retain their existing
readability and resume rules.

Run-evidence access rejects symlinked ancestors and leaf files. Regular file
reads and writes also use `O_NOFOLLOW` plus descriptor identity checks. Node's
portable filesystem API does not expose dirfd-relative `readdir`, `rename`, or
`unlink`, so a hostile local process that replaces an ancestor concurrently can
still race those path-based operations. Operator handoff claim and lock sidecars
use the same confined runtime-file owner for reads, exclusive creation, atomic
replacement, and removal; the replacement/removal operations retain that exact
portable Node path-based TOCTOU limit. Workflow JavaScript is already trusted
host code; this is a residual local evidence-integrity limit, not process
isolation.

## Lookup and retention

- `/workflows status <runId>` shows both `workspaceDir` and `runDir` when the
  persisted envelope is available.
- Result envelopes also persist `workspacePhysicalIdentity` with schema version
  `1`, a canonical project-relative identity with no workstation absolute path. Exact
  `post-code-review` resume requires this field to be valid and equal to the
  newly resolved physical workspace before lease or checkpoint access. This
  generated identity is separate from the caller-facing `outputDir` grammar:
  default workspaces may contain spaces or exceed its 400-character bound, while
  runtime resolution proves lexical and physical project containment before
  persisting the identity.
- New readers inspect only `.pi/locus-pi/runs/<runId>/`.
- Old `.pi/locus-pi/workflows/<runId>/` directories are left untouched. An exact
  lookup returns a named migration message; there is no fallback read or
  automatic migration.
- Removing a run directory removes automatic evidence but not its project-local
  workflow workspace. Removing a workspace does not remove run evidence.
- `tmp/` is a project convention in this repository. The runtime does not claim
  that every foreign repository ignores it.
