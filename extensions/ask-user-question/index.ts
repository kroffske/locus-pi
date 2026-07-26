import { Type } from "@sinclair/typebox";
import { Input, Text } from "@earendil-works/pi-tui";
import type { CustomUiComponent, CustomUiTui, ExtensionAPI, ExtensionContext, ToolResult } from "../_shared/pi-api.js";
import { errorResult, textResult } from "../_shared/pi-api.js";
import { requestOperatorInput } from "../_shared/operator-input.js";
import {
  isStaleInlineOperatorInteractionError,
  isSupersededInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
} from "../_shared/operator-interaction.js";
import { requestOperatorQuestion } from "../_shared/operator-question.js";
import { renderOperatorBlock, type OperatorThemeLike } from "../_shared/operator-ui.js";
import { validateParams } from "../_shared/validation.js";
import { redactForSensitivity } from "../_shared/redaction.js";
import { emitDevEvent } from "../_shared/event-bus.js";
import { recordDecision, stableDecisionId } from "../_shared/human-control.js";

const RECOMMENDED_SUFFIX = " (Recommended)";
const OTHER_OPTION = "Other (type your own)";
const DONE_OPTION = "Done selecting";
const CHECKED_PREFIX = "[x] ";
const UNCHECKED_PREFIX = "[ ] ";

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

type LegacyAskKind = "select" | "multi-select" | "text" | "editor";
interface LegacyAskParams {
  question: string;
  kind: LegacyAskKind;
  options?: string[];
  allowCustom?: boolean;
  default?: string | string[];
  timeoutMs?: number;
  sensitivity?: "public" | "internal" | "secret";
  reason?: string;
}

interface OmpQuestion {
  id: string;
  question: string;
  options: Array<{ label: string }>;
  multi?: boolean;
  recommended?: number;
}

interface OmpAskParams {
  questions: OmpQuestion[];
}

interface QuestionResult {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}

interface AskSelection {
  selectedOptions: string[];
  customInput?: string;
  cancelled: boolean;
  timedOut: boolean;
  navigation?: "back" | "forward";
}

interface AskNavigation {
  allowBack: boolean;
  allowForward: boolean;
  progressText?: string;
}

export default function askUserQuestion(pi: ExtensionAPI): void {
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

const MARK_CHOSEN = "(o)";
const MARK_UNCHOSEN = "( )";

function renderAskResult(result: ToolResult): Text {
  const details = (result.details ?? {}) as Record<string, unknown>;
  const lines: string[] = [result.isError === true ? "[ERROR] Ask" : "[RESULT] Ask"];
  if (Array.isArray(details.results)) {
    for (const entry of details.results as QuestionResult[])
      lines.push(...renderAnsweredQuestion(entry, result.isError));
  } else if (
    typeof details.question === "string" &&
    (Array.isArray(details.options) || typeof details.customInput === "string")
  ) {
    lines.push(
      ...renderAnsweredQuestion(
        {
          id: typeof details.questionId === "string" ? details.questionId : "",
          question: details.question,
          options: Array.isArray(details.options) ? (details.options as string[]) : [],
          multi: Boolean(details.multi),
          selectedOptions: Array.isArray(details.selectedOptions) ? (details.selectedOptions as string[]) : [],
          ...(typeof details.customInput === "string" ? { customInput: details.customInput } : {}),
        },
        result.isError,
      ),
    );
  } else {
    return new Text([...lines, ...firstResultText(result).split(/\r?\n/)].join("\n"), 0, 0);
  }
  const renderedLines = lines.length > 1 ? lines : [...lines, ...firstResultText(result).split(/\r?\n/)];
  return new Text(renderedLines.join("\n"), 0, 0);
}

function renderAnsweredQuestion(result: QuestionResult, isError?: boolean): string[] {
  const chosen = new Set(result.selectedOptions);
  const lines = [`Q: ${result.question}`];
  for (const option of result.options) {
    lines.push(`  ${chosen.has(option) ? MARK_CHOSEN : MARK_UNCHOSEN} ${option}`);
  }
  if (result.customInput !== undefined) lines.push(`  ${MARK_CHOSEN} (custom) ${singleLine(result.customInput)}`);
  lines.push(isError ? "  -> cancelled" : "  -> answered");
  return lines;
}

function singleLine(text: string): string {
  return text.split(/\r?\n/).join(" ").trim();
}

function firstResultText(result: ToolResult): string {
  for (const part of result.content) {
    if (part.type === "text") return part.text;
  }
  return "";
}

async function askOmpCompatible(
  pi: ExtensionAPI,
  params: OmpAskParams,
  ctx: ExtensionContext,
  signal: AbortSignal,
  source: string,
): Promise<ToolResult> {
  if (params.questions.length === 0) return errorResult("Error: questions must not be empty");
  if (ctx.hasUI === false || ctx.mode === "json" || ctx.mode === "print") {
    return errorResult("Ask is unavailable because this host mode cannot prompt the user.", {
      status: "unavailable",
      reason: "no-ui",
      source,
    });
  }
  const timeoutSetting = Number(ctx.settings?.get("ask.timeout") ?? 0);
  const timeoutMs = Number.isFinite(timeoutSetting) && timeoutSetting > 0 ? timeoutSetting * 1000 : undefined;
  const questionCount = params.questions.length;
  const resultsByIndex: Array<QuestionResult | undefined> = Array.from({ length: questionCount });
  let questionIndex = 0;

  while (questionIndex < questionCount) {
    const question = params.questions[questionIndex]!;
    const labels = question.options.map((option) => option.label);
    const title =
      questionCount > 1 ? `${question.question} (${questionIndex + 1}/${questionCount})` : question.question;
    const navigation =
      questionCount > 1
        ? { allowBack: questionIndex > 0, allowForward: true, progressText: `${questionIndex + 1}/${questionCount}` }
        : undefined;
    const askOptions: { previous?: Pick<AskSelection, "selectedOptions" | "customInput">; navigation?: AskNavigation } =
      {};
    const previous = resultsByIndex[questionIndex];
    if (previous !== undefined) askOptions.previous = previous;
    if (navigation !== undefined) askOptions.navigation = navigation;
    let selection: AskSelection;
    try {
      selection = await askSingleQuestion(
        ctx,
        { ...question, question: title },
        labels,
        Boolean(question.multi),
        timeoutMs,
        signal,
        askOptions,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Pi shows one inline surface at a time. Another prompt taking the screen
      // is normal traffic, not a broken tool: it is reported as its own
      // retryable status so the model re-asks instead of treating the question
      // as failed.
      if (isStaleInlineOperatorInteractionError(error)) {
        // Only a genuine takeover may claim one; a stale lease means this prompt
        // never reached the screen at all, and saying "ask again" to that would
        // promise a retry that fails the same way.
        const superseded = isSupersededInlineOperatorInteractionError(error);
        return errorResult(
          superseded
            ? "Ask was closed because another prompt took the screen; ask again."
            : "Ask did not reach the screen: this session's prompt surface is no longer the one that asked.",
          {
            status: superseded ? "superseded" : "stale",
            source,
            question: question.id,
          },
        );
      }
      return errorResult(`Ask UI failed: ${reason}`, {
        status: "error",
        source,
        question: question.id,
      });
    }
    if (selection.cancelled && !selection.timedOut) {
      const decision = await recordDecision(pi, ctx, {
        decisionId: stableDecisionId(source, question.id),
        question: question.question,
        status: "cancelled",
        source,
      });
      return errorResult("Ask tool was cancelled by the user", { question: question.id, decision });
    }
    resultsByIndex[questionIndex] = {
      id: question.id,
      question: question.question,
      options: labels,
      multi: Boolean(question.multi),
      selectedOptions: selection.selectedOptions,
      ...(selection.customInput !== undefined ? { customInput: selection.customInput } : {}),
    };

    if (selection.navigation === "back") {
      questionIndex = Math.max(0, questionIndex - 1);
      continue;
    }
    questionIndex += 1;
  }

  const results = resultsByIndex.map((result, index) => {
    if (result) return result;
    const question = params.questions[index]!;
    return {
      id: question.id,
      question: question.question,
      options: question.options.map((option) => option.label),
      multi: Boolean(question.multi),
      selectedOptions: [],
    };
  });

  emitDevEvent("ask:answered", { questions: questionCount });
  const decisions: unknown[] = [];
  for (const result of results) {
    decisions.push(
      await recordDecision(pi, ctx, {
        decisionId: stableDecisionId(source, result.id),
        question: result.question,
        answer: {
          selectedOptions: result.selectedOptions,
          ...(result.customInput !== undefined ? { customInput: result.customInput } : {}),
        },
        status: "answered",
        source,
        metadata: { multi: result.multi },
      }),
    );
  }
  if (results.length === 1) {
    const result = results[0]!;
    return textResult(formatSingleAnswer(result), {
      question: result.question,
      options: result.options,
      multi: result.multi,
      selectedOptions: result.selectedOptions,
      ...(result.customInput !== undefined ? { customInput: result.customInput } : {}),
      decision: decisions[0],
    });
  }
  return textResult(`User answers:\n${results.map(formatQuestionLine).join("\n")}`, { results, decisions });
}

async function askSingleQuestion(
  ctx: ExtensionContext,
  question: OmpQuestion,
  optionLabels: string[],
  multi: boolean,
  timeoutMs: number | undefined,
  signal: AbortSignal,
  options: { previous?: Pick<AskSelection, "selectedOptions" | "customInput">; navigation?: AskNavigation } = {},
): Promise<AskSelection> {
  const sharedSingleQuestionAvailable =
    ctx.mode === "rpc" || (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined);
  if (!multi && timeoutMs === undefined && sharedSingleQuestionAvailable) {
    const shared = await requestOperatorQuestion(
      ctx,
      {
        question: question.question,
        subject: "Ask",
        options: optionLabels.map((label, index) => ({
          label,
          value: label,
          ...(question.recommended === index ? { recommended: true } : {}),
        })),
        allowCustom: true,
        customLabel: OTHER_OPTION,
        customPlaceholder: "Type a custom response",
        ...(options.navigation?.progressText ? { progressText: options.navigation.progressText } : {}),
        ...(options.navigation === undefined
          ? {}
          : {
              navigation: {
                allowBack: options.navigation.allowBack,
                allowForward: options.navigation.allowForward,
              },
            }),
        ...(options.previous?.customInput !== undefined
          ? { initialAnswer: { kind: "custom" as const, answer: options.previous.customInput } }
          : options.previous?.selectedOptions[0] !== undefined
            ? { initialAnswer: { kind: "option" as const, answer: options.previous.selectedOptions[0] } }
            : {}),
      },
      { signal },
    );
    if (shared.status === "answered") {
      return shared.kind === "custom"
        ? { selectedOptions: [], customInput: shared.answer, cancelled: false, timedOut: false }
        : { selectedOptions: [shared.answer], cancelled: false, timedOut: false };
    }
    if (shared.status === "navigate") {
      return {
        selectedOptions: shared.answer?.kind === "option" ? [shared.answer.answer] : [],
        ...(shared.answer?.kind === "custom" ? { customInput: shared.answer.answer } : {}),
        cancelled: false,
        timedOut: false,
        navigation: shared.direction,
      };
    }
    return { selectedOptions: [], cancelled: true, timedOut: false };
  }
  if (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined) {
    return askQuestionWithCustomUi(ctx, question, optionLabels, multi, timeoutMs, signal, options);
  }
  if (multi) return askMultiQuestion(ctx, question, optionLabels, timeoutMs, signal);
  return askSingleSelectQuestion(ctx, question, optionLabels, timeoutMs, signal);
}

async function askSingleSelectQuestion(
  ctx: ExtensionContext,
  question: OmpQuestion,
  optionLabels: string[],
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<AskSelection> {
  const shownLabels = addRecommendedSuffix(optionLabels, question.recommended);
  const choices = [...shownLabels, OTHER_OPTION];
  const choice = await selectWithTimeout(ctx, selectTitle(question.question), choices, timeoutMs, signal);
  if (choice.timedOut) {
    return {
      selectedOptions: getAutoSelectionOnTimeout(optionLabels, question.recommended),
      cancelled: false,
      timedOut: true,
    };
  }
  if (choice.cancelled || choice.value === undefined) return { selectedOptions: [], cancelled: true, timedOut: false };
  if (choice.value === OTHER_OPTION) {
    const custom = await promptCustomInput(ctx, signal);
    return custom === undefined
      ? { selectedOptions: [], cancelled: true, timedOut: false }
      : { selectedOptions: [], customInput: custom, cancelled: false, timedOut: false };
  }
  return { selectedOptions: [stripRecommendedSuffix(choice.value)], cancelled: false, timedOut: false };
}

async function askMultiQuestion(
  ctx: ExtensionContext,
  question: OmpQuestion,
  optionLabels: string[],
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<AskSelection> {
  const selected = new Set<string>();
  while (true) {
    if (signal.aborted) return { selectedOptions: [...selected], cancelled: true, timedOut: false };
    const choices = optionLabels.map((label) => `${selected.has(label) ? CHECKED_PREFIX : UNCHECKED_PREFIX}${label}`);
    if (selected.size > 0) choices.push(DONE_OPTION);
    choices.push(OTHER_OPTION);

    const prefix = selected.size > 0 ? `(${selected.size} selected) ` : "";
    const choice = await selectWithTimeout(
      ctx,
      selectTitle(`${prefix}${question.question}`),
      choices,
      timeoutMs,
      signal,
    );
    if (choice.timedOut) {
      return {
        selectedOptions: selected.size ? [...selected] : getAutoSelectionOnTimeout(optionLabels, question.recommended),
        cancelled: false,
        timedOut: true,
      };
    }
    if (choice.cancelled || choice.value === undefined)
      return { selectedOptions: [...selected], cancelled: true, timedOut: false };
    if (choice.value === DONE_OPTION) return { selectedOptions: [...selected], cancelled: false, timedOut: false };
    if (choice.value === OTHER_OPTION) {
      const custom = await promptCustomInput(ctx, signal);
      return custom === undefined
        ? { selectedOptions: [...selected], cancelled: true, timedOut: false }
        : { selectedOptions: [], customInput: custom, cancelled: false, timedOut: false };
    }

    const label = stripCheckboxPrefix(choice.value);
    if (label === undefined) continue;
    if (selected.has(label)) selected.delete(label);
    else selected.add(label);
  }
}

interface AskQuestionComponentArgs {
  tui: CustomUiTui;
  question: OmpQuestion;
  optionLabels: string[];
  multi: boolean;
  timeoutMs: number | undefined;
  signal: AbortSignal;
  done: (result: AskSelection) => void;
  previous?: Pick<AskSelection, "selectedOptions" | "customInput">;
  navigation?: AskNavigation;
  theme?: OperatorThemeLike;
}

interface AskRenderedChoice {
  kind: "option" | "done" | "other";
  label: string;
  value?: string;
}

class AskQuestionComponent implements CustomUiComponent {
  #tui: CustomUiTui;
  #question: OmpQuestion;
  #optionLabels: string[];
  #multi: boolean;
  #timeoutMs: number | undefined;
  #signal: AbortSignal;
  #done: (result: AskSelection) => void;
  #navigation: AskNavigation | undefined;
  #theme: OperatorThemeLike | undefined;
  #selected = new Set<string>();
  #selectedValue: string | undefined;
  #customInput: string | undefined;
  #customEditor = new Input();
  #mode: "select" | "custom" = "select";
  #validationMessage: string | undefined;
  #cursorIndex = 0;
  #finished = false;
  #timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  #abortHandler: (() => void) | undefined;

  constructor(args: AskQuestionComponentArgs) {
    this.#tui = args.tui;
    this.#question = args.question;
    this.#optionLabels = args.optionLabels;
    this.#multi = args.multi;
    this.#timeoutMs = args.timeoutMs;
    this.#signal = args.signal;
    this.#done = args.done;
    this.#navigation = args.navigation;
    this.#theme = args.theme;
    this.#customInput = args.previous?.customInput;
    this.#customEditor.focused = true;
    if (this.#customInput !== undefined) this.#customEditor.setValue(this.#customInput);
    this.#customEditor.onSubmit = (value) => this.#submitCustomInput(value);
    this.#customEditor.onEscape = () => this.#cancel();

    if (this.#multi) {
      this.#selected = new Set(
        (args.previous?.selectedOptions ?? []).filter((label) => this.#optionLabels.includes(label)),
      );
    } else {
      this.#selectedValue = (args.previous?.selectedOptions ?? []).find((label) => this.#optionLabels.includes(label));
    }

    this.#cursorIndex = this.#initialCursorIndex(args.previous);
    if (this.#signal.aborted) {
      queueMicrotask(() => this.#cancel());
      return;
    }
    this.#abortHandler = () => this.#cancel();
    this.#signal.addEventListener("abort", this.#abortHandler, { once: true });
    this.#startTimeout();
  }

  render(width: number): string[] {
    const choices = this.#choices();
    this.#clampCursor(choices.length);
    const [primary = "Choose an answer", ...questionBody] = splitLines(this.#question.question);
    const body =
      this.#mode === "custom"
        ? [
            ...questionBody,
            "Type a custom response, then press Enter.",
            ...this.#customEditor.render(Math.max(1, width - 6)).map((line) => `> ${line}`),
            ...(this.#validationMessage === undefined ? [] : [this.#validationMessage]),
          ]
        : [...questionBody, ...choices.map((choice, index) => this.#renderChoice(choice, index))];
    return renderOperatorBlock(
      {
        type: this.#mode === "custom" ? "INPUT" : "SELECT",
        subject: "Ask",
        primary,
        badges: [
          ...(this.#multi ? [{ text: "MULTI", tone: "accent" as const }] : []),
          ...(this.#navigation?.progressText ? [{ text: this.#navigation.progressText, tone: "muted" as const }] : []),
        ],
        body,
        controls: [this.#renderHelp()],
      },
      width,
      this.#theme,
    );
  }

  async handleInput(data: string): Promise<void> {
    if (this.#finished) return;
    if (this.#mode === "custom") {
      this.#validationMessage = undefined;
      this.#customEditor.handleInput(data);
      this.#requestRender();
      return;
    }
    if (isEscape(data) || isCtrlC(data)) {
      this.#cancel();
      return;
    }
    if (this.#navigation?.allowBack && isLeft(data)) {
      this.#finishCurrentState("back");
      return;
    }
    if (this.#navigation?.allowForward && isRight(data)) {
      this.#finishCurrentState("forward");
      return;
    }
    if (isHome(data)) {
      this.#cursorIndex = 0;
      this.#requestRender();
      return;
    }
    if (isEnd(data)) {
      this.#cursorIndex = Math.max(0, this.#choices().length - 1);
      this.#requestRender();
      return;
    }
    if (isUp(data)) {
      this.#moveCursor(-1);
      return;
    }
    if (isDown(data)) {
      this.#moveCursor(1);
      return;
    }
    if (isEnter(data) || isSpace(data)) {
      await this.#activateCurrentChoice();
    }
  }

  invalidate(): void {
    this.#customEditor.invalidate();
  }

  #choices(): AskRenderedChoice[] {
    if (this.#multi) {
      const choices: AskRenderedChoice[] = this.#optionLabels.map((label) => ({
        kind: "option" as const,
        label,
        value: label,
      }));
      if (this.#selected.size > 0) choices.push({ kind: "done" as const, label: DONE_OPTION });
      choices.push({ kind: "other" as const, label: OTHER_OPTION });
      return choices;
    }
    const shownLabels = addRecommendedSuffix(this.#optionLabels, this.#question.recommended);
    return [
      ...shownLabels.map((label, index) => ({ kind: "option" as const, label, value: this.#optionLabels[index]! })),
      { kind: "other" as const, label: OTHER_OPTION },
    ];
  }

  #renderChoice(choice: AskRenderedChoice, index: number): string {
    const prefix = index === this.#cursorIndex ? "> " : "  ";
    if (choice.kind === "option") {
      if (this.#multi) {
        return `${prefix}${this.#selected.has(choice.value!) ? CHECKED_PREFIX : UNCHECKED_PREFIX}${choice.label}`;
      }
      return `${prefix}${choice.label}`;
    }
    if (choice.kind === "done") return `${prefix}${DONE_OPTION}`;
    return `${prefix}${OTHER_OPTION}`;
  }

  #renderHelp(): string {
    if (this.#mode === "custom") return "enter submit | esc cancel";
    if (this.#navigation !== undefined) {
      return this.#multi
        ? "up/down move | space toggle | enter Done | left/right prev-next | esc cancel"
        : "up/down move | enter select | left/right prev-next | esc cancel";
    }
    return this.#multi
      ? "up/down move | enter/space toggle | enter Done | esc cancel"
      : "up/down move | enter select | esc cancel";
  }

  #initialCursorIndex(previous: Pick<AskSelection, "selectedOptions" | "customInput"> | undefined): number {
    if (previous?.customInput !== undefined) {
      return Math.max(
        0,
        this.#choices().findIndex((choice) => choice.kind === "other"),
      );
    }
    const selectedValue = previous?.selectedOptions.find((label) => this.#optionLabels.includes(label));
    if (selectedValue !== undefined) {
      const index = this.#optionLabels.indexOf(selectedValue);
      if (index >= 0) return index;
    }
    if (
      typeof this.#question.recommended === "number" &&
      this.#question.recommended >= 0 &&
      this.#question.recommended < this.#optionLabels.length
    ) {
      return this.#question.recommended;
    }
    return 0;
  }

  #currentResultBase(): Pick<AskSelection, "selectedOptions" | "customInput"> {
    if (this.#multi) {
      const result: Pick<AskSelection, "selectedOptions" | "customInput"> = { selectedOptions: [...this.#selected] };
      if (this.#customInput !== undefined) result.customInput = this.#customInput;
      return result;
    }
    const result: Pick<AskSelection, "selectedOptions" | "customInput"> = {
      selectedOptions: this.#selectedValue !== undefined ? [this.#selectedValue] : [],
    };
    if (this.#customInput !== undefined) result.customInput = this.#customInput;
    return result;
  }

  #moveCursor(delta: number): void {
    const choices = this.#choices();
    if (choices.length === 0) return;
    this.#cursorIndex = (this.#cursorIndex + delta + choices.length) % choices.length;
    this.#requestRender();
  }

  #clampCursor(length: number): void {
    if (length <= 0) {
      this.#cursorIndex = 0;
      return;
    }
    this.#cursorIndex = Math.max(0, Math.min(this.#cursorIndex, length - 1));
  }

  #currentChoice(): AskRenderedChoice | undefined {
    const choices = this.#choices();
    this.#clampCursor(choices.length);
    return choices[this.#cursorIndex];
  }

  async #activateCurrentChoice(): Promise<void> {
    const choice = this.#currentChoice();
    if (!choice) return;
    if (choice.kind === "done") {
      this.#finishCurrentState();
      return;
    }
    if (choice.kind === "other") {
      this.#openCustomInput();
      return;
    }
    if (this.#multi) {
      if (this.#customInput !== undefined) this.#customInput = undefined;
      if (this.#selected.has(choice.value!)) this.#selected.delete(choice.value!);
      else this.#selected.add(choice.value!);
      this.#clampCursor(this.#choices().length);
      this.#requestRender();
      return;
    }
    this.#selectedValue = choice.value!;
    this.#customInput = undefined;
    this.#finishCurrentState();
  }

  #openCustomInput(): void {
    this.#clearTimeout();
    this.#mode = "custom";
    this.#validationMessage = undefined;
    if (this.#customInput !== undefined) {
      this.#customEditor.setValue(this.#customInput);
    }
  }

  #submitCustomInput(value: string): void {
    const custom = value.trim();
    if (custom === "") {
      this.#validationMessage = "Response must not be empty.";
      this.#requestRender();
      return;
    }
    if (this.#multi) this.#selected.clear();
    else this.#selectedValue = undefined;
    this.#customInput = custom;
    this.#finishCurrentState();
  }

  #finishCurrentState(navigation?: "back" | "forward", timedOut = false): void {
    const base = this.#currentResultBase();
    this.#finish({
      ...base,
      cancelled: false,
      timedOut,
      ...(navigation !== undefined ? { navigation } : {}),
    });
  }

  #handleTimeout(): void {
    if (this.#finished) return;
    const base = this.#currentResultBase();
    if (base.selectedOptions.length === 0 && base.customInput === undefined) {
      this.#finish({
        selectedOptions: getAutoSelectionOnTimeout(this.#optionLabels, this.#question.recommended),
        cancelled: false,
        timedOut: true,
      });
      return;
    }
    this.#finish({ ...base, cancelled: false, timedOut: true });
  }

  #cancel(): void {
    if (this.#finished) return;
    this.#finish({ ...this.#currentResultBase(), cancelled: true, timedOut: false });
  }

  #finish(result: AskSelection): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#clearTimeout();
    if (this.#abortHandler !== undefined) {
      this.#signal.removeEventListener("abort", this.#abortHandler);
      this.#abortHandler = undefined;
    }
    this.#done(result);
  }

  #startTimeout(): void {
    if (this.#timeoutMs === undefined || !Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) return;
    this.#timeoutHandle = setTimeout(() => this.#handleTimeout(), this.#timeoutMs);
  }

  #clearTimeout(): void {
    if (this.#timeoutHandle !== undefined) {
      clearTimeout(this.#timeoutHandle);
      this.#timeoutHandle = undefined;
    }
  }

  #requestRender(): void {
    this.#tui.requestRender();
  }
}

async function askQuestionWithCustomUi(
  ctx: ExtensionContext,
  question: OmpQuestion,
  optionLabels: string[],
  multi: boolean,
  timeoutMs: number | undefined,
  signal: AbortSignal,
  options: { previous?: Pick<AskSelection, "selectedOptions" | "customInput">; navigation?: AskNavigation } = {},
): Promise<AskSelection> {
  if (signal.aborted) {
    return {
      ...(options.previous?.selectedOptions !== undefined
        ? { selectedOptions: [...options.previous.selectedOptions] }
        : { selectedOptions: [] }),
      ...(options.previous?.customInput !== undefined ? { customInput: options.previous.customInput } : {}),
      cancelled: true,
      timedOut: false,
    };
  }
  if (ctx.ui.custom === undefined) {
    return multi
      ? askMultiQuestion(ctx, question, optionLabels, timeoutMs, signal)
      : askSingleSelectQuestion(ctx, question, optionLabels, timeoutMs, signal);
  }
  return await requestInlineOperatorInteraction<AskSelection>(ctx, (tui, theme, _keybindings, done) => {
    const resolvedTheme = operatorTheme(theme);
    return new AskQuestionComponent({
      tui,
      question,
      optionLabels,
      multi,
      timeoutMs,
      signal,
      done,
      ...(resolvedTheme === undefined ? {} : { theme: resolvedTheme }),
      ...(options.previous !== undefined ? { previous: options.previous } : {}),
      ...(options.navigation !== undefined ? { navigation: options.navigation } : {}),
    });
  });
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function isEnter(data: string): boolean {
  return data === "\r" || data === "\n";
}

function isSpace(data: string): boolean {
  return data === " ";
}

function isEscape(data: string): boolean {
  return data === "\x1b";
}

function isCtrlC(data: string): boolean {
  return data === "\x03";
}

function isUp(data: string): boolean {
  return data === "\x1b[A" || data === "\x1bOA" || data === "k";
}

function isDown(data: string): boolean {
  return data === "\x1b[B" || data === "\x1bOB" || data === "j";
}

function isRight(data: string): boolean {
  return data === "\x1b[C" || data === "\x1bOC" || data === "l";
}

function isLeft(data: string): boolean {
  return data === "\x1b[D" || data === "\x1bOD" || data === "h";
}

function isHome(data: string): boolean {
  return data === "\x1b[H" || data === "\x1bOH" || data === "g";
}

function isEnd(data: string): boolean {
  return data === "\x1b[F" || data === "\x1bOF" || data === "G";
}

async function askLegacy(
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
    const reason = error instanceof Error ? error.message : String(error);
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

async function selectWithTimeout(
  ctx: ExtensionContext,
  title: string,
  labels: string[],
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<{ value?: string; cancelled: boolean; timedOut: boolean }> {
  const select = ctx.ui.select(title, labels);
  const result = await raceWithTimeout(select, timeoutMs, signal);
  if (result.timedOut) return { cancelled: false, timedOut: true };
  if (result.aborted) return { cancelled: true, timedOut: false };
  const normalized = normalizeSelectReturn(result.value);
  if (normalized.value === undefined) return { cancelled: true, timedOut: false };
  return { value: normalized.value, cancelled: normalized.cancelled, timedOut: false };
}

async function promptCustomInput(ctx: ExtensionContext, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  if (ctx.mode === "rpc") {
    const raw = await (
      ctx.ui.input as unknown as (
        title: string,
        placeholder?: string,
        opts?: { signal?: AbortSignal },
      ) => Promise<string | undefined | { value: string; cancelled?: boolean }>
    )("[INPUT] Ask custom response", "Type a custom response", { signal });
    if (raw === undefined || typeof raw === "string") return raw;
    return raw.cancelled === true ? undefined : raw.value;
  }
  const result = await requestOperatorInput(ctx, {
    kind: "editor",
    title: "[INPUT] Ask custom response",
    prefill: "",
  });
  return result.status === "submitted" ? result.value : undefined;
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<{ value?: T; timedOut: boolean; aborted: boolean }> {
  if (signal.aborted) return { timedOut: false, aborted: true };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ value, timedOut: false, aborted: false })),
      new Promise<{ timedOut: boolean; aborted: boolean }>((resolve) => {
        if (timeoutMs !== undefined) timeout = setTimeout(() => resolve({ timedOut: true, aborted: false }), timeoutMs);
        abort = () => resolve({ timedOut: false, aborted: true });
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function normalizeSelectReturn(result: Awaited<ReturnType<ExtensionContext["ui"]["select"]>>): {
  value?: string;
  cancelled: boolean;
} {
  if (result === undefined) return { cancelled: true };
  if (typeof result === "string") return { value: result, cancelled: false };
  const value = result.value || result.label;
  return value === undefined
    ? { cancelled: result.cancelled ?? true }
    : { value, cancelled: result.cancelled ?? false };
}

function addRecommendedSuffix(labels: string[], recommendedIndex?: number): string[] {
  if (recommendedIndex === undefined || recommendedIndex < 0 || recommendedIndex >= labels.length) return labels;
  return labels.map((label, index) =>
    index === recommendedIndex && !label.endsWith(RECOMMENDED_SUFFIX) ? `${label}${RECOMMENDED_SUFFIX}` : label,
  );
}

function stripRecommendedSuffix(label: string): string {
  return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

function stripCheckboxPrefix(label: string): string | undefined {
  if (label.startsWith(CHECKED_PREFIX)) return label.slice(CHECKED_PREFIX.length);
  if (label.startsWith(UNCHECKED_PREFIX)) return label.slice(UNCHECKED_PREFIX.length);
  return undefined;
}

function getAutoSelectionOnTimeout(optionLabels: string[], recommended?: number): string[] {
  if (optionLabels.length === 0) return [];
  if (typeof recommended === "number" && recommended >= 0 && recommended < optionLabels.length)
    return [optionLabels[recommended]!];
  return [optionLabels[0]!];
}

function formatSingleAnswer(result: QuestionResult): string {
  const lines: string[] = [];
  if (result.selectedOptions.length > 0) lines.push(`User selected: ${result.selectedOptions.join(", ")}`);
  if (result.customInput !== undefined) {
    lines.push(
      result.customInput.includes("\n")
        ? `User provided custom input:\n${indentMultiline(result.customInput)}`
        : `User provided custom input: ${result.customInput}`,
    );
  }
  return lines.join("\n") || "User answered with no selection.";
}

function formatQuestionLine(result: QuestionResult): string {
  if (result.customInput !== undefined) return `${result.id}: "${result.customInput}"`;
  if (result.selectedOptions.length > 0) {
    return result.multi
      ? `${result.id}: [${result.selectedOptions.join(", ")}]`
      : `${result.id}: ${result.selectedOptions[0]}`;
  }
  return `${result.id}: (cancelled)`;
}

function indentMultiline(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
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

function selectTitle(question: string): string {
  return `[SELECT] Ask — ${singleLine(question)}`;
}

function inputTitle(question: string): string {
  return `[INPUT] Ask — ${singleLine(question)}`;
}

function operatorTheme(value: unknown): OperatorThemeLike | undefined {
  return typeof value === "object" && value !== null ? (value as OperatorThemeLike) : undefined;
}
