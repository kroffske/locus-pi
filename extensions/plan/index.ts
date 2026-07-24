import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { CommandArgs, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../_shared/pi-api.js";
import { errorResult, getCommandText, getProjectRoot, textResult } from "../_shared/pi-api.js";
import { registerCommandWithUiLifecycle } from "../_shared/command-ui.js";
import { runGoalAiDraftSession, runPlanDraftSession } from "../_shared/goal-ai-draft.js";
import { requestOperatorInput } from "../_shared/operator-input.js";
import { clearOperatorStatus, setOperatorStatus } from "../_shared/operator-status.js";
import type { OperatorBlock } from "../_shared/operator-ui.js";
import { SETTINGS_HELP_PLACEMENT, setOperatorWidget } from "../_shared/widget-render.js";
import {
  type CycleMode,
  type ModeState,
  clearModeState,
  currentCycleMode,
  isInPlanMode,
  listPlanSlugs,
  loadActiveModeState,
  loadModeState,
  makeModeAwareEditorClass,
  MODE_CYCLE,
  modeStateForCycle,
  modeStatusLabel,
  planArtifactPath,
  planModeInjectionText,
  PLAN_MODE_COLOR,
  planSlug,
  slugify,
  userPlansDir,
  writeModeState,
} from "../_shared/mode-state.js";
import {
  type GoalOperationResult,
  completeGoalState,
  createOrReplaceGoalState,
  dropGoalState,
  goalCompletionAuditPath,
  goalCompletionGuidance,
  goalContinuationPath,
  goalInjectionText,
  goalStatePath,
  writeGoalContinuationArtifact,
  isBudgetLimited,
  loadGoalState,
  pauseGoalState,
  resumeGoalState,
  renderGoalCompletionAudit,
  setGoalBudget,
  shouldInjectGoalContext,
  writeGoalState,
} from "../_shared/goal-mode.js";
import {
  PromptCommandTargetError,
  readPromptCommand,
  resolvePromptCommandTarget,
  writePromptCommand,
} from "../_shared/prompt-command-store.js";
import { validateParams } from "../_shared/validation.js";
import {
  emptyGoalStateBlock,
  goalErrorBlock,
  goalHelpBlock,
  goalOperationBlock,
  goalStateBlock,
} from "./goal-operator-ui.js";
import {
  parsePromptShelfCommand,
  promptShelfBodyBlock,
  promptShelfChangeBlock,
  promptShelfErrorBlock,
  promptShelfSummaryBlock,
  promptShelfWarningBlock,
  type PromptShelfKind,
  type PromptShelfTarget,
} from "./prompt-shelf-ui.js";

function setPlanOperatorBlock(
  ctx: ExtensionContext,
  block: OperatorBlock,
  placement?: "aboveEditor" | "belowEditor",
): void {
  setOperatorWidget(ctx, "plan", block, placement === undefined ? {} : { placement });
}

function setGoalOperatorBlock(
  ctx: ExtensionContext,
  block: OperatorBlock,
  placement?: "aboveEditor" | "belowEditor",
): void {
  setOperatorWidget(ctx, "goal", block, placement === undefined ? {} : { placement });
}

function setPromptShelfOperatorBlock(
  ctx: ExtensionContext,
  key: PromptShelfKind,
  block: OperatorBlock,
  placement?: "aboveEditor" | "belowEditor",
): void {
  setOperatorWidget(ctx, key, block, placement === undefined ? {} : { placement });
}

function cancelledInputBlock(subject: string, reopenCommand: string): OperatorBlock {
  return {
    type: "RESULT",
    subject,
    primary: "Cancelled; no state or artifact was changed.",
    badges: [{ text: "CANCELLED", tone: "muted" }],
    controls: [`Reopen: ${reopenCommand}`],
  };
}

function dialogFailureBlock(subject: string, reopenCommand: string, error: unknown): OperatorBlock {
  return {
    type: "ERROR",
    subject,
    primary: "The host input dialog returned an unsupported result.",
    metadata: [`reason: ${error instanceof Error ? error.message : String(error)}`],
    hint: ["No state or artifact was changed."],
    controls: [`Retry: ${reopenCommand}`],
  };
}

// ---------------------------------------------------------------------------
// Mode-aware UI state (status badge + input border color)
// ---------------------------------------------------------------------------

/**
 * Whether the input editor should render its plan-mode border color. Read live by
 * the mode-aware editor's border getter, so flipping it (then triggering a render
 * via setStatus) recolors the input. Module-level because it is shared between the
 * editor factory closure and the mode-change handlers.
 */
let planBorderActive = false;
/** Guards the one-time install of the mode-aware editor component. */
let editorInstalled = false;
const PLAN_MODE_STATUS_ID = "plan.mode";

type EditorBase = new (...args: any[]) => any;
type EditorBaseLoader = () => Promise<EditorBase | undefined>;

/**
 * Resolve Pi's `CustomEditor` base class at runtime. The specifier is widened to
 * `string` so tsc/bundlers do not require the host package as a dependency (it is
 * resolved by Pi's loader at runtime). Returns undefined when unavailable.
 */
const defaultEditorBaseLoader: EditorBaseLoader = async () => {
  const mod: any = await import("@earendil-works/pi-coding-agent" as string);
  return mod?.CustomEditor as EditorBase | undefined;
};
let editorBaseLoader: EditorBaseLoader = defaultEditorBaseLoader;

/** Test seam: override how the editor base class is resolved (null restores default). */
export function __setEditorBaseLoaderForTests(loader: EditorBaseLoader | null): void {
  editorBaseLoader = loader ?? defaultEditorBaseLoader;
}

/** Test seam: reset module-level mode-UI state between tests. */
export function __resetModeUiStateForTests(): void {
  planBorderActive = false;
  editorInstalled = false;
  editorBaseLoader = defaultEditorBaseLoader;
}

/**
 * Set (or clear) the mode status badge AND the input-border flag from a mode
 * state, in one place. The badge is styled via the live theme when present (plain
 * text otherwise); the border flag is read by the mode-aware editor on next render.
 */
function setModeStatus(ctx: ExtensionContext, state: ModeState | null): void {
  planBorderActive = isInPlanMode(state);
  const label = modeStatusLabel(state);
  // Clear the pre-M02 key while installed sessions migrate to the shared
  // bounded status registry.
  ctx.ui.setStatus("mode", undefined);
  if (label === undefined) {
    clearOperatorStatus(ctx, PLAN_MODE_STATUS_ID);
    return;
  }
  setOperatorStatus(ctx, {
    id: PLAN_MODE_STATUS_ID,
    lane: "route",
    priority: 60,
    wide: `MODE ${label}`,
    compact: "MODE plan",
    narrow: "PLAN",
    tone: PLAN_MODE_COLOR,
  });
}

/**
 * Install the mode-aware input editor once, so its border color tracks plan mode.
 * No-op when the UI cannot host a custom editor (non-interactive mode, missing
 * theme, or unavailable host editor base) — the default editor stays in place.
 */
async function ensureModeAwareEditor(ctx: ExtensionContext): Promise<void> {
  if (editorInstalled) return;
  if (ctx.mode !== "tui" || ctx.hasUI === false) return;
  const ui = ctx.ui;
  if (typeof ui.setEditorComponent !== "function" || !ui.theme) return;
  const theme = ui.theme;
  let Base: EditorBase | undefined;
  try {
    Base = await editorBaseLoader();
  } catch {
    return;
  }
  if (typeof Base !== "function") return;
  const planColor = (str: string) => theme.fg(PLAN_MODE_COLOR, str);
  const ModeAwareEditor = makeModeAwareEditorClass(Base, planColor, () => planBorderActive);
  ui.setEditorComponent((tui, editorTheme, keybindings) => new ModeAwareEditor(tui, editorTheme, keybindings));
  editorInstalled = true;
}

const COMMANDS: Array<{ kind: Exclude<PromptShelfKind, "goal">; description: string }> = [
  { kind: "review", description: "Review prompt shelf: summary, show/read, or set a project/explicit-task prompt." },
  { kind: "todos", description: "Todos prompt shelf: summary, show/read, or set a project/explicit-task prompt." },
];

const COMMAND_HELP = [
  "Usage:",
  "- /goal <objective>                Create or replace active goal state.",
  "- /goal set <objective>            Same as /goal <objective>.",
  "- /goal show                       Show active goal state summary.",
  "- /goal pause                      Pause active goal.",
  "- /goal resume                     Resume paused goal.",
  "- /goal drop                       Mark active goal as dropped.",
  "- /goal complete                   Mark active goal as complete.",
  "- /goal continue                   Write a bounded next-step continuation prompt.",
  "- /goal budget <N|off>             Set token budget or clear budget limit.",
  "- /goal prompt <text>              Save old goal prompt shelf.",
  "- Add --task <task-id> with /goal prompt to keep task-backed artifact explicit.",
  "- /goal show | pause | resume | drop | complete | continue | budget",
].join("\n");

const GoalToolParams = Type.Object({
  op: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("get"),
      Type.Literal("complete"),
      Type.Literal("resume"),
      Type.Literal("drop"),
    ],
    { description: "Goal tool operation" },
  ),
  objective: Type.Optional(Type.String({ description: "Goal objective for op=create", minLength: 1, maxLength: 8000 })),
  token_budget: Type.Optional(Type.Integer({ description: "Token budget for op=create", minimum: 1 })),
});

const GoalContinueParams = Type.Object({
  summary: Type.Optional(Type.String({ description: "Short completion summary", maxLength: 2000 })),
  nextStep: Type.Optional(Type.String({ description: "Bounded next step", maxLength: 2000 })),
  remainingRisks: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 10 })),
});

function goalToolApproval(args: unknown) {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  return record.op === "get" ? "read" : "write";
}

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

  pi.registerTool({
    name: "goal",
    description: "Manage local Locus goal state from models.",
    parameters: GoalToolParams,
    approval: goalToolApproval,
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(GoalToolParams, params);
      if (!valid.ok) return valid.result;

      const projectRoot = getProjectRoot(ctx);
      if (valid.value.op === "get") {
        const state = await loadGoalState(projectRoot);
        if (!state) return errorResult("No active goal state.");
        return textResult(JSON.stringify(state, null, 2), {
          goalStateSource: "local-file",
          path: goalStatePath(projectRoot),
        });
      }

      if (valid.value.op === "create") {
        if (valid.value.objective === undefined || valid.value.objective.trim().length === 0) {
          return errorResult("Goal create requires objective.");
        }
        const saved = await createOrReplaceGoalState(projectRoot, pi, valid.value.objective, valid.value.token_budget);
        if (saved.error) return errorResult(saved.error);
        if (!saved.state) return errorResult("Failed to create goal state.");
        return textResult(saved.message, {
          goal: saved.state.goal,
          path: goalStatePath(projectRoot),
          objective: saved.state.goal.objective,
          status: saved.state.goal.status,
          tokenBudget: saved.state.goal.tokenBudget,
        });
      }

      if (valid.value.op === "resume") {
        const result = await resumeGoalState(projectRoot, pi);
        return runGoalToolTransition(projectRoot, result);
      }
      if (valid.value.op === "drop") {
        const result = await dropGoalState(projectRoot, pi);
        return runGoalToolTransition(projectRoot, result);
      }
      const result = await completeGoalState(projectRoot, pi);
      return runGoalToolTransition(projectRoot, result);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Plan mode is session-explicit. A previous crash/restart/reload must not
    // silently arm planning for the next workflow or ordinary user turn.
    clearModeState(getProjectRoot(ctx));
    await ensureModeAwareEditor(ctx);
    setModeStatus(ctx, null);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const projectRoot = getProjectRoot(ctx);
    const original = _event.systemPrompt ?? "";
    let systemPrompt = original;

    const goalState = await loadGoalState(projectRoot);
    if (shouldInjectGoalContext(goalState) && goalState) {
      systemPrompt = appendSystemBlock(systemPrompt, goalInjectionText(goalState));
    }

    // v2 plan mode is BEHAVIORAL: inject a planning framing, do NOT block tools.
    const modeState = loadActiveModeState(projectRoot);
    if (isInPlanMode(modeState)) {
      systemPrompt = appendSystemBlock(systemPrompt, planModeInjectionText(modeState));
    }

    if (systemPrompt === original) return;
    return { systemPrompt };
  });
}

function appendSystemBlock(systemPrompt: string, block: string): string {
  return systemPrompt.trim() === "" ? block : `${systemPrompt}\n\n${block}`;
}

async function runGoalToolTransition(projectRoot: string, result: GoalOperationResult) {
  if (result.error)
    return errorResult(result.error, {
      goal: result.state?.goal ?? null,
      path: result.state ? goalStatePath(projectRoot) : undefined,
    });
  if (!result.state) return errorResult("No active goal state.", { path: goalStatePath(projectRoot) });
  return textResult(result.message, {
    goal: result.state.goal,
    path: goalStatePath(projectRoot),
    ...(result.completionAudit !== undefined
      ? { completionAudit: result.completionAudit, completionAuditPath: goalCompletionAuditPath(projectRoot) }
      : {}),
  });
}

function planListBlock(projectRoot: string): OperatorBlock {
  const slugs = listPlanSlugs(projectRoot);
  const plansDir = userPlansDir(projectRoot);
  return {
    type: "VIEW",
    subject: "Saved plans",
    primary: slugs.length === 0 ? "No saved plans." : `${slugs.length} saved plan(s).`,
    body: slugs,
    metadata: [`directory: ${plansDir}`],
    controls: ["Open: /plan open <slug>", "Help: /plan help"],
  };
}

const PLAN_COMMAND_HELP = [
  "Usage:",
  "  /plan <request>    Enter plan mode with a new plan.",
  "  /plan              Prompt for a request, then enter plan mode.",
  "  /plan exit         Exit plan mode.",
  "  /plan list         List saved plans.",
  "  /plan open <slug>  Load a saved plan and re-arm mode.",
  "  /plan help         Show this usage.",
];

function planHelpBlock(projectRoot: string): OperatorBlock {
  return {
    type: "VIEW",
    subject: "Plan help",
    primary: "Behavioral plan mode and saved-plan commands.",
    body: PLAN_COMMAND_HELP.slice(1),
    metadata: [`saved plans: ${listPlanSlugs(projectRoot).length}`],
    controls: ["Inspect library: /plan list"],
  };
}

async function handlePlanCommand(args: CommandArgs, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  await ensureModeAwareEditor(ctx);
  const projectRoot = getProjectRoot(ctx);
  const rawText = getCommandText(args).trim();
  const [verb, rest] = splitFirstWord(rawText);

  const activeState = loadActiveModeState(projectRoot);
  if (activeState === null) {
    const rawState = loadModeState(projectRoot);
    if (rawState !== null && rawState.mode !== null) {
      clearModeState(projectRoot);
    }
  }

  if (verb === "list") {
    setPlanOperatorBlock(ctx, planListBlock(projectRoot), SETTINGS_HELP_PLACEMENT);
    return;
  }

  if (verb === "help" || verb === "?") {
    setPlanOperatorBlock(ctx, planHelpBlock(projectRoot), SETTINGS_HELP_PLACEMENT);
    return;
  }

  if (verb === "exit") {
    const current = loadModeState(projectRoot);
    if (current !== null && isInPlanMode(current)) {
      const action = await runPlanExitDecision(ctx, pi, projectRoot);
      setPlanOperatorBlock(ctx, planExitBlock(action));
    } else {
      clearModeState(projectRoot);
      setModeStatus(ctx, null);
      setPlanOperatorBlock(ctx, {
        type: "VIEW",
        subject: "Plan mode",
        primary: "Already in default mode.",
        controls: ["Enter: /plan"],
      });
    }
    return;
  }

  if (verb === "open") {
    const slug = slugify(rest.trim());
    if (!slug || rest.trim() === "") {
      setPlanOperatorBlock(ctx, {
        type: "WARN",
        subject: "Plan open",
        primary: "A saved-plan slug is required.",
        hint: ["Usage: /plan open <slug>"],
        controls: ["Inspect library: /plan list"],
      });
      return;
    }
    const artifactPath = planArtifactPath(projectRoot, slug);
    if (!existsSync(artifactPath)) {
      const available = listPlanSlugs(projectRoot);
      setPlanOperatorBlock(ctx, {
        type: "WARN",
        subject: "Plan open",
        primary: `Plan not found: ${slug}`,
        body: available.length === 0 ? ["No saved plans are available."] : available,
        controls: ["Inspect library: /plan list"],
      });
      return;
    }
    const content = readFileSync(artifactPath, "utf8");
    writeModeState(projectRoot, {
      version: 1,
      mode: "plan",
      slug,
      activeArtifactPath: artifactPath,
      enteredAt: new Date().toISOString(),
      status: "active",
    });
    setModeStatus(ctx, loadModeState(projectRoot));
    setPlanOperatorBlock(ctx, planOpenBlock(slug, content, artifactPath));
    return;
  }

  if (verb === "") {
    let input: Awaited<ReturnType<typeof requestOperatorInput>>;
    try {
      input = await requestOperatorInput(ctx, {
        kind: "input",
        title: "[INPUT] Plan request — desired end state",
        placeholder: "Describe the state the plan should make true",
      });
    } catch (error) {
      setPlanOperatorBlock(ctx, dialogFailureBlock("Plan request", "/plan", error));
      return;
    }
    if (input.status === "unavailable") {
      setPlanOperatorBlock(ctx, {
        type: "WARN",
        subject: "Plan request",
        primary: "Interactive input is unavailable in this host mode.",
        hint: ["Provide the request directly: /plan <request>"],
        controls: ["Help: /plan help"],
      });
      return;
    }
    if (input.status === "cancelled") {
      setPlanOperatorBlock(ctx, cancelledInputBlock("Plan request", "/plan"));
      return;
    }
    const request = input.value.trim();
    if (request === "") {
      setPlanOperatorBlock(ctx, {
        type: "WARN",
        subject: "Plan request",
        primary: "The request cannot be empty.",
        controls: ["Reopen: /plan", "Help: /plan help"],
      });
      return;
    }
    await enterPlanModeWithRequest(request, ctx, pi, projectRoot);
    return;
  }

  await enterPlanModeWithRequest(rawText, ctx, pi, projectRoot);
}

/**
 * Enter plan mode for an explicit request: confirm-replace an active plan, run the
 * draft session, persist the artifact + mode state. Shared by the direct `/plan
 * <request>` path and the bare-`/plan` interactive-prompt path.
 */
async function enterPlanModeWithRequest(
  request: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  projectRoot: string,
): Promise<void> {
  const existing = loadModeState(projectRoot);
  if (existing !== null && isInPlanMode(existing)) {
    const confirmed = await ctx.ui.confirm(
      `Replace active plan '${existing.slug}'?`,
      "Entering a new plan will replace the active plan-mode reference.",
    );
    if (!confirmed) {
      setPlanOperatorBlock(ctx, {
        type: "RESULT",
        subject: "Plan request",
        primary: `Kept active plan '${existing.slug}'; no replacement was started.`,
        badges: [{ text: "CANCELLED", tone: "muted" }],
        controls: ["Exit first: /plan exit"],
      });
      return;
    }
  }

  const slug = planSlug(request);
  const artifactPath = planArtifactPath(projectRoot, slug);
  setPlanOperatorBlock(ctx, {
    type: "RUN",
    subject: "Plan draft",
    primary: "Authoring one plan in a replacement session.",
    metadata: [`slug: ${slug}`],
  });
  const result = await runPlanDraftSession(ctx, request);
  const renderCtx = result.renderContext ?? ctx;

  if (result.status === "blocked") {
    setPlanOperatorBlock(renderCtx, {
      type: "ERROR",
      subject: "Plan draft",
      primary: `Plan mode is blocked: ${result.reason}`,
      metadata: [
        "artifact: not written",
        ...(result.childSessionId === undefined ? [] : [`childSessionId: ${result.childSessionId}`]),
      ],
      controls: ["Retry after host recovery: /plan <request>"],
    });
    return;
  }

  const draft = result.draft;
  const completed = result.status === "completed" && draft !== undefined;
  const artifactContent =
    draft ?? ["# Draft plan unavailable", "", `Plan draft session ${result.status}.`, result.reason].join("\n");
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${artifactContent.trimEnd()}\n`, "utf8");

  writeModeState(projectRoot, {
    version: 1,
    mode: "plan",
    slug,
    activeArtifactPath: artifactPath,
    enteredAt: new Date().toISOString(),
    status: completed ? "active" : "draft",
  });
  setModeStatus(renderCtx, loadModeState(projectRoot));
  setPlanOperatorBlock(
    renderCtx,
    completed
      ? {
          type: "RESULT",
          subject: "Plan draft",
          primary: "Plan saved; behavioral plan mode is active.",
          badges: [{ text: "PLAN", tone: "accent" }],
          metadata: [
            `slug: ${slug}`,
            `path: ${artifactPath}`,
            ...(result.childSessionId === undefined ? [] : [`childSessionId: ${result.childSessionId}`]),
          ],
          controls: ["Exit or execute: /plan exit"],
        }
      : {
          type: "WARN",
          subject: "Plan draft",
          primary: `Draft session ${result.status}: ${result.reason}`,
          metadata: [
            `stub path: ${artifactPath}`,
            `slug: ${slug}`,
            ...(result.childSessionId === undefined ? [] : [`childSessionId: ${result.childSessionId}`]),
          ],
          hint: ["A diagnostic stub was saved; it is not a completed plan."],
          controls: ["Retry: /plan <request>"],
        },
  );
}

// ---------------------------------------------------------------------------
// Explicit /mode changes
// ---------------------------------------------------------------------------

/** Set the active mode, persist it, and update the status badge + input border. */
function applyMode(ctx: ExtensionContext, mode: CycleMode): CycleMode {
  const state = modeStateForCycle(mode);
  writeModeState(getProjectRoot(ctx), state);
  setModeStatus(ctx, state);
  return mode;
}

// ---------------------------------------------------------------------------
// Plan -> execution handoff (T-D)
// ---------------------------------------------------------------------------
// On leaving plan mode with a composed plan, ask the user what to do with it.
// The "ask the user with options" primitive is the built-in ctx.ui.select; we
// drive it from extension code (no LLM-callable tool needed for this flow).

type PlanExitAction = "plain-exit" | "kept" | "execute" | "execute-fresh" | "tweak-execute";

const PLAN_EXIT_TITLE = "Plan ready — what next?";
const PLAN_EXIT_EXECUTE = "Execute the plan (this context)";
const PLAN_EXIT_FRESH = "Execute with a fresh context (reset)";
const PLAN_EXIT_TWEAK = "Tweak, then execute";
const PLAN_EXIT_KEEP = "Keep planning";

/** Build the message that carries the saved plan into the execution turn. */
function planExecutionPrompt(content: string, amendment?: string): string {
  const lines = [
    "Execute the following plan in this project. Implement it fully — do not just re-plan or restate it.",
    "",
    "<plan>",
    content.trim(),
    "</plan>",
  ];
  if (amendment !== undefined && amendment.trim() !== "") {
    lines.push("", "Apply this amendment before executing:", amendment.trim());
  }
  lines.push("", "Begin now.");
  return lines.join("\n");
}

function planExitBlock(action: PlanExitAction): OperatorBlock {
  switch (action) {
    case "kept":
      return {
        type: "RESULT",
        subject: "Plan mode",
        primary: "Stayed in plan mode; no execution turn was queued.",
        badges: [{ text: "CANCELLED", tone: "muted" }],
        controls: ["Reopen exit choices: /plan exit"],
      };
    case "execute":
      return {
        type: "CHANGE",
        subject: "Behavioral mode",
        primary: "plan -> default; execution queued in this context.",
      };
    case "execute-fresh":
      return {
        type: "CHANGE",
        subject: "Behavioral mode",
        primary: "plan -> default; execution queued in a fresh context.",
      };
    case "tweak-execute":
      return {
        type: "CHANGE",
        subject: "Behavioral mode",
        primary: "plan -> default; amended plan queued in this context.",
      };
    default:
      return {
        type: "CHANGE",
        subject: "Behavioral mode",
        primary: "plan -> default.",
        hint: ["No execution turn was queued."],
      };
  }
}

/**
 * On leaving plan mode, offer four ways to act on the composed plan via the
 * built-in ctx.ui.select. Degrades to a plain exit (the previous behavior) when
 * there is no composed plan artifact or no interactive UI (headless/print mode).
 */
async function runPlanExitDecision(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  projectRoot: string,
): Promise<PlanExitAction> {
  const state = loadModeState(projectRoot);
  const artifactPath = state?.activeArtifactPath;
  const hasArtifact = typeof artifactPath === "string" && existsSync(artifactPath);

  if (ctx.hasUI !== true || !hasArtifact) {
    clearModeState(projectRoot);
    setModeStatus(ctx, null);
    return "plain-exit";
  }

  const content = readFileSync(artifactPath, "utf8");
  const choice = await ctx.ui.select(PLAN_EXIT_TITLE, [
    PLAN_EXIT_EXECUTE,
    PLAN_EXIT_FRESH,
    PLAN_EXIT_TWEAK,
    PLAN_EXIT_KEEP,
  ]);
  const picked = typeof choice === "string" ? choice : choice?.value;

  // Dismissed (Esc), empty, or "Keep planning" -> stay in plan mode untouched.
  if (!picked || picked === PLAN_EXIT_KEEP) return "kept";

  if (picked === PLAN_EXIT_FRESH) {
    clearModeState(projectRoot);
    setModeStatus(ctx, null);
    await ctx.newSession?.({
      withSession: async (fresh) => {
        await fresh.sendUserMessage?.(planExecutionPrompt(content), { deliverAs: "followUp" });
      },
    });
    return "execute-fresh";
  }

  let amendment: string | undefined;
  if (picked === PLAN_EXIT_TWEAK) {
    const input = await requestOperatorInput(ctx, {
      kind: "input",
      title: "[INPUT] Plan amendment",
      placeholder: "e.g. skip step 3; use Y instead of X",
    });
    if (input.status !== "submitted" || input.value.trim() === "") return "kept";
    amendment = input.value;
  }

  clearModeState(projectRoot);
  setModeStatus(ctx, null);
  await pi.sendUserMessage(planExecutionPrompt(content, amendment), { deliverAs: "followUp" });
  return picked === PLAN_EXIT_TWEAK ? "tweak-execute" : "execute";
}

function modeLine(mode: CycleMode): string {
  return mode === "plan" ? "plan (planning framing; commands & scripts allowed)" : "default (normal execution)";
}

async function handleModeCommand(args: CommandArgs, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  await ensureModeAwareEditor(ctx);
  const projectRoot = getProjectRoot(ctx);
  const [verb] = splitFirstWord(getCommandText(args));

  if (verb === "" || verb === "show") {
    const current = currentCycleMode(loadActiveModeState(projectRoot));
    setPlanOperatorBlock(ctx, modeViewBlock(current), SETTINGS_HELP_PLACEMENT);
    return;
  }

  if (verb === "plan" || verb === "default") {
    const current = currentCycleMode(loadActiveModeState(projectRoot));
    if (current === "plan" && verb === "default") {
      const action = await runPlanExitDecision(ctx, pi, projectRoot);
      setPlanOperatorBlock(ctx, planExitBlock(action));
      return;
    }
    const mode = applyMode(ctx, verb);
    setPlanOperatorBlock(ctx, modeChangeBlock(current, mode));
    return;
  }

  if (verb !== "") {
    setPlanOperatorBlock(ctx, {
      type: "WARN",
      subject: "Behavioral mode",
      primary: `Unknown mode '${verb}'.`,
      metadata: [`Supported: ${MODE_CYCLE.join(", ")}`],
      controls: ["Show current mode: /mode show", "Help: /mode [plan|default|show]"],
    });
    return;
  }
}

function modeViewBlock(mode: CycleMode): OperatorBlock {
  return {
    type: "VIEW",
    subject: "Behavioral mode",
    primary: modeLine(mode),
    metadata: [`available: ${MODE_CYCLE.join(", ")}`],
    controls: ["Change explicitly: /mode plan | /mode default"],
  };
}

function modeChangeBlock(from: CycleMode, to: CycleMode): OperatorBlock {
  if (from === to) {
    return {
      ...modeViewBlock(to),
      primary: `Mode remains ${modeLine(to)}.`,
    };
  }
  return {
    type: "CHANGE",
    subject: "Behavioral mode",
    primary: `${from} -> ${to}`,
    metadata: [modeLine(to)],
    controls: ["Inspect: /mode show"],
  };
}

async function handleGoalCommand(args: CommandArgs, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const projectRoot = getProjectRoot(ctx);
  const raw = getCommandText(args).trim();
  const [verb, rest] = splitFirstWord(raw);

  if (verb === "") {
    const state = await loadGoalState(projectRoot);
    setGoalOperatorBlock(
      ctx,
      state === null ? emptyGoalStateBlock() : goalStateBlock(state, { compact: ctx.mode !== "tui" }),
    );
    return;
  }
  if (verb === "help" || verb === "?") {
    setGoalOperatorBlock(
      ctx,
      goalHelpBlock(COMMAND_HELP.split(/\r?\n/u), { compact: ctx.mode !== "tui" }),
      SETTINGS_HELP_PLACEMENT,
    );
    return;
  }
  if (verb === "set") {
    await handleCreateGoal(rest, ctx, projectRoot, pi);
    return;
  }
  if (verb === "show") {
    const state = await loadGoalState(projectRoot);
    setGoalOperatorBlock(
      ctx,
      state === null ? emptyGoalStateBlock() : goalStateBlock(state, { compact: ctx.mode !== "tui" }),
    );
    return;
  }
  if (verb === "pause") {
    const result = await pauseGoalState(projectRoot, pi);
    setGoalOperatorBlock(ctx, goalOperationBlock(result, projectRoot, { compact: ctx.mode !== "tui" }));
    return;
  }
  if (verb === "resume") {
    const result = await resumeGoalState(projectRoot, pi);
    setGoalOperatorBlock(ctx, goalOperationBlock(result, projectRoot, { compact: ctx.mode !== "tui" }));
    return;
  }
  if (verb === "complete") {
    const result = await completeGoalState(projectRoot, pi);
    setGoalOperatorBlock(ctx, goalOperationBlock(result, projectRoot, { compact: ctx.mode !== "tui" }));
    return;
  }
  if (verb === "continue") {
    const result = await handleGoalContinue(projectRoot, rest, pi);
    setGoalOperatorBlock(ctx, goalOperationBlock(result, projectRoot, { compact: ctx.mode !== "tui" }));
    return;
  }
  if (verb === "drop") {
    const result = await dropGoalState(projectRoot, pi);
    setGoalOperatorBlock(ctx, goalOperationBlock(result, projectRoot, { compact: ctx.mode !== "tui" }));
    return;
  }
  if (verb === "budget") {
    const parsed = parseBudget(rest);
    if (!parsed.valid) {
      setGoalOperatorBlock(ctx, {
        type: "WARN",
        subject: "Goal state",
        primary: "Invalid token budget; state was not changed.",
        controls: ["Usage: /goal budget <N|off>", "Inspect: /goal"],
      });
      return;
    }
    const result = await setGoalBudget(projectRoot, pi, parsed.value);
    setGoalOperatorBlock(ctx, goalOperationBlock(result, projectRoot, { compact: ctx.mode !== "tui" }));
    return;
  }
  if (verb === "prompt") {
    await handleGoalPrompt(rest, projectRoot, ctx);
    return;
  }

  await handleCreateGoal(raw, ctx, projectRoot, pi);
}

async function handleCreateGoal(
  text: string,
  ctx: ExtensionContext,
  projectRoot: string,
  pi: ExtensionAPI,
): Promise<void> {
  const saved = await createOrReplaceGoalState(projectRoot, pi, text, undefined);
  if (
    saved.state &&
    saved.state.goal.status !== "active" &&
    saved.state.goal.tokenBudget !== undefined &&
    isBudgetLimited(saved.state, saved.state.goal)
  ) {
    saved.state.goal.status = "budget-limited";
    await writeGoalState(projectRoot, pi, saved.state);
  }
  setGoalOperatorBlock(ctx, goalOperationBlock(saved, projectRoot, { compact: ctx.mode !== "tui" }));
}

async function handleGoalContinue(projectRoot: string, raw: string, pi: ExtensionAPI): Promise<GoalOperationResult> {
  const state = await loadGoalState(projectRoot);
  if (!state) return { state: null, changed: false, message: "No goal to continue." };
  if (state.goal.status === "complete" || state.goal.status === "dropped") {
    return { state, changed: false, message: `Goal is ${state.goal.status}; continuation is disabled.` };
  }
  const result = buildGoalContinuation(state.goal.objective, raw, state.goal.id, projectRoot);
  const saved = await writeGoalContinuationArtifact(projectRoot, pi, result.continuation);
  return { state, changed: false, message: "Goal continuation saved.", continuation: saved };
}

function buildGoalContinuation(
  objective: string,
  raw: string,
  goalId: string,
  projectRoot: string,
): {
  prompt: string;
  nextStep: string;
  continuation: {
    version: 1;
    goalId: string;
    objective: string;
    path: string;
    prompt: string;
    autoDispatch: false;
    status: "manual";
    stopReason: string;
    createdAt: string;
    maxSteps: 1;
  };
} {
  const parsed = parseContinuationInput(raw);
  const nextStep = parsed.nextStep ?? "Choose one bounded next action and stop.";
  const lines = [
    "Task:",
    objective,
    "",
    "Draft goal:",
    `Continue ${goalId} with one bounded step only.`,
    "",
    "Intent:",
    parsed.summary ?? "Summarize the completion state and propose the next bounded step.",
    "",
    "Context:",
    "- Keep the next prompt short and action-oriented.",
    "- Do not auto-dispatch a child agent or model call.",
    "- Stop after one next step.",
    "",
    "Draft direction:",
    `- In scope: ${nextStep}`,
    "- Out of scope: multi-step plans, background dispatch, or hidden continuation.",
    "- Outcome type: prompt",
    "",
    "Expected result:",
    "- one bounded next prompt artifact",
    "",
    "Final result:",
    nextStep,
  ];
  const prompt = lines.join("\n");
  return {
    prompt,
    nextStep,
    continuation: {
      version: 1,
      goalId,
      objective,
      path: goalContinuationPath(projectRoot),
      prompt,
      autoDispatch: false,
      status: "manual",
      stopReason: "continuation is a bounded next prompt artifact, not auto-dispatch",
      createdAt: new Date().toISOString(),
      maxSteps: 1,
    },
  };
}

function parseContinuationInput(raw: string): { summary?: string; nextStep?: string; remainingRisks: string[] } {
  const trimmed = raw.trim();
  if (trimmed === "") return { remainingRisks: [] };
  const parts = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = parts[0];
  const nextStep = parts[1];
  const remainingRisks = parts.slice(2);
  return {
    ...(summary === undefined ? {} : { summary }),
    ...(nextStep === undefined ? {} : { nextStep }),
    remainingRisks,
  };
}

async function handleGoalPrompt(raw: string, projectRoot: string, ctx: ExtensionContext): Promise<void> {
  await handlePromptShelf("goal", raw, projectRoot, ctx);
}

function parseBudget(input: string): { valid: boolean; value: string } {
  const trimmed = input.trim();
  if (trimmed.toLowerCase() === "off") return { valid: true, value: "off" };
  if (!/^[1-9][0-9]*$/u.test(trimmed)) return { valid: false, value: "" };
  return { valid: true, value: trimmed };
}

async function handlePromptCommand(
  kind: Exclude<PromptShelfKind, "goal">,
  args: CommandArgs,
  ctx: ExtensionContext,
): Promise<void> {
  const projectRoot = getProjectRoot(ctx);
  await handlePromptShelf(kind, getCommandText(args), projectRoot, ctx);
}

async function handlePromptShelf(
  kind: PromptShelfKind,
  raw: string,
  projectRoot: string,
  ctx: ExtensionContext,
): Promise<void> {
  const parsed = parsePromptShelfCommand(raw);
  if (parsed.action.kind === "invalid") {
    setPromptShelfOperatorBlock(
      ctx,
      kind,
      promptShelfWarningBlock(kind, `Invalid prompt shelf command: ${parsed.action.message}.`, parsed.targetLabel, [
        "No artifact was read or written.",
      ]),
      "aboveEditor",
    );
    return;
  }

  let target: PromptShelfTarget;
  try {
    target = resolvePromptCommandTarget(projectRoot, kind, parsed.target) as PromptShelfTarget;
  } catch (error) {
    if (error instanceof PromptCommandTargetError) {
      setPromptShelfOperatorBlock(
        ctx,
        kind,
        promptShelfWarningBlock(kind, `${kind} prompt not saved.`, parsed.targetLabel, [
          "The explicit prompt shelf target could not be resolved.",
          error.message,
          "No project-local fallback was used.",
        ]),
        "aboveEditor",
      );
      return;
    }
    setPromptShelfOperatorBlock(ctx, kind, promptShelfErrorBlock(kind, error, parsed.targetLabel), "aboveEditor");
    return;
  }

  try {
    if (parsed.action.kind === "summary") {
      setPromptShelfOperatorBlock(ctx, kind, promptShelfSummaryBlock(kind, target, readPromptCommand(target)));
      return;
    }
    if (parsed.action.kind === "show") {
      setPromptShelfOperatorBlock(
        ctx,
        kind,
        promptShelfBodyBlock(kind, target, readPromptCommand(target), { compact: ctx.mode !== "tui" }),
      );
      return;
    }
    writePromptCommand(target, parsed.action.prompt);
    setPromptShelfOperatorBlock(ctx, kind, promptShelfChangeBlock(kind, target), "aboveEditor");
  } catch (error) {
    setPromptShelfOperatorBlock(ctx, kind, promptShelfErrorBlock(kind, error, parsed.targetLabel), "aboveEditor");
  }
}

async function handleGoalAiCommand(args: CommandArgs, ctx: ExtensionContext): Promise<void> {
  let parsed = parsePromptCommandInput(getCommandText(args));
  if (parsed.prompt === "") {
    let input: Awaited<ReturnType<typeof requestOperatorInput>>;
    try {
      input = await requestOperatorInput(ctx, {
        kind: "editor",
        title: "[INPUT] Goal AI request — describe prompt outcome",
        prefill: "",
      });
    } catch (error) {
      setOperatorWidget(ctx, "goal", dialogFailureBlock("Goal AI request", "/goal-ai", error), {
        placement: "aboveEditor",
      });
      return;
    }
    if (input.status === "unavailable") {
      setOperatorWidget(
        ctx,
        "goal",
        {
          type: "WARN",
          subject: "Goal AI request",
          primary: "Interactive input is unavailable in this host mode.",
          hint: ["Provide the request directly: /goal-ai [--task <task-id>] <request>"],
        },
        { placement: "aboveEditor" },
      );
      return;
    }
    if (input.status === "cancelled") {
      setOperatorWidget(ctx, "goal", cancelledInputBlock("Goal AI request", "/goal-ai"), { placement: "aboveEditor" });
      return;
    }
    const request = input.value.trim();
    if (request === "") {
      setOperatorWidget(
        ctx,
        "goal",
        {
          type: "WARN",
          subject: "Goal AI request",
          primary: "The request cannot be empty.",
          controls: ["Reopen: /goal-ai"],
        },
        { placement: "aboveEditor" },
      );
      return;
    }
    parsed = { ...parsed, prompt: request };
  }

  const projectRoot = getProjectRoot(ctx);
  const target = resolveGoalAiTargetOrRenderError(projectRoot, parsed.target, ctx);
  if (target === undefined) return;

  setOperatorWidget(
    ctx,
    "goal",
    {
      type: "RUN",
      subject: "Goal AI draft",
      primary: "Drafting one Locus Prompt Draft in a replacement session.",
      metadata: [`target: ${target.target}`],
    },
    { placement: "aboveEditor" },
  );
  const result = await runGoalAiDraftSession(ctx as ExtensionCommandContext, parsed.prompt);
  const renderCtx = result.renderContext ?? ctx;
  if (result.status !== "completed" || result.draft === undefined) {
    setOperatorWidget(
      renderCtx,
      "goal",
      {
        type: result.status === "cancelled" ? "WARN" : "ERROR",
        subject: "Goal AI draft",
        primary: `Draft ${result.status}: ${result.reason}`,
        metadata: [
          `target: ${target.target}`,
          "artifact: not written",
          ...(result.childSessionId === undefined ? [] : [`childSessionId: ${result.childSessionId}`]),
        ],
        controls: ["Retry: /goal-ai <request>"],
      },
      { placement: "aboveEditor" },
    );
    return;
  }

  writePromptCommand(target, result.draft);
  setOperatorWidget(
    renderCtx,
    "goal",
    {
      type: "RESULT",
      subject: "Goal AI draft",
      primary: "Draft saved as a goal prompt; it was not executed.",
      metadata: [
        `target: ${target.target}`,
        `kind: ${target.kind}`,
        promptCommandPathLine(target),
        ...(result.childSessionId === undefined ? [] : [`childSessionId: ${result.childSessionId}`]),
      ],
      controls: ["Continue explicitly: /goal continue"],
    },
    { placement: "aboveEditor" },
  );
}

function parsePromptCommandInput(text: string): {
  target: { type: "project" } | { type: "task"; taskId: string };
  prompt: string;
} {
  const trimmed = text.trim();
  const taskEquals = /^--task=([^\s]+)\s*([\s\S]*)$/u.exec(trimmed);
  if (taskEquals !== null) return { target: { type: "task", taskId: taskEquals[1]! }, prompt: taskEquals[2]!.trim() };

  const taskSeparated = /^--task\s+([^\s]+)\s*([\s\S]*)$/u.exec(trimmed);
  if (taskSeparated !== null)
    return { target: { type: "task", taskId: taskSeparated[1]! }, prompt: taskSeparated[2]!.trim() };

  return { target: { type: "project" }, prompt: trimmed };
}

function resolveGoalAiTargetOrRenderError(
  projectRoot: string,
  selector: { type: "project" } | { type: "task"; taskId: string },
  ctx: ExtensionContext,
) {
  try {
    return resolvePromptCommandTarget(projectRoot, "goal", selector);
  } catch (error) {
    const target = selector.type === "task" ? `task:${selector.taskId}` : "project-local";
    if (error instanceof PromptCommandTargetError) {
      setGoalOperatorBlock(ctx, {
        type: "ERROR",
        subject: "Goal AI target",
        primary: error.message,
        metadata: [`target: ${target}`, "kind: goal", "artifact: not written"],
        hint: ["No project-local fallback was used because the task target was explicit."],
      });
      return undefined;
    }
    setGoalOperatorBlock(ctx, {
      type: "ERROR",
      subject: "Goal AI target",
      primary: "Target resolution failed unexpectedly; no artifact was written.",
      body: [`error: ${error instanceof Error ? error.message : String(error)}`],
      metadata: [`target: ${target}`, "kind: goal"],
      controls: ["Retry: /goal-ai <request>"],
    });
    return undefined;
  }
}

type PromptCommandTarget = ReturnType<typeof resolvePromptCommandTarget>;

/** Body lines shown inline in a typed /plan preview before the "+N more" affordance. */
const PLAN_PREVIEW_MAX_LINES = 8;

/**
 * Build the typed CHANGE receipt for loading a saved plan. The preview is
 * clamped before it reaches the shared renderer so the explicit open-path
 * affordance survives its viewport budget.
 */
function planOpenBlock(slug: string, body: string, artifactPath: string): OperatorBlock {
  const bodyLines = body.replace(/\s+$/, "").split(/\r?\n/);
  const visible = bodyLines.slice(0, PLAN_PREVIEW_MAX_LINES);
  const hidden = bodyLines.length - visible.length;
  return {
    type: "CHANGE",
    subject: "Plan mode",
    primary: `Opened '${slug}'; behavioral plan mode is active.`,
    badges: [{ text: "PLAN", tone: "accent" }],
    body: visible,
    metadata: [`path: ${artifactPath}`],
    ...(hidden > 0 ? { hint: [`(+${hidden} more — open ${artifactPath})`] } : {}),
    controls: ["Exit or execute: /plan exit"],
  };
}

function promptCommandPathLine(target: PromptCommandTarget): string {
  return `path: ${compactPromptCommandPath(target)}`;
}

function compactPromptCommandPath(target: PromptCommandTarget): string {
  if (!target.target.startsWith("task:")) return target.displayPath;
  const artifactPath = /\/artifacts\/[^/]+$/u.exec(target.displayPath)?.[0];
  if (artifactPath === undefined) return target.displayPath;
  const taskId = target.target.slice("task:".length);
  return `.tasks/${taskId}${artifactPath}`;
}

function splitFirstWord(input: string): [string, string] {
  const trimmed = input.trim();
  if (!trimmed) return ["", ""];
  const match = /^(\S+)\s*([\s\S]*)$/u.exec(trimmed);
  if (!match) return ["", ""];
  return [match[1]!.toLowerCase(), match[2]!.trim()];
}
