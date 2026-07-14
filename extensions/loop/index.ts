import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext, ToolResult } from "../_shared/pi-api.js";
import { errorResult, getCommandText, getProjectRoot, textResult } from "../_shared/pi-api.js";
import { registerCommandWithUiLifecycle, registerTransientUiCleanup } from "../_shared/command-ui.js";
import { requestOperatorInput } from "../_shared/operator-input.js";
import { clearOperatorStatus, setOperatorStatus } from "../_shared/operator-status.js";
import type { OperatorBlock } from "../_shared/operator-ui.js";
import { SETTINGS_HELP_PLACEMENT, setOperatorWidget } from "../_shared/widget-render.js";
import { validateParams } from "../_shared/validation.js";
import { buildGoalContinuationArtifact, loadGoalState, renderGoalContinuationArtifact, writeGoalContinuationArtifact } from "../_shared/goal-mode.js";
import {
  createWorkflowLoopContinuation,
  readLoopStatus,
  renderLoopStatus,
  renderGoalLoopContinuationResult,
  renderLoopWorkflowContinuationResult,
} from "../_shared/loop-continuation.js";

const LoopControlParams = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("once"),
    Type.Literal("start"),
    Type.Literal("stop"),
    Type.Literal("until"),
  ], { description: "Loop action" }),
  source: Type.Optional(Type.Union([
    Type.Literal("goal"),
    Type.Literal("workflow"),
    Type.Literal("review"),
  ], { description: "Continuation source for once" })),
  runId: Type.Optional(Type.String({ description: "Workflow run id for source=workflow", maxLength: 200 })),
  prompt: Type.Optional(Type.String({ description: "Optional bounded continuation focus", maxLength: 4000 })),
});

type LoopCommandParse =
  | { action: "input" }
  | { action: "help" }
  | { action: "status" }
  | { action: "once"; source?: string; runId?: string; prompt?: string }
  | { action: "unsupported"; value: string };

type LoopInputParse =
  | { ok: true; source: "goal"; prompt?: string }
  | { ok: true; source: "workflow"; runId: string; prompt?: string }
  | { ok: false; reason: string };

const LOOP_STATUS_ID = "loop.manual";

export default function loop(pi: ExtensionAPI): void {
  registerTransientUiCleanup(pi, "loop", (ctx) => clearOperatorStatus(ctx, LOOP_STATUS_ID));

  pi.registerTool({
    name: "loopControl",
    description: "Bounded loop continuation controller. Supports status and one manual once path; unsupported legacy actions fail closed.",
    parameters: LoopControlParams,
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(LoopControlParams, params);
      if (!valid.ok) return valid.result;
      if (valid.value.action === "status") {
        return await runLoopStatus(ctx);
      }
      if (valid.value.action === "once") {
        return await runLoopOnce(pi, ctx, valid.value.source, valid.value.runId, valid.value.prompt);
      }
      return unsupportedAction(valid.value.action);
    },
  });

  registerCommandWithUiLifecycle(pi, {
    command: "loop",
    group: "loop",
    surfaces: ["transient-widget", "status", "blocking-prompt", "artifact-write"],
    transientWidgets: ["loop"],
    transientStatuses: ["loop"],
  }, {
    description: "Prepare one bounded continuation, inspect status, or show help.",
    handler: async (args, ctx) => {
      const raw = getCommandText(args).trim();
      const parsed = parseLoopCommand(raw);
      if (parsed.action === "input") {
        await handleLoopInput(pi, ctx);
        return;
      }
      if (parsed.action === "help") {
        clearLoopStatus(ctx);
        presentLoopBlock(ctx, loopHelpBlock(), SETTINGS_HELP_PLACEMENT);
        return;
      }
      if (parsed.action === "status") {
        const report = await readLoopStatus(getProjectRoot(ctx));
        clearLoopStatus(ctx);
        presentLoopBlock(ctx, loopStatusBlock(renderLoopStatus(report)), SETTINGS_HELP_PLACEMENT);
        return;
      }
      if (parsed.action === "once") {
        const result = await runLoopOnce(pi, ctx, parsed.source, parsed.runId, parsed.prompt);
        presentLoopResult(ctx, result);
        return;
      }
      clearLoopStatus(ctx);
      presentLoopBlock(ctx, loopWarningBlock(unsupportedLoopText(parsed.value)));
    },
  });
}

async function handleLoopInput(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  let prefill = "goal ";
  let title = "[INPUT] Loop — goal [focus] | workflow <runId> [focus]";

  while (true) {
    let input: Awaited<ReturnType<typeof requestOperatorInput>>;
    try {
      input = await requestOperatorInput(ctx, {
        kind: "editor",
        title,
        prefill,
      });
    } catch (error) {
      clearLoopStatus(ctx);
      presentLoopBlock(ctx, {
        type: "ERROR",
        subject: "Loop input",
        primary: "The host input dialog returned an unsupported result.",
        metadata: [`reason: ${dialogErrorMessage(error)}`],
        hint: ["No continuation artifact was created."],
        controls: ["Use explicit syntax: /loop once goal [focus]", "Help: /loop help"],
      });
      return;
    }
    if (input.status === "unavailable") {
      clearLoopStatus(ctx);
      presentLoopBlock(ctx, {
        type: "WARN",
        subject: "Loop continuation",
        primary: "Interactive input is unavailable in this host mode.",
        hint: ["Use /loop once goal [focus] or /loop once workflow <runId> [focus]."],
        controls: ["Help: /loop help"],
      });
      return;
    }
    if (input.status === "cancelled") {
      clearLoopStatus(ctx);
      presentLoopBlock(ctx, cancelledLoopBlock());
      return;
    }

    const parsed = parseLoopInput(input.value);
    if (!parsed.ok) {
      prefill = input.value;
      title = `[WARN] Loop continuation — ${parsed.reason}`;
      continue;
    }

    presentLoopBlock(ctx, {
      type: "RUN",
      subject: "Loop continuation",
      primary: parsed.source === "goal"
        ? "Preparing one bounded goal continuation."
        : `Preparing one bounded workflow continuation for ${parsed.runId}.`,
      metadata: ["maxSteps: 1", "autoDispatch: false"],
    });
    const result = await runLoopOnce(pi, ctx, parsed.source, parsed.source === "workflow" ? parsed.runId : undefined, parsed.prompt);
    presentLoopResult(ctx, result);
    return;
  }
}

async function runLoopStatus(ctx: ExtensionCommandContext): Promise<ToolResult> {
  const report = await readLoopStatus(getProjectRoot(ctx));
  return textResult(renderLoopStatus(report), {
    owner: "loop",
    mode: report.mode,
    sources: report.sources,
    ...(report.recommendedSource !== undefined ? { recommendedSource: report.recommendedSource } : {}),
    ...(report.recommendedSourceId !== undefined ? { recommendedSourceId: report.recommendedSourceId } : {}),
  });
}

async function runLoopOnce(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  source: string | undefined,
  runId: string | undefined,
  prompt: string | undefined,
): Promise<ToolResult> {
  try {
    if (source === undefined) {
      return unsupportedOnce("missing source: use /loop once goal or /loop once workflow <runId>");
    }
    if (source === "review") {
      return unsupportedOnce("review continuation is not implemented");
    }

    const projectRoot = getProjectRoot(ctx);
    if (source === "goal") {
      const goalState = await loadGoalState(projectRoot);
      if (!goalState) return unsupportedOnce("no goal state exists; create a goal before using /loop once goal");
      if (goalState.goal.status === "complete" || goalState.goal.status === "dropped") {
        return unsupportedOnce(`goal is ${goalState.goal.status}; create a new goal before using /loop once goal`);
      }
      const artifact = buildGoalContinuationArtifact(projectRoot, goalState.goal.id, goalState.goal.objective, prompt ?? "");
      const saved = await writeGoalContinuationArtifact(projectRoot, pi, artifact);
      const text = renderGoalLoopContinuationResult(saved);
      return textResult(text, {
        owner: "loop",
        source: "goal",
        sourceId: goalState.goal.id,
        sourceStatus: goalState.goal.status,
        path: saved.path,
        autoDispatch: saved.autoDispatch,
        status: saved.status,
        stopReason: saved.stopReason,
        createdAt: saved.createdAt,
        maxSteps: saved.maxSteps,
        prompt: saved.prompt,
        goal: goalState.goal,
        goalContinuation: saved,
        sourceMetadata: {
          goalId: goalState.goal.id,
          goalStatus: goalState.goal.status,
          objective: goalState.goal.objective,
        },
      });
    }

    if (source !== "workflow") {
      return unsupportedOnce(`unsupported loop source: ${source}`);
    }
    if (runId === undefined || runId.trim() === "") {
      return unsupportedOnce("workflow continuation requires /loop once workflow <runId>");
    }
    const result = await createWorkflowLoopContinuation(projectRoot, runId, prompt ?? "");
    const text = renderLoopWorkflowContinuationResult(result);
    return textResult(text, {
      owner: "loop",
      source: "workflow",
      sourceId: runId,
      path: result.artifact.path,
      autoDispatch: result.artifact.autoDispatch,
      status: result.artifact.status,
      stopReason: result.artifact.stopReason,
      createdAt: result.artifact.createdAt,
      maxSteps: result.artifact.maxSteps,
      prompt: result.artifact.prompt,
      runStatus: result.artifact.runStatus,
      sourceSummary: result.sourceSummary,
      workflowContinuation: result.artifact,
      sourceMetadata: {
        runId,
        runStatus: result.artifact.runStatus,
        sourcePath: result.artifact.sourcePath,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unexpected loop continuation failure";
    return unsupportedOnce(`${source ?? "loop"} continuation failed: ${reason}`);
  }
}

function unsupportedAction(action: string): ToolResult {
  return errorResult(unsupportedLoopText(action), {
    owner: "loop",
    requestedAction: action,
    supportedActions: ["status", "once"],
    supportedSources: ["goal", "workflow"],
  });
}

function unsupportedOnce(reason: string): ToolResult {
  return errorResult(["Loop continuation is blocked.", reason, "Use /loop status, /loop once goal, or /loop once workflow <runId>."] .join("\n"), {
    owner: "loop",
    source: "blocked",
    reason,
    supportedSources: ["goal", "workflow"],
  });
}

function unsupportedLoopText(action: string): string {
  return [
    `Unsupported loop action: ${action}`,
    "Use /loop status or /loop once goal | /loop once workflow <runId>.",
    "Legacy auto-run actions remain disabled.",
  ].join("\n");
}

function parseLoopCommand(raw: string): LoopCommandParse {
  const trimmed = raw.trim();
  if (trimmed === "") return { action: "input" };
  if (trimmed === "status") return { action: "status" };
  if (trimmed === "help" || trimmed === "?") return { action: "help" };
  const [action, ...rest] = trimmed.split(/\s+/);
  if (action !== "once") return { action: "unsupported", value: action ?? "" };
  const [source, maybeRunId, ...promptParts] = rest;
  if (source === undefined) return { action: "once" };
  if (source === "workflow") {
    return {
      action: "once",
      source,
      ...(maybeRunId !== undefined ? { runId: maybeRunId } : {}),
      prompt: promptParts.join(" "),
    };
  }
  return { action: "once", source: source as "goal" | "review", prompt: [maybeRunId, ...promptParts].filter(Boolean).join(" ") };
}

function parseLoopInput(raw: string): LoopInputParse {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "enter goal or workflow source" };
  const [source, ...rest] = trimmed.split(/\s+/u);
  if (source === "goal") {
    const prompt = rest.join(" ").trim();
    return { ok: true, source: "goal", ...(prompt === "" ? {} : { prompt }) };
  }
  if (source === "workflow") {
    const [runId, ...promptParts] = rest;
    if (runId === undefined || runId.trim() === "") {
      return { ok: false, reason: "workflow requires a run id" };
    }
    const prompt = promptParts.join(" ").trim();
    return { ok: true, source: "workflow", runId, ...(prompt === "" ? {} : { prompt }) };
  }
  return { ok: false, reason: "use goal or workflow source" };
}

function clearLoopStatus(ctx: ExtensionCommandContext): void {
  ctx.ui.setStatus("loop", undefined);
  clearOperatorStatus(ctx, LOOP_STATUS_ID);
}

function presentLoopResult(ctx: ExtensionCommandContext, result: ToolResult): void {
  if (result.isError === true) {
    clearLoopStatus(ctx);
    presentLoopBlock(ctx, loopWarningBlock(firstResultText(result)));
    return;
  }

  const details = result.details ?? {};
  const source = typeof details.source === "string" ? details.source : "continuation";
  setOperatorStatus(ctx, {
    id: LOOP_STATUS_ID,
    lane: "activity",
    priority: 40,
    wide: `LOOP manual: ${source}`,
    compact: `LOOP: ${source}`,
    narrow: "LOOP",
  });
  presentLoopBlock(ctx, {
    type: "RESULT",
    subject: "Loop continuation",
    primary: "One bounded continuation is ready; it was not auto-dispatched.",
    badges: [{ text: source.toUpperCase(), tone: "accent" }],
    metadata: [
      ...(typeof details.sourceId === "string" ? [`sourceId: ${details.sourceId}`] : []),
      ...(typeof details.path === "string" ? [`path: ${details.path}`] : []),
      `maxSteps: ${String(details.maxSteps ?? 1)}`,
      `autoDispatch: ${String(details.autoDispatch ?? false)}`,
    ],
    controls: ["Inspect: /loop status"],
  });
}

function presentLoopBlock(
  ctx: ExtensionCommandContext,
  block: OperatorBlock,
  placement: "aboveEditor" | "belowEditor" = "aboveEditor",
): void {
  setOperatorWidget(ctx, "loop", block, { placement });
}

function loopStatusBlock(text: string): OperatorBlock {
  const [primary = "status unavailable", ...body] = text.split(/\r?\n/u);
  return {
    type: "VIEW",
    subject: "Loop status",
    primary,
    body,
    controls: ["Prepare one continuation: /loop", "Help: /loop help"],
  };
}

function loopHelpBlock(): OperatorBlock {
  return {
    type: "VIEW",
    subject: "Loop help",
    primary: "One manual continuation per submit; no auto-repeat.",
    body: [
      "/loop — enter source and optional focus",
      "/loop status — inspect eligible sources",
      "/loop once goal [focus]",
      "/loop once workflow <runId> [focus]",
    ],
    metadata: ["Supported sources: goal, workflow", "maxSteps: 1", "autoDispatch: false"],
  };
}

function cancelledLoopBlock(): OperatorBlock {
  return {
    type: "RESULT",
    subject: "Loop input",
    primary: "Cancelled; no continuation was created.",
    badges: [{ text: "CANCELLED", tone: "muted" }],
    controls: ["Reopen: /loop"],
  };
}

function loopWarningBlock(text: string): OperatorBlock {
  const [primary = "Loop continuation is blocked.", ...body] = text.split(/\r?\n/u);
  return {
    type: "WARN",
    subject: "Loop continuation",
    primary,
    body,
    controls: ["Inspect eligibility: /loop status", "Help: /loop help"],
  };
}

function firstResultText(result: ToolResult): string {
  return result.content.find((part) => part.type === "text")?.text ?? "Loop continuation is blocked.";
}

function dialogErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
