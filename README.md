# locus-pi — moved to LocusForge

> **Development has moved to [LocusForge](https://github.com/locus-forge/locus-pi).**
> This repository and the `@kroffske/locus-pi` npm package are retired from active
> maintenance. No further updates are planned here.

Use the [LocusForge repository](https://github.com/locus-forge/locus-pi) for current
source, installation instructions, documentation, and issues. Its npm package
name is `@locus-forge/locus-pi`; follow the new repository's instructions for
availability before changing your installation.

Updating `@kroffske/locus-pi` does **not** switch an existing Pi installation to
LocusForge. When migrating, replace the old package entry in the same global or
project scope and preserve your extension and skill filters. Do not load both
packages in one Pi session.

## Legacy package

This final handoff release preserves the legacy extensions and workflows. The
README and npm metadata point readers to LocusForge; the package does not install
or redirect to the successor automatically.

The legacy runtime requires Node.js `>=22.19.0`, Pi `>=0.83.0`, and trusted project
and workflow sources. Extensions and workflows execute with the Pi and Node.js
host, without a sandbox.

## Historical documentation

These guides describe the legacy package and are retained for existing users:

- [Getting started](docs/getting-started.md)
- [Extensions catalog](docs/extensions.md)
- [Create workflows](docs/locus-pi-workflows.md) · [Run and inspect workflows](docs/workflows.md)
- [Workflow reference by topic](docs/workflows/index.md) · [External-agent skill links](skills/README.md)

Licensed under the [MIT License](LICENSE).
