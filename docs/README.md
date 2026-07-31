# locus-pi docs map

This directory holds the public map of the `locus-pi` package: what Pi loads,
which extensions are available, where permissions and risks are described, and
which constraints matter before publishing. Internal plans, runtime state,
drafts and one-off artifacts are not part of this map.

## Source truth

- `package.json#pi.extensions` — the single list of extensions that are loaded
  by default.
- `package.json#pi.skills` — the one directory Pi scans for shipped skills. It
  holds [`../skills/locus-pi-workflows/SKILL.md`](../skills/locus-pi-workflows/SKILL.md),
  which is what an agent reads to learn that workflows exist here, how to run
  one, and how to author one.
- `extensions/<name>/manifest.json` — machine-readable metadata for an
  extension: commands, tools, hooks, permissions, risk and review/source status.
- [extension-index.md](extension-index.md) — public status index for the ten
  retained active extensions and six curated workflows.
- [extension-ownership-matrix.md](extension-ownership-matrix.md) — ownership and
  promotion decisions. If an extension changes the default surface, the decision
  must show up there.
- [extensions/active/](extensions/active/README.md) — manual pages for the ten
  default extensions.
- `docs/prd/todo-session-auto-continuation.md` — repository product contract for
  bounded session queue execution. Repository-only; it is not packed.

Registered extensions: 10 active by default: `agents`, `ask-user-question`, `ast-structural-edit`, `devext-doctor`, `loop`, `model`, `plan`, `security-gate`, `todo-context`, `workflows`.

## Public Map

| Surface                                                | Public home                                                                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install, trust, `npx` smoke and quick operator checks  | [../README.md](../README.md).                                                                                                                        |
| Repository-only release policies                       | `CONTRIBUTING.md`, `SUPPORT.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `CHANGELOG.md` live at repository root and are intentionally not packed.   |
| Default extension list                                 | `package.json#pi.extensions`; mirrored above for docs sanity.                                                                                        |
| Active extension manuals                               | [extensions/active/](extensions/active/README.md).                                                                                                   |
| Todo queue execution product contract                  | `docs/prd/todo-session-auto-continuation.md`, repository-only and intentionally not packed.                                                          |
| Extension status and risk index                        | [extension-index.md](extension-index.md).                                                                                                            |
| Ownership and promotion decisions                      | [extension-ownership-matrix.md](extension-ownership-matrix.md).                                                                                      |
| Package/runtime boundary                               | [runtime/locus-workspace.md](runtime/locus-workspace.md).                                                                                            |
| Agent execution trust model                            | [adr/agent-execution-trust-model.md](adr/agent-execution-trust-model.md).                                                                            |
| Curated workflow portfolio                             | [adr/curated-workflow-portfolio.md](adr/curated-workflow-portfolio.md).                                                                              |
| Extension ownership layers under `extensions/_shared/` | [adr/extension-ownership-layers.md](adr/extension-ownership-layers.md).                                                                              |
| Source attribution and borrowed behavior               | [Repository-only source-audit notes](https://github.com/kroffske/locus-pi/tree/main/docs/source-audit) named by active manifests.                    |
| Bundled agent catalog used by `agents` and `workflows` | `.agents/agents/`, which ships in the tarball as ten agent files with no index page. This is package runtime surface, not private planning material. |
| Shipped skill an agent loads to use workflows          | [../skills/locus-pi-workflows/SKILL.md](../skills/locus-pi-workflows/SKILL.md), declared by `package.json#pi.skills`.                                |

## Excluded from the clean release

These paths are local or internal and must stay ignored unless a separate
promotion decision says otherwise:

- `.locus/**` — runtime state, generated reports, task-local evidence.
- `.locus-pi/**` — retired location of workflow run reports, which now live inside
  the run directory (`.pi/locus-pi/workflows/<runId>/logs/`). Still ignored so a
  checkout that predates the move stays clean.
- `.tasks/**` — local task state.
- `.pi/**` — project-local Pi settings and workflow scratch.
- `.planning/**` — planning export and historical planning state.
- `specs/**` — draft specs.
- `artifacts/**` — one-off implementation artifacts.
- `.agents/skills/**` and `.agents/workflows/**` — local authoring surfaces.
- `extensions/beta/**` and `docs/extensions/beta/**` — private-history beta,
  fixtures, and backlog material; these paths do not exist in the clean repo.
- `catalog/**`, `STATUS.md`, benchmarks, evaluations, reports, galleries,
  archives, transcripts, and system-design output — private internal context,
  not the clean repository or npm v1 surface.

## Package Boundary

The npm package intentionally ships only the ten default entrypoints and their
explicit local import closure, the six curated Package workflows
(`live-smoke`, `plan`, `plan-implement`, `requirements-grill`, `review`,
`review-fix`), active manifests, the
bundled agent catalog, designated user docs, and the
`locus-pi` diagnostic CLI. `package.json#files` is the package allowlist;
repository presence alone does not make a path public npm surface.
`public-repository.json#repositoryFiles` is also file-exact: directory entries
are rejected, so adding a file under an existing public folder does not publish
it without an explicit manifest and inventory change.
