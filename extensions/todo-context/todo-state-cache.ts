/**
 * extensions/todo-context/todo-state-cache.ts — the in-memory mirror of the todo queue that
 * this extension keeps beside the durable session store.
 *
 * A CACHE AND FALLBACK, NOT A SOURCE OF TRUTH. `_shared/project/todo-state` owns backend
 * selection and durable writes: `loadTodoPhases` passes this object in as the LAST fallback,
 * after the JSONL session store and Pi's custom entries, and then overwrites it from whatever
 * the chosen backend returned; `commitTodoPhases` overwrites it from what was just persisted.
 * Nothing may read it as authoritative or write it without a matching durable commit.
 *
 * `phase-store.ts` is the only writer; `phase-store.ts` and `todo-write-tool.ts` are the only
 * readers, which is why it sits inside this extension rather than in a shared directory. The
 * binding does not survive Pi's cache-disabled entrypoint loading — each loaded entrypoint
 * gets its own copy — which is a second reason the durable store, not this object, has to be
 * the thing a surface trusts.
 */
import type { TodoPhase } from "../_shared/project/todo-state.js";

export const todoStateCache: { phases: TodoPhase[]; context: string | null; autoContinue: boolean } = {
  phases: [],
  context: null,
  autoContinue: false,
};
