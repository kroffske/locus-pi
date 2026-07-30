import type { ExtensionAPI, ExtensionContext, ReplacementSessionEntryLike } from "../host/pi-api.js";
import { getProjectRoot, getSessionId, getWorkingDirectory } from "../host/pi-api.js";
import {
  createSessionStore,
  selectSessionStoreBackend,
  type SessionStoreBackend,
} from "../runtime/runtime-capabilities.js";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

export interface TodoTask {
  content: string;
  status: TodoStatus;
  notes?: string[];
}

export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}

export interface TodoStateSnapshot {
  phases: TodoPhase[];
  context?: string;
  autoContinue: boolean;
  backend: "jsonl" | "pi-entry" | "memory";
  diagnostics: string[];
}

export interface TodoQueueMetadata {
  context?: string;
  autoContinue: boolean;
}

export interface TodoStateCommit {
  backend: SessionStoreBackend;
  diagnostics: string[];
}

export async function loadTodoState(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  fallbackPhases: TodoPhase[],
  fallbackMetadata: TodoQueueMetadata = { autoContinue: false },
): Promise<TodoStateSnapshot> {
  const backend = selectSessionStoreBackend();
  if (backend === "jsonl") {
    const store = createSessionStore({ projectRoot: getProjectRoot(ctx), backend: "jsonl" });
    const sessionId = ensureRuntimeSession(store, ctx);
    const latest = store.latestEntry(sessionId, "todo_write");
    if (latest !== undefined) {
      return {
        phases: cloneTodoPhases(latest.payload.phases as TodoPhase[]),
        ...readTodoMetadata(latest.payload.metadata),
        backend: "jsonl",
        diagnostics: "diagnostics" in store ? store.diagnostics : [],
      };
    }
  }

  const latest = await getLatestPiTodoEntry(ctx);
  const data = latest?.data as { phases?: unknown; metadata?: unknown } | undefined;
  if (data && Array.isArray(data.phases)) {
    return {
      phases: cloneTodoPhases(data.phases as TodoPhase[]),
      ...readTodoMetadata(data.metadata),
      backend: "pi-entry",
      diagnostics: [],
    };
  }
  return {
    phases: cloneTodoPhases(fallbackPhases),
    ...cloneTodoMetadata(fallbackMetadata),
    backend: "memory",
    diagnostics: [],
  };
}

async function getLatestPiTodoEntry(ctx: ExtensionContext): Promise<{ data?: unknown } | undefined> {
  const entries = await ctx.sessionManager?.getEntries();
  for (const entry of [...(entries ?? [])].reverse()) {
    const data = getTodoWriteEntryData(entry);
    if (data !== undefined) return { data };
  }
  return undefined;
}

function getTodoWriteEntryData(entry: ReplacementSessionEntryLike): unknown {
  if (entry.type === "custom" && entry.customType === "todo_write") return entry.data;
  if (entry.type === "todo_write") return entry.data ?? entry.payload;
  return undefined;
}

export async function commitTodoState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  phases: TodoPhase[],
  metadata: TodoQueueMetadata = { autoContinue: false },
): Promise<TodoStateCommit> {
  const backend = selectSessionStoreBackend();
  const cloned = cloneTodoPhases(phases);
  const clonedMetadata = cloneTodoMetadata(metadata);
  const persistedMetadata: Record<string, unknown> = { ...clonedMetadata };
  const diagnostics: string[] = [];
  if (backend === "jsonl") {
    const store = createSessionStore({ projectRoot: getProjectRoot(ctx), backend: "jsonl" });
    const sessionId = ensureRuntimeSession(store, ctx);
    store.appendEntry(sessionId, { type: "todo_write", payload: { phases: cloned, metadata: persistedMetadata } });
    if ("diagnostics" in store) diagnostics.push(...store.diagnostics);
  }
  await pi.appendEntry("todo_write", { phases: cloned, metadata: persistedMetadata });
  return { backend, diagnostics };
}

function readTodoMetadata(value: unknown): TodoQueueMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { autoContinue: false };
  }
  const metadata = value as Record<string, unknown>;
  const context = typeof metadata.context === "string" && metadata.context.trim() !== "" ? metadata.context : undefined;
  return {
    ...(context === undefined ? {} : { context }),
    autoContinue: metadata.autoContinue === true,
  };
}

function cloneTodoMetadata(metadata: TodoQueueMetadata): TodoQueueMetadata {
  return {
    ...(metadata.context === undefined ? {} : { context: metadata.context }),
    autoContinue: metadata.autoContinue === true,
  };
}

export function cloneTodoPhases(phases: TodoPhase[]): TodoPhase[] {
  return phases.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map((task) => ({
      content: task.content,
      status: task.status,
      ...(task.notes && task.notes.length > 0 ? { notes: [...task.notes] } : {}),
    })),
  }));
}

function ensureRuntimeSession(store: ReturnType<typeof createSessionStore>, ctx: ExtensionContext): string {
  const sessionId = getSessionId(ctx);
  if (store.getSession(sessionId) === undefined) {
    store.createSession({
      id: sessionId,
      projectRoot: getProjectRoot(ctx),
      workingDirectory: getWorkingDirectory(ctx),
    });
  }
  return sessionId;
}
