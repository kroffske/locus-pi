/**
 * extensions/ask-user-question/ask-tool.ts — The two ask tool declarations.
 *
 * What each tool accepts (the TypeBox schema and its TypeScript mirror, kept
 * side by side so a schema edit cannot drift from the type the flow reads) and
 * how each is registered. The answering itself lives in `question-runner.ts`
 * and `legacy-ask.ts`; redrawing an answered question lives in
 * `result-card.ts`.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { validateParams } from "../_shared/host/validation.js";
import { askLegacy } from "./legacy-ask.js";
import type { OmpQuestion } from "./question-prompt.js";
import { askOmpCompatible } from "./question-runner.js";
import { renderAskResult } from "./result-card.js";

const OmpAskOption = Type.Object({
  label: Type.String({ description: "display label" }),
});

const OmpAskQuestion = Type.Object({
  id: Type.String({ description: "question id" }),
  question: Type.String({ description: "question text" }),
  options: Type.Array(OmpAskOption, { description: "available options" }),
  multi: Type.Optional(Type.Boolean({ description: "allow multiple selections" })),
  recommended: Type.Optional(Type.Number({ description: "recommended option index" })),
});

const OmpAskParams = Type.Object({
  questions: Type.Array(OmpAskQuestion, { minItems: 1, description: "questions to ask" }),
});

const LegacyAskUserQuestionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user", maxLength: 500 }),
  kind: Type.Union(
    [Type.Literal("select"), Type.Literal("multi-select"), Type.Literal("text"), Type.Literal("editor")],
    { description: "UI control type" },
  ),
  options: Type.Optional(
    Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20, description: "Choices for select/multi-select" }),
  ),
  allowCustom: Type.Optional(Type.Boolean({ default: false, description: "Allow a custom answer" })),
  default: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  timeoutMs: Type.Optional(
    Type.Number({ default: 30000, minimum: 1000, maximum: 300000, description: "Auto-cancel after this many ms" }),
  ),
  sensitivity: Type.Optional(
    Type.Union([Type.Literal("public"), Type.Literal("internal"), Type.Literal("secret")], { default: "internal" }),
  ),
  reason: Type.Optional(Type.String({ description: "Why this question is being asked", maxLength: 500 })),
});

export type LegacyAskKind = "select" | "multi-select" | "text" | "editor";
export interface LegacyAskParams {
  question: string;
  kind: LegacyAskKind;
  options?: string[];
  allowCustom?: boolean;
  default?: string | string[];
  timeoutMs?: number;
  sensitivity?: "public" | "internal" | "secret";
  reason?: string;
}

export interface OmpAskParams {
  questions: OmpQuestion[];
}

export function registerAskTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask",
    description: "Ask the interactive user one or more OMP-compatible option questions.",
    parameters: OmpAskParams,
    approval: "read",
    async execute(_toolCallId, params, signal, _update, ctx) {
      const valid = validateParams(OmpAskParams, params);
      if (!valid.ok) return valid.result;
      return askOmpCompatible(pi, valid.value as OmpAskParams, ctx, signal, "ask");
    },
    renderResult: renderAskResult,
  });

  pi.registerTool({
    name: "askUserQuestion",
    description: "Compatibility alias for the OMP-compatible ask tool.",
    parameters: LegacyAskUserQuestionParams,
    approval: "read",
    async execute(_toolCallId, params, signal, _update, ctx) {
      const valid = validateParams(LegacyAskUserQuestionParams, params);
      if (!valid.ok) return valid.result;
      return askLegacy(pi, valid.value as LegacyAskParams, ctx, signal);
    },
    renderResult: renderAskResult,
  });
}
