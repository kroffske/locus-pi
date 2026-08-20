import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ToolResult } from "../_shared/host/pi-api.js";
import { errorResult, getProjectRoot, getSessionId, textResult } from "../_shared/host/pi-api.js";
import { runLoopOnce } from "./continuation-launcher.js";
import { loopRootPath, readLoopStatus, renderLoopStatus } from "./loop-continuation.js";

export type LoopAction = "start" | "until";
export type LoopSource = "goal" | "workflow";

export interface LoopStartRequest {
  action: LoopAction;
  source: LoopSource;
  runId?: string;
  prompt?: string;
  condition?: string;
  maxIterations?: number;
  maxDurationMinutes?: number;
}

export interface LoopState {
  version: 1;
  sessionId: string;
  status: "active" | "stopped";
  action: LoopAction;
  source: LoopSource;
  runId?: string;
  prompt?: string;
  condition?: string;
  iteration: number;
  maxIterations: number;
  startedAt: string;
  deadlineAt: string;
  ignoreNextSettlement: boolean;
  stopReason?: string;
}

export interface LoopController {
  status(ctx: ExtensionCommandContext): Promise<ToolResult>;
  start(ctx: ExtensionCommandContext, request: LoopStartRequest, origin: "tool" | "command"): Promise<ToolResult>;
  stop(ctx: ExtensionCommandContext, reason?: string): Promise<ToolResult>;
  handleAgentSettled(ctx: ExtensionCommandContext): Promise<void>;
}

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_MAX_DURATION_MINUTES = 30;

export function createLoopController(pi: ExtensionAPI): LoopController {
  return {
    async status(ctx) {
      const state = readState(ctx);
      if (state) return textResult(renderState(state), { owner: "loop", ...state });
      const report = await readLoopStatus(getProjectRoot(ctx));
      return textResult(renderLoopStatus(report), {
        owner: "loop",
        mode: report.mode,
        sources: report.sources,
        ...(report.recommendedSource ? { recommendedSource: report.recommendedSource } : {}),
        ...(report.recommendedSourceId ? { recommendedSourceId: report.recommendedSourceId } : {}),
      });
    },

    async start(ctx, request, origin) {
      const existing = readState(ctx);
      if (existing?.status === "active") {
        return errorResult("A loop is already active in this session. Stop it before starting another.", {
          owner: "loop",
          status: existing.status,
          iteration: existing.iteration,
        });
      }
      if (request.action === "until" && !request.condition?.trim()) {
        return errorResult("loop until requires a non-empty condition.", { owner: "loop", status: "blocked" });
      }
      if (request.source === "workflow" && !request.runId?.trim()) {
        return errorResult("A workflow loop requires runId.", { owner: "loop", status: "blocked" });
      }
      if (pi.sendMessage === undefined) {
        return errorResult("Loop cannot start because this Pi host cannot schedule a follow-up turn.", {
          owner: "loop",
          status: "blocked",
        });
      }
      const now = Date.now();
      const maxIterations = clampInteger(request.maxIterations, DEFAULT_MAX_ITERATIONS, 1, 100);
      const maxDurationMinutes = clampInteger(request.maxDurationMinutes, DEFAULT_MAX_DURATION_MINUTES, 1, 1440);
      const state: LoopState = {
        version: 1,
        sessionId: getSessionId(ctx),
        status: "active",
        action: request.action,
        source: request.source,
        ...(request.runId ? { runId: request.runId } : {}),
        ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.condition ? { condition: request.condition.trim() } : {}),
        iteration: 0,
        maxIterations,
        startedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + maxDurationMinutes * 60_000).toISOString(),
        ignoreNextSettlement: origin === "tool",
      };
      writeState(ctx, state);
      const dispatched = await dispatchNext(pi, ctx, state);
      if (dispatched.isError) return dispatched;
      return textResult(`Loop started.\n${renderState(state)}`, { owner: "loop", ...state });
    },

    async stop(ctx, reason = "explicit stop") {
      const state = readState(ctx);
      if (!state || state.status !== "active") {
        return textResult("Loop is already idle.", { owner: "loop", status: "idle" });
      }
      stopState(ctx, state, reason);
      return textResult(`Loop stopped: ${reason}`, { owner: "loop", ...state });
    },

    async handleAgentSettled(ctx) {
      const state = readState(ctx);
      if (!state || state.status !== "active") return;
      if (state.ignoreNextSettlement) {
        state.ignoreNextSettlement = false;
        writeState(ctx, state);
        return;
      }
      await dispatchNext(pi, ctx, state);
    },
  };
}

async function dispatchNext(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: LoopState): Promise<ToolResult> {
  if (state.iteration >= state.maxIterations) return stopWithError(ctx, state, "maximum iteration limit reached");
  if (Date.now() >= Date.parse(state.deadlineAt)) return stopWithError(ctx, state, "maximum duration reached");
  if (pi.sendMessage === undefined) return stopWithError(ctx, state, "follow-up delivery became unavailable");

  const prepared = await runLoopOnce(pi, ctx, state.source, state.runId, state.prompt);
  if (prepared.isError) return stopWithError(ctx, state, firstText(prepared));
  const prompt = prepared.details?.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return stopWithError(ctx, state, "continuation source returned no prompt");
  }
  const nextIteration = state.iteration + 1;
  const control = [
    `LOOP CONTROL: iteration ${nextIteration}/${state.maxIterations}. Perform one bounded continuation step.`,
    state.condition ? `Stop condition: ${state.condition}` : "Stop when the source objective is complete.",
    'If the objective or stop condition is satisfied, call loop with {"action":"stop","reason":"condition satisfied"} before ending this turn.',
    "If it is not satisfied, do not start another loop and do not call stop; the controller will schedule the next turn.",
  ].join("\n");
  try {
    await pi.sendMessage(
      {
        customType: "locus-loop-continuation",
        content: `${control}\n\n${prompt}`,
        display: false,
        details: { iteration: nextIteration, maxIterations: state.maxIterations, source: state.source },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  } catch (error) {
    return stopWithError(
      ctx,
      state,
      `follow-up delivery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  state.iteration = nextIteration;
  writeState(ctx, state);
  return textResult(`Loop continuation ${nextIteration}/${state.maxIterations} scheduled.`, {
    owner: "loop",
    ...state,
  });
}

function stopWithError(ctx: ExtensionCommandContext, state: LoopState, reason: string): ToolResult {
  stopState(ctx, state, reason);
  return errorResult(`Loop stopped: ${reason}`, { owner: "loop", ...state });
}

function stopState(ctx: ExtensionCommandContext, state: LoopState, reason: string): void {
  state.status = "stopped";
  state.stopReason = reason;
  state.ignoreNextSettlement = false;
  writeState(ctx, state);
}

function statePath(ctx: ExtensionCommandContext): string {
  const safeSessionId = getSessionId(ctx).replace(/[^a-zA-Z0-9._-]+/gu, "_");
  return path.join(loopRootPath(getProjectRoot(ctx)), "sessions", `${safeSessionId}.json`);
}

function readState(ctx: ExtensionCommandContext): LoopState | undefined {
  try {
    return JSON.parse(readFileSync(statePath(ctx), "utf8")) as LoopState;
  } catch {
    return undefined;
  }
}

function writeState(ctx: ExtensionCommandContext, state: LoopState): void {
  const target = statePath(ctx);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value!));
}

function renderState(state: LoopState): string {
  return [
    `status: ${state.status}`,
    `source: ${state.source}`,
    `iteration: ${state.iteration}/${state.maxIterations}`,
    `deadline: ${state.deadlineAt}`,
    ...(state.condition ? [`condition: ${state.condition}`] : []),
    ...(state.stopReason ? [`stopReason: ${state.stopReason}`] : []),
  ].join("\n");
}

function firstText(result: ToolResult): string {
  return result.content.find((part) => part.type === "text")?.text ?? "continuation source is unavailable";
}
