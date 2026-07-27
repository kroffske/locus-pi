/**
 * extensions/todo-context/phase-store.ts — the one load/commit pair every todo
 * surface goes through, and the queue-context normalization that travels with
 * it.
 *
 * `_shared/todo-state` owns backend selection and durable session writes;
 * `sharedState.todos` stays a local cache/fallback that this module keeps in
 * step so the tool and command paths share one storage contract. The operations
 * applied between a load and a commit live in `phase-ops.ts`.
 */
import { emitDevEvent } from "../_shared/event-bus.js";
import type { ExtensionAPI, ExtensionContext } from "../_shared/pi-api.js";
import { sharedState } from "../_shared/state.js";
import {
  cloneTodoPhases,
  commitTodoState,
  loadTodoState,
  type TodoPhase,
  type TodoQueueMetadata,
  type TodoStateCommit,
  type TodoStateSnapshot,
} from "../_shared/todo-state.js";

/**
 * Load the current phases from the best available session source.
 *
 * `_shared/todo-state` owns backend selection: JSONL session store first when
 * enabled, then Pi custom entries, then shared memory as the final fallback.
 */
export async function loadTodoPhases(pi: ExtensionAPI, ctx: ExtensionContext): Promise<TodoStateSnapshot> {
  const snapshot = await loadTodoState(pi, ctx, sharedState.todos, {
    ...(sharedState.todoContext === null ? {} : { context: sharedState.todoContext }),
    autoContinue: sharedState.todoAutoContinue,
  });
  sharedState.todos = cloneTodoPhases(snapshot.phases);
  sharedState.todoContext = snapshot.context ?? null;
  sharedState.todoAutoContinue = snapshot.autoContinue;
  return snapshot;
}

/**
 * Persist a normalized todo snapshot and emit a development event.
 *
 * `sharedState.todos` remains a local cache/fallback. Durable session writes
 * are delegated to `_shared/todo-state` so command and tool paths share one
 * storage contract.
 */
export async function commitTodoPhases(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  phases: TodoPhase[],
  metadata: TodoQueueMetadata = {
    ...(sharedState.todoContext === null ? {} : { context: sharedState.todoContext }),
    autoContinue: sharedState.todoAutoContinue,
  },
): Promise<TodoStateCommit> {
  sharedState.todos = cloneTodoPhases(phases);
  sharedState.todoContext = metadata.context ?? null;
  sharedState.todoAutoContinue = metadata.autoContinue;
  const commit = await commitTodoState(pi, ctx, sharedState.todos, metadata);
  emitDevEvent("todo:update", { phases: sharedState.todos.length });
  return commit;
}

export function normalizeQueueContext(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized.slice(0, 2000);
}
