/**
 * extensions/todo-context/index.ts — Extension entrypoint for session-backed
 * todo state.
 *
 * Registers two deliberately different surfaces plus the queue hook that binds
 * them:
 * - `todo_write` (./todo-write-tool.js) is the model/runtime-facing tool that
 *   applies structured todo operations to the current session state.
 * - `/todo` (./command-router.js) is the operator-facing compatibility command
 *   for inspection, Markdown export, manual edits, and explicit task bridge
 *   commands.
 * - `agent_settled` drives the autonomous queue in ./queue-controller.js, the
 *   one owner of the continuation state both surfaces move.
 *
 * The extension is an OMP-compatible wrapper, not a standalone task manager.
 * It stores the latest todo phases through the Locus session backend when that
 * backend is enabled, keeps Pi `todo_write` custom entries for compatibility,
 * and falls back to shared in-process state only when no session entry exists.
 */
import type { ExtensionAPI } from "../_shared/pi-api.js";
import { registerTodoCommand } from "./command-router.js";
import { createTodoQueueController } from "./queue-controller.js";
import { registerTodoWriteTool } from "./todo-write-tool.js";

export default function todoContext(pi: ExtensionAPI): void {
  const queue = createTodoQueueController(pi);

  registerTodoCommand(pi, queue);
  registerTodoWriteTool(pi, queue);

  pi.on("agent_settled", async (_event, ctx) => {
    await queue.handleAgentSettled(ctx);
  });
}
