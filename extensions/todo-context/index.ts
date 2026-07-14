/**
 * Pi extension for session-backed todo state.
 *
 * This module intentionally exposes two different surfaces:
 * - `todo_write` is the model/runtime-facing tool that applies structured todo
 *   operations to the current session state.
 * - `/todo` is the operator-facing compatibility command for inspection,
 *   Markdown export, manual edits, and explicit task bridge commands.
 *
 * The extension is an OMP-compatible wrapper, not a standalone task manager.
 * It stores the latest todo phases through the Locus session backend when that
 * backend is enabled, keeps Pi `todo_write` custom entries for compatibility,
 * and falls back to shared in-process state only when no session entry exists.
 */
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "../_shared/pi-api.js";
import { errorResult, getCommandText, getProjectRoot, textResult } from "../_shared/pi-api.js";
import { registerCommandWithUiLifecycle } from "../_shared/command-ui.js";
import { requestOperatorInput } from "../_shared/operator-input.js";
import type { OperatorBlock } from "../_shared/operator-ui.js";
import { setOperatorWidget } from "../_shared/widget-render.js";
import { emitDevEvent } from "../_shared/event-bus.js";
import { sharedState } from "../_shared/state.js";
import {
  exportTodosToProjectTask,
  formatCurrentProjectTaskResolution,
  importTodosFromProjectTasks,
  loadTaskBridgeSnapshot,
  resolveCurrentProjectTask,
  writeCompletionNoteWithApproval,
  type TaskBridgeSnapshot,
} from "../_shared/task-bridge.js";
import { tasksRoot } from "../_shared/tasks-store.js";
import {
  cloneTodoPhases,
  commitTodoState,
  loadTodoState,
  type TodoPhase,
  type TodoStateCommit,
  type TodoStateSnapshot,
  type TodoStatus,
  type TodoTask,
} from "../_shared/todo-state.js";
import { validateParams } from "../_shared/validation.js";

const TodoWriteParams = Type.Object({
  ops: Type.Array(Type.Object({
    op: Type.Union([
      Type.Literal("init"),
      Type.Literal("start"),
      Type.Literal("done"),
      Type.Literal("drop"),
      Type.Literal("rm"),
      Type.Literal("append"),
      Type.Literal("note"),
    ]),
    phase: Type.Optional(Type.String()),
    task: Type.Optional(Type.String()),
    items: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })),
    text: Type.Optional(Type.String({ maxLength: 500 })),
    list: Type.Optional(Type.Array(Type.Object({
      phase: Type.String(),
      items: Type.Array(Type.String(), { minItems: 1 }),
    }))),
  }), { minItems: 1, maxItems: 30 }),
});

interface TodoOp {
  op: string;
  phase?: string;
  task?: string;
  items?: string[];
  text?: string;
  list?: Array<{ phase: string; items: string[] }>;
}

interface TodoCompletionTransition {
  phase: string;
  content: string;
}

function setTodoBlock(ctx: ExtensionContext, block: OperatorBlock): void {
  setOperatorWidget(ctx, "todo", ctx.mode === "tui" ? block : compactTodoBlock(block));
}

function compactTodoBlock(block: OperatorBlock): OperatorBlock {
  const body = [...(block.body ?? [])];
  const visibleBody = body.slice(0, 2);
  const hidden = body.length - visibleBody.length;
  const metadata = prioritizeCompactLines(block.metadata ?? [], /^(?:artifact|path|target|storageBackend|activeTask):/u, 3);
  const controls = prioritizeCompactLines(block.controls ?? [], /(?:export|body|retry|recovery|usage)/iu, 1);
  return {
    ...block,
    body: [...visibleBody, ...(hidden > 0 ? [`(+${hidden} hidden)`] : [])],
    metadata,
    hint: (block.hint ?? []).slice(0, 1),
    controls,
  };
}

function prioritizeCompactLines(lines: readonly string[], priority: RegExp, limit: number): string[] {
  const preferred = lines.filter((line) => priority.test(line));
  const rest = lines.filter((line) => !priority.test(line));
  return [...preferred, ...rest].slice(0, limit);
}

function todoCounts(phases: readonly TodoPhase[]): {
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

function todoCountMetadata(phases: readonly TodoPhase[], backend?: string): string[] {
  const counts = todoCounts(phases);
  const active = findActiveTask(phases);
  return [
    `phases: ${counts.phases}`,
    `tasks: ${counts.tasks} · pending ${counts.pending} · active ${counts.inProgress} · done ${counts.completed} · dropped ${counts.abandoned}`,
    ...(active === undefined ? [] : [`activeTask: ${active}`]),
    ...(backend === undefined ? [] : [`storageBackend: ${backend}`]),
  ];
}

function todoStateBlock(phases: TodoPhase[], backend: string, note?: string): OperatorBlock {
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

function todoChangeBlock(
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

function todoWarningBlock(primary: string, body: string[] = [], controls: string[] = ["Help: /todo help"]): OperatorBlock {
  return {
    type: "WARN",
    subject: "Session todos",
    primary,
    body,
    controls,
  };
}

function todoResultBlock(primary: string, metadata: string[] = [], subject = "Session todos"): OperatorBlock {
  return {
    type: "RESULT",
    subject,
    primary,
    badges: [{ text: "NO CHANGE", tone: "muted" }],
    metadata,
    controls: ["Inspect: /todo"],
  };
}

function todoErrorBlock(error: unknown): OperatorBlock {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: "ERROR",
    subject: "Session todos",
    primary: "Todo command failed; no successful change is claimed.",
    body: [`error: ${message}`],
    controls: ["Inspect current state: /todo", "Help: /todo help"],
  };
}

/**
 * Register the todo tool and command with the Pi host.
 *
 * The registration boundary is deliberately thin: host-facing APIs are wired
 * here, while state loading, mutation, rendering, and Markdown parsing stay in
 * local helpers below.
 */
export default function todoContext(pi: ExtensionAPI): void {
  registerCommandWithUiLifecycle(pi, {
    command: "todo",
    group: "todo",
    surfaces: ["transient-widget", "blocking-prompt", "artifact-write"],
    transientWidgets: ["todo"],
  }, {
    description: "Show, edit, and explicitly bridge OMP-style todos from the session todo state.",
    handler: async (args, ctx) => {
      try {
        await handleTodoCommand(pi, getCommandText(args), ctx);
      } catch (error) {
        setTodoBlock(ctx, todoErrorBlock(error));
      }
    },
  });

  pi.registerTool({
    name: "todo_write",
    description: "Apply ordered OMP-compatible todo operations to visible session todo state.",
    parameters: TodoWriteParams,
    approval: "write",
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(TodoWriteParams, params);
      if (!valid.ok) return valid.result;
      const previous = await loadTodoPhases(pi, ctx);
      const previousPhases = previous.phases;
      const { phases, errors } = applyTodoOps(previousPhases, valid.value.ops as TodoOp[]);
      const completedTasks = getCompletionTransitions(previousPhases, phases);
      const commit = await commitTodoPhases(pi, ctx, phases);
      const details = {
        phases: sharedState.todos,
        storage: "session",
        storageBackend: commit.backend,
        todoStateSource: previous.backend,
        ...(commit.diagnostics.length > 0 || previous.diagnostics.length > 0 ? { storageDiagnostics: [...previous.diagnostics, ...commit.diagnostics] } : {}),
        activeTask: findActiveTask(sharedState.todos),
        ...(completedTasks.length > 0 ? { completedTasks } : {}),
      };
      const summary = renderTodos(sharedState.todos, errors);
      return errors.length > 0 ? errorResult(summary, details) : textResult(summary, details);
    },
  });
}

/**
 * Route `/todo` operator input to the command implementation.
 *
 * This command is a compatibility/operator surface. Agentic state updates
 * should prefer the structured `todo_write` tool so the model call sees a real
 * schema and receives structured result details.
 */
async function handleTodoCommand(pi: ExtensionAPI, text: string, ctx: ExtensionContext): Promise<void> {
  const input = text.trim();
  if (!input || input === "show" || input === "list") {
    await showTodos(pi, ctx);
    return;
  }
  if (input === "help" || input === "?") {
    setTodoBlock(ctx, {
      type: "VIEW",
      subject: "Session todos help",
      primary: "Inspect or explicitly change session-backed todo state.",
      body: TODO_HELP.split(/\r?\n/u),
      hint: ["/todos is a different surface: the Todos prompt shelf."],
    });
    return;
  }

  const [verb = "", rest = ""] = splitCommand(input);
  if (verb === "edit") {
    await editTodos(pi, ctx);
    return;
  }
  if (verb === "copy") {
    await showTodos(pi, ctx, "Copy not available here; printing Markdown instead.");
    return;
  }
  if (verb === "export") {
    await exportTodos(pi, ctx);
    return;
  }
  if (verb === "append") {
    await appendTodo(pi, ctx, rest);
    return;
  }
  if (verb === "start") {
    await startTodo(pi, ctx, rest);
    return;
  }
  if (verb === "from-task") {
    await seedTodoFromTask(pi, ctx, rest);
    return;
  }
  if (verb === "current-task") {
    showCurrentProjectTask(ctx);
    return;
  }
  if (verb === "completion-note") {
    await writeTodoCompletionNote(pi, ctx, rest);
    return;
  }
  if (verb === "done" || verb === "drop" || verb === "rm") {
    await mutateTodo(pi, ctx, verb, rest);
    return;
  }

  setTodoBlock(ctx, todoWarningBlock(`Unknown /todo verb: ${verb}.`, [], ["Help: /todo help"]));
}

/**
 * Load the current phases from the best available session source.
 *
 * `_shared/todo-state` owns backend selection: JSONL session store first when
 * enabled, then Pi custom entries, then shared memory as the final fallback.
 */
async function loadTodoPhases(pi: ExtensionAPI, ctx: ExtensionContext): Promise<TodoStateSnapshot> {
  return loadTodoState(pi, ctx, sharedState.todos);
}

/**
 * Persist a normalized todo snapshot and emit a development event.
 *
 * `sharedState.todos` remains a local cache/fallback. Durable session writes
 * are delegated to `_shared/todo-state` so command and tool paths share one
 * storage contract.
 */
async function commitTodoPhases(pi: ExtensionAPI, ctx: ExtensionContext, phases: TodoPhase[]): Promise<TodoStateCommit> {
  sharedState.todos = cloneTodoPhases(phases);
  const commit = await commitTodoState(pi, ctx, sharedState.todos);
  emitDevEvent("todo:update", { phases: sharedState.todos.length });
  return commit;
}

/**
 * Render the latest todo state into the Pi text widget.
 */
async function showTodos(pi: ExtensionAPI, ctx: ExtensionContext, prefix?: string): Promise<void> {
  const { phases, backend } = await loadTodoPhases(pi, ctx);
  setTodoBlock(ctx, todoStateBlock(phases, backend, prefix));
}

/**
 * Open the operator editor and round-trip OMP-style Markdown checklist syntax.
 */
async function editTodos(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const { phases: current } = await loadTodoPhases(pi, ctx);
  const initial = current.length > 0 ? phasesToMarkdown(current) : "# Todos\n- [ ] Replace this with your first task\n";
  const result = await requestOperatorInput(ctx, {
    kind: "editor",
    title: "[INPUT] Edit session todos as Markdown",
    prefill: initial,
  });
  if (result.status === "unavailable") {
    setTodoBlock(ctx, todoWarningBlock(
      "Interactive todo editing is unavailable in this host mode.",
      [],
      ["Use /todo append, /todo start, /todo done, or todo_write."],
    ));
    return;
  }
  if (result.status === "cancelled") {
    setTodoBlock(ctx, todoResultBlock("Cancelled; session todos were not changed."));
    return;
  }
  const parsed = markdownToPhases(result.value);
  if (parsed.errors.length > 0) {
    setTodoBlock(ctx, todoWarningBlock(
      "Could not parse session todos; state was not changed.",
      parsed.errors.map((error) => `- ${error}`),
      ["Reopen: /todo edit", "Syntax: /todo help"],
    ));
    return;
  }
  const commit = await commitTodoPhases(pi, ctx, parsed.phases);
  setTodoBlock(ctx, todoChangeBlock(
    `Todos updated from editor: ${parsed.phases.length} phase(s), ${parsed.phases.reduce((sum, phase) => sum + phase.tasks.length, 0)} task(s).`,
    parsed.phases,
    commit.backend,
  ));
}

/**
 * Append one task from the operator command path.
 *
 * The command accepts fuzzy phase input for operator ergonomics. The structured
 * tool path remains stricter and addresses phases/tasks by exact values.
 */
async function appendTodo(pi: ExtensionAPI, ctx: ExtensionContext, rest: string): Promise<void> {
  const tokens = tokenize(rest);
  if (tokens.length === 0) {
    setTodoBlock(ctx, todoWarningBlock(
      "Append requires a task.",
      [],
      ["Usage: /todo append [<phase>] <task...>"],
    ));
    return;
  }
  const { phases: current } = await loadTodoPhases(pi, ctx);
  const phaseName = tokens.length === 1 ? undefined : tokens[0];
  const content = tokens.length === 1 ? tokens[0]! : tokens.slice(1).join(" ");
  const next = cloneTodoPhases(current);
  let target = phaseName ? findPhaseFuzzy(next, phaseName) : next[next.length - 1];
  if (!target) {
    target = { name: phaseName ? titleCaseWords(phaseName) : "Todos", tasks: [] };
    next.push(target);
  }
  target.tasks.push({ content: titleCaseSentence(content), status: "pending" });
  normalizeInProgressTask(next);
  const commit = await commitTodoPhases(pi, ctx, next);
  setTodoBlock(ctx, todoChangeBlock(
    `Appended to ${target.name}: ${titleCaseSentence(content)}`,
    next,
    commit.backend,
  ));
}

/**
 * Mark one fuzzy-matched operator task as `in_progress`.
 */
async function startTodo(pi: ExtensionAPI, ctx: ExtensionContext, rest: string): Promise<void> {
  const { phases: current } = await loadTodoPhases(pi, ctx);
  const hit = findTaskFuzzy(current, rest);
  if (!hit) {
    setTodoBlock(ctx, todoWarningBlock(
      `No task matched "${rest}".`,
      [],
      ["Inspect current state: /todo"],
    ));
    return;
  }
  const { phases } = applyTodoOps(current, [{ op: "start", task: hit.task.content }]);
  const commit = await commitTodoPhases(pi, ctx, phases);
  setTodoBlock(ctx, todoChangeBlock(`Started: ${hit.task.content}`, phases, commit.backend));
}

/**
 * Apply an operator mutation to one task, one phase, or all tasks.
 */
async function mutateTodo(pi: ExtensionAPI, ctx: ExtensionContext, verb: "done" | "drop" | "rm", rest: string): Promise<void> {
  const { phases: current } = await loadTodoPhases(pi, ctx);
  const trimmed = rest.trim();
  if (!trimmed) {
    if (verb === "rm") {
      const commit = await commitTodoPhases(pi, ctx, []);
      setTodoBlock(ctx, todoChangeBlock("Cleared all todos.", [], commit.backend));
      return;
    }
    const { phases } = applyTodoOps(current, [{ op: verb }]);
    const commit = await commitTodoPhases(pi, ctx, phases);
    setTodoBlock(ctx, todoChangeBlock(
      verb === "done" ? "Marked all tasks completed." : "Marked all tasks abandoned.",
      phases,
      commit.backend,
    ));
    return;
  }

  const taskHit = findTaskFuzzy(current, trimmed);
  const phaseHit = taskHit ? undefined : findPhaseFuzzy(current, trimmed);
  if (!taskHit && !phaseHit) {
    setTodoBlock(ctx, todoWarningBlock(
      `No task or phase matched "${trimmed}".`,
      [],
      ["Inspect current state: /todo"],
    ));
    return;
  }

  const { phases } = applyTodoOps(current, [taskHit ? { op: verb, task: taskHit.task.content } : { op: verb, phase: phaseHit!.name }]);
  const commit = await commitTodoPhases(pi, ctx, phases);
  const target = taskHit?.task.content ?? phaseHit!.name;
  const label = verb === "done" ? "Marked completed" : verb === "drop" ? "Marked abandoned" : "Removed";
  setTodoBlock(ctx, todoChangeBlock(`${label}: ${target}`, phases, commit.backend));
}

/**
 * Print deterministic Markdown for the current state.
 */
async function exportTodos(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const { phases, backend } = await loadTodoPhases(pi, ctx);
  const counts = todoCounts(phases);
  setTodoBlock(ctx, {
    type: "VIEW",
    subject: "Session todos export",
    primary: `Deterministic Markdown for ${counts.tasks} task(s).`,
    body: phasesToMarkdown(phases).trimEnd().split(/\r?\n/u),
    metadata: [...todoCountMetadata(phases, backend), "format: markdown"],
    controls: ["Return to summary: /todo"],
  });
}

type TaskBridgeTask = TaskBridgeSnapshot["tasks"][number];

interface ExplicitTaskTarget {
  task: TaskBridgeTask;
  workspace: {
    id: string;
    dir: string;
    taskPath: string;
    eventsPath: string;
  };
}

/**
 * Seed session todo state from a single explicit project task.
 */
async function seedTodoFromTask(pi: ExtensionAPI, ctx: ExtensionContext, rest: string): Promise<void> {
  const taskId = rest.trim();
  if (taskId === "") {
    setTodoBlock(ctx, todoWarningBlock(
      "Task import requires an exact task id.",
      ["Reads .tasks/index.json and seeds session todos only.", "No current task is inferred."],
      ["Usage: /todo from-task <task-id>"],
    ));
    return;
  }

  try {
    const { task, workspace } = resolveExplicitTaskTarget(getProjectRoot(ctx), taskId);
    const phases = importTodosFromProjectTasks([task]);
    const commit = await commitTodoPhases(pi, ctx, phases);
    setTodoBlock(ctx, todoChangeBlock(
      `Seeded session todos from task ${task.id}: ${task.title}`,
      phases,
      commit.backend,
      [`taskPath: ${displayProjectPath(getProjectRoot(ctx), workspace.taskPath)}`, "taskSelection: explicit"],
    ));
  } catch (error) {
    renderExplicitTaskFailure(ctx, "from-task", taskId, error);
  }
}

/**
 * Render the current project task without reading or mutating session todos.
 */
function showCurrentProjectTask(ctx: ExtensionContext): void {
  const resolution = resolveCurrentProjectTask(getProjectRoot(ctx));
  const [heading = "Current project task", ...details] = formatCurrentProjectTaskResolution(resolution).split(/\r?\n/u);
  setTodoBlock(ctx, {
    type: resolution.ok ? "VIEW" : "WARN",
    subject: "Project task resolution",
    primary: resolution.ok ? `${heading}: ${resolution.taskId}` : resolution.message,
    body: details,
    hint: ["This resolver never reads or mutates Session todos."],
    controls: resolution.ok ? ["Seed explicitly: /todo from-task <task-id>"] : ["Inspect .tasks/index.json; no current task was inferred."],
  });
}

/**
 * Write the current session todo markdown to an explicit task artifact.
 */
async function writeTodoCompletionNote(pi: ExtensionAPI, ctx: ExtensionContext, rest: string): Promise<void> {
  const parsed = parseCompletionNoteInput(rest);
  if (parsed.usage !== undefined) {
    setTodoBlock(ctx, todoWarningBlock("Completion note requires one exact task id.", [], [parsed.usage]));
    return;
  }

  try {
    const { task, workspace } = resolveExplicitTaskTarget(getProjectRoot(ctx), parsed.taskId);
    const { phases, backend } = await loadTodoPhases(pi, ctx);
    const approval = await writeCompletionNoteWithApproval({
      pi,
      ctx,
      workspace,
      note: exportTodosToProjectTask(phases),
      approvalTier: parsed.approvalTier,
    });
    if (!approval.approved || approval.artifactPath === undefined) {
      setTodoBlock(ctx, todoResultBlock(
        `Completion note not written for task ${task.id}; session todos were not changed.`,
        ["permission: delegated-to-pi", `reason: ${approval.reason}`, `target: task:${task.id}`],
        "Todo completion note",
      ));
      return;
    }

    setTodoBlock(ctx, {
      type: "CHANGE",
      subject: "Todo completion note",
      primary: `Completion note written for task ${task.id}.`,
      badges: [{ text: "ARTIFACT", tone: "success" }],
      metadata: [
        ...todoCountMetadata(phases, backend),
        "permission: delegated-to-pi",
        `artifact: ${path.basename(approval.artifactPath)}`,
        `path: ${displayProjectPath(getProjectRoot(ctx), approval.artifactPath)}`,
        `target: task:${task.id}`,
      ],
      controls: ["Inspect session state: /todo"],
    });
  } catch (error) {
    renderExplicitTaskFailure(ctx, "completion-note", parsed.taskId, error);
  }
}

function parseCompletionNoteInput(rest: string): { taskId: string; approvalTier: "allow" | "prompt"; usage?: string } {
  const tokens = tokenize(rest);
  if (tokens.length === 0) return { taskId: "", approvalTier: "prompt", usage: "Usage: /todo completion-note [--yes] <task-id>" };
  if (tokens[0] === "--yes") {
    if (tokens.length !== 2) return { taskId: "", approvalTier: "allow", usage: "Usage: /todo completion-note --yes <task-id>" };
    return { taskId: tokens[1]!, approvalTier: "allow" };
  }
  if (tokens.length !== 1) return { taskId: "", approvalTier: "prompt", usage: "Usage: /todo completion-note [--yes] <task-id>" };
  return { taskId: tokens[0]!, approvalTier: "prompt" };
}

function resolveExplicitTaskTarget(projectRoot: string, taskId: string): ExplicitTaskTarget {
  let snapshot: TaskBridgeSnapshot;
  try {
    snapshot = loadTaskBridgeSnapshot(projectRoot);
  } catch {
    throw new Error(`Task target ${taskId} cannot be resolved because .tasks/index.json is missing or unsupported.`);
  }

  const matches = snapshot.tasks.filter((candidate) => candidate.id === taskId);
  if (matches.length === 0) {
    throw new Error(`Task target ${taskId} was not found in .tasks/index.json.`);
  }
  if (matches.length > 1) {
    throw new Error(`Task target ${taskId} is ambiguous in .tasks/index.json.`);
  }
  const task = matches[0]!;
  return { task, workspace: resolveTaskWorkspace(projectRoot, task) };
}

function resolveTaskWorkspace(projectRoot: string, task: TaskBridgeTask): ExplicitTaskTarget["workspace"] {
  const taskRoot = tasksRoot(projectRoot);
  const taskDir = path.resolve(taskRoot, task.path);
  if (taskDir === taskRoot || !taskDir.startsWith(`${taskRoot}${path.sep}`)) {
    throw new Error(`Task target ${task.id} resolves outside .tasks and cannot receive completion-note artifacts.`);
  }
  return {
    id: task.id,
    dir: taskDir,
    taskPath: path.join(taskDir, "task.md"),
    eventsPath: path.join(taskDir, "events.jsonl"),
  };
}

function renderExplicitTaskFailure(ctx: ExtensionContext, action: string, taskId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  setTodoBlock(ctx, todoWarningBlock(
    `/todo ${action} failed.`,
    [`target: task:${taskId}`, `error: ${message}`, "No session todos were changed."],
    [action === "from-task" ? "Retry: /todo from-task <task-id>" : "Retry: /todo completion-note [--yes] <task-id>"],
  ));
}

function displayProjectPath(projectRoot: string, filePath: string): string {
  const relative = path.relative(projectRoot, filePath).split(path.sep).join("/");
  return relative.startsWith("..") ? filePath : `./${relative}`;
}

const TODO_HELP = [
  "Usage: /todo <verb> [args]",
  "  /todo                              Show current todos",
  "  /todo edit                         Edit todos as Markdown",
  "  /todo copy                         Print todos as Markdown",
  "  /todo export                       Print deterministic Markdown only",
  "  /todo append [<phase>] <task...>   Append a task",
  "  /todo start  <task>                Mark task in_progress",
  "  /todo from-task <task-id>          Seed session todos from an exact .tasks/index.json task",
  "  /todo current-task                 Show the unambiguous project task from .tasks/index.json",
  "  /todo completion-note --yes <task-id>  Write current session todos to .tasks/<task>/artifacts/completion-note.md",
  "  /todo done   [<task|phase>]        Mark task/phase/all completed",
  "  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
  "  /todo rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

function splitCommand(input: string): [verb: string, rest: string] {
  const space = input.search(/\s/u);
  return space === -1 ? [input.toLowerCase(), ""] : [input.slice(0, space).toLowerCase(), input.slice(space + 1).trim()];
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (let index = 0; index < input.length; index++) {
    const ch = input[index]!;
    if (ch === "\\" && index + 1 < input.length) {
      current += input[++index];
      continue;
    }
    if (ch === "\"") {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/u.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function titleCaseWords(text: string): string {
  return text
    .split(/\s+/u)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function titleCaseSentence(text: string): string {
  const trimmed = text.trim();
  return trimmed ? trimmed[0]!.toUpperCase() + trimmed.slice(1) : trimmed;
}

/**
 * Find a phase from free-form operator text.
 *
 * Exact match wins, then a unique prefix match, then a unique substring match.
 */
function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return undefined;
  const exact = phases.find((phase) => phase.name.toLowerCase() === normalized);
  if (exact) return exact;
  const prefixMatches = phases.filter((phase) => phase.name.toLowerCase().startsWith(normalized));
  if (prefixMatches.length === 1) return prefixMatches[0];
  const substringMatches = phases.filter((phase) => phase.name.toLowerCase().includes(normalized));
  return substringMatches.length === 1 ? substringMatches[0] : undefined;
}

/**
 * Find a task from free-form operator text.
 *
 * The tool path does not use fuzzy matching; this helper exists only for
 * `/todo` command ergonomics.
 */
function findTaskFuzzy(phases: TodoPhase[], query: string): { task: TodoTask; phase: TodoPhase } | undefined {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return undefined;
  for (const phase of phases) {
    const exact = phase.tasks.find((task) => task.content.toLowerCase() === normalized);
    if (exact) return { task: exact, phase };
  }
  const matches = phases.flatMap((phase) => phase.tasks
    .filter((task) => task.content.toLowerCase().includes(normalized))
    .map((task) => ({ task, phase })));
  if (matches.length === 1) return matches[0];
  const active = matches.filter(({ task }) => task.status === "pending" || task.status === "in_progress");
  return active.length === 1 ? active[0] : undefined;
}

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
  pending: " ",
  in_progress: "/",
  completed: "x",
  abandoned: "-",
};

/**
 * Serialize phases to the Markdown checklist format used by `/todo export`.
 */
function phasesToMarkdown(phases: TodoPhase[]): string {
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
function markdownToPhases(markdown: string): { phases: TodoPhase[]; errors: string[] } {
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

/**
 * Apply a batch of `todo_write` operations in order.
 *
 * Errors are accumulated without rolling back earlier successful operations.
 * This mirrors the compatibility contract tested for OMP-style behavior.
 */
function applyTodoOps(currentPhases: TodoPhase[], ops: TodoOp[]): { phases: TodoPhase[]; errors: string[] } {
  const errors: string[] = [];
  let phases = cloneTodoPhases(currentPhases);
  for (const op of ops) {
    if (op.op === "init") {
      if (!op.list) {
        errors.push("Missing list for init operation");
        continue;
      }
      phases = op.list.map((phase) => ({
        name: phase.phase,
        tasks: phase.items.map((content) => ({
          content,
          status: "pending" as const,
        })),
      }));
    }
    if (op.op === "append" && op.phase) {
      appendItems(phases, op, errors);
    }
    if (op.op === "append" && !op.phase) {
      errors.push("Missing phase name for append operation");
    }
    if (op.op === "start") {
      const hit = resolveTaskOrError(phases, op.task, errors);
      if (hit) {
        for (const phase of phases) {
          for (const task of phase.tasks) {
            if (task.status === "in_progress" && task !== hit.task) task.status = "pending";
          }
        }
        hit.task.status = "in_progress";
      }
    }
    if (op.op === "done") setTargets(phases, op, "completed", errors);
    if (op.op === "drop") setTargets(phases, op, "abandoned", errors);
    if (op.op === "rm") removeTargets(phases, op, errors);
    if (op.op === "note") addNote(phases, op, errors);
  }
  normalizeInProgressTask(phases);
  return { phases, errors };
}

function getPhase(phases: TodoPhase[], name: string): TodoPhase {
  let phase = phases.find((item) => item.name === name);
  if (!phase) {
    phase = { name, tasks: [] };
    phases.push(phase);
  }
  return phase;
}

function findTask(phases: TodoPhase[], content: string): { task: TodoTask; phase: TodoPhase } | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((item) => item.content === content);
    if (task) return { task, phase };
  }
  return undefined;
}

function resolveTaskOrError(phases: TodoPhase[], content: string | undefined, errors: string[]): { task: TodoTask; phase: TodoPhase } | undefined {
  if (!content) {
    errors.push("Missing task content");
    return undefined;
  }
  const hit = findTask(phases, content);
  if (!hit) {
    if (/^task-\d+$/u.test(content)) {
      errors.push(`Task "${content}" not found. Tasks are referenced by content, not by IDs - pass the task's full text from the previous result.`);
      return undefined;
    }
    const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
    const hint = totalTasks === 0 ? " (todo list is empty - was it replaced or not yet created?)" : "";
    errors.push(`Task "${content}" not found${hint}`);
  }
  return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
  if (!name) {
    errors.push("Missing phase name");
    return undefined;
  }
  const phase = phases.find((item) => item.name === name);
  if (!phase) errors.push(`Phase "${name}" not found`);
  return phase;
}

function appendItems(phases: TodoPhase[], op: TodoOp, errors: string[]): void {
  if (!op.items || op.items.length === 0) {
    errors.push("Missing items for append operation");
    return;
  }
  const phase = getPhase(phases, op.phase ?? "");
  for (const content of op.items) {
    if (findTask(phases, content)) {
      errors.push(`Task "${content}" already exists`);
      return;
    }
    phase.tasks.push({ content, status: "pending" });
  }
}

function getTargets(phases: TodoPhase[], op: TodoOp, errors: string[]): TodoTask[] {
  if (op.task) {
    const hit = resolveTaskOrError(phases, op.task, errors);
    return hit ? [hit.task] : [];
  }
  if (op.phase) {
    const phase = resolvePhaseOrError(phases, op.phase, errors);
    return phase ? [...phase.tasks] : [];
  }
  return phases.flatMap((phase) => phase.tasks);
}

function setTargets(phases: TodoPhase[], op: TodoOp, status: "completed" | "abandoned", errors: string[]): void {
  for (const task of getTargets(phases, op, errors)) task.status = status;
}

function removeTargets(phases: TodoPhase[], op: TodoOp, errors: string[]): void {
  if (op.task) {
    const hit = resolveTaskOrError(phases, op.task, errors);
    if (!hit) return;
    hit.phase.tasks = hit.phase.tasks.filter((candidate) => candidate !== hit.task);
    return;
  }
  if (op.phase) {
    const phase = resolvePhaseOrError(phases, op.phase, errors);
    if (phase) phase.tasks = [];
    return;
  }
  for (const phase of phases) phase.tasks = [];
}

function addNote(phases: TodoPhase[], op: TodoOp, errors: string[]): void {
  const hit = resolveTaskOrError(phases, op.task, errors);
  if (!hit) return;
  const text = (op.text ?? "").replace(/\s+$/u, "");
  if (!text) {
    errors.push("Missing text for note operation");
    return;
  }
  hit.task.notes = hit.task.notes ? [...hit.task.notes, text] : [text];
}

function normalizeInProgressTask(phases: TodoPhase[]): void {
  const orderedTasks = phases.flatMap((phase) => phase.tasks);
  const inProgressTasks = orderedTasks.filter((task) => task.status === "in_progress");
  for (const task of inProgressTasks.slice(1)) task.status = "pending";
  if (inProgressTasks.length > 0) return;
  const firstPendingTask = orderedTasks.find((task) => task.status === "pending");
  if (firstPendingTask) firstPendingTask.status = "in_progress";
}

/**
 * Return the task that should be shown as the current active item.
 */
function findActiveTask(phases: readonly TodoPhase[]): string | undefined {
  return phases.flatMap((phase) => phase.tasks).find((task) => task.status === "in_progress")?.content;
}

/**
 * Report tasks that newly reached `completed` during one operation batch.
 */
function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
  const previousStatuses = new Map<string, TodoStatus>();
  for (const phase of previous) {
    for (const task of phase.tasks) previousStatuses.set(`${phase.name}\0${task.content}`, task.status);
  }
  const transitions: TodoCompletionTransition[] = [];
  for (const phase of updated) {
    for (const task of phase.tasks) {
      const previousStatus = previousStatuses.get(`${phase.name}\0${task.content}`);
      if (task.status === "completed" && previousStatus && previousStatus !== "completed") {
        transitions.push({ phase: phase.name, content: task.content });
      }
    }
  }
  return transitions;
}

/**
 * Render the concise text summary returned by the `todo_write` tool.
 */
function renderTodos(phases: TodoPhase[], errors: string[]): string {
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length === 0) return errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.";
  const remaining = phases
    .flatMap((phase) => phase.tasks.map((task) => ({ ...task, phase: phase.name })))
    .filter((task) => task.status === "pending" || task.status === "in_progress");
  const lines: string[] = [];
  if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
  if (remaining.length === 0) {
    lines.push("Remaining items: none.");
  } else {
    lines.push(`Remaining items (${remaining.length}):`);
    for (const task of remaining) lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
  }
  for (const phase of phases) {
    lines.push(`${phase.name}:`);
    for (const task of phase.tasks) {
      const noteCount = task.notes?.length ?? 0;
      const noteMarker = noteCount > 0 ? ` (+${noteCount} note${noteCount === 1 ? "" : "s"})` : "";
      lines.push(`  - [${task.status}] ${task.content}${noteMarker}`);
      if (task.status === "in_progress" && task.notes) {
        for (const note of task.notes) {
          for (const line of note.split("\n")) lines.push(`      ${line}`);
        }
      }
    }
  }
  return lines.join("\n");
}
