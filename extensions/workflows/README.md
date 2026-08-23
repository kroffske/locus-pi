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
/workflows skills <sync|status|remove> [--host codex|claude|all] [--scope user|project]
```

Tools: `workflow`, read-only `workflow_check_source`, and opt-in `fusion`. Compatibility command: `/workflow-stop`.

`/workflows skills` exposes the package's action-named workflow skills to
external agents. Pi already loads the packaged skills. The command manages
fail-closed symlinks in Codex `.agents/skills` and Claude Code `.claude/skills`;
the adjacent `.locus-pi-workflow-skills.v1.json` file records ownership, so it
never infers ownership from a path or replaces a real directory or foreign
symlink. See
[`skills/README.md`](../../skills/README.md).

The `workflow` tool is the structured execution surface for agents. It supports fields that cannot always be represented safely by slash-command text, including caller `items` and approved continuations.

`workflow_check_source` validates one project-relative `.workflow.mjs` file up to 512 KiB against the standard authoring grammar. It reads the source as text and never imports or executes the workflow.

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
