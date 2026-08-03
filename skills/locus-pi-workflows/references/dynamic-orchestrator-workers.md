# Dynamic orchestrator-workers — unsupported standard profile

Use this card to identify a runtime gap, not to generate a workaround. The shape
is needed when the set of worker units cannot be known while authoring.

Graph: `manager discovers units -> delegated workers under shared budget
-> composer`. Worker count is runtime-selected.

Cost: unknown until discovery; this profile cannot reserve or journal the shared
delegation budget truthfully.

Handoffs: the desired manager-to-worker task text and worker-to-composer answers
would be exact text, but the child-spawn edge itself is unavailable.

Required primitives: a future bounded delegation primitive with inherited
capabilities, shared budget, journaling, and recursion prevention. None exists.

Why unsupported: SDK children cannot call `spawn_agent` or `task`; read-only
children have stricter capabilities. The current harness can call `parallel()`
only over units JavaScript already knows. Implementing a structured planner,
domain validator, dispatcher, and recovery layer would recreate a graph runtime
inside the workflow and violate the standard profile.

Failure: authoring stops and names the bounded-delegation gap. Do not silently
reduce coverage or fake delegation with a large JSON plan.

Allowed redesigns:

- make the units explicit in the approved design, then use fixed fan-out;
- let one capable agent inspect all units and return one complete textual list;
- split discovery and execution into separately approved workflows;
- track a first-class runtime primitive with shared budget, inherited rights,
  journaling, and recursion prevention.
