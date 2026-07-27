/**
 * extensions/plan/index.ts — Extension entrypoint.
 *
 * Registers the behavioral-mode commands (`/plan`, `/mode`), the goal surface
 * (`/goal`, `/goal-ai`, and the model-callable `goal` tool), and the two
 * prompt-shelf commands (`/review`, `/todos`), plus the two lifecycle hooks
 * they need: the session-start reset of plan mode and the system-prompt
 * injection. Every command body, block builder and parser lives in a submodule.
 */

import type { ExtensionAPI } from "../_shared/pi-api.js";
import { getProjectRoot } from "../_shared/pi-api.js";
import { registerCommandWithUiLifecycle } from "../_shared/command-ui.js";
import { clearModeState } from "../_shared/mode-state.js";
import { goalErrorBlock } from "./goal-operator-ui.js";
import type { PromptShelfKind } from "./prompt-shelf-ui.js";
import { ensureModeAwareEditor, setGoalOperatorBlock, setModeStatus } from "./operator-surface.js";
import { handlePlanCommand } from "./plan-command.js";
import { handleModeCommand } from "./mode-command.js";
import { handleGoalCommand } from "./goal-command.js";
import { handleGoalAiCommand } from "./goal-ai-command.js";
import { handlePromptCommand } from "./prompt-shelf-command.js";
import { registerGoalTool } from "./goal-tool.js";
import { injectPlanContext } from "./system-prompt.js";

const COMMANDS: Array<{ kind: Exclude<PromptShelfKind, "goal">; description: string }> = [
  { kind: "review", description: "Review prompt shelf: summary, show/read, or set a project/explicit-task prompt." },
  { kind: "todos", description: "Todos prompt shelf: summary, show/read, or set a project/explicit-task prompt." },
];

export default function plan(pi: ExtensionAPI): void {
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

  registerGoalTool(pi);

  pi.on("session_start", async (_event, ctx) => {
    // Plan mode is session-explicit. A previous crash/restart/reload must not
    // silently arm planning for the next workflow or ordinary user turn.
    clearModeState(getProjectRoot(ctx));
    await ensureModeAwareEditor(ctx);
    setModeStatus(ctx, null);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const systemPrompt = await injectPlanContext(getProjectRoot(ctx), _event.systemPrompt ?? "");
    if (systemPrompt === undefined) return;
    return { systemPrompt };
  });
}
