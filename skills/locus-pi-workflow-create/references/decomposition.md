# Bounded discovery and workers

Use this card when independent work units are unknown until one discovery agent inspects the task. Avoid overlapping write effects, recursive manager delegation or a hidden generated execution graph.

Graph: discovery `agent({ handoffs })` → visible parallel/pipeline workers → aggregator. Each member is one complete non-blank unique text unit.

Cost: 1 + K×W + 1 calls for K discovered units and W stages per unit; logical depth W + 2. Local group width and the shared physical-agent budget both apply.

Handoff: exact units go to workers; complete worker text goes to aggregation. The design derives a domain maximum, for example `MAX_DAGS_IN_SCOPE`; runtime maxItems is 1..100, transport safety for one structured response, not a default business limit. Caller `dsl.items()` is a separate exact-list contract with no Locus items count or character policy.

Failure: malformed handoffs receive one repair in the legacy shaped-output path, then fail closed. Worker failure rejects its barrier. Do not silently filter failures out of the final catalog.

Primitives: handoffs, parallel or pipeline, exact-text aggregation. Labels are literal callsite identities, not interpolated item numbers. Author-known literal records may use named properties/flat destructuring; model-produced handoffs remain opaque strings.

Replay of an identical recorded discovery call is allowed, and only the exact recorded prefix of confirmed calls is reused. This is not a blanket non-resumable pattern. Fresh model discovery must not be rebound to old durable checkpoint keys. Never derive resumable positional keys from a fresh model output. For saved-child checkpoints a separate caller must supply a frozen approved list with the exact same ordering and deliberate semantic keys.

Keep decomposition in the visible harness, not child `spawn_agent`/`task`, which remains unavailable. A supervisor here discovers bounded work units; it does not acquire an independent orchestration control plane.

[Runnable decomposition example](../../../extensions/workflows/references/examples/decomposition.workflow.mjs). For author-owned keyed inventories use [execution controls](../../../extensions/workflows/references/execution-controls.md).
