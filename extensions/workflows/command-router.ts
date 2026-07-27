/**
 * extensions/workflows/command-router.ts — The `/workflows` command surface.
 *
 * Parses the command text, routes it to one operator surface (help, catalog,
 * info, dashboard, status, result, stop, continue, run), and registers the
 * flat `/workflow-*` aliases as thin routes into the same grammar. Everything
 * it needs from the session — the launcher, the handoff pump, the completion
 * context — arrives as injected dependencies, never as module state.
 */

import type { CommandArgs, ExtensionAPI, ExtensionCommandContext } from "../_shared/pi-api.js";
import { getCommandText, getProjectRoot, getWorkingDirectory } from "../_shared/pi-api.js";
import { registerCommandWithUiLifecycle } from "../_shared/command-ui.js";
import {
  isStaleInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
} from "../_shared/operator-interaction.js";
import { setOperatorWidget } from "../_shared/widget-render.js";
import { readWorkflowRunResultText, resolveWorkflowRunId } from "../_shared/workflow-journal.js";
import { WORKFLOW_INPUT_MAX_CHARS } from "../_shared/workflow-runtime.js";
import { WorkflowCatalogViewer, WorkflowInfoViewer } from "./catalog-viewer.js";
import { workflowArgumentCompletions, workflowFlatCommandCompletions } from "./command-completions.js";
import { parseContinueCommand, parseRunCommand } from "./command-parser.js";
import { isOneShotCommandMode, preflightWorkflowCommandTarget, workflowCommandIdleBlock } from "./launch-guard.js";
import type { WorkflowHandoffPumpResult } from "./operator-handoff-controller.js";
import { clearWorkflowWidget, presentWorkflowHandoffPumpResult } from "./operator-surface.js";
import {
  ambiguousWorkflowRunBlock,
  assertNever,
  errorMessage,
  listExampleNames,
  workflowHelpBlock,
  workflowNotFoundBlock,
  workflowRunConflictBlock,
  workflowStopBlock,
  workflowUnknownCommandBlock,
  workflowWarningBlock,
} from "./operator-ui.js";
import { WORKFLOW_LIVE_WIDGET_KEY } from "./progress-widget.js";
import { WorkflowResultViewer, WorkflowRunViewer } from "./run-viewer.js";
import {
  buildRunDetailBlock,
  buildRunsListBlock,
  RUNS_IN_STATUS_LIST,
  WORKFLOW_RPC_STATUS_ROWS,
} from "./run-evidence.js";
import {
  buildWorkflowActionPrompt,
  buildWorkflowCatalogBlockFromModel,
  buildWorkflowCatalogModel,
  buildWorkflowInfoBlock,
  type WorkflowBrowserIntent,
} from "./workflow-catalog.js";
import type { WorkflowCommandLauncher } from "./workflow-command-launcher.js";

/** Bounded preview for hosts without custom UI; the file path carries the rest. */
const WORKFLOW_RESULT_WIDGET_LINES = 40;

const FLAT_WORKFLOW_COMMANDS = ["run", "stop", "list", "info", "status", "result", "continue"] as const;

export type FlatWorkflowCommand = (typeof FLAT_WORKFLOW_COMMANDS)[number];

export interface WorkflowCommandRouterDependencies {
  commandLauncher: WorkflowCommandLauncher;
  /** Open, answer, or advance the oldest actionable handoff for this session. */
  pumpCurrentHandoffs: (
    ctx: ExtensionCommandContext,
    options?: { explicit?: boolean; runId?: string; answer?: string },
  ) => Promise<WorkflowHandoffPumpResult>;
  /** Latch the roots a later completion callback has to answer from. */
  rememberCompletionContext: (ctx: ExtensionCommandContext) => void;
  completionContext: () => { projectRoot: string; workingDirectory: string };
  actionableRunIds: (projectRoot: string) => string[];
}

export function registerWorkflowCommands(pi: ExtensionAPI, deps: WorkflowCommandRouterDependencies): void {
  const { commandLauncher, pumpCurrentHandoffs, rememberCompletionContext } = deps;

  const handleWorkflowCommand = async (args: CommandArgs, ctx: ExtensionCommandContext): Promise<void> => {
    const text = getCommandText(args).trim();
    const projectRoot = getProjectRoot(ctx);
    rememberCompletionContext(ctx);

    // Bare `/workflows` reopens the oldest question; home is the no-attention fallback.
    if (text === "") {
      clearWorkflowWidget(ctx, WORKFLOW_LIVE_WIDGET_KEY);
      const pending = await pumpCurrentHandoffs(ctx, { explicit: true });
      if (pending.status !== "none") {
        presentWorkflowHandoffPumpResult(ctx, pending);
        return;
      }
      setOperatorWidget(ctx, "workflows", workflowHelpBlock());
      return;
    }

    // `/workflows dashboard` — persisted run/stage/evidence browser. RPC and
    // hosts without custom UI retain the same bounded disk-backed list.
    if (text === "dashboard") {
      if (await openWorkflowRunViewer(ctx, projectRoot)) return;
      setOperatorWidget(
        ctx,
        "workflows",
        buildRunsListBlock(
          projectRoot,
          ctx.mode === "tui" ? RUNS_IN_STATUS_LIST : WORKFLOW_RPC_STATUS_ROWS,
          ctx.mode !== "tui",
        ),
      );
      return;
    }

    // `/workflows list [query]` — operator catalog over the existing sources.
    const listMatch = /^list(?:\s+([\s\S]+))?$/.exec(text);
    if (listMatch !== null) {
      const query = listMatch[1]?.trim();
      const workingDirectory = getWorkingDirectory(ctx);
      const catalog = buildWorkflowCatalogModel(projectRoot, workingDirectory, query === "" ? undefined : query);
      if (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined) {
        clearWorkflowWidget(ctx, "workflows");
        let intent: WorkflowBrowserIntent | undefined;
        try {
          intent = await requestInlineOperatorInteraction<WorkflowBrowserIntent | undefined>(
            ctx,
            (tui, theme, keybindings, done) =>
              new WorkflowCatalogViewer(tui, theme, keybindings, catalog, projectRoot, workingDirectory, done),
          );
        } catch (error) {
          setOperatorWidget(
            ctx,
            "workflows",
            workflowWarningBlock(
              `Workflow browser closed with an error: ${errorMessage(error)}.`,
              "No editor text was changed and no workflow was started.",
            ),
          );
          return;
        }
        if (intent === undefined) return;
        const prompt = buildWorkflowActionPrompt(intent);
        if (ctx.ui.setEditorText === undefined) {
          setOperatorWidget(
            ctx,
            "workflows",
            workflowWarningBlock(
              "Workflow action could not fill the editor because this Pi host does not expose setEditorText().",
              "No workflow was started; reopen in an interactive Pi TUI with editor-prefill support.",
            ),
          );
          return;
        }
        try {
          ctx.ui.setEditorText(prompt);
        } catch (error) {
          setOperatorWidget(
            ctx,
            "workflows",
            workflowWarningBlock(
              `Workflow action could not fill the editor: ${errorMessage(error)}.`,
              "No workflow was started and no message was sent.",
            ),
          );
        }
        return;
      }
      const passive = buildWorkflowCatalogBlockFromModel(catalog, { compact: ctx.mode !== "tui" });
      setOperatorWidget(
        ctx,
        "workflows",
        ctx.mode === "tui"
          ? {
              ...passive,
              hint: [
                ...(passive.hint ?? []),
                "Interactive catalog unavailable: this Pi host did not expose custom UI.",
              ],
              controls: [
                ...(passive.controls ?? []),
                "Read-only fallback shown; retry in an interactive Pi TUI with custom UI support.",
              ],
            }
          : passive,
      );
      return;
    }

    const infoMatch = /^info(?:\s+([\s\S]+))?$/.exec(text);
    if (infoMatch !== null) {
      const name = infoMatch[1]?.trim();
      const infoBlock = buildWorkflowInfoBlock(projectRoot, getWorkingDirectory(ctx), name === "" ? undefined : name);
      if (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined) {
        try {
          await requestInlineOperatorInteraction<void>(
            ctx,
            (tui, theme, keybindings, done) => new WorkflowInfoViewer(tui, theme, keybindings, infoBlock, done),
          );
        } catch (error) {
          setOperatorWidget(
            ctx,
            "workflows",
            workflowWarningBlock(
              `Workflow info viewer closed with an error: ${errorMessage(error)}.`,
              "No editor text was changed and no workflow was started.",
            ),
          );
        }
        return;
      }
      setOperatorWidget(
        ctx,
        "workflows",
        ctx.mode === "tui"
          ? {
              ...infoBlock,
              hint: [
                ...(infoBlock.hint ?? []),
                "Interactive workflow info unavailable: this Pi host did not expose custom UI.",
              ],
              controls: [
                ...(infoBlock.controls ?? []),
                "Read-only fallback shown; retry in an interactive Pi TUI with custom UI support.",
              ],
            }
          : infoBlock,
      );
      return;
    }

    // `/workflows status` — recent runs; `/workflows status <runId>` — one run's progress.
    if (text === "status") {
      if (await openWorkflowRunViewer(ctx, projectRoot)) return;
      const compact = ctx.mode !== "tui";
      setOperatorWidget(
        ctx,
        "workflows",
        buildRunsListBlock(projectRoot, compact ? WORKFLOW_RPC_STATUS_ROWS : RUNS_IN_STATUS_LIST, compact),
      );
      return;
    }
    const statusMatch = /^status\s+(\S+)$/.exec(text);
    if (statusMatch !== null) {
      const selector = statusMatch[1] ?? "";
      // The chat digest and the live panel head a run with its short suffix
      // (`run #98cc`), so that is what an operator has in front of them; the run
      // list and detail widgets print full ids. Both resolve here, and an id that
      // matches several runs is named as such rather than reported as missing.
      const resolved = resolveWorkflowRunId(projectRoot, selector);
      if (resolved.status === "ambiguous") {
        setOperatorWidget(ctx, "workflows", ambiguousWorkflowRunBlock(selector, resolved));
        return;
      }
      const runId = resolved.status === "resolved" ? resolved.runId : selector;
      if (await openWorkflowRunViewer(ctx, projectRoot, runId)) return;
      setOperatorWidget(ctx, "workflows", buildRunDetailBlock(projectRoot, runId, ctx.mode !== "tui"));
      return;
    }

    // `/workflows result [runId|last]` — the whole terminal text of a finished run.
    const resultMatch = /^result(?:\s+(\S+))?$/.exec(text);
    if (resultMatch !== null) {
      await presentWorkflowRunResultText(ctx, projectRoot, resultMatch[1] ?? "last");
      return;
    }

    const stopMatch = /^stop(?:\s+(\S+))?$/.exec(text);
    if (stopMatch !== null) {
      const lease = commandLauncher.currentLease(ctx);
      if (lease === undefined) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            "Workflow stop is unavailable because this extension session has already shut down.",
            "Recovery: wait for Pi to finish reloading, then retry /workflows stop last.",
          ),
        );
        return;
      }
      const selector = stopMatch[1] ?? "last";
      setOperatorWidget(ctx, "workflows", workflowStopBlock(selector, commandLauncher.stop(lease, selector)));
      return;
    }

    const parsedContinue = parseContinueCommand(text);
    if (parsedContinue !== null) {
      if (parsedContinue.runId === undefined) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            "Workflow continuation requires a source run id.",
            "Retry: /workflow-continue <runId> [--answer <text>]",
          ),
        );
        return;
      }
      if (parsedContinue.missingAnswer === true) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock("Missing text after --answer.", "Retry: /workflow-continue <runId> --answer <text>"),
        );
        return;
      }
      const result = await pumpCurrentHandoffs(ctx, {
        explicit: true,
        runId: parsedContinue.runId,
        ...(parsedContinue.answer === undefined ? {} : { answer: parsedContinue.answer }),
      });
      if (result.status === "none") {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            `No actionable workflow handoff was found for ${parsedContinue.runId}.`,
            "Inspect durable evidence: /workflow-status <runId>",
          ),
        );
        return;
      }
      presentWorkflowHandoffPumpResult(ctx, result);
      return;
    }

    // `/workflows run <name|path> [--resume <runId>] [input]` — run with a live progress panel.
    const parsedRun = parseRunCommand(text);
    if (parsedRun !== null) {
      if (parsedRun.missingResumeId === true) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            "Missing run id after --resume.",
            "Retry: /workflows run <name|path> --resume <runId> [input]",
          ),
        );
        return;
      }
      if (parsedRun.input !== undefined && parsedRun.input.length > WORKFLOW_INPUT_MAX_CHARS) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            `Workflow input exceeds the ${WORKFLOW_INPUT_MAX_CHARS}-character limit after command trimming.`,
            "Retry with a shorter semantic request.",
          ),
        );
        return;
      }
      const idleBlock = workflowCommandIdleBlock(ctx);
      if (idleBlock !== undefined) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            idleBlock,
            "Recovery: wait for the current response to finish, then retry the same /workflows run command.",
          ),
        );
        return;
      }
      const scriptRef = parsedRun.scriptRef;
      const workingDirectory = getWorkingDirectory(ctx);
      const targetPreflight = preflightWorkflowCommandTarget(scriptRef, projectRoot, workingDirectory);
      if (targetPreflight.status === "not-found") {
        setOperatorWidget(ctx, "workflows", workflowNotFoundBlock(scriptRef));
        return;
      }
      // Confinement and other resolution failures deliberately continue
      // through the runner once. That owner creates the canonical failed
      // run and result.json instead of losing durable operator evidence.
      const target = targetPreflight.status === "resolved" ? targetPreflight.target : undefined;

      const launched = commandLauncher.launch({
        ctx,
        scriptRef,
        ...(target === undefined ? {} : { target }),
        ...(parsedRun.input === undefined ? {} : { input: parsedRun.input }),
        ...(parsedRun.resumeFromRunId === undefined ? {} : { resumeFromRunId: parsedRun.resumeFromRunId }),
        ...(ctx.waitForIdle === undefined ? {} : { waitForIdle: () => ctx.waitForIdle!() }),
      });
      if (launched.status === "started") {
        // A `tui` session and a long-lived `rpc` session both outlive the turn, so
        // the run stays detached and the operator keeps the prompt. The one-shot
        // output modes do not: the host disposes the session when the turn ends,
        // and the detached run's captured ctx goes stale before its first child
        // session ("This extension ctx is stale after session replacement or
        // reload"). There the command holds the turn open until the run settles.
        if (isOneShotCommandMode(ctx)) await commandLauncher.awaitActive();
      } else if (launched.status === "busy") {
        setOperatorWidget(ctx, "workflows", workflowRunConflictBlock(launched.owner));
      } else if (launched.status === "stale") {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            "Workflow not started: this extension session has already shut down.",
            "Recovery: wait for Pi to finish reloading, then retry the same /workflows run command.",
          ),
        );
      }
      return;
    }

    const available = text.startsWith("run") ? listExampleNames() : [];
    setOperatorWidget(ctx, "workflows", workflowUnknownCommandBlock(text, available));
  };

  registerCommandWithUiLifecycle(
    pi,
    {
      command: "workflows",
      group: "workflows",
      surfaces: ["transient-widget", "status", "artifact-write", "no-ui"],
      transientWidgets: ["workflows", WORKFLOW_LIVE_WIDGET_KEY],
    },
    {
      description:
        "Usage: /workflows | dashboard | list [query] | info [name] | status [runId] | run <name|path> [--resume <runId>] [input] | continue <runId> [--answer <text>] | stop [runId|last]. Bare /workflows reopens the oldest pending operator question; subcommands remain available for compatibility.",
      getArgumentCompletions: (prefix) => {
        const context = deps.completionContext();
        return workflowArgumentCompletions(prefix, context.projectRoot, context.workingDirectory);
      },
      handler: handleWorkflowCommand,
    },
  );

  registerWorkflowCommandAliases(pi, handleWorkflowCommand, deps.completionContext, deps.actionableRunIds);
}

function registerWorkflowCommandAliases(
  pi: ExtensionAPI,
  handler: (args: CommandArgs, ctx: ExtensionCommandContext) => Promise<void>,
  completionContext: () => { projectRoot: string; workingDirectory: string },
  actionableRunIds: (projectRoot: string) => string[],
): void {
  for (const command of FLAT_WORKFLOW_COMMANDS) {
    const commandName = `workflow-${command}`;
    registerCommandWithUiLifecycle(
      pi,
      {
        command: commandName,
        group: "workflows",
        surfaces: ["transient-widget", "status", "artifact-write", "no-ui"],
        transientWidgets: ["workflows", WORKFLOW_LIVE_WIDGET_KEY],
      },
      {
        description: flatWorkflowCommandDescription(command),
        getArgumentCompletions: (prefix) => {
          const context = completionContext();
          return workflowFlatCommandCompletions(
            command,
            prefix,
            context.projectRoot,
            context.workingDirectory,
            actionableRunIds(context.projectRoot),
          );
        },
        handler: (args, ctx) => {
          const tail = getCommandText(args).trim();
          return handler(tail === "" ? command : `${command} ${tail}`, ctx);
        },
      },
    );
  }
}

function flatWorkflowCommandDescription(command: FlatWorkflowCommand): string {
  switch (command) {
    case "run":
      return "Run a saved workflow: /workflow-run <name|path> [--resume <runId>] [input]";
    case "stop":
      return "Explicitly stop a workflow: /workflow-stop [runId|last]";
    case "list":
      return "Browse saved workflows: /workflow-list [query]";
    case "info":
      return "Show workflow information: /workflow-info [name]";
    case "status":
      return "Inspect persisted workflow evidence: /workflow-status [runId]";
    case "result":
      return "Read the full text a run finished with: /workflow-result [runId|last]";
    case "continue":
      return "Answer and continue an actionable workflow handoff: /workflow-continue <runId> [--answer <text>]";
    default:
      return assertNever(command);
  }
}

/**
 * Show the full text a run finished with. Interactive hosts get a scrollable
 * screen; every other host gets the text bounded by the widget plus the exact
 * file path, because the file is the copy that is never truncated.
 */
async function presentWorkflowRunResultText(
  ctx: ExtensionCommandContext,
  projectRoot: string,
  selector: string,
): Promise<void> {
  const resolved = resolveWorkflowRunId(projectRoot, selector);
  if (resolved.status === "ambiguous") {
    setOperatorWidget(ctx, "workflows", ambiguousWorkflowRunBlock(selector, resolved));
    return;
  }
  if (resolved.status === "not-found") {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        selector === "last" || selector === ""
          ? "No workflow run with persisted evidence was found."
          : `No workflow run matches ${selector}.`,
        "List runs: /workflows status",
      ),
    );
    return;
  }
  const read = readWorkflowRunResultText(projectRoot, resolved.runId);
  if (read.status === "none") {
    setOperatorWidget(ctx, "workflows", workflowWarningBlock(read.message, "Inspect evidence: /workflows status"));
    return;
  }
  const title = `workflow result · run ${read.runId}`;
  if (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined) {
    clearWorkflowWidget(ctx, "workflows");
    try {
      await requestInlineOperatorInteraction<void>(
        ctx,
        (tui, theme, keybindings, done) => new WorkflowResultViewer(tui, theme, keybindings, title, read.text, done),
      );
      return;
    } catch (error) {
      if (!isStaleInlineOperatorInteractionError(error)) throw error;
      // Another prompt owns the screen. Say so and leave the path behind, so the
      // command never ends with nothing on screen — best-effort, because a
      // replaced session may no longer accept a notification at all.
      try {
        ctx.ui.notify("Workflow result closed: another prompt took the screen. Retry /workflows result.", "info");
      } catch {
        // The bounded widget below is still written.
      }
    }
  }
  // The widget re-bounds this body itself and marks what it drops, so the only
  // honest thing to add is the size of the whole result and where all of it is.
  // Claiming a second, different line count here would contradict that marker.
  const allLines = read.text.replace(/\n$/u, "").split(/\r?\n/u);
  setOperatorWidget(ctx, "workflows", {
    type: "VIEW",
    subject: "Workflow result",
    primary: title,
    body: allLines.slice(0, WORKFLOW_RESULT_WIDGET_LINES),
    metadata: [`full text: ${allLines.length} line(s) at ${read.path}`],
    controls: ["Read it all in an interactive Pi TUI, or open the file above"],
  });
}

async function openWorkflowRunViewer(
  ctx: ExtensionCommandContext,
  projectRoot: string,
  runId?: string,
): Promise<boolean> {
  if (ctx.mode !== "tui" || ctx.hasUI === false || ctx.ui.custom === undefined) return false;
  clearWorkflowWidget(ctx, "workflows");
  try {
    await requestInlineOperatorInteraction<void>(
      ctx,
      (tui, theme, keybindings, done) => new WorkflowRunViewer(tui, theme, keybindings, projectRoot, done, runId),
    );
  } catch (error) {
    const fallback =
      runId === undefined
        ? buildRunsListBlock(projectRoot, RUNS_IN_STATUS_LIST)
        : buildRunDetailBlock(projectRoot, runId);
    setOperatorWidget(ctx, "workflows", {
      ...fallback,
      metadata: [
        `Interactive evidence viewer failed: ${errorMessage(error)}. Bounded static evidence is shown instead.`,
        ...(fallback.metadata ?? []),
      ],
    });
  }
  return true;
}
