# Large agent runs are a legitimate graph

Choose the decomposition the question needs. Thirty-five work units with ten focused fields each can legitimately require 350 agent calls. Do not infer that the graph is wrong from that count, invent a platform-wide maximum, or automatically replace it with one broad agent. A bound on one structured response is not a global execution limit.

Use the existing keyed `parallel(thunks, { concurrency, keys, title })` where keys are available, and distinguish that local group width from the shared leaf concurrency gate. Concurrency bounds simultaneous work; it need not reduce the number of requested work units. Semantic termination follows the requested scope and an explicit completion or review condition. A chosen maximum number of refinement rounds is local to that design, not a mandatory economic policy for every workflow.

Let the operator observe `/ps` and `/workflows status <runId>`, and request `/workflows stop <runId>` when needed. Do not issue that stop merely because many agents are shown. Existing package fuses and explicit operator settings stay in force; this skill does not silently lower, raise or remove them. Replayed answers spend the `totalAgents` fuse too, so a Repair + Continue that would cross it needs an explicit operator `budget` override on the structured tool — see [execution controls](../../../extensions/workflows/references/execution-controls.md).

Physical fresh attempts, logical calls, active calls, queued calls, completed calls and reused answers are not interchangeable counters. Same-session format corrections do not spawn new physical children. Provider usage may be absent or partial; report its availability honestly. No token estimator or budget-reading branch belongs in generated workflow source.

If more work is discovered after a run stops, preserve completed work through [Repair + Continue](repair-and-continue.md) where the prefix contract permits. Do not describe that as arbitrary per-item checkpoint support.
