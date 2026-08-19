# loop

`loop` is the bounded continuation controller for active goals and eligible persisted workflow runs.

## Actions

The `loop` tool and `/loop` command support:

- `status` — inspect the active loop or eligible source;
- `once` — prepare one manual continuation without dispatching a model turn;
- `start` — begin automatic bounded continuation;
- `until` — continue with a model-evaluated stop condition;
- `stop` — stop the loop and record a reason.

Only one loop may be active per Pi session. Automatic continuation stops on completion, explicit stop, missing metadata, lost transport, deadline, or iteration limit. Defaults are 20 iterations and 30 minutes; configured values remain bounded by the manifest/runtime contract.

State is stored under `.locus/runtime/loop/sessions/` and existing goal/workflow continuation artifacts. Local state is ignored by Git.

## Implementation

- Entrypoint: `extensions/loop/index.ts`
- Controller: `extensions/loop/loop-controller.ts`
- Tool: `extensions/loop/loop-control-tool.ts`
- Manifest: `extensions/loop/manifest.json`
