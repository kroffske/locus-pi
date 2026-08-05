# ADR: Extension ownership layers

- Status: accepted
- Date: 2026-07-30

## Context

`extensions/_shared/` was a flat directory. At its largest it held 64 modules with
no declared direction between them, so nothing stopped a foundational module from
importing a feature entrypoint, and nothing said which of those modules were
genuinely shared as opposed to merely sitting where everything used to sit. A
reviewer could not hold "which of these files may import which" in their head, and
the answer was not written down anywhere to be checked.

The fix was to give every shared module a declared owner and a declared direction.
Six named layers now exist as real directories, `_shared/` holds nothing else, and
the direction is recorded as data in `scripts/check-extension-layers.ts` and
re-checked mechanically by `npm run check:layers`, inside both `npm run check` and
`npm run check:push`. `AGENTS.md` states the rules a contributor must obey. This
ADR records the layout those rules describe and why it is shaped this way.

## The layout

Forty-three shared modules, each declared exactly once. A module's directory must
equal its declared layer, so the owner of a file is legible from its path rather
than from a table in a script.

- **`host`** — the Pi host API surface every extension talks through, plus the
  defensive helpers that depend on nothing else: tool-result and error shapes,
  package and workspace path derivation, schema validation, secret redaction, and
  the package-wide output bounds.
  `pi-api`, `error-text`, `files`, `validation`, `redaction`, `safe-output`.
- **`operator`** — the operator-facing terminal surface: command lifecycle, widget
  rendering, status line, input, keys, questions, notifications, and the scroll
  geometry every viewer recomputes.
  `command-ui`, `widget-render`, `operator-ui`, `operator-status`,
  `operator-input`, `operator-interaction`, `operator-keys`, `operator-question`,
  `operator-notify`, `viewer-geometry`.
- **`runtime`** — session-scoped storage and eventing: session stores and the
  selection of their backend, the runtime artifact store, and the dev event bus.
  `session-core`, `artifacts`, `event-bus`, `runtime-capabilities`.
- **`model`** — model selection and its display: the role table and selector
  grammar, the live model label, and the one owner of "which concrete model does
  this selector name".
  `model-settings`, `live-model-display`, `workflow-model-resolve`.
- **`project`** — project- and task-scoped durable state: goal mode, saved prompt
  commands, the task index, the task workspace bridge, and the todo phase store.
  `goal-mode`, `prompt-command-store`, `tasks-store`, `task-bridge`, `todo-state`.
- **`agent-runtime`** — the shared child-agent execution stack: catalog discovery,
  the run boundary and SDK session host, live rows, panel and transcript, the
  read-only tool policy, petnames, the system prompt and its context extras,
  evidence evaluation, the closed failure vocabulary, workload proof, and the
  fleet menu.
  `agents`, `agent-context-extras`, `agent-evidence-evaluator`,
  `agent-execution-prompt`, `agent-executor-host`, `agent-failure-cause`,
  `agent-live-panel`, `agent-live-transcript`, `agent-names`,
  `agent-read-only-policy`, `agent-runner`, `agent-sdk-host`,
  `agent-system-prompt`, `agent-workload-proof`, `fleet-menu`.

`agent-runtime` is the layer most likely to be mistaken for feature code. It stays
shared, rather than moving under `extensions/agents/`, because `extensions/workflows/`
runs its child agents through exactly this stack: filing it under the agents
extension would invert a dependency workflows already has.

## The declared order, and why

Each layer has a rank — `host` 0, `operator` 1, `runtime` 2, `model` 2, `project` 3,
`agent-runtime` 4 — and a module may import another shared module only when the
target layer's rank is less than or equal to its own. Same-layer imports are
allowed. `runtime` and `model` share a rank because neither is beneath the other;
in the tree as it stands neither imports the other at all.

The rank order is what the tree already did, made explicit and then enforced. Read
downward it is a sentence: the agent runtime needs models and session storage,
project state needs session storage, everything needs the host facade, and the host
facade needs nothing.

`operator` is narrowed further, and in both directions: it may reach only `host`
and itself, and no other shared layer may reach it. Its rank of 1 therefore
understates the constraint — the narrowing is by name, not by rank. Operator UI is
a leaf consumer. A foundational module that depended on it would drag command
registration and widget rendering down into the base of the tree, where every other
layer would then carry them transitively. No shared module imports the operator
layer today, and that is the property the rule protects.

Type-only imports are enforced identically. They are reported distinctly, because a
`import type` edge tells a reader something different, but they are never exempt: a
type-only edge still says this module's contract is defined in terms of that one,
which is ownership.

## The one sanctioned cross-extension read

`extensions/workflows/run-read.ts` is the only door into workflow run persistence
for code outside the workflows extension. Workflow runs persist under
`.pi/locus-pi/runs/<runId>/`, and the module that owns that layout —
`extensions/workflows/runtime/workflow-journal.ts` — also owns the append sink, the
journal-to-live-row projection, and the live-row retention bound. Two consumers
only ever needed to read a run, and both had been importing that module directly,
so both held its write side.

Exactly two modules outside the extension go through the facade today:

- `extensions/agents/drill-command.ts:18`, for the agent drill's round submenu;
- `extensions/loop/loop-continuation.ts:29`, for the loop's continuation source.

The facade re-exports seven read operations and the one type they return. It
deliberately re-exports no sink, no append, no retention pass, and no live-row
mutation. It also implements nothing itself: five of the seven resolve through
private journal internals — the start-timestamp proof that orders runs, the
per-line structural validator, the persisted-result projection — so copying one
here would fork a parser away from the format it parses.

Guardrail rule 9 is what makes it the only door. Rule 1 governs direction — shared
code may not reach up into a feature — but two extensions are peers, so nothing in
rule 1 stopped one from reaching into another's internals, and a facade a peer can
bypass buys nothing. The journal is therefore declared internal to
`extensions/workflows/`, with `run-read.ts` named as its single exception: any other
extension importing the journal directly fails the check. Rule 9 governs only
modules declared internal this way, so the extension's other public files remain
ordinary imports — the agents extension also reads the workflow progress widget and
the background-run registry, neither of which is behind a facade.

## Why a script rather than a convention

Because two of the failure modes this refactor actually hit are structurally
invisible to a static check, and a convention cannot see what a check cannot.

**A path derived from a module's own file location.** Such a path silently
repoints at a directory that does not exist when the module moves. This happened
twice, and both times `check:layers` reported zero violations and `typecheck`
passed. Moving the workflow loader repointed the Package workflow registry, which
it derives from its own `import.meta.url`, and every shipped example would have
vanished from `/workflows` with nothing raised; the test asserting the exact six
shipped names is what caught it. Moving `agents.ts` one directory deeper repointed
the bundled agent catalog at `extensions/.agents/agents`, and because discovery
treats a missing bundled directory as non-fatal, `/agent list` would have quietly
dropped all ten shipped agents. The catalog derivation now carries a comment saying
it must be re-counted on the next move; the registry one does not. Both are proved
at runtime rather than statically:
`tests/integration/public-registration.test.ts` and
`tests/extensions/agents/bundled-agent-profiles.test.ts` load through the derived
paths and would fail on an empty result.

**A process-global registry that becomes per-module-instance state.** Pi loads each
registered entrypoint with the module cache disabled, so two entrypoints hold two
instances of any module they both import, and only a versioned `globalThis` slot
makes them agree. Rule 7 asserts statically that exactly one module names each
slot, matching by both symbol string and owning path — but that is a source-level
count, and duplicating a slot's state per module instance leaves it green and
`typecheck` clean. Only a test that loads two entrypoints in one process can see
it. Seven registries are declared:

| Registry                                   | Owning module                                      | Cross-entrypoint proof                                                    |
| ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------- |
| `locus-pi.agent-live-store.v5`             | `_shared/agent-runtime/agent-sdk-host.ts`          | `tests/extensions/agents/agent-live-store-entrypoints.test.ts`            |
| `locus-pi.command-ui-lifecycle.v2`         | `_shared/operator/command-ui.ts`                   | `tests/integration/command-ui-lifecycle.test.ts`                          |
| `locus-pi.operator-status.v1`              | `_shared/operator/operator-status.ts`              | `tests/integration/operator-status.test.ts`                               |
| `locus-pi.fleet-menu-state.v2`             | `_shared/agent-runtime/fleet-menu.ts`              | `tests/extensions/agents/fleet-menu-entrypoints.test.ts`                  |
| `locus-pi.workflow-live-executions.v1`     | `extensions/workflows/runtime/workflow-journal.ts` | `tests/extensions/workflows/workflow-live-executions-entrypoints.test.ts` |
| `locus-pi.active-agent-session-viewers.v1` | `extensions/agents/session-viewer.ts`              | `tests/extensions/agents/session-viewer-entrypoints.test.ts`              |
| `locus-pi.workflow-background-runs.v1`     | `extensions/workflows/background-run-registry.ts`  | none                                                                      |

Six of the seven are proved across two separately registered entrypoints loaded
with the module cache disabled. The three proofs this breakup added were each
falsified before landing, by duplicating the state per module instance and
confirming the static check and `typecheck` stayed green while the proof failed.
`locus-pi.workflow-background-runs.v1` has no such proof; it is covered
same-process only, and it is the one registry owner none of the slices moved.

The same reasoning produced a second ledger for mutable module state that is not a
`globalThis` slot. Three such bindings are declared, and none of them survives
cache-disabled entrypoint loading — each loaded entrypoint gets its own copy — so a
relocation must not quietly imply otherwise.

## Considered and rejected

- **Compatibility re-export shims at the old paths.** Every relocation updated its
  importers instead, and the two catch-all files were deleted rather than left as
  stubs. A shim is a second live path for one module, and this ledger is keyed to
  exactly one: the ledger keys modules by basename, a module's directory must equal
  its declared layer, and a registry is bound to a single owning path. The guardrail
  already treats a second accepted path as a defect in its own data — the mechanism
  for naming the path an owner is about to become is asserted non-stale, because a
  leftover alias is a silent second owner for a slot only one module may declare.
- **Moving a shared module down into one of its consumers, behind a second facade.**
  Rejected for `workflow-model-resolve`. Two extensions consume it, and that is
  deliberate parity rather than an accident of history: the workflows agent bridge
  resolves a workflow child call's selector through it, and the agents extension
  resolves an agent definition's declared model through the same module. Making one
  of them the owner and the other a facade client would put a seam through the one
  question both are asking, and a model selector is exactly the surface where two
  answers is a defect a reader cannot see — one agent name would resolve to two
  models. Selector resolution in this package has already failed silently once: it
  read the host's model lookup from a path the pinned host no longer exported it
  from, so every selector resolved to nothing and calls fell through to the parent
  session's model, while the journal, the live row and the run-result artifact all
  reported the selector as though it had been honoured. A single owner is what makes
  that class of failure one bug rather than a disagreement.
- **Loosening a rank to admit an inconvenient edge.** Declared exceptions name the
  edge instead, and are asserted still to exist so the list fails as stale once a
  slice removes one. A loosened rank would silently permit every other edge of the
  same shape, none of which anybody reviewed. Both exception mechanisms are empty
  today and kept for that discipline.

## Consequences

The owner of a shared module is now a property of the tree, and the direction
between owners fails a check rather than a review. Moving anything under
`extensions/` costs a ledger update in the same change, which is the intended
price: the alternative was a directory where the correct place for a new module was
unknowable.

Two things this deliberately does not claim. The rank order is not a claim that a
lower layer is more stable or more tested, only that it may not depend upward. And
`check:layers` passing is not a claim that a relocation is safe — the two failure
modes above are why every slice of the breakup also owed a runtime proof, and why
one registry is recorded here as still lacking one.
