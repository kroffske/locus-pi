# Task workflow authoring

`task` is a group-only Package namespace with two manual stages.

1. `task/draft` turns a raw request into `draft.md`. The draft already names the
   workflow pattern, agents, handoffs, bounded reflection or review, concurrency,
   failure exits, and expected output. Copy and edit this text when needed.
2. `task/plan` receives the complete accepted draft as semantic input. It designs,
   reviews, builds, and checks one concrete `workflow.mjs`, then publishes that
   source as the final result. Missing, empty, or whitespace-only input fails before
   the first child starts and publishes no `workflow.mjs`.

The verifier writes workspace `workflow.mjs` and returns check evidence, never
publication bytes. A choice routes to publication, failure, or one explicit
correction followed by independent recheck. Decision agents write their findings
and next action to workspace `workflow-source-decision.md` and, after correction,
`workflow-source-recheck.md`; the correction owner reads those findings. Refusal
returns `stage: "verify"` with source, report and transcript guidance. Exhaustion
stays failed. The host
reads the confined regular file, checks Node syntax and orchestration-only shape,
and retains those same bytes as `result.name === "workflow.mjs"` and
`outputs/workflow.mjs`. Invalid source remains available for repair but receives
no accepted primary artifact.

Design, design review, and source build return complete text without writing a
saved workflow into the project. The designated verifier writes the workspace
candidate. Semantic review checks explicit failure returns, actionable findings
reaching correction, and agreement between primary output names and content;
static syntax/shape checks alone do not establish those properties. The design
must express those checks through supported agent/choice edges, not JavaScript
inspection of opaque answers or publication references. The host already rejects
empty answers and execution/publication errors. Simple fixed tasks retain their
requested graph and primary filename without automatic QA or approval stages;
substantive implementation still needs its declared review and final QA.

Neither package stage executes generated source. Create-only ends with the
checked source and launch command. For an authorized create-and-run request, the
caller reviews the retained file and hands it to `locus-pi-workflow-run` through
the existing file-target path, without repeat approval. Report authoring,
execution and product verification separately. A mutable workspace file or a
verifier's success sentence is not the retained source.

```text
/workflows run task/draft -- <raw request>
/workflows run task/plan -- <complete accepted draft>
```

Both workflow scripts are orchestration-only. Child agents may inspect the live
project when their prompt requires it. The JavaScript does not read project or
artifact files. The checked-source publication declaration delegates the file
read and validation to the existing host publication boundary.

## Default authoring style

Substantive implementation briefs default to adaptive slices: the owner revises
remaining work after each reviewed slice. Briefs state the role, expected result,
sources and essential constraints. Fixed graphs and procedural detail remain
explicit alternatives. See the [workflow guide](../../../../docs/locus-pi-workflows.md#create-a-workflow)
for folder-level inputs, style/size choices and design-to-implementation handoff.
