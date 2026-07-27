# Support

`locus-pi` is MIT-licensed. No paid support, response-time guarantee, or
service-level agreement is provided.

Use these repository-native routes:

- Read `README.md` and the active manuals under `docs/extensions/active/` first.
- Use GitHub Discussions for usage and design questions when Discussions is
  enabled. Otherwise, use a clearly labelled question issue.
- Use a GitHub issue for a reproducible defect in a supported default extension
  or one of the four curated Package workflows.
- Use GitHub private vulnerability reporting for security concerns, as required
  by `SECURITY.md`. Never post vulnerability details in a public issue.

A useful defect report includes the Node and Pi versions, the exact command or
tool surface, a minimal reproduction, expected and observed behavior, and a
redacted error or artifact. Remove credentials, model transcripts, personal
data, local absolute paths, and private repository content.

## Supported boundary

Support covers the ten default entrypoints in `package.json#pi.extensions`, the
four workflows in `CURATED_PACKAGE_WORKFLOW_NAMES`, and their shipped manuals,
manifests, runtime dependencies, and source-audit notes.

Beta modules, uncurated workflow fixtures, archives, reports, galleries,
transcripts, benchmarks, evaluations, and local runtime or planning state are
not supported release surfaces. `/devext doctor` is a diagnostic inventory; a
green view is not proof that unsupported or disabled modules work.
