# loop

`loop` is the bounded continuation controller for active goals and eligible persisted workflow runs.

Beta: disabled by default. Nothing below is registered until the project enables `loop` — see [beta extensions](../../docs/getting-started.md#beta-extensions).

## Actions

The `loop` tool and `/loop` command support:

- `status` — inspect the active loop or eligible source;
- `once` — prepare one manual continuation without dispatching a model turn;
- `start` — begin automatic bounded continuation;
- `until` — continue with a model-evaluated stop condition;
- `stop` — stop the loop and record a reason.

Only one loop may be active per Pi session. Automatic continuation stops on completion, explicit stop, missing metadata, lost transport, deadline, or iteration limit. Defaults are 20 iterations and 30 minutes; configured values remain bounded by the manifest/runtime contract.

Automatic loop state is stored under `.locus/runtime/loop/sessions/`. A manual workflow continuation is returned directly with its exact prompt and bounded source summary; it writes no separate workflow-continuation file. Goal continuation keeps its existing `.locus/runtime/goal/continue.md` contract. Local state is ignored by Git.

## Implementation

- Entrypoint: `extensions/loop/index.ts`
- Controller: `extensions/loop/loop-controller.ts`
- Tool: `extensions/loop/loop-control-tool.ts`
- Manifest: `extensions/loop/manifest.json`
