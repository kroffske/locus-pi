# Dynamic discovery and workers

Use this card when the set of independent worker units is unknown until one
discovery agent inspects the live project itself.

Graph: `discovery agent({ handoffs }) -> explicit inline workers -> composer`.
Worker count is runtime-selected but bounded in the discovery declaration.
This same-run pattern is intentionally non-resumable: fresh model output must
never be rebound to old durable checkpoint keys.

The approved Design derives a small maximum from the domain (for example, the
maximum DAGs in the selected deployment scope). `maxItems` is required in the
runtime range `1..100`; it is transport safety for one structured response, not
a default business limit.

Cost: `1 + K×W + 1` calls for `K` discovered units, `W` visible workers per
unit, and one composer. The run-level 10,000-call fuse and global concurrency
gate remain authoritative.

Handoff: each `handoffs` array member is one complete non-blank unique text unit.
Workers receive that string unchanged and return complete text to the composer.

Source boundary: put the inspection request in the discovery prompt. Workflow
JavaScript does not obtain a project path, enumerate directories, or read a
discovery file. If units contain paths, the discovery agent returns complete
project-relative units and each worker interprets its own unit.

Required primitives: `agent({ handoffs })`, `parallel()` or `pipeline()`, and an
exact-text composer.

Primitive:

```js
const MAX_DAGS_IN_SCOPE = 12;
const units = await agent("Inspect the live project. Return one complete handoff per discovered unit.", {
  handoffs: { minItems: 1, maxItems: MAX_DAGS_IN_SCOPE, maxItemChars: 4000 },
});

const findings = await parallel(
  units.map(
    (unit, index) => () =>
      agent(`Process this exact project-relative unit:\n${unit}`, {
        label: `worker-${index + 1}`,
      }),
  ),
);
```

Failure: invalid, blank, duplicate, or over-limit discovery receives one repair
from runtime and then fails closed. Any worker failure rejects the whole barrier.

For a large catalog, do not raise this one-response shape into a hidden inventory
policy. Freeze an owner-approved catalog, then render its complete task prompts
literally in project-local source or pass them through caller `items`, which has
no Locus items count or character policy. Total attempts, time, context, JSON,
and Node memory still bind execution.

For resumable execution, stop after discovery and expose its human-readable
list for approval. A separate caller then starts the durable parent with a
frozen approved `items` list and caller-owned semantic keys. Positional keys such
as `item-1` are safe only when that caller intentionally reuses the exact same
list and ordering for the output namespace. Never derive resumable positional
keys from a fresh `agent({ handoffs })` result. Do not parse the discovery file;
the caller transports the approved list explicitly.

Avoid these replacements:

- parsing newline/CSV/JSON prose in workflow JavaScript;
- domain schemas or validators for discovered units;
- child `spawn_agent`/`task`, which remains unavailable;
- recursive or hidden manager-agent delegation.
- a workflow-side checkpoint ledger, recovery engine, or result-file parser.
