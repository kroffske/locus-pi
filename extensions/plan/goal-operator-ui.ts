import path from "node:path";
import type { GoalOperationResult, GoalState } from "../_shared/goal-mode.js";
import type { OperatorBlock, OperatorBadge } from "../_shared/operator-ui.js";
import { projectDisplayPath } from "../_shared/prompt-command-store.js";

interface GoalBlockOptions {
  compact?: boolean;
}

export function goalStateBlock(state: GoalState, options: GoalBlockOptions = {}): OperatorBlock {
  return {
    type: "VIEW",
    subject: "Goal state",
    primary: state.goal.objective,
    badges: [goalStatusBadge(state)],
    metadata: goalStateMetadata(state, options.compact === true),
    controls:
      options.compact === true
        ? ["Transitions: /goal help"]
        : ["Transitions: /goal help", "Prompt shelf: /goal prompt"],
  };
}

export function emptyGoalStateBlock(): OperatorBlock {
  return {
    type: "WARN",
    subject: "Goal state",
    primary: "No active goal.",
    badges: [{ text: "EMPTY", tone: "muted" }],
    controls: ["Create: /goal set <objective>", "Help: /goal help"],
  };
}

export function goalHelpBlock(lines: readonly string[], options: GoalBlockOptions = {}): OperatorBlock {
  const body = options.compact === true ? lines.slice(0, 5) : [...lines];
  const hidden = lines.length - body.length;
  return {
    type: "VIEW",
    subject: "Goal state help",
    primary: "Inspect or explicitly change the long-lived project goal.",
    body: [...body, ...(hidden > 0 ? [`(+${hidden} hidden; full help: /goal help)`] : [])],
    hint: ["/goal prompt is a different surface: the Goal prompt shelf."],
  };
}

export function goalOperationBlock(
  result: GoalOperationResult,
  projectRoot: string,
  options: GoalBlockOptions = {},
): OperatorBlock {
  if (result.continuation !== undefined) {
    return {
      type: "CHANGE",
      subject: "Goal continuation",
      primary: result.message,
      badges: [{ text: "ARTIFACT", tone: "success" }],
      metadata:
        options.compact === true
          ? [
              `path: ${projectDisplayPath(projectRoot, result.continuation.path)}`,
              `maxSteps: ${result.continuation.maxSteps}`,
              `autoDispatch: ${String(result.continuation.autoDispatch)}`,
            ]
          : [
              `goalId: ${result.continuation.goalId}`,
              `path: ${projectDisplayPath(projectRoot, result.continuation.path)}`,
              `maxSteps: ${result.continuation.maxSteps}`,
              `autoDispatch: ${String(result.continuation.autoDispatch)}`,
              `status: ${result.continuation.status}`,
              `stopReason: ${result.continuation.stopReason}`,
            ],
      hint: ["Prompt body is stored in the artifact and omitted from this receipt."],
      controls:
        options.compact === true
          ? ["Inspect state: /goal"]
          : ["Inspect state: /goal", "Inspect continuation: /loop status"],
    };
  }

  if (result.error !== undefined) {
    return {
      type: "WARN",
      subject: "Goal state",
      primary: result.message,
      body: [`error: ${result.error}`],
      ...(result.state === null ? {} : { badges: [goalStatusBadge(result.state)] }),
      ...(result.state === null ? {} : { metadata: goalStateMetadata(result.state, options.compact === true) }),
      controls: ["Inspect: /goal", "Help: /goal help"],
    };
  }

  if (result.state === null) {
    return {
      type: "WARN",
      subject: "Goal state",
      primary: result.message,
      controls: ["Create: /goal set <objective>", "Help: /goal help"],
    };
  }

  return {
    type: result.changed ? "CHANGE" : "WARN",
    subject: "Goal state",
    primary: result.message,
    badges: [goalStatusBadge(result.state)],
    metadata: [
      `objective: ${result.state.goal.objective}`,
      ...goalStateMetadata(result.state, options.compact === true),
      ...(result.completionAudit === undefined
        ? []
        : [
            `completionAudit: ${projectDisplayPath(projectRoot, path.join(projectRoot, ".locus", "runtime", "goal", "completion-audit.json"))}`,
          ]),
    ],
    controls: result.changed ? ["Inspect: /goal"] : ["Inspect: /goal", "Help: /goal help"],
  };
}

export function goalErrorBlock(error: unknown): OperatorBlock {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: "ERROR",
    subject: "Goal state",
    primary: "Goal command failed; no successful state change is claimed.",
    body: [`error: ${message}`],
    controls: ["Inspect current state: /goal", "Help: /goal help"],
  };
}

function goalStateMetadata(state: GoalState, compact = false): string[] {
  const goal = state.goal;
  if (compact) {
    return [
      `id: ${goal.id}`,
      `status: ${goal.status}`,
      `usage: ${goal.tokensUsed}${goal.tokenBudget === undefined ? " tokens" : ` / ${goal.tokenBudget} tokens`}`,
      "storage: .locus/runtime/goal/state.json",
    ];
  }
  return [
    `id: ${goal.id}`,
    `status: ${goal.status}`,
    `usage: ${goal.tokensUsed}${goal.tokenBudget === undefined ? " tokens" : ` / ${goal.tokenBudget} tokens`}`,
    `timeUsedSeconds: ${goal.timeUsedSeconds}`,
    `createdAt: ${goal.createdAt}`,
    `updatedAt: ${goal.updatedAt}`,
    ...(goal.activeSince === undefined ? [] : [`activeSince: ${goal.activeSince}`]),
    "storage: .locus/runtime/goal/state.json",
  ];
}

function goalStatusBadge(state: GoalState): OperatorBadge {
  const status = state.goal.status;
  const tone =
    status === "active"
      ? "success"
      : status === "budget-limited"
        ? "warning"
        : status === "dropped"
          ? "error"
          : "muted";
  return { text: status.toUpperCase(), tone };
}
