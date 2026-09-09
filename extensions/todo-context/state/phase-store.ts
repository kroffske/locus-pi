/**
 * extensions/todo-context/state/phase-store.ts — the one load/commit pair every todo
 * surface goes through, and the queue-context normalization that travels with
 * it.
 *
 * `todo-state.ts` owns backend selection and durable session writes;
 * `todoStateCache` below stays a local cache/fallback that this module keeps in
 * step so the tool and command paths share one storage contract. The operations
 * applied between a load and a commit live in `phase-ops.ts`.
 */
import { emitDevEvent } from "../../_shared/runtime/event-bus.js";
import type { ExtensionAPI, ExtensionContext } from "../../_shared/host/pi-api.js";
import {
  cloneTodoPhases,
  commitTodoState,
  loadTodoState,
  type TodoPhase,
  type TodoQueueMetadata,
  type TodoStateCommit,
  type TodoStateSnapshot,
} from "./todo-state.js";

/**
 * The in-memory mirror of the todo queue that this extension keeps beside the durable
 * session store.
 *
 * A CACHE AND FALLBACK, NOT A SOURCE OF TRUTH. `todo-state.ts` owns backend
 * selection and durable writes: `loadTodoPhases` passes this object in as the LAST fallback,
 * after the JSONL session store and Pi's custom entries, and then overwrites it from whatever
 * the chosen backend returned; `commitTodoPhases` overwrites it from what was just persisted.
 * Nothing may read it as authoritative or write it without a matching durable commit.
 *
 * This module is the only writer; this module and `todo-write-tool.ts` are the only readers,
 * which is why it sits inside this extension rather than in a shared directory. The binding
 * does not survive Pi's cache-disabled entrypoint loading — each loaded entrypoint gets its
 * own copy — which is a second reason the durable store, not this object, has to be the thing
 * a surface trusts.
 */
export const todoStateCache: { phases: TodoPhase[]; context: string | null; autoContinue: boolean } = {
  phases: [],
  context: null,
  autoContinue: false,
};

/**
 * Load the current phases from the best available session source.
 *
 * `todo-state.ts` owns backend selection: JSONL session store first when
 * enabled, then Pi custom entries, then `todoStateCache` as the final fallback.
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
 * are delegated to `todo-state.ts` so command and tool paths share one
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
