# Choose a workflow shape

Choose by the required control decision, not by agent count. Read one card, then [design-and-build.md](design-and-build.md).

| Form                                        | When                                   | Default call cost                                |
| ------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| [Fixed graph](fixed-graph.md)               | Stages/units known                     | Exactly the declared calls                       |
| [Bounded refinement](bounded-refinement.md) | A verifier may demand more work        | Up to 3R logical calls in the text-review recipe |
| [Bounded decomposition](decomposition.md)   | Work units discovered during execution | Discovery + bounded workers + aggregation        |
| [Human continuation](human-continuation.md) | Only the operator can authorize/decide | Two stages in separate runs                      |

Crash replay is a runtime capability, not another graph pattern. Generated source is a way to obtain a graph, not semantic continuation. Candidate search, councils and fixed fan-out are fixed-graph techniques unless the design explicitly adds refinement. No universal judge is injected.

The legacy card filenames below remain redirects so old links still work. They do not define a second catalog or their own API.
