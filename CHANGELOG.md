# Changelog

This file records user-visible changes to the public package. History before
the `0.3.0` baseline is collapsed; details live in the git history.

## [Unreleased]

- The `workflow-creator` Package namespace creates new workflows in three
  reviewed steps: `design`, `svg`, and `build`.
- Folder-qualified workflows keep their own workspace and visible run
  history, and operator answers continue them by their saved name.
- The workflow catalog gained Project, User, Package, and History tabs with
  safe copy actions for folder-owned namespaces.
- The workflow TUI clamps wide agent summaries to terminal columns instead
  of crashing at the edge, and questions can show bound source evidence
  beside their choices.
- Repository meta files were reduced to `README.md`, `SECURITY.md`, and this
  collapsed changelog.

## [0.3.0] - 2026-08-10

Public baseline. Eleven default extensions, the curated Package workflow
namespaces (`implement`, `live-smoke`, `task`, `post-code-review`), three
bundled skills, and the workflow runtime with durable runs, replay,
journals, and evidence checks.
