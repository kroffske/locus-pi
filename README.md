# locus-pi

`locus-pi` is a Pi extension package for agentic software-development workflows. It installs curated extensions, workflows, and workflow skills. Named agent profiles remain owned by the user's project or home catalog.

Requires Node.js `>=22.19.0`, Pi `>=0.83.0`, and trusted project and workflow sources.

For workflow authoring, API contracts, budgets and recovery, start with the
[workflow documentation](docs/workflows/index.md), included in the npm installation.

## Install

```bash
pi install npm:@kroffske/locus-pi
```

Start a fresh Pi session, then inspect the installed workflows:

```text
/workflows list
```

Pi loads the bundled skills automatically. To also install them for Codex and Claude Code, run inside Pi:

```text
/workflows skills sync --host all --scope user
```

This creates managed links to the installed package. See [skill installation](skills/README.md#install-for-codex-and-claude-code) for host and project scope options.

Run the smallest live check:

```text
/workflows run live-smoke
```

Remove the package with `pi remove npm:@kroffske/locus-pi`.

## Documentation

- [Getting started](docs/getting-started.md)
- [Environment variables](docs/environment-variables.md)
- [Extensions](docs/extensions.md)
- [Create workflows and choose a style](docs/locus-pi-workflows.md)
- [Run and inspect workflows](docs/workflows.md)
- [TUI visual language](docs/tui-design.md)
- [Architecture](docs/architecture.md)

## Trust

Extensions and workflow scripts run inside the trusted Pi and Node.js host. They are not sandboxed. Review local workflow sources before running them.

## Development

```bash
npm ci --ignore-scripts
npm run check
```

Use GitHub Issues for reproducible defects. Report suspected vulnerabilities through GitHub private vulnerability reporting, never through a public issue.

## License

Licensed under the [MIT License](LICENSE). Third-party attribution is recorded in [docs/third-party-notices.md](docs/third-party-notices.md).
