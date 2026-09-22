---
title: Getting started
type: guide
status: active
updated: 2026-09-22T15:43:18Z
description: Historical installation guide for the retired package; current development lives in LocusForge.
owner: locus-pi maintainers
tags: [installation, getting-started]
---

# Getting started

This guide describes the retired `@kroffske/locus-pi` package. Development and
current installation instructions live in the
[LocusForge repository](https://github.com/locus-forge/locus-pi). No further
updates are planned for this legacy package. Updating it does not migrate your
Pi settings to LocusForge; replace the source in the same scope when migrating,
preserve extension and skill filters, and do not load both packages together.

## Install the legacy package

For a new installation:

```bash
pi install npm:@kroffske/locus-pi
pi list
```

`pi list` is the authority for registration scope. Pi reports missing entrypoints and extension load failures when it loads the package.

Start a new Pi session in a trusted project:

```text
/workflows list
/workflows run live-smoke
```

`live-smoke` is the smallest runtime check: it starts two child-agent jobs that list the current project directory.

The package also ships workflow skills. Pi loads them by default. To expose the
same skills to Codex or Claude Code, follow the [managed skill-link guide](../skills/README.md#install-for-codex-and-claude-code).

## Load only selected extensions

Pi installs the package once and can filter which entrypoints it loads. Use `pi config` for an interactive global or project-local selection, or edit the existing locus-pi entry in `~/.pi/agent/settings.json` or `.pi/settings.json`. Replace that entry instead of adding a second copy; keep all other package entries.

For example, this profile loads only the workflow extension and disables the bundled skills:

```json
{
  "packages": [
    {
      "source": "npm:@kroffske/locus-pi",
      "extensions": ["extensions/workflows/index.ts"],
      "skills": []
    }
  ]
}
```

The JSON block shows one `packages` array for clarity. If your settings already
contain other packages, change only the locus-pi object inside that array.
`skills: []` disables package skills; omitting `skills` leaves them enabled.

Filtering is a loading boundary, not an installation boundary: the npm tarball and production dependencies are still installed, and an enabled extension may import helper modules owned by another feature directory without registering that feature's entrypoint.

## Mix with another Pi package

Pi can load several package sources in one process. Before enabling another implementation of the same capability, explicitly exclude the overlapping Locus entrypoint. Do not rely on package order to override a tool: duplicate tool names are order-sensitive, duplicate commands are disambiguated by the host, and hooks compose according to each event's rules.

Example: keep the Locus agent launcher and use workflows from another package:

```json
{
  "packages": [
    {
      "source": "npm:@kroffske/locus-pi",
      "extensions": ["extensions/agents/index.ts"],
      "skills": []
    },
    "npm:@vendor/other-workflows"
  ]
}
```

## Update, scopes, and removal

To update the npm installation, run `pi update npm:@kroffske/locus-pi` and start
a fresh Pi session. The filter stays in your settings.

The same package identity can be configured globally and for a project. Use `pi list` and `pi config` to inspect the effective source and filters. Remove only the unwanted scope:

```bash
pi remove npm:@kroffske/locus-pi
pi remove npm:@kroffske/locus-pi -l
```

For a source checkout, run `pi remove .` or `pi remove . -l` from the registered checkout root. Remove the registration before moving or deleting the directory.

Removing a registration does not delete Pi runtime history.

## Install from a Git checkout

Use a checkout only for development or pre-release validation. Review it before registration because Pi loads the extension source directly.

```bash
git clone https://github.com/locus-forge/locus-pi.git
cd locus-pi
npm ci --ignore-scripts
pi install .
pi list
npm run check
```

Use either user scope (`pi install .`) or project scope (`pi install . -l`), not both for the same checkout.

Updating the checkout does not require re-registration:

```bash
git pull --ff-only
npm ci --ignore-scripts
```

Start a fresh Pi session after updating so the host reloads the source.

## Common failures

### Pi reports a missing or failed extension entrypoint

Reinstall dependencies for a checkout and verify that the package or checkout is complete. For npm installs, remove and reinstall the same package identity.

### Pi works outside the repository but fails inside it

The checkout is probably registered in both user and project scope. Use `pi list`, then remove one registration.

### `/workflows run` is rejected before a run starts

Check the target name, required `--output-dir`, safe project-relative path rules, and whether the workflow needs structured fields available only through the `workflow` tool. Use `/workflows info <name>` for the live contract.

### A workflow is awaiting operator input

Inspect it with `/workflows status <runId>`, then continue it explicitly with `/workflows continue <runId>`. Do not invent an answer in automation.

### A local workflow is untrusted

Do not run it. Project and user workflows are JavaScript with host access; path validation and approval prompts are not a sandbox.
