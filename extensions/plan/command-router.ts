/**
 * extensions/plan/command-router.ts — registers this extension's five commands
 * and dispatches each to its own command module: the two prompt-shelf shells
 * (`/review`, `/todos`), the behavioral-mode pair (`/plan`, `/mode`), and the
 * goal pair (`/goal`, `/goal-ai`) — including the one error boundary `/goal`
 * wraps its body in. Every command body lives in a `-command.ts` sibling; the
 * blocks they render are built in the `-ui` modules.
 */

import type { ExtensionAPI } from "../_shared/pi-api.js";
import { registerCommandWithUiLifecycle } from "../_shared/command-ui.js";
import type { PromptShelfKind } from "./command-parser.js";
import { goalErrorBlock } from "./goal-operator-ui.js";
import { setGoalOperatorBlock } from "./operator-surface.js";
import { handlePlanCommand } from "./plan-command.js";
import { handleModeCommand } from "./mode-command.js";
import { handleGoalCommand } from "./goal-command.js";
import { handleGoalAiCommand } from "./goal-ai-command.js";
import { handlePromptCommand } from "./prompt-shelf-command.js";

const COMMANDS: Array<{ kind: Exclude<PromptShelfKind, "goal">; description: string }> = [
  { kind: "review", description: "Review prompt shelf: summary, show/read, or set a project/explicit-task prompt." },
  { kind: "todos", description: "Todos prompt shelf: summary, show/read, or set a project/explicit-task prompt." },
];

export function registerPlanCommands(pi: ExtensionAPI): void {
  for (const command of COMMANDS) {
    registerCommandWithUiLifecycle(
      pi,
      {
        command: command.kind,
        group: command.kind,
        surfaces: ["transient-widget", "artifact-write"],
        transientWidgets: [command.kind],
      },
      {
        description: command.description,
        handler: async (args, ctx) => {
          await handlePromptCommand(command.kind, args, ctx);
        },
      },
    );
  }

  registerCommandWithUiLifecycle(
    pi,
    {
      command: "plan",
      group: "plan",
      surfaces: ["persistent-state", "status", "transient-widget", "blocking-prompt", "artifact-write"],
      transientWidgets: ["plan"],
      persistentStatuses: ["locus"],
    },
    {
      description:
        "Usage: /plan [<request>|exit|list|open <slug>|help]. Enter plan mode (prompts for a request if none given), list, exit, or help.",
      handler: async (args, ctx) => {
        await handlePlanCommand(args, ctx, pi);
      },
    },
  );

  registerCommandWithUiLifecycle(
    pi,
    {
      command: "mode",
      group: "plan",
      surfaces: ["persistent-state", "status", "transient-widget", "blocking-prompt"],
      transientWidgets: ["plan"],
      persistentStatuses: ["locus"],
    },
    {
      description: "Usage: /mode [plan|default|show]. Change behavioral mode only when a name is explicit.",
      handler: async (args, ctx) => {
        await handleModeCommand(args, ctx, pi);
      },
    },
  );

  registerCommandWithUiLifecycle(
    pi,
    {
      command: "goal",
      group: "goal",
      surfaces: ["persistent-state", "transient-widget", "artifact-write"],
      transientWidgets: ["goal"],
    },
    {
      description: "Usage: /goal <objective|set|show|pause|resume|drop|complete|continue|budget|prompt>.",
      handler: async (args, ctx) => {
        try {
          await handleGoalCommand(args, ctx, pi);
        } catch (error) {
          setGoalOperatorBlock(ctx, goalErrorBlock(error));
        }
      },
    },
  );

  registerCommandWithUiLifecycle(
    pi,
    {
      command: "goal-ai",
      group: "goal",
      surfaces: ["transient-widget", "blocking-prompt", "artifact-write"],
      transientWidgets: ["goal"],
    },
    {
      description:
        "Usage: /goal-ai [--task <task-id>] <request>. Ask an LLM to draft a Locus Prompt Draft and save it as a goal prompt.",
      handler: async (args, ctx) => {
        await handleGoalAiCommand(args, ctx);
      },
    },
  );
}
