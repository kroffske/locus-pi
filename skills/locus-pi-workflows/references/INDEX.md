# Workflow pattern cards

Choose from the requirement, not from agent count. Read only the selected card.

| Requirement                                          | Card                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| One task or a fixed sequence on one subject          | [Sequential text graph](./sequential-text.md)                     |
| Independent known questions, then one document       | [Fixed fan-out/fan-in](./fixed-fan-out.md)                        |
| Draft, critique, bounded revision, acceptance        | [Bounded review loop](./bounded-review-loop.md)                   |
| A decision only a person may make                    | [Human gate](./human-gate.md)                                     |
| Preserve several competing solutions before choosing | [Bounded candidate search](./bounded-candidate-search.md)         |
| Units are unknown until runtime                      | [Dynamic orchestrator-workers](./dynamic-orchestrator-workers.md) |
| Approved Plan plus canonical `steps.md`              | [Plan to sequential workflow](./plan-to-sequential-workflow.md)   |

## Canonical-name cross-reference

| Common name                                                     | Use this card or rule                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| ReAct                                                           | Stage prompt technique inside any tool-using `agent()`; not a graph                  |
| Plan-and-Solve / plan-and-execute                               | Sequential text graph; add bounded review only when acceptance is needed             |
| Reflexion / Self-Refine / evaluator-optimizer / critic-revision | Bounded review loop                                                                  |
| Self-consistency / judge panel / map-reduce                     | Fixed fan-out/fan-in                                                                 |
| Mixture-of-Agents                                               | Fixed layered fan-out; every layer must be visible                                   |
| Consilium / expert council / debate                             | Fixed fan-out/fan-in with distinct responsibilities, then synthesis and fresh review |
| Router / finite-state handoff                                   | `agent({ choice })` followed by visible branches                                     |
| Supervisor / dynamic orchestrator-workers                       | Dynamic discovery with `agent({ handoffs })`, then explicit workers                  |
| Plan catalog / plan execution                                   | Plan to sequential workflow; preserve complete approved task blocks                  |
| Blackboard / shared-state coordination                          | Unsupported standard profile; use exact handoffs or redesign                         |
| Tree/graph search                                               | Usually bounded candidate search; require a proven need before paying its cost       |

Full research workflow scripts are evidence, not templates. Adapt the topology to
standard primitives; do not copy schemas, validators, renderers, or recovery code.
