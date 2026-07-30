/**
 * extensions/todo-context/queue-controller.ts — the autonomous todo queue.
 *
 * Owns the two pieces of per-session state that decide whether the next settled
 * turn continues the queue: whether a continuation is armed, and how many
 * automatic dispatches this run has already spent. The `todo_write` tool, the
 * `/todo run` and `/todo pause` verbs, and the `agent_settled` hook all move the
 * same state machine, so it lives in one place instead of in three closures.
 *
 * Block wording comes from `operator-ui.ts`; persistence from `phase-store.ts`.
 */
import type { ExtensionAPI, ExtensionContext } from "../_shared/host/pi-api.js";
import type { TodoStateSnapshot } from "../_shared/project/todo-state.js";
import { errorMessage } from "../_shared/host/error-text.js";
import { setTodoBlock } from "./operator-surface.js";
import { todoChangeBlock, todoWarningBlock } from "./operator-ui.js";
import { findActiveTask, findActiveTaskDetails } from "./phase-ops.js";
import { commitTodoPhases, loadTodoPhases, normalizeQueueContext } from "./phase-store.js";

const MAX_AUTO_CONTINUATIONS = 20;

export interface TodoQueueController {
  /** Whether a settled turn should dispatch the next continuation. */
  readonly continuationArmed: boolean;
  /** Start the dispatch budget over, for a queue that was just (re)started. */
  resetAutomaticDispatches(): void;
  setContinuationArmed(armed: boolean): void;
  /** `/todo run`: enable autonomous execution and dispatch the active todo. */
  run(ctx: ExtensionContext, contextInput: string): Promise<void>;
  /** `/todo pause`: disable autonomous execution, keeping the active todo. */
  pause(ctx: ExtensionContext): Promise<void>;
  handleAgentSettled(ctx: ExtensionContext): Promise<void>;
}

export function createTodoQueueController(pi: ExtensionAPI): TodoQueueController {
  let continuationArmed = false;
  let automaticDispatches = 0;
  const dispatchNext = async (ctx: ExtensionContext): Promise<void> => {
    if (await dispatchActiveTodo(pi, ctx, automaticDispatches)) {
      automaticDispatches += 1;
    }
  };

  const run = async (ctx: ExtensionContext, contextInput: string): Promise<void> => {
    continuationArmed = false;
    automaticDispatches = 0;
    const current = await loadTodoPhases(pi, ctx);
    const context = normalizeQueueContext(contextInput) ?? current.context;
    if (findActiveTask(current.phases) === undefined) {
      setTodoBlock(ctx, todoWarningBlock("No active todo to run.", [], ["Add: /todo append <task>"]));
      return;
    }
    const commit = await commitTodoPhases(pi, ctx, current.phases, {
      ...(context === undefined ? {} : { context }),
      autoContinue: true,
    });
    setTodoBlock(
      ctx,
      todoChangeBlock("Autonomous todo execution started.", current.phases, commit.backend, [
        ...(context === undefined ? [] : [`context: ${context}`]),
        "autoContinue: true",
      ]),
    );
    await dispatchNext(ctx);
  };

  const pause = async (ctx: ExtensionContext): Promise<void> => {
    continuationArmed = false;
    const current = await loadTodoPhases(pi, ctx);
    const commit = await commitTodoPhases(pi, ctx, current.phases, {
      ...(current.context === undefined ? {} : { context: current.context }),
      autoContinue: false,
    });
    setTodoBlock(
      ctx,
      todoChangeBlock("Autonomous todo execution paused.", current.phases, commit.backend, ["autoContinue: false"]),
    );
  };

  const handleAgentSettled = async (ctx: ExtensionContext): Promise<void> => {
    if (!continuationArmed) return;
    continuationArmed = false;
    await dispatchNext(ctx);
  };

  return {
    get continuationArmed(): boolean {
      return continuationArmed;
    },
    resetAutomaticDispatches: () => {
      automaticDispatches = 0;
    },
    setContinuationArmed: (armed: boolean) => {
      continuationArmed = armed;
    },
    run,
    pause,
    handleAgentSettled,
  };
}

async function dispatchActiveTodo(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  automaticDispatches: number,
): Promise<boolean> {
  const current = await loadTodoPhases(pi, ctx);
  const active = findActiveTaskDetails(current.phases);
  if (!current.autoContinue || active === undefined) return false;

  if (automaticDispatches >= MAX_AUTO_CONTINUATIONS) {
    await pauseAutonomousState(pi, ctx, current);
    setTodoBlock(
      ctx,
      todoWarningBlock(
        `Autonomous execution paused after ${MAX_AUTO_CONTINUATIONS} continuations.`,
        ["The active item remains visible and can be resumed explicitly."],
        ["Resume: /todo run", "Inspect: /todo"],
      ),
    );
    return false;
  }

  if (pi.sendMessage === undefined) {
    await pauseAutonomousState(pi, ctx, current);
    setTodoBlock(
      ctx,
      todoWarningBlock(
        "Autonomous execution is unavailable because this Pi host cannot trigger a continuation turn.",
        ["The active item remains visible."],
        ["Inspect: /todo"],
      ),
    );
    return false;
  }

  try {
    await pi.sendMessage(
      {
        customType: "locus-todo-continuation",
        content: buildContinuationPrompt(current.context, active.phase, active.task.content),
        display: false,
        details: {
          phase: active.phase,
          activeTask: active.task.content,
          continuation: automaticDispatches + 1,
        },
      },
      {
        triggerTurn: true,
        deliverAs: "followUp",
      },
    );
    return true;
  } catch (error) {
    await pauseAutonomousState(pi, ctx, current);
    const message = errorMessage(error);
    setTodoBlock(
      ctx,
      todoWarningBlock(
        "Autonomous execution paused because the continuation turn could not be dispatched.",
        [`error: ${message}`, "The active item remains visible."],
        ["Resume: /todo run", "Inspect: /todo"],
      ),
    );
    return false;
  }
}

async function pauseAutonomousState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  current: TodoStateSnapshot,
): Promise<void> {
  await commitTodoPhases(pi, ctx, current.phases, {
    ...(current.context === undefined ? {} : { context: current.context }),
    autoContinue: false,
  });
}

function buildContinuationPrompt(context: string | undefined, phase: string, task: string): string {
  return [
    "Continue the explicit session todo queue.",
    ...(context === undefined ? [] : ["Queue context:", context]),
    `Active phase: ${phase}`,
    `Active todo: ${task}`,
    "",
    "Complete only this active todo. Work directly or delegate through available agent tools.",
    "Before ending your response, call todo_write with a terminal transition for the active todo.",
    "If blocked or user input is required, call todo_write with autoContinue: false and explain the blocker.",
    "Do not execute later todos in this response; the queue controller will schedule the next one.",
  ].join("\n");
}
