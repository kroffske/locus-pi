# workflows

`workflows` is the trusted JavaScript workflow runtime. It discovers Package, project, user, and retained-history entries; runs child-agent graphs; and persists inspectable evidence.

## Surface

```text
/workflows
/workflows dashboard
/workflows list [query]
/workflows info [name]
/workflows status [runId]
/workflows result [runId|last]
/workflows run <name|path> [--run-name <name> | --output-dir <path>] [--resume <runId>] [--no-operator|--operator] [--] [input]
/workflows continue <runId>
/workflows stop [runId|last]
```

Tools: `workflow` and opt-in `fusion`. Compatibility command: `/workflow-stop`.

The `workflow` tool is the structured execution surface for agents. It supports fields that cannot always be represented safely by slash-command text, including caller `items` and approved continuations.

## Evidence and workspaces

- Run evidence: `.locus-pi/runs/<runId>/outputs/` and `runtime/`.
- Default workflow workspace: a unique `.locus-pi/plans/<generated-run-name>/` directory.
- Any workflow supports `--run-name <name>` to select `.locus-pi/plans/<name>/`.
- Explicit output directories must remain safe, project-relative paths.
- Run evidence and the workflow workspace are separate ownership zones.
- `.locus-pi/workflow-state/v1/<hash>/` is active lease and saved-child checkpoint state. A normal run can leave an empty state directory after releasing its temporary workspace lock.

## Trust

Workflow modules execute in the Pi Node.js host and are not sandboxed. Review project and user workflows before running them. Pi approvals remain the enforcement owner.

## More documentation

- [Operator workflow guide](../../docs/workflows.md)
- [Readable authoring contract](AUTHORING.md)
- [Advanced runtime and DSL reference](REFERENCE.md)
- [Packaged examples](examples/README.md)
- [Manifest](manifest.json)
