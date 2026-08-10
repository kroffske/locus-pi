/**
 * extensions/todo-context/command-router.ts — registers `/todo` and dispatches
 * its verbs.
 *
 * `/todo` is a compatibility/operator surface. Agentic state updates should
 * prefer the structured `todo_write` tool so the model call sees a real schema
 * and receives structured result details. Nothing here does work itself: the
 * session-state verbs live in `state-commands.ts`, the explicit project-task
 * verbs in `task-bridge-commands.ts`, the queue verbs in `queue-controller.ts`,
 * and the grammar in `command-parser.ts`.
 */
import { registerCommandWithUiLifecycle } from "../_shared/operator/command-ui.js";
import type { ExtensionAPI, ExtensionContext } from "../_shared/host/pi-api.js";
import { getCommandText } from "../_shared/host/pi-api.js";
import { splitCommand } from "./command-parser.js";
import { setTodoBlock } from "./operator-surface.js";
import { todoErrorBlock, todoHelpBlock, todoWarningBlock } from "./operator-ui.js";
import type { TodoQueueController } from "./queue-controller.js";
import { appendTodo, editTodos, exportTodos, mutateTodo, showTodos, startTodo } from "./state-commands.js";
import { seedTodoFromTask, showCurrentProjectTask, writeTodoCompletionNote } from "./task-bridge-commands.js";

export function registerTodoCommand(pi: ExtensionAPI, queue: TodoQueueController): void {
  registerCommandWithUiLifecycle(
    pi,
    {
      command: "todo",
      group: "todo",
      surfaces: ["transient-widget", "blocking-prompt", "artifact-write"],
      transientWidgets: ["todo"],
    },
    {
      description: "Show, edit, and explicitly bridge OMP-style todos from the session todo state.",
      handler: async (args, ctx) => {
        try {
          await handleCommand(pi, queue, args, ctx);
        } catch (error) {
          setTodoBlock(ctx, todoErrorBlock(error));
        }
      },
    },
  );
}

async function handleCommand(
  pi: ExtensionAPI,
  queue: TodoQueueController,
  args: string | { text?: string; args: Record<string, string> },
  ctx: ExtensionContext,
): Promise<void> {
  const input = getCommandText(args).trim();
  const [verb = "", rest = ""] = splitCommand(input);
  if (verb === "run") {
    await queue.run(ctx, rest);
    return;
  }
  if (verb === "pause") {
    await queue.pause(ctx);
    return;
  }
  await handleTodoCommand(pi, input, ctx);
}

/**
 * Route `/todo` operator input to the command implementation.
 */
async function handleTodoCommand(pi: ExtensionAPI, text: string, ctx: ExtensionContext): Promise<void> {
  const input = text.trim();
  if (!input || input === "show" || input === "list") {
    await showTodos(pi, ctx);
    return;
  }
  if (input === "help" || input === "?") {
    setTodoBlock(ctx, todoHelpBlock());
    return;
  }

  const [verb = "", rest = ""] = splitCommand(input);
  if (verb === "edit") {
    await editTodos(pi, ctx);
    return;
  }
  if (verb === "copy") {
    await showTodos(pi, ctx, "Copy not available here; printing Markdown instead.");
    return;
  }
  if (verb === "export") {
    await exportTodos(pi, ctx);
    return;
  }
  if (verb === "append") {
    await appendTodo(pi, ctx, rest);
    return;
  }
  if (verb === "start") {
    await startTodo(pi, ctx, rest);
    return;
  }
  if (verb === "from-task") {
    await seedTodoFromTask(pi, ctx, rest);
    return;
  }
  if (verb === "current-task") {
    showCurrentProjectTask(ctx);
    return;
  }
  if (verb === "completion-note") {
    await writeTodoCompletionNote(pi, ctx, rest);
    return;
  }
  if (verb === "done" || verb === "drop" || verb === "rm") {
    await mutateTodo(pi, ctx, verb, rest);
    return;
  }

  setTodoBlock(ctx, todoWarningBlock(`Unknown /todo verb: ${verb}.`, [], ["Help: /todo help"]));
}
