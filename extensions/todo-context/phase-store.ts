/**
 * extensions/todo-context/phase-store.ts — the one load/commit pair every todo
 * surface goes through, and the queue-context normalization that travels with
 * it.
 *
 * `_shared/project/todo-state` owns backend selection and durable session writes;
 * `todo-state-cache.ts` stays a local cache/fallback that this module keeps in
 * step so the tool and command paths share one storage contract. The operations
 * applied between a load and a commit live in `phase-ops.ts`.
 */
import { emitDevEvent } from "../_shared/runtime/event-bus.js";
import type { ExtensionAPI, ExtensionContext } from "../_shared/host/pi-api.js";
import { todoStateCache } from "./todo-state-cache.js";
import {
  cloneTodoPhases,
  commitTodoState,
  loadTodoState,
  type TodoPhase,
  type TodoQueueMetadata,
  type TodoStateCommit,
  type TodoStateSnapshot,
} from "../_shared/project/todo-state.js";

/**
 * Load the current phases from the best available session source.
 *
 * `_shared/project/todo-state` owns backend selection: JSONL session store first when
 * enabled, then Pi custom entries, then `todo-state-cache.ts` as the final fallback.
 */
export async function loadTodoPhases(pi: ExtensionAPI, ctx: ExtensionContext): Promise<TodoStateSnapshot> {
  const snapshot = await loadTodoState(pi, ctx, todoStateCache.phases, {
    ...(todoStateCache.context === null ? {} : { context: todoStateCache.context }),
    autoContinue: todoStateCache.autoContinue,
  });
  todoStateCache.phases = cloneTodoPhases(snapshot.phases);
  todoStateCache.context = snapshot.context ?? null;
  todoStateCache.autoContinue = snapshot.autoContinue;
  return snapshot;
}

/**
 * Persist a normalized todo snapshot and emit a development event.
 *
 * `todoStateCache.phases` remains a local cache/fallback. Durable session writes
 * are delegated to `_shared/project/todo-state` so command and tool paths share one
 * storage contract.
 */
export async function commitTodoPhases(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  phases: TodoPhase[],
  metadata: TodoQueueMetadata = {
    ...(todoStateCache.context === null ? {} : { context: todoStateCache.context }),
    autoContinue: todoStateCache.autoContinue,
  },
): Promise<TodoStateCommit> {
  todoStateCache.phases = cloneTodoPhases(phases);
  todoStateCache.context = metadata.context ?? null;
  todoStateCache.autoContinue = metadata.autoContinue;
  const commit = await commitTodoState(pi, ctx, todoStateCache.phases, metadata);
  emitDevEvent("todo:update", { phases: todoStateCache.phases.length });
  return commit;
}

export function normalizeQueueContext(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized.slice(0, 2000);
}
