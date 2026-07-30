/**
 * extensions/ask-user-question/legacy-ask.ts — The `askUserQuestion` alias.
 *
 * Serves the free-text kinds itself through Pi's input/editor dialogs, and
 * converts a select/multi-select question into the OMP flow before projecting
 * the answer back into the legacy result shape — redacted by the caller's
 * declared sensitivity, and recorded as a decision exactly once.
 */

import { emitDevEvent } from "../_shared/runtime/event-bus.js";
import { recordDecision, stableDecisionId } from "../_shared/human-control.js";
import { requestOperatorInput } from "../_shared/operator/operator-input.js";
import type { ExtensionAPI, ExtensionContext, ToolResult } from "../_shared/host/pi-api.js";
import { errorResult, textResult } from "../_shared/host/pi-api.js";
import { redactForSensitivity } from "../_shared/host/redaction.js";
import { errorMessage } from "../_shared/host/error-text.js";
import type { LegacyAskParams, OmpAskParams } from "./ask-tool.js";
import { inputTitle } from "./prompt-text.js";
import type { OmpQuestion } from "./question-prompt.js";
import { askOmpCompatible } from "./question-runner.js";

export async function askLegacy(
  pi: ExtensionAPI,
  params: LegacyAskParams,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (ctx.hasUI === false || ctx.mode === "json" || ctx.mode === "print") {
    return errorResult("Ask is unavailable because this host mode cannot prompt the user.", {
      status: "unavailable",
      reason: "no-ui",
      source: "askUserQuestion",
    });
  }
  try {
    if (params.kind === "text") {
      const defaultValue = asString(params.default);
      const input = await requestOperatorInput(
        ctx,
        defaultValue === ""
          ? { kind: "input", title: inputTitle(promptWithReason(params)), placeholder: "Type a response" }
          : { kind: "editor", title: inputTitle(promptWithReason(params)), prefill: defaultValue },
      );
      if (input.status === "unavailable") {
        return errorResult("Ask is unavailable because this host mode cannot prompt the user.", {
          status: "unavailable",
          reason: "no-ui",
        });
      }
      return legacyResult(
        pi,
        ctx,
        params,
        input.status === "submitted" ? input.value : "",
        input.status === "cancelled",
        false,
      );
    }
    if (params.kind === "editor") {
      const input = await requestOperatorInput(ctx, {
        kind: "editor",
        title: inputTitle(promptWithReason(params)),
        prefill: asString(params.default),
      });
      if (input.status === "unavailable") {
        return errorResult("Ask is unavailable because this host mode cannot prompt the user.", {
          status: "unavailable",
          reason: "no-ui",
        });
      }
      return legacyResult(
        pi,
        ctx,
        params,
        input.status === "submitted" ? input.value : "",
        input.status === "cancelled",
        false,
      );
    }
  } catch (error) {
    const reason = errorMessage(error);
    return errorResult(`Ask UI failed: ${reason}`, {
      status: "error",
      source: "askUserQuestion",
      question: stableQuestionId(params.question),
    });
  }

  const recommended = recommendedIndex(params);
  const question: OmpQuestion = {
    id: stableQuestionId(params.question),
    question: promptWithReason(params),
    options: (params.options ?? []).map((label) => ({ label })),
    multi: params.kind === "multi-select",
  };
  if (recommended !== undefined) question.recommended = recommended;
  const converted: OmpAskParams = { questions: [question] };
  const result = await askOmpCompatible(pi, converted, ctx, signal, "askUserQuestion");
  if (result.isError) return result;
  const details = result.details ?? {};
  const value = params.kind === "multi-select" ? (details.selectedOptions as string[]) : firstLegacyValue(details);
  return legacyResult(pi, ctx, params, value, false, false, details.decision);
}

function promptWithReason(params: LegacyAskParams): string {
  return params.reason ? `${params.question}\n\nReason: ${params.reason}` : params.question;
}

async function legacyResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: LegacyAskParams,
  value: string | string[],
  cancelled: boolean,
  timedOut: boolean,
  existingDecision?: unknown,
): Promise<ToolResult> {
  const visibleAnswer = Array.isArray(value)
    ? value.map((item) => redactForSensitivity(item, params.sensitivity).text)
    : redactForSensitivity(value, params.sensitivity).text;
  emitDevEvent("ask:answered", { kind: params.kind, cancelled, sensitivity: params.sensitivity ?? "internal" });
  const decision =
    existingDecision ??
    (await recordDecision(pi, ctx, {
      decisionId: stableDecisionId("askUserQuestion", stableQuestionId(params.question)),
      question: params.question,
      answer: params.sensitivity === "secret" ? "[REDACTED:secret-answer]" : value,
      status: cancelled ? "cancelled" : "answered",
      source: "askUserQuestion",
      metadata: { kind: params.kind, sensitivity: params.sensitivity ?? "internal", timedOut },
    }));
  return textResult(
    cancelled
      ? "Question cancelled"
      : `Answer: ${Array.isArray(visibleAnswer) ? visibleAnswer.join(", ") : visibleAnswer}`,
    {
      questionId: stableQuestionId(params.question),
      kind: params.kind,
      value: params.sensitivity === "secret" ? undefined : value,
      visibleValue: visibleAnswer,
      cancelled,
      timedOut,
      decision,
      sensitivity: params.sensitivity ?? "internal",
    },
  );
}

function recommendedIndex(params: LegacyAskParams): number | undefined {
  const defaultValue = Array.isArray(params.default) ? params.default[0] : params.default;
  if (!defaultValue) return undefined;
  const index = (params.options ?? []).indexOf(defaultValue);
  return index >= 0 ? index : undefined;
}

function firstLegacyValue(details: Record<string, unknown>): string {
  const selected = details.selectedOptions;
  if (Array.isArray(selected) && typeof selected[0] === "string") return selected[0];
  return typeof details.customInput === "string" ? details.customInput : "";
}

function asString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

function stableQuestionId(question: string): string {
  let hash = 2166136261;
  for (let index = 0; index < question.length; index += 1) {
    hash ^= question.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `q_${(hash >>> 0).toString(16)}`;
}
