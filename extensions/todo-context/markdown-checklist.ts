/**
 * extensions/todo-context/markdown-checklist.ts — the OMP-style Markdown
 * checklist codec: phases to deterministic Markdown for `/todo export`,
 * `/todo copy`, and the state view body, and back again for the `/todo edit`
 * round trip.
 *
 * Pure text in, pure phase data out. The blocks this Markdown is rendered into
 * are built in `operator-ui.ts`.
 */
import type { TodoPhase, TodoStatus, TodoTask } from "../_shared/todo-state.js";
import { normalizeInProgressTask } from "./phase-ops.js";

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
  pending: " ",
  in_progress: "/",
  completed: "x",
  abandoned: "-",
};

/**
 * Serialize phases to the Markdown checklist format used by `/todo export`.
 */
export function phasesToMarkdown(phases: TodoPhase[]): string {
  if (phases.length === 0) return "# Todos\n";
  const lines: string[] = [];
  for (const [index, phase] of phases.entries()) {
    if (index > 0) lines.push("");
    lines.push(`# ${phase.name}`);
    for (const task of phase.tasks) {
      lines.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}`);
      for (const [noteIndex, note] of (task.notes ?? []).entries()) {
        if (noteIndex > 0) lines.push("  >");
        for (const noteLine of note.split("\n")) lines.push(noteLine ? `  > ${noteLine}` : "  >");
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
  " ": "pending",
  "": "pending",
  x: "completed",
  X: "completed",
  "/": "in_progress",
  ">": "in_progress",
  "-": "abandoned",
  "~": "abandoned",
};

/**
 * Parse the Markdown checklist format accepted by `/todo edit`.
 */
export function markdownToPhases(markdown: string): { phases: TodoPhase[]; errors: string[] } {
  const phases: TodoPhase[] = [];
  const errors: string[] = [];
  let currentPhase: TodoPhase | undefined;
  let currentTask: TodoTask | undefined;
  let noteBuffer: string[] = [];

  const flushNote = () => {
    if (!currentTask || noteBuffer.length === 0) {
      noteBuffer = [];
      return;
    }
    while (noteBuffer[noteBuffer.length - 1] === "") noteBuffer.pop();
    if (noteBuffer.length > 0) currentTask.notes = [...(currentTask.notes ?? []), noteBuffer.join("\n")];
    noteBuffer = [];
  };

  markdown.split(/\r?\n/u).forEach((raw, index) => {
    const note = /^\s*>\s?(.*)$/u.exec(raw);
    if (note && currentTask) {
      if (note[1] === "") flushNote();
      else noteBuffer.push(note[1] ?? "");
      return;
    }
    const trimmed = raw.trim();
    if (!trimmed) return;

    const heading = /^#{1,6}\s+(.+?)\s*$/u.exec(trimmed);
    if (heading) {
      flushNote();
      currentTask = undefined;
      currentPhase = { name: heading[1]!.trim(), tasks: [] };
      phases.push(currentPhase);
      return;
    }

    const task = /^[-*+]\s*\[(.?)\]\s+(.+?)\s*$/u.exec(trimmed);
    if (task) {
      flushNote();
      currentPhase ??= { name: "Todos", tasks: [] };
      if (!phases.includes(currentPhase)) phases.push(currentPhase);
      const status = MARKER_TO_STATUS[task[1] ?? ""];
      if (!status) {
        errors.push(`Line ${index + 1}: unknown status marker "[${task[1]}]" (use [ ], [x], [/], [-])`);
        currentTask = undefined;
        return;
      }
      currentTask = { content: task[2]!.trim(), status };
      currentPhase.tasks.push(currentTask);
      return;
    }

    flushNote();
    currentTask = undefined;
    errors.push(`Line ${index + 1}: unrecognized syntax "${trimmed}"`);
  });
  flushNote();
  normalizeInProgressTask(phases);
  return { phases, errors };
}
