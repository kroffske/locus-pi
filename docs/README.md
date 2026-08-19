# Documentation

The public documentation is intentionally small. Start with the page that matches the task; extension-specific behavior lives beside the extension source.

| Need                                                                 | Read                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Install, verify, update, or uninstall                                | [Getting started](getting-started.md)                                       |
| Find a command, tool, hook, risk level, or extension owner           | [Extension reference](extensions.md)                                        |
| Run, inspect, resume, stop, or author workflows                      | [Workflow guide](workflows.md)                                              |
| Understand repository layout, source-of-truth rules, and local state | [Architecture and boundaries](architecture.md)                              |
| Work on one extension                                                | `extensions/<name>/README.md` and `extensions/<name>/manifest.json`         |
| Author a workflow                                                    | [`extensions/workflows/AUTHORING.md`](../extensions/workflows/AUTHORING.md) |
| Inspect advanced workflow runtime behavior                           | [`extensions/workflows/REFERENCE.md`](../extensions/workflows/REFERENCE.md) |

Stable public contracts belong in these guides, extension READMEs, manifests, tests, and release notes. Drafts, task plans, ADR history, source-audit working notes, generated reports, transcripts, and local runtime state are not part of the public documentation surface.
