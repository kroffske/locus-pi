---
title: Architecture and repository boundaries
type: overview
status: active
updated: 2026-08-19T22:43:06Z
source_commit: aeb217fe8dab
update_event: cleanup
context: changes=S files=4
description: Document architecture and repository boundaries.
owner: locus-pi maintainers
tags: [architecture, repository]
---

# Architecture and repository boundaries

## Sources of truth

Public behavior is defined by the intersection of:

1. `package.json#pi.extensions` — the extension entrypoints Pi loads;
2. `extensions/<name>/manifest.json` — declared tier, tools, commands, hooks, permissions, risk, tests, and manual. A `beta` tier means the entrypoint loads like any other and registers nothing until the project enables it, so the loaded set and the registered set are not the same list;
3. extension source and focused tests;
4. the shipped workflow registry under `extensions/workflows/examples/`;
5. the npm allowlist in `package.json#files`.

A file merely existing in the repository does not make it a default extension, supported workflow, or npm package surface.

## Repository layout

```text
extensions/              default extension implementations
extensions/_shared/      shared host, operator, runtime, model, project, and agent-runtime layers
extensions/workflows/    workflow runtime, authoring guide, and packaged examples
skills/                  bundled Pi skills
scripts/                 validation and public-repository materialization
tests/                   focused and integration tests
docs/                    small cross-cutting public guides
```

Extension-specific documentation is co-located in `extensions/<name>/README.md`. This keeps behavior, manifest metadata, tests, and documentation reviewable in one change.

## Extension dependency rule

Shared infrastructure under `extensions/_shared/` does not create a feature dependency. A direct feature dependency exists only when one `extensions/<feature>/` directory imports another feature directory.

The current direct feature graph has two edges:

- `agents → workflows`
- `loop → workflows` through the read-only persisted-run facade

`scripts/check-extension-layers.ts` enforces the shared-layer ownership and import direction rules.

## Runtime state

Local runtime state is intentionally outside the public source surface and ignored by Git:

- `.locus-pi/runs/<runId>/` — workflow outputs and machine evidence;
- `.locus-pi/workspaces/<generated-run-name>/` — workflow-authored working files, including task drafts, generated workflows, review files, and implementation history;
- `.locus-pi/plans/<plan-slug>.md` — checkout-local documents authored through `/plan`; legacy home files are migration input only;
- `.locus-pi/workflow-state/v1/<hash>/` — active workspace leases and saved-child checkpoints; the directory may be empty after a lease is released;
- `.locus-pi/fusion/config.json` — project-local Fusion configuration;
- `.locus-pi/config.json` — project-local settings the package reads at load time; currently only the `beta` opt-in list described in [getting started](getting-started.md#beta-extensions). It is the one file here a project may want to commit;
- `.locus/runtime/` — session, artifact, and diagnostic state used by Locus extensions; the beta `plan` extension owns its `goal/`, `mode/` and `prompts/` trees and the beta `loop` extension its `goal/` and `loop/` trees, so none of those four appears until the owning extension is enabled;
- `.tasks/` — optional local task state and explicit bridges;
- an explicit project-relative output directory — an optional operator override for workflow-owned working files.

Runtime state may contain project paths, prompts, model output, transcripts, or other private material. Do not commit it.

## Workflow precedence

Workflow discovery is first-wins by name. Project and user workflows can override package names according to the runtime discovery order. `/workflows list` shows the effective live catalog and source.

Package workflows are reviewed release assets. Project and user workflows remain local trusted code and receive no package support promise merely because the runtime can discover them.

## Publication boundary

The public repository keeps source, tests, package metadata, stable guides, extension manuals, examples, and legal/support files. The following belong outside the public Git history:

- task drafts and planning state;
- private roadmaps and product notes;
- ADR and decision history not required to use or contribute to the current code;
- source-audit working notes and local upstream checkouts;
- generated reports, transcripts, benchmarks, evaluations, and runtime artifacts;
- diagnostic export manifests and workstation-specific paths.

`.gitignore` prevents new local files in these categories from being added accidentally. It does not hide files already tracked; publication cleanup must remove them from the index and, when necessary, rewrite Git history before making the repository public.
