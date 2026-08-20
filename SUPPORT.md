# Support

`locus-pi` is MIT-licensed. No paid support, response-time guarantee, or service-level agreement is provided.

Before opening a report, read [`README.md`](README.md), [`docs/getting-started.md`](docs/getting-started.md), and the relevant `extensions/<name>/README.md`.

Use:

- GitHub Discussions for usage and design questions when enabled;
- a clearly labelled question issue when Discussions is unavailable;
- a GitHub issue for a reproducible defect in one of the ten default extensions or eighteen shipped workflow names;
- GitHub private vulnerability reporting for security concerns, as required by [`SECURITY.md`](SECURITY.md).

A useful defect report includes Node and Pi versions, the exact command/tool surface, a minimal reproduction, expected and observed behavior, and redacted diagnostics. Remove credentials, model transcripts, personal data, private repository content, and absolute local paths.

## Supported boundary

Support covers:

- the ten entrypoints in `package.json#pi.extensions`;
- the Package workflows shipped under `extensions/workflows/examples/`;
- their manifests, co-located manuals, runtime dependencies, and documented public contracts.

Local project/user workflows, private task state, experimental files, archived decisions, reports, transcripts, benchmarks, evaluations, and generated runtime artifacts are outside the supported release surface.
