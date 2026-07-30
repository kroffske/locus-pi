import type { ExtensionContext } from "../_shared/host/pi-api.js";
import { getProjectRoot } from "../_shared/host/pi-api.js";
import type { WorkflowOperatorHandoffEnvelope } from "./runtime/workflow-handoff.js";
import { errorMessage } from "../_shared/host/error-text.js";
import {
  isStaleInlineOperatorInteractionError,
  type StaleInlineOperatorInteractionError,
} from "../_shared/operator/operator-interaction.js";
import {
  requestOperatorQuestion,
  type OperatorQuestionResult,
  type OperatorQuestionSpec,
} from "../_shared/operator/operator-question.js";

export interface WorkflowHandoffSelectQuestion {
  kind: "select";
  id: string;
  prompt: string;
  options: Array<{ label: string }>;
  recommended?: string;
  allowCustom?: boolean;
}

export interface WorkflowHandoffTextQuestion {
  kind: "text";
  id: string;
  prompt: string;
}

export type WorkflowHandoffQuestion = WorkflowHandoffSelectQuestion | WorkflowHandoffTextQuestion;

export interface ActionableWorkflowHandoff {
  runId: string;
  title: string;
  questions: WorkflowHandoffQuestion[];
  value: WorkflowOperatorHandoffEnvelope;
}

export type WorkflowHandoffLaunchResult =
  { status: "started"; runId?: string } | { status: "busy" | "invalid" | "failed"; message: string };

/**
 * `pending` — the questions were never answered; the pump may open them
 * unprompted. `retryable` — a continuation already consumed an answer and then
 * failed or was cancelled, so reopening is an operator decision: the same
 * questions asked again unprompted read as the run forgetting the answers it
 * already had. Absent means `pending` (older scan sources).
 */
export type WorkflowHandoffActionableState = "pending" | "retryable";

export type WorkflowHandoffScanItem =
  | { status: "actionable"; handoff: ActionableWorkflowHandoff; state?: WorkflowHandoffActionableState }
  | { status: "nonactionable"; runId: string; message: string }
  | { status: "invalid"; runId: string; message: string };

type WorkflowHandoffSelection = Extract<WorkflowHandoffScanItem, { status: "actionable" | "invalid" }>;

export interface WorkflowHandoffControllerPorts {
  /** Durable handoff evidence ordered newest-first by persisted run-start evidence,
   * with run id as the deterministic tie-breaker for exact timestamp ties. */
  scan(projectRoot: string): WorkflowHandoffScanItem[];
  read(projectRoot: string, runId: string): ActionableWorkflowHandoff | { message: string } | undefined;
  launch(
    handoff: ActionableWorkflowHandoff,
    answer: string,
    ctx: ExtensionContext,
  ): Promise<WorkflowHandoffLaunchResult>;
}

export type WorkflowHandoffPumpResult =
  | { status: "none" }
  | { status: "busy" }
  | { status: "snoozed" }
  | { status: "cancelled"; runId: string }
  | { status: "unavailable"; runId: string }
  | { status: "stale" }
  | { status: "invalid"; message: string; runId?: string }
  | { status: "started"; sourceRunId: string; runId?: string }
  | { status: "failed"; message: string; runId: string }
  /** An unprompted pump found only retryable handoffs and opened nothing; the
   *  named run is reachable through an explicit `/workflows`. Reported once per
   *  session so the notice lands beside the failed continuation, not on every
   *  later idle moment. */
  | { status: "deferred"; runId: string };

interface PumpOptions {
  explicit?: boolean;
  runId?: string;
  answer?: string;
  isCurrent?: () => boolean;
}

/**
 * Session-local projection over durable handoff truth.
 *
 * Persistence, eligibility, claims, and continuation launch stay behind the
 * ports. This owner serializes one visible prompt, remembers Escape snooze for
 * the current session, and never stores an answer after handing it to launch.
 */
export class WorkflowOperatorHandoffController {
  readonly #ports: WorkflowHandoffControllerPorts;
  #snoozed = false;
  #retryableNoticeShown = false;
  #activePump: Promise<WorkflowHandoffPumpResult> | undefined;

  constructor(ports: WorkflowHandoffControllerPorts) {
    this.#ports = ports;
  }

  startSession(): void {
    this.#snoozed = false;
    this.#retryableNoticeShown = false;
  }

  shutdown(): void {
    this.#snoozed = true;
  }

  eligibleRunIds(projectRoot: string): string[] {
    return orderedScan(this.#ports.scan(projectRoot)).flatMap((item) =>
      item.status === "actionable" ? [item.handoff.runId] : [],
    );
  }

  pump(ctx: ExtensionContext, options: PumpOptions = {}): Promise<WorkflowHandoffPumpResult> {
    if (options.explicit === true) this.#snoozed = false;
    const guard = pumpGuard(ctx, options.isCurrent);
    if (guard !== "ready") return Promise.resolve({ status: guard });
    if (this.#activePump !== undefined) return Promise.resolve({ status: "busy" });
    if (this.#snoozed && options.explicit !== true) return Promise.resolve({ status: "snoozed" });

    const active = this.#pumpOnce(ctx, options)
      .catch((error): WorkflowHandoffPumpResult => ({
        status: "invalid",
        message: `Workflow handoff pump failed: ${errorMessage(error)}`,
      }))
      .finally(() => {
        if (this.#activePump === active) this.#activePump = undefined;
      });
    this.#activePump = active;
    return active;
  }

  async pumpAfterActive(ctx: ExtensionContext, options: PumpOptions = {}): Promise<WorkflowHandoffPumpResult> {
    await this.#activePump;
    return this.pump(ctx, options);
  }

  async #pumpOnce(ctx: ExtensionContext, options: PumpOptions): Promise<WorkflowHandoffPumpResult> {
    const projectRoot = getProjectRoot(ctx);
    const scan = orderedScan(this.#ports.scan(projectRoot));
    const actionableItems = scan.flatMap((item) => (item.status === "actionable" ? [item] : []));
    // Unprompted pumps open only never-answered handoffs. A retryable one — its
    // continuation consumed an answer and then failed — must not re-take the
    // editor with questions the operator already answered; it stays reachable
    // through an explicit /workflows or /workflow-continue.
    const unprompted = options.explicit !== true && options.runId === undefined;
    const candidates = unprompted
      ? actionableItems.filter((item) => (item.state ?? "pending") === "pending")
      : actionableItems;
    const actionable = candidates.map((item) => item.handoff);
    const firstInvalid = scan.find(
      (item): item is Extract<WorkflowHandoffScanItem, { status: "invalid" }> => item.status === "invalid",
    );
    if (unprompted && actionable.length === 0 && firstInvalid === undefined) {
      const retryable = actionableItems.find((item) => item.state === "retryable");
      if (retryable !== undefined && !this.#retryableNoticeShown) {
        this.#retryableNoticeShown = true;
        return { status: "deferred", runId: retryable.handoff.runId };
      }
      return { status: "none" };
    }
    const selection =
      options.runId === undefined
        ? actionable[0] === undefined
          ? firstInvalid
          : { status: "actionable" as const, handoff: actionable[0] }
        : selectedScanItem(options.runId, this.#readSelected(projectRoot, options.runId));
    if (selection === undefined) return { status: "none" };
    if (selection.status === "invalid") {
      return {
        status: "invalid",
        message: selection.message,
        runId: selection.runId,
      };
    }
    const selected = selection.handoff;
    const beforeMount = pumpGuard(ctx, options.isCurrent);
    if (beforeMount !== "ready") return { status: beforeMount };

    let answer: string | undefined;
    if (options.answer !== undefined) {
      const parsed = explicitWorkflowAnswer(selected, options.answer);
      if (!parsed.ok) return { status: "invalid", message: parsed.message, runId: selected.runId };
      answer = parsed.answer;
    } else {
      const collected = await this.#collectAnswers(ctx, selected, Math.max(1, actionable.length), options.isCurrent);
      switch (collected.status) {
        case "cancelled":
          this.#snoozed = true;
          return { status: "cancelled", runId: selected.runId };
        case "unavailable":
          return { status: "unavailable", runId: selected.runId };
        case "stale":
          return { status: "stale" };
        case "busy":
          return { status: "busy" };
        case "invalid":
          return { status: "invalid", message: collected.message, runId: selected.runId };
        case "answered":
          answer = collected.answer;
          break;
        default:
          return assertNever(collected);
      }
    }
    const beforeLaunch = pumpGuard(ctx, options.isCurrent);
    if (beforeLaunch !== "ready") return { status: beforeLaunch };
    if (answer === undefined) return { status: "invalid", message: "Workflow handoff answer is missing." };

    const launched = await this.#ports.launch(selected, answer, ctx);
    if (launched.status === "started") {
      return {
        status: "started",
        sourceRunId: selected.runId,
        ...(launched.runId === undefined ? {} : { runId: launched.runId }),
      };
    }
    if (launched.status === "busy") return { status: "busy" };
    return {
      status: launched.status,
      message: launched.message,
      runId: selected.runId,
    };
  }

  #readSelected(projectRoot: string, runId: string): ActionableWorkflowHandoff | { message: string } | undefined {
    return this.#ports.read(projectRoot, runId);
  }

  async #collectAnswers(
    ctx: ExtensionContext,
    handoff: ActionableWorkflowHandoff,
    queueLength: number,
    isCurrent: (() => boolean) | undefined,
  ): Promise<
    | { status: "answered"; answer: string }
    | { status: "busy" | "cancelled" | "unavailable" | "stale" }
    | { status: "invalid"; message: string }
  > {
    const answers: Array<{ id: string; prompt: string; answer: string }> = [];
    for (let index = 0; index < handoff.questions.length; index += 1) {
      const question = handoff.questions[index];
      if (question === undefined) {
        return { status: "invalid", message: "Workflow handoff contains an unreadable question." };
      }
      let result: OperatorQuestionResult;
      try {
        result = await requestOperatorQuestion(ctx, operatorQuestionSpec(handoff, question, index, queueLength), {
          isCurrent: () => pumpGuard(ctx, isCurrent) === "ready",
        });
      } catch (error) {
        if (isStaleInteraction(error)) {
          const guard = pumpGuard(ctx, isCurrent);
          return { status: guard === "busy" ? "busy" : "stale" };
        }
        return {
          status: "invalid",
          message: errorMessage(error),
        };
      }
      if (result.status === "cancelled") return { status: "cancelled" };
      if (result.status === "unavailable") return { status: "unavailable" };
      if (result.status !== "answered") {
        return { status: "invalid", message: "Workflow handoff question returned an unsupported navigation result." };
      }
      answers.push({ id: question.id, prompt: question.prompt, answer: result.answer });
    }
    return { status: "answered", answer: renderWorkflowAnswers(answers) };
  }
}

/**
 * Name the blocked run and the tool that blocked it. The envelope records no
 * asking agent, so this states the workflow, its run, and `awaitOperator` — and
 * never guesses a child agent.
 */
function workflowHandoffContext(handoff: ActionableWorkflowHandoff): string {
  const compact = handoff.runId.replace(/[^a-zA-Z0-9]/gu, "");
  const shortRunId = compact === "" ? handoff.runId : compact.slice(-4);
  return `workflow ${handoff.value.target.ref} · run #${shortRunId} · awaitOperator`;
}

function operatorQuestionSpec(
  handoff: ActionableWorkflowHandoff,
  question: WorkflowHandoffQuestion,
  questionIndex: number,
  queueLength: number,
): OperatorQuestionSpec {
  const questionProgress =
    handoff.questions.length === 1 ? "" : ` · Prompt ${questionIndex + 1} of ${handoff.questions.length}`;
  if (question.kind === "text") {
    return {
      subject: handoff.title,
      question: question.prompt,
      options: [],
      allowCustom: true,
      progressText: `Question 1 of ${queueLength}${questionProgress}`,
      contextText: workflowHandoffContext(handoff),
    };
  }
  return {
    subject: handoff.title,
    question: question.prompt,
    options: question.options.map((option) => ({
      label: option.label,
      value: option.label,
      ...(option.label === question.recommended ? { recommended: true } : {}),
    })),
    allowCustom: question.allowCustom === true,
    progressText: `Question 1 of ${queueLength}${questionProgress}`,
  };
}

function explicitWorkflowAnswer(
  handoff: ActionableWorkflowHandoff,
  rawAnswer: string,
): { ok: true; answer: string } | { ok: false; message: string } {
  if (handoff.questions.length !== 1) {
    return {
      ok: false,
      message: "Explicit --answer requires an actionable handoff with exactly one question.",
    };
  }
  const answer = rawAnswer.trim();
  if (answer === "") return { ok: false, message: "Explicit --answer must not be empty." };
  const question = handoff.questions[0]!;
  if (question.kind === "select") {
    const exact = question.options.some((option) => option.label === answer);
    if (!exact && question.allowCustom !== true) {
      return {
        ok: false,
        message: `Explicit answer must exactly match one declared option: ${question.options
          .map((option) => option.label)
          .join(", ")}`,
      };
    }
  }
  return { ok: true, answer };
}

function renderWorkflowAnswers(answers: Array<{ id: string; prompt: string; answer: string }>): string {
  const only = answers[0];
  if (answers.length === 1 && only !== undefined) return only.answer;
  return answers
    .flatMap((answer, index) => [
      `${index + 1}. ${answer.prompt}`,
      `   id: ${answer.id}`,
      `   answer: ${answer.answer}`,
    ])
    .join("\n");
}

function contextIsIdle(ctx: ExtensionContext): boolean {
  try {
    return ctx.isIdle();
  } catch {
    return false;
  }
}

function pumpGuard(ctx: ExtensionContext, isCurrent: (() => boolean) | undefined): "ready" | "busy" | "stale" {
  try {
    if (isCurrent?.() === false) return "stale";
  } catch {
    return "stale";
  }
  return contextIsIdle(ctx) ? "ready" : "busy";
}

function orderedScan(items: WorkflowHandoffScanItem[]): WorkflowHandoffScanItem[] {
  return [...items].reverse();
}

function selectedScanItem(
  runId: string,
  selected: ActionableWorkflowHandoff | { message: string } | undefined,
): WorkflowHandoffSelection | undefined {
  if (selected === undefined) return undefined;
  return "questions" in selected
    ? { status: "actionable", handoff: selected }
    : { status: "invalid", runId, message: selected.message };
}

function isStaleInteraction(error: unknown): error is StaleInlineOperatorInteractionError {
  return isStaleInlineOperatorInteractionError(error);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled workflow handoff result: ${String(value)}`);
}
