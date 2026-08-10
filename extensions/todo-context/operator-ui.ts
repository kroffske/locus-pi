/**
 * extensions/todo-context/operator-ui.ts — pure OperatorBlock builders for the
 * `/todo` surface: the state view, the Markdown export view, the saved-change
 * card, warnings, no-change results, the error card, the help card, the project
 * task resolution card, the completion-note receipt, and the count metadata they
 * share.
 *
 * No Pi handle, no ExtensionContext, no storage: every builder is a function of
 * the values it is handed, which is what makes the `/todo` wording testable.
 * The ctx-bound write of these blocks lives in `operator-surface.ts`.
 */
import type { OperatorBlock } from "../_shared/operator/operator-ui.js";
import {
  formatCurrentProjectTaskResolution,
  type CurrentProjectTaskResolution,
} from "../_shared/project/task-bridge.js";
import type { TodoPhase } from "../_shared/project/todo-state.js";
import { errorMessage } from "../_shared/host/error-text.js";
import { phasesToMarkdown } from "./markdown-checklist.js";
import { findActiveTask } from "./phase-ops.js";

export function todoCounts(phases: readonly TodoPhase[]): {
  phases: number;
  tasks: number;
  pending: number;
  inProgress: number;
  completed: number;
  abandoned: number;
} {
  const tasks = phases.flatMap((phase) => phase.tasks);
  return {
    phases: phases.length,
    tasks: tasks.length,
    pending: tasks.filter((task) => task.status === "pending").length,
    inProgress: tasks.filter((task) => task.status === "in_progress").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    abandoned: tasks.filter((task) => task.status === "abandoned").length,
  };
}

export function todoCountMetadata(phases: readonly TodoPhase[], backend?: string): string[] {
  const counts = todoCounts(phases);
  const active = findActiveTask(phases);
  return [
    `phases: ${counts.phases}`,
    `tasks: ${counts.tasks} · pending ${counts.pending} · active ${counts.inProgress} · done ${counts.completed} · dropped ${counts.abandoned}`,
    ...(active === undefined ? [] : [`activeTask: ${active}`]),
    ...(backend === undefined ? [] : [`storageBackend: ${backend}`]),
  ];
}

export function todoStateBlock(phases: TodoPhase[], backend: string, note?: string): OperatorBlock {
  if (phases.length === 0) {
    return {
      type: "WARN",
      subject: "Session todos",
      primary: "No todos. Use /todo append <task> to start one.",
      badges: [{ text: "EMPTY", tone: "muted" }],
      metadata: todoCountMetadata(phases, backend),
      ...(note === undefined ? {} : { hint: [note] }),
      controls: ["Add: /todo append <task>", "Help: /todo help"],
    };
  }
  const counts = todoCounts(phases);
  return {
    type: "VIEW",
    subject: "Session todos",
    primary: `${counts.tasks} task(s) across ${counts.phases} phase(s).`,
    badges: [
      ...(counts.inProgress > 0 ? [{ text: `${counts.inProgress} ACTIVE`, tone: "accent" as const }] : []),
      { text: backend.toUpperCase(), tone: "muted" },
    ],
    body: phasesToMarkdown(phases).trimEnd().split(/\r?\n/u),
    metadata: todoCountMetadata(phases, backend),
    ...(note === undefined ? {} : { hint: [note] }),
    controls: ["Edit: /todo edit", "Body: /todo export"],
  };
}

export function todoExportBlock(phases: TodoPhase[], backend: string): OperatorBlock {
  const counts = todoCounts(phases);
  return {
    type: "VIEW",
    subject: "Session todos export",
    primary: `Deterministic Markdown for ${counts.tasks} task(s).`,
    body: phasesToMarkdown(phases).trimEnd().split(/\r?\n/u),
    metadata: [...todoCountMetadata(phases, backend), "format: markdown"],
    controls: ["Return to summary: /todo"],
  };
}

export function todoChangeBlock(
  primary: string,
  phases: TodoPhase[],
  backend?: string,
  metadata: string[] = [],
): OperatorBlock {
  return {
    type: "CHANGE",
    subject: "Session todos",
    primary,
    badges: [{ text: "SAVED", tone: "success" }],
    metadata: [...todoCountMetadata(phases, backend), ...metadata],
    controls: ["Inspect: /todo", "Body: /todo export"],
  };
}

export function todoWarningBlock(
  primary: string,
  body: string[] = [],
  controls: string[] = ["Help: /todo help"],
): OperatorBlock {
  return {
    type: "WARN",
    subject: "Session todos",
    primary,
    body,
    controls,
  };
}

export function todoResultBlock(primary: string, metadata: string[] = [], subject = "Session todos"): OperatorBlock {
  return {
    type: "RESULT",
    subject,
    primary,
    badges: [{ text: "NO CHANGE", tone: "muted" }],
    metadata,
    controls: ["Inspect: /todo"],
  };
}

export function todoErrorBlock(error: unknown): OperatorBlock {
  const message = errorMessage(error);
  return {
    type: "ERROR",
    subject: "Session todos",
    primary: "Todo command failed; no successful change is claimed.",
    body: [`error: ${message}`],
    controls: ["Inspect current state: /todo", "Help: /todo help"],
  };
}

/**
 * The `/todo current-task` card: project task truth only, never session todos.
 */
export function projectTaskResolutionBlock(resolution: CurrentProjectTaskResolution): OperatorBlock {
  const [heading = "Current project task", ...details] = formatCurrentProjectTaskResolution(resolution).split(/\r?\n/u);
  return {
    type: resolution.ok ? "VIEW" : "WARN",
    subject: "Project task resolution",
    primary: resolution.ok ? `${heading}: ${resolution.taskId}` : resolution.message,
    body: details,
    hint: ["This resolver never reads or mutates Session todos."],
    controls: resolution.ok
      ? ["Seed explicitly: /todo from-task <task-id>"]
      : ["Inspect .tasks/index.json; no current task was inferred."],
  };
}

/**
 * The `/todo completion-note` receipt for a note Pi approved and wrote.
 *
 * `artifact` and `path` arrive already formatted so this module stays free of
 * path resolution; `task-bridge-commands.ts` owns that.
 */
export function todoCompletionNoteBlock(input: {
  taskId: string;
  phases: TodoPhase[];
  backend: string;
  artifact: string;
  path: string;
}): OperatorBlock {
  return {
    type: "CHANGE",
    subject: "Todo completion note",
    primary: `Completion note written for task ${input.taskId}.`,
    badges: [{ text: "ARTIFACT", tone: "success" }],
    metadata: [
      ...todoCountMetadata(input.phases, input.backend),
      "permission: delegated-to-pi",
      `artifact: ${input.artifact}`,
      `path: ${input.path}`,
      `target: task:${input.taskId}`,
    ],
    controls: ["Inspect session state: /todo"],
  };
}

const TODO_HELP = [
  "Usage: /todo <verb> [args]",
  "  /todo                              Show current todos",
  "  /todo edit                         Edit todos as Markdown",
  "  /todo copy                         Print todos as Markdown",
  "  /todo export                       Print deterministic Markdown only",
  "  /todo append [<phase>] <task> [;; <task> ...]  Append one or more tasks atomically",
  "  /todo run [<context...>]            Start autonomous execution of the active todo",
  "  /todo pause                         Pause autonomous execution",
  "  /todo start  <task>                Mark task in_progress",
  "  /todo from-task <task-id>          Seed session todos from an exact .tasks/index.json task",
  "  /todo current-task                 Show the unambiguous project task from .tasks/index.json",
  "  /todo completion-note --yes <task-id>  Write current session todos to .tasks/<task>/artifacts/completion-note.md",
  "  /todo done   [<task|phase>]        Mark task/phase/all completed",
  "  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
  "  /todo rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

export function todoHelpBlock(): OperatorBlock {
  return {
    type: "VIEW",
    subject: "Session todos help",
    primary: "Inspect or explicitly change session-backed todo state.",
    body: TODO_HELP.split(/\r?\n/u),
    hint: ["/todos is a different surface: the Todos prompt shelf."],
  };
}
