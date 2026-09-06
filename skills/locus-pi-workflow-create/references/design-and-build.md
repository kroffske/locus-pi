# Design, review, Build

Audience: the author after a graph pattern has been selected. This file owns the authoring process and design record, not the DSL grammar or runtime defaults.

## Authoring is continuous by default

A plain request to create, design, write, or author a workflow runs one visible
sequence in the same turn:

1. Create `.locus-pi/workflows/<name>/` and write
   `.locus-pi/workflows/<name>/<name>.design.md` before any source.
2. Review the design against the request, selected pattern, graph contract, and
   standard source profile. Revise the design until the review finds no material
   mismatch.
3. Build exactly the direct `.workflow.mjs` entries declared by the reviewed
   design. A `runnable root` design includes
   `.locus-pi/workflows/<name>/<name>.workflow.mjs`; a `group-only` design omits it
   and builds only its direct children. Never invent a root.
4. Validate source identity, module load, graph correspondence, and standard
   source shape. Do not run the workflow unless the user separately asks to run it.

The design remains the readable source of truth and must exist before JavaScript;
continuous authoring removes only the mandatory human pause between them. Stop
after the design only when the user explicitly asks for `design only`, `pause
after design`, `do not build`, or equivalent wording. A user may also request the
build-only compatibility route with `Build approved design: <exact design path>`
or `Build design: <exact design path>`.

If design review or Build discovers a material algorithm mismatch, update and
re-review the design before
building; never hide the change in source. Ask the user only when resolving the
mismatch would change the requested result, not for routine authoring choices.

## Design contract

The design is short Markdown a reader can approve without opening JavaScript:

```markdown
# Design: <name>

Purpose: <one sentence>
Input: <semantic text or none>
Primary output: `<name>.md`
Evidence boundary: <semantic input, caller items, author-known prompt material, or child inspection>
Pattern: <catalog pattern, or why none fits>

Namespace: `runnable root` (include the `<name>` entry below) or `group-only`
(omit the root entry; children remain directly runnable)

## Entries

| Ref              | Entry kind    | Responsibility         | Invoked by |
| ---------------- | ------------- | ---------------------- | ---------- |
| `<name>`         | runnable root | <standard entry point> | operator   |
| `<name>/<child>` | direct child  | <one bounded subtask>  | `<node>`   |

For `group-only`, omit the `<name>` row entirely. Declare every direct child
that Build must create; do not declare grandchildren or an implicit root.

1. <numbered algorithm>

| Node     | Responsibility         | Receives      | Returns                              | Next       |
| -------- | ---------------------- | ------------- | ------------------------------------ | ---------- |
| `<node>` | <one coherent subtask> | <exact input> | <complete text, choice, or handoffs> | <consumer> |

Concurrency: <groups or none>
Loop bounds: <bounds or none>
File boundary: workflow source performs no file reads; name any child-owned source inspection
Worst-case calls: <exact formula including saved children>
Failure exits: <fail-closed exits>
Mechanisms: <parallel barriers, choices, loops, human gates; no agent-count penalty>
Status: REVIEWED — ready for build.
```

Count orchestration machinery, not agents. More agents are fine when the task
really decomposes into more coherent subtasks.

Read [the pattern index](INDEX.md), then only the selected
pattern card. The cards are algorithms and small snippets, not full workflows to
copy blindly.

## Build checks

Build writes one canonical folder matching the reviewed design: an optional
`.locus-pi/workflows/<name>/<name>.workflow.mjs` only when the namespace is declared
`runnable root`, plus only its declared direct child entries. A `group-only`
namespace has no root source and never receives a fake one. It then checks:

- the design `Entries` table and source set match exactly;
- when present, root `meta.name` equals `<name>`; each child `meta.name` equals
  `<name>/<child>` and its filename is `<child>.workflow.mjs`;
- `meta.profile` is `"standard"`;
- source identity policy passes;
- the module loads and exports `meta` plus a default function;
- source exposes the reviewed nodes, edges, handoffs, bounds, and failure exits;
- no design-absent node or standard-profile bad smell appeared.
- the exact built file passes the Pi-native `workflow_check_source` tool with
  `mode: "orchestration-only"` for every built
  `.locus-pi/workflows/<name>/*.workflow.mjs` path.
- every built source uses only the orchestration-only DSL subset and contains no
  file, path, artifact-consumption, clock, or randomness primitive.

Read checker diagnostics as `path:line:column [CODE] message`. Any error fails
Build. Warning-only output remains a successful check, but Build must report the
warning and repair declaration drift when it concerns generated source.

An unavailable tool, failed checker result, failed module import, or
design/source mismatch means Build failed. Repair and rerun; never return a
successful Build claim after a skipped or failed check.

Build does not run. The caller runs it separately and evaluates the primary
artifact against live repository evidence. A successful Build returns the exact
copyable launch command `/workflows run <name>` (or the qualified child ref).

## Pattern-specific design decisions

For fixed graphs, do not add a judge or semantic retry that the request did not require. For refinement, record the completion authority, immutable criteria, measured evidence, literal round cap, no-progress rule, exact handoff and terminal outcomes. For decomposition, record local concurrency, global budget and key ownership. Human continuation names two runs and a verified artifact handoff, never a suspended JavaScript stack.

Budget values and failure dispositions belong to the [runtime reference](../../../extensions/workflows/REFERENCE.md); source provenance, mutation and permitted DSL methods belong to [AUTHORING.md](../../../extensions/workflows/AUTHORING.md). Read the relevant sections before Build. Do not duplicate those invariants in another skill.

A standard source check is not live proof. Report the exact checks executed and any unavailable native checker, dependency, host or model route. Do not report successful Build after a skipped gate.
