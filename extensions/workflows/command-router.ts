/**
 * extensions/workflows/command-router.ts — The `/workflows` command surface.
 *
 * Parses the command text, routes it to one operator surface (help, catalog,
 * info, dashboard, status, result, stop, continue, run), and registers the
 * flat `/workflow-*` aliases as thin routes into the same grammar. Everything
 * it needs from the session — the launcher, the handoff pump, the completion
 * context — arrives as injected dependencies, never as module state.
 */

import type { CommandArgs, ExtensionAPI, ExtensionCommandContext } from "../_shared/host/pi-api.js";
import { getCommandText, getProjectRoot, getWorkingDirectory } from "../_shared/host/pi-api.js";
import { registerCommandWithUiLifecycle } from "../_shared/operator/command-ui.js";
import {
  isStaleInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
} from "../_shared/operator/operator-interaction.js";
import { setOperatorWidget } from "../_shared/operator/widget-render.js";
import { listWorkflowRunIds, readWorkflowRunResultText, resolveWorkflowRunId } from "./runtime/workflow-journal.js";
import { WORKFLOW_INPUT_MAX_CHARS } from "./runtime/workflow-runtime.js";
import { WorkflowCatalogViewer, WorkflowInfoViewer } from "./catalog-viewer.js";
import { workflowArgumentCompletions, workflowFlatCommandCompletions } from "./command-completions.js";
import {
  formatWorkflowCommandToken,
  parseContinueCommand,
  parseRunCommand,
  parseWorkflowCommandToken,
} from "./command-parser.js";
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
const WORKFLOW_MENU_OPTION_LIMIT = 20;

const WORKFLOW_MENU_COMMANDS = ["dashboard", "list", "info", "status", "result", "run", "continue", "stop"] as const;

type WorkflowMenuCommand = (typeof WORKFLOW_MENU_COMMANDS)[number];
type WorkflowMenuSelection =
  { status: "selected"; value: string } | { status: "dismissed" } | { status: "failed"; message: string };

const WORKFLOW_MENU_DESCRIPTIONS: Record<WorkflowMenuCommand, string> = {
  dashboard: "inspect persisted runs and evidence",
  list: "browse available workflows",
  info: "inspect one workflow's details",
  status: "view recent run progress",
  result: "read a finished run's output",
  run: "start a workflow",
  continue: "answer a pending handoff",
  stop: "stop an active run",
};

const WORKFLOW_MENU_OPTIONS = WORKFLOW_MENU_COMMANDS.map((command) => ({
  command,
  label: `${command} — ${WORKFLOW_MENU_DESCRIPTIONS[command]}`,
}));

const FLAT_WORKFLOW_COMMANDS = ["run", "stop", "list", "info", "status", "result", "continue"] as const;

export type FlatWorkflowCommand = (typeof FLAT_WORKFLOW_COMMANDS)[number];

export interface WorkflowCommandRouterDependencies {
  commandLauncher: WorkflowCommandLauncher;
  /** Open, answer, or advance the oldest actionable handoff for this session. */
  pumpCurrentHandoffs: (
    ctx: ExtensionCommandContext,
    options?: { runId?: string; answer?: string },
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

    // Bare `/workflows` is the interactive command chooser. Noninteractive
    // hosts receive the same grammar as a read-only block instead of a prompt.
    if (text === "") {
      clearWorkflowWidget(ctx, WORKFLOW_LIVE_WIDGET_KEY);
      if (workflowMenuAvailable(ctx)) {
        await openWorkflowCommandMenu(
          ctx,
          projectRoot,
          getWorkingDirectory(ctx),
          commandLauncher,
          deps.actionableRunIds,
          (command) => handleWorkflowCommand(command, ctx),
        );
      } else {
        setOperatorWidget(ctx, "workflows", workflowHelpBlock());
      }
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
      const name = workflowInfoName(infoMatch[1]?.trim());
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
            "Retry: /workflows continue <runId> [--answer <text>]",
          ),
        );
        return;
      }
      if (parsedContinue.missingAnswer === true) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock("Missing text after --answer.", "Retry: /workflows continue <runId> --answer <text>"),
        );
        return;
      }
      const result = await pumpCurrentHandoffs(ctx, {
        runId: parsedContinue.runId,
        ...(parsedContinue.answer === undefined ? {} : { answer: parsedContinue.answer }),
      });
      if (result.status === "none") {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            `No actionable workflow handoff was found for ${parsedContinue.runId}.`,
            "Inspect durable evidence: /workflows status <runId>",
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
        "Usage: /workflows | dashboard | list [query] | info [name] | status [runId] | result [runId|last] | run <name|path> [--resume <runId>] [input] | continue <runId> [--answer <text>] | stop [runId|last]. Bare /workflows opens an interactive command menu only in a Pi TUI with select support; other hosts receive command help. Subcommands remain available directly.",
      getArgumentCompletions: (prefix) => {
        const context = deps.completionContext();
        return workflowArgumentCompletions(
          prefix,
          context.projectRoot,
          context.workingDirectory,
          deps.actionableRunIds(context.projectRoot),
        );
      },
      handler: handleWorkflowCommand,
    },
  );

  registerWorkflowCommandAliases(pi, handleWorkflowCommand, deps.completionContext, deps.actionableRunIds);
}

function workflowMenuAvailable(ctx: ExtensionCommandContext): boolean {
  return ctx.mode === "tui" && ctx.hasUI !== false && typeof ctx.ui.select === "function";
}

async function openWorkflowCommandMenu(
  ctx: ExtensionCommandContext,
  projectRoot: string,
  workingDirectory: string,
  commandLauncher: WorkflowCommandLauncher,
  actionableRunIds: (projectRoot: string) => string[],
  route: (command: string) => Promise<void>,
): Promise<void> {
  const root = await requestWorkflowMenuSelection(
    ctx,
    "[SELECT] Workflows",
    WORKFLOW_MENU_OPTIONS.map((option) => option.label),
  );
  if (!presentWorkflowMenuSelectionFailure(ctx, root, "Retry /workflows or use /workflows <subcommand>.")) return;

  const command = WORKFLOW_MENU_OPTIONS.find((option) => option.label === root.value)?.command;
  if (command === undefined) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        `Workflow menu returned an unsupported root selection: ${JSON.stringify(root.value)}.`,
        "Retry /workflows or use /workflows <subcommand>.",
      ),
    );
    return;
  }
  switch (command) {
    case "dashboard":
    case "list":
    case "status":
      await route(command);
      return;
    case "info": {
      const selected = await selectWorkflowTarget(ctx, projectRoot, workingDirectory, "info");
      if (selected !== undefined) await route(`info ${formatWorkflowCommandToken(selected.name)}`);
      return;
    }
    case "result": {
      const runId = await selectWorkflowRun(ctx, projectRoot, "read result for");
      if (runId !== undefined) await route(`result ${runId}`);
      return;
    }
    case "run": {
      const selected = await selectWorkflowTarget(ctx, projectRoot, workingDirectory, "run");
      if (selected !== undefined) {
        fillWorkflowEditor(ctx, `/workflows run ${formatWorkflowCommandToken(selected.ref)}`);
      }
      return;
    }
    case "continue": {
      let runIds: string[];
      try {
        runIds = actionableRunIds(projectRoot).slice(0, WORKFLOW_MENU_OPTION_LIMIT);
      } catch (error) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            `Workflow handoffs could not be listed: ${errorMessage(error)}.`,
            "No handoff was opened; inspect durable evidence with /workflows status.",
          ),
        );
        return;
      }
      if (runIds.length === 0) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock("No workflow handoff currently needs an answer.", "Inspect runs: /workflows status"),
        );
        return;
      }
      const selected = await requestWorkflowMenuSelection(ctx, "[SELECT] Workflow handoff to continue", runIds);
      if (!presentWorkflowMenuSelectionFailure(ctx, selected, "Retry /workflows continue <runId>.")) return;
      await route(`continue ${selected.value}`);
      return;
    }
    case "stop": {
      const lease = commandLauncher.currentLease(ctx);
      if (lease === undefined) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            "Workflow stop is unavailable because this extension session has already shut down.",
            "Wait for Pi to finish reloading, then retry /workflows.",
          ),
        );
        return;
      }
      const selectors = [...new Set(commandLauncher.unsettled(lease).map((run) => run.runId ?? run.launchId))];
      if (selectors.length === 0) {
        setOperatorWidget(
          ctx,
          "workflows",
          workflowWarningBlock(
            "No workflow run in the current session is available to stop.",
            "Start one: /workflows run",
          ),
        );
        return;
      }
      const selected = await requestWorkflowMenuSelection(ctx, "[SELECT] Workflow run to stop", ["last", ...selectors]);
      if (!presentWorkflowMenuSelectionFailure(ctx, selected, "Retry /workflows stop [runId|last].")) return;
      fillWorkflowEditor(ctx, `/workflows stop ${selected.value}`);
      return;
    }
    default:
      return assertNever(command);
  }
}

async function selectWorkflowTarget(
  ctx: ExtensionCommandContext,
  projectRoot: string,
  workingDirectory: string,
  action: "info" | "run",
): Promise<{ name: string; ref: string } | undefined> {
  let rows: ReturnType<typeof buildWorkflowCatalogModel>["current"];
  try {
    rows = buildWorkflowCatalogModel(projectRoot, workingDirectory).current.slice(0, WORKFLOW_MENU_OPTION_LIMIT);
  } catch (error) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        `Workflow catalog could not be opened: ${errorMessage(error)}.`,
        "No editor text was changed and no workflow was started.",
      ),
    );
    return undefined;
  }
  if (rows.length === 0) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock("No current workflow is available.", "Browse: /workflows list"),
    );
    return undefined;
  }
  const choices = workflowTargetMenuChoices(rows);
  const selected = await requestWorkflowMenuSelection(
    ctx,
    `[SELECT] Workflow to ${action}`,
    choices.map((choice) => choice.label),
  );
  if (!presentWorkflowMenuSelectionFailure(ctx, selected, `Retry /workflows ${action} <name>.`)) return undefined;
  const choice = choices.find((candidate) => candidate.label === selected.value);
  if (choice !== undefined) return { name: choice.name, ref: choice.ref };
  setOperatorWidget(
    ctx,
    "workflows",
    workflowWarningBlock("Workflow selection no longer matches the current catalog.", "Nothing was opened or started."),
  );
  return undefined;
}

function workflowInfoName(raw: string | undefined): string | undefined {
  if (raw === undefined || !raw.startsWith('"')) return raw;
  const parsed = parseWorkflowCommandToken(raw);
  return parsed?.rest === "" ? parsed.value : raw;
}

function workflowTargetMenuChoices(
  rows: ReturnType<typeof buildWorkflowCatalogModel>["current"],
): Array<{ label: string; name: string; ref: string }> {
  const used = new Set<string>();
  return rows.map((row) => {
    const base = workflowTargetMenuLabel(row.name);
    let label = base;
    let suffix = 2;
    while (used.has(label)) label = `${base} [${suffix++}]`;
    used.add(label);
    return { label, name: row.name, ref: row.target.ref };
  });
}

function workflowTargetMenuLabel(name: string): string {
  if (/^[^\s"\\\u0000-\u001f\u007f-\u009f]+$/u.test(name)) return name;
  return JSON.stringify(name).replace(
    /[\u007f-\u009f\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

async function selectWorkflowRun(
  ctx: ExtensionCommandContext,
  projectRoot: string,
  action: string,
): Promise<string | undefined> {
  const runIds = listWorkflowRunIds(projectRoot).slice(0, WORKFLOW_MENU_OPTION_LIMIT);
  if (runIds.length === 0) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock("No workflow run is available.", "Start one: /workflows run"),
    );
    return undefined;
  }
  const selected = await requestWorkflowMenuSelection(ctx, `[SELECT] Workflow run to ${action}`, runIds);
  return presentWorkflowMenuSelectionFailure(ctx, selected, "Inspect runs: /workflows status")
    ? selected.value
    : undefined;
}

async function requestWorkflowMenuSelection(
  ctx: ExtensionCommandContext,
  title: string,
  choices: string[],
): Promise<WorkflowMenuSelection> {
  try {
    const result = await ctx.ui.select(title, choices);
    if (result === undefined) return { status: "dismissed" };
    if (typeof result !== "string") {
      return { status: "failed", message: "Workflow menu returned an unsupported selection result." };
    }
    if (result === "") return { status: "failed", message: "Workflow menu returned an empty selection." };
    const allowed = choices.includes(result);
    return allowed
      ? { status: "selected", value: result }
      : { status: "failed", message: `Workflow menu returned an unsupported selection: ${JSON.stringify(result)}.` };
  } catch (error) {
    return { status: "failed", message: `Workflow menu closed with an error: ${errorMessage(error)}.` };
  }
}

function presentWorkflowMenuSelectionFailure(
  ctx: ExtensionCommandContext,
  selection: WorkflowMenuSelection,
  recovery: string,
): selection is Extract<WorkflowMenuSelection, { status: "selected" }> {
  if (selection.status === "selected") return true;
  if (selection.status === "failed") {
    setOperatorWidget(ctx, "workflows", workflowWarningBlock(selection.message, recovery));
  }
  return false;
}

function fillWorkflowEditor(ctx: ExtensionCommandContext, command: string): void {
  if (ctx.ui.setEditorText === undefined) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        "Workflow action could not fill the editor because this Pi host does not expose setEditorText().",
        "Nothing was started or stopped; use the matching /workflows subcommand directly.",
      ),
    );
    return;
  }
  try {
    ctx.ui.setEditorText(command);
  } catch (error) {
    setOperatorWidget(
      ctx,
      "workflows",
      workflowWarningBlock(
        `Workflow action could not fill the editor: ${errorMessage(error)}.`,
        "Nothing was started or stopped.",
      ),
    );
  }
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
      return "Compatibility alias for /workflows run <name|path> [--resume <runId>] [input]: /workflow-run";
    case "stop":
      return "Compatibility alias for /workflows stop [runId|last]: /workflow-stop";
    case "list":
      return "Compatibility alias for /workflows list [query]: /workflow-list";
    case "info":
      return "Compatibility alias for /workflows info [name]: /workflow-info";
    case "status":
      return "Compatibility alias for /workflows status [runId]: /workflow-status";
    case "result":
      return "Compatibility alias for /workflows result [runId|last]: /workflow-result";
    case "continue":
      return "Compatibility alias for /workflows continue <runId> [--answer <text>]: /workflow-continue";
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
