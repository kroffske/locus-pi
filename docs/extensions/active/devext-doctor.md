# devext-doctor

## Purpose

`devext-doctor` shows a short health/status report for the current reduced default package. It exists so you can quickly check that the installed build sees the extensions that are active by default and that the OMP-port backlog is not confused with the product-ready surface.

## Why it is in the project

After an install or a smoke run, a developer needs one simple operator command that shows active defaults, active compatibility wrappers, disabled compatibility wrappers, OMP-owned ports, redesign-later surfaces, split-required bundles, fixtures, and deleted legacy surfaces. `devext-doctor` does not try to replace tests, but it gives a quick answer to the question: is the honest reduced surface loaded, rather than the old set of local duplicates?

## User Surface

- The user runs the command `/devext doctor`. The extension prints a typed `VIEW` `Extension doctor` with `status:ok` and `diagnostic`, count/preview lines for the default surface, recovery/actions, and an explicit boundary: this is a snapshot of the inventory/manifests, not runtime proof of the listed or disabled extensions.
- RPC gets a separate compact projection no longer than the host `string[]` budget: the evidence boundary, docs pointer, and actions are preserved. The task-lifecycle RPC likewise preserves `dryRun:true`, the no-mutation evidence, and the `locus task update` path instead of silent truncation.
- Before `/devext doctor` renders, the shared command UI lifecycle clears stale transient widgets/status from previous commands, so old lines do not linger next to the new doctor output.
- After `/devext doctor`, the next unrelated input, for example `ls`, clears the `devext-doctor` widget, so old lines do not look like current status.
- The user runs the command `/devext reload` to execute the official Pi reload flow through the command-context `ctx.reload()`. Before the call, a typed `RUN` is shown: Pi owns completion, and the old command frame is not proof of success. An unavailable host yields a `WARN` with `/reload`/restart recovery; an exception yields an `ERROR`, not a false success.
- The user runs the command `/devext task-lifecycle <task-id> <target-status>` to get a read-only dry-run transition plan over `.tasks/index.json`. The command builds a typed `VIEW` or `WARN` directly from the structured `TaskLifecyclePlan`, marks `dryRun:true`, shows preconditions/evidence boundary and the authoritative `locus task update` mutation path. It does not mutate `.tasks` and does not touch session todos.
- An unknown `/devext <action>` returns a typed `WARN`, states explicitly that no diagnostic/mutation/reload was run, and keeps the full usage recovery. It does not dissolve into uniform white notification text.
- The agent can call the tool `devext_reload`. The tool attempts a direct `ctx.reload()` only if the host ever exposes a reload method in the tool context. In the current Pi host, reload is available only to command-context handlers, so the tool fails closed with an instruction to run `/devext reload` or the built-in `/reload` manually in the interactive command input.

## How it works in code

The entrypoint `extensions/devext-doctor/index.ts` registers the command `devext` and the tool `devext_reload`. The handler reads the command text through `_shared/pi-api.getCommandText`; if the argument is empty, it is treated as `doctor`. `/devext reload` calls the official command-context `ctx.reload()` after the `RUN` receipt; the Pi docs warn that code after reload keeps executing in the old call frame, so the receipt does not assert completion. If the host does not export `ctx.reload`, the command fails closed and shows a `WARN` asking to run `/reload` manually or restart Pi; a thrown error shows an `ERROR`. `/devext task-lifecycle <task-id> <target-status>` parses the exact `task-id` and `target-status`, calls `_shared/task-bridge.planTaskLifecycleTransition()`, then builds a typed block from the structured plan without re-parsing a format string.

The shared lifecycle planner reads `.tasks/index.json` through `loadTaskBridgeSnapshot(projectRoot)`, looks up the task by exact `id`, checks the allowed dry-run transitions, and, if the target is `done`, additionally requires a `qa.md` containing the word `ACCEPTED` and a real `## Closure` section in `task.md`. The planner stays dry-run only and does not write files.

The `doctorBlock()` function builds a typed block from the shared inventory in `extensions/_shared/extension-inventory.ts`. That inventory records the product-visible `currentStatus` and ownership bucket for retained and deleted extensions. Normal doctor output stays bounded: active defaults, compatibility wrappers, OMP backlog, redesign/split buckets, fixtures/deleted legacy surfaces are printed as counts and short previews instead of long raw comma-list dump lines. Command registration goes through `extensions/_shared/command-ui.ts`, so stale transient cleanup no longer hard-codes other extensions' widget keys inside `devext-doctor`.

- Entrypoint: `./extensions/devext-doctor/index.ts`
- Manifest: `extensions/devext-doctor/manifest.json`
- Commands: `devext doctor`, `devext reload`, `devext task-lifecycle <task-id> <target-status>`
- Tools: `devext_reload`
- Hooks: `input`
- Permissions: fs.read=`.tasks/index.json`, `.tasks/**/qa.md`, `.tasks/**/task.md`; fs.write=none, subprocess=none, network=none, browser=false, models=false, ui=`setWidget`, `setStatus`, `notify`
- State: the extension reads the shared extension inventory, the `.tasks/index.json` task bridge snapshot, and task workspace files for the dry-run planner, but stores nothing.
- Tests: `tests/integration/command-ui-lifecycle.test.ts`, `tests/shared/task/tasks-bridge.test.ts`, `tests/shared/session/session-core-jsonl.test.ts`, `tests/integration/public-registration.test.ts`, `tests/extensions/agents/agent-observer.test.ts`
- Review: status=reviewed, source=write-from-scratch, reviewedBy=locus-pi, reviewedAt=2026-05-31, risk=low

## Limitations and risks

`devext-doctor` is a status summary, not deep self-test diagnostics. It does not check commands, hooks, UI permissions, or the real ability of a disabled extension to run its scenarios. Normal output is deliberately sized to fit one 80x24 TUI viewport and therefore shows counts/previews rather than a full inventory dump. For details, read `docs/extension-index.md`, the manifests, and the focused tests.

`/devext task-lifecycle <task-id> <target-status>` also stays dry-run only. It does not mutate `.tasks`, does not auto-sync todo state, and does not replace `locus task update`, which remains the authoritative mutation/closure path. A report that looks fine only means that the current process sees the shared inventory for the default/backlog buckets; lifecycle proof is separately limited by the dry-run task bridge.

`/devext reload` can only work after this version of the extension is already loaded. It cannot fix the very first old session where `devext_reload` is not yet registered; that still requires a manual `/reload` or a restart. In the current Pi host, `devext_reload` from the model tool context cannot perform the reload itself and does not fake success; it returns a blocked/error result instead of sending a slash command into the chat.

## Decision

Decision: `keep`. The extension is useful as an operator surface after installation and during smoke checks. It can be extended with individual checks, but its current form should stay short and safe.
