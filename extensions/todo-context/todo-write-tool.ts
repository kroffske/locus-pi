/**
 * extensions/todo-context/todo-write-tool.ts — the `todo_write` tool: its
 * TypeBox schema, the ordered application of one op batch onto session state,
 * the queue-state transition a batch implies, and the concise text summary the
 * model sees back.
 *
 * The operator-facing `/todo` compatibility surface is `command-router.ts`; the
 * queue state this tool moves is owned by `queue-controller.ts`.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { errorResult, textResult } from "../_shared/host/pi-api.js";
import { todoStateCache } from "./todo-state-cache.js";
import type { TodoPhase } from "../_shared/project/todo-state.js";
import { validateParams } from "../_shared/host/validation.js";
import { applyTodoOps, findActiveTask, getCompletionTransitions, type TodoOp } from "./phase-ops.js";
import { commitTodoPhases, loadTodoPhases, normalizeQueueContext } from "./phase-store.js";
import type { TodoQueueController } from "./queue-controller.js";

const TodoWriteParams = Type.Object({
  context: Type.Optional(Type.String({ maxLength: 2000 })),
  autoContinue: Type.Optional(Type.Boolean()),
  ops: Type.Array(
    Type.Object({
      op: Type.Union([
        Type.Literal("init"),
        Type.Literal("start"),
        Type.Literal("done"),
        Type.Literal("drop"),
        Type.Literal("rm"),
        Type.Literal("append"),
        Type.Literal("note"),
      ]),
      phase: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()),
      items: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })),
      text: Type.Optional(Type.String({ maxLength: 500 })),
      list: Type.Optional(
        Type.Array(
          Type.Object({
            phase: Type.String(),
            items: Type.Array(Type.String(), { minItems: 1 }),
          }),
        ),
      ),
    }),
    { minItems: 1, maxItems: 30 },
  ),
});

const PROGRESS_OPS = new Set(["init", "start", "done", "drop", "rm", "append"]);

export function registerTodoWriteTool(pi: ExtensionAPI, queue: TodoQueueController): void {
  pi.registerTool({
    name: "todo_write",
    description: "Apply ordered OMP-compatible todo operations to visible session todo state.",
    parameters: TodoWriteParams,
    approval: "write",
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(TodoWriteParams, params);
      if (!valid.ok) return valid.result;
      const previous = await loadTodoPhases(pi, ctx);
      const previousPhases = previous.phases;
      const { phases, errors } = applyTodoOps(previousPhases, valid.value.ops as TodoOp[]);
      const completedTasks = getCompletionTransitions(previousPhases, phases);
      const context = normalizeQueueContext(valid.value.context) ?? previous.context;
      const requestedAutoContinue = valid.value.autoContinue ?? previous.autoContinue;
      const autoContinue = findActiveTask(phases) === undefined ? false : requestedAutoContinue;
      if (
        (previous.autoContinue === false && autoContinue) ||
        (autoContinue && valid.value.ops.some((op) => op.op === "init"))
      ) {
        queue.resetAutomaticDispatches();
      }
      const commit = await commitTodoPhases(pi, ctx, phases, {
        ...(context === undefined ? {} : { context }),
        autoContinue,
      });
      if (errors.length > 0 || !autoContinue || findActiveTask(phases) === undefined) {
        queue.setContinuationArmed(false);
      } else if (valid.value.ops.some((op) => PROGRESS_OPS.has(op.op))) {
        queue.setContinuationArmed(true);
      }
      const details = {
        phases: todoStateCache.phases,
        storage: "session",
        storageBackend: commit.backend,
        todoStateSource: previous.backend,
        queueContext: context,
        autoContinue,
        continuationArmed: queue.continuationArmed,
        ...(commit.diagnostics.length > 0 || previous.diagnostics.length > 0
          ? { storageDiagnostics: [...previous.diagnostics, ...commit.diagnostics] }
          : {}),
        activeTask: findActiveTask(todoStateCache.phases),
        ...(completedTasks.length > 0 ? { completedTasks } : {}),
      };
      const summary = renderTodos(todoStateCache.phases, errors);
      return errors.length > 0 ? errorResult(summary, details) : textResult(summary, details);
    },
  });
}

/**
 * Render the concise text summary returned by the `todo_write` tool.
 */
function renderTodos(phases: TodoPhase[], errors: string[]): string {
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length === 0) return errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.";
  const remaining = phases
    .flatMap((phase) => phase.tasks.map((task) => ({ ...task, phase: phase.name })))
    .filter((task) => task.status === "pending" || task.status === "in_progress");
  const lines: string[] = [];
  if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
  if (remaining.length === 0) {
    lines.push("Remaining items: none.");
  } else {
    lines.push(`Remaining items (${remaining.length}):`);
    for (const task of remaining) lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
  }
  for (const phase of phases) {
    lines.push(`${phase.name}:`);
    for (const task of phase.tasks) {
      const noteCount = task.notes?.length ?? 0;
      const noteMarker = noteCount > 0 ? ` (+${noteCount} note${noteCount === 1 ? "" : "s"})` : "";
      lines.push(`  - [${task.status}] ${task.content}${noteMarker}`);
      if (task.status === "in_progress" && task.notes) {
        for (const note of task.notes) {
          for (const line of note.split("\n")) lines.push(`      ${line}`);
        }
      }
    }
  }
  return lines.join("\n");
}
