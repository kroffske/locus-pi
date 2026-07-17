# locus-pi docs map

Эта директория хранит публичную карту пакета `locus-pi`: что грузится Pi,
какие расширения доступны, где описаны права/риски и какие ограничения важны
перед публикацией. Внутренние планы, runtime state, черновики и одноразовые
артефакты не являются частью этой карты.

## Source truth

- `package.json#pi.extensions` — единственный список расширений, которые
  загружаются по умолчанию.
- `extensions/<name>/manifest.json` — machine-readable metadata расширения:
  commands, tools, hooks, permissions, risk и review/source status.
- [extension-index.md](extension-index.md) — public status index for the ten
  retained active extensions and three curated workflows.
- [extension-ownership-matrix.md](extension-ownership-matrix.md) — ownership и
  promotion decisions. Если extension меняет default surface, решение должно
  появиться там.
- [extensions/active/](extensions/active/) — ручные страницы для десяти default
  extensions.

Registered extensions: 10 active by default: `agents`, `ask-user-question`, `ast-structural-edit`, `devext-doctor`, `loop`, `model`, `plan`, `security-gate`, `todo-context`, `workflows`.

## Public Map

| Surface                                                | Public home                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install, trust, `npx` smoke and quick operator checks  | [../README.md](../README.md).                                                                                                                      |
| Repository-only release policies                       | `CONTRIBUTING.md`, `SUPPORT.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `CHANGELOG.md` live at repository root and are intentionally not packed. |
| Default extension list                                 | `package.json#pi.extensions`; mirrored above for docs sanity.                                                                                      |
| Active extension manuals                               | [extensions/active/](extensions/active/).                                                                                                          |
| Extension status and risk index                        | [extension-index.md](extension-index.md).                                                                                                          |
| Ownership and promotion decisions                      | [extension-ownership-matrix.md](extension-ownership-matrix.md).                                                                                    |
| Package/runtime boundary                               | [runtime/locus-workspace.md](runtime/locus-workspace.md).                                                                                          |
| Agent execution trust model                            | [adr/agent-execution-trust-model.md](adr/agent-execution-trust-model.md).                                                                          |
| Source attribution and borrowed behavior               | [Repository-only source-audit notes](https://github.com/kroffske/locus-pi/tree/main/docs/source-audit) named by active manifests.                  |
| Bundled agent catalog used by `agents` and `workflows` | [../.agents/agents/](../.agents/agents/). This is package runtime surface, not private planning material.                                          |

## Excluded from the clean release

These paths are local or internal and must stay ignored unless a separate
promotion decision says otherwise:

- `.locus/**` — runtime state, generated reports, task-local evidence.
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
explicit local import closure, the three curated Package workflows
(`live-smoke`, `llm-smoke`, `requirements-grill`), active manifests, the
bundled agent catalog, designated user docs, and the
`locus-pi` diagnostic CLI. `package.json#files` is the package allowlist;
repository presence alone does not make a path public npm surface.
