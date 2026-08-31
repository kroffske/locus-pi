# Task workflow authoring

`task` is a group-only Package namespace with two manual stages.

1. `task/draft` turns a raw request into `draft.md`. The draft already names the
   workflow pattern, agents, handoffs, bounded reflection or review, concurrency,
   failure exits, and expected output. Copy and edit this text when needed.
2. `task/plan` receives the complete accepted draft as semantic input. It designs,
   reviews, builds, and checks one concrete `workflow.mjs`, then publishes that
   source as the final result.

The second stage replaces the old generic implementation and template-rendering
pipeline. Nothing executes the generated workflow automatically. Review the
source, copy it into the target project's `.pi/workflows/` namespace, and run it
only through the normal reviewed-workflow path.

```text
/workflows run task/draft -- <raw request>
/workflows run task/plan -- <complete accepted draft>
```

Both workflow scripts are orchestration-only. Child agents may inspect the live
project when their prompt requires it. The JavaScript does not read project or
artifact files.
