/**
 * extensions/todo-context/command/state-commands.ts — the `/todo` verbs that read or
 * change session todo state: show, copy, export, edit, append, start, done,
 * drop, rm.
 *
 * These bodies accept fuzzy phase/task input for operator ergonomics, which is
 * why the fuzzy matchers live here and not in `phase-ops.ts` — the `todo_write`
 * tool path stays strict and addresses tasks by exact content. Dispatch to these
 * bodies is `command-router.ts`; the explicit project-task verbs are in
 * `task-bridge-commands.ts`.
 */
import { requestOperatorInput } from "../../_shared/operator/operator-input.js";
import type { ExtensionAPI, ExtensionContext } from "../../_shared/host/pi-api.js";
import { cloneTodoPhases, type TodoPhase, type TodoTask } from "../../_shared/project/todo-state.js";
import { titleCaseSentence, titleCaseWords, tokenize } from "./command-parser.js";
import { markdownToPhases, phasesToMarkdown } from "../state/markdown-checklist.js";
import { setTodoBlock } from "../operator/operator-surface.js";
import {
  todoChangeBlock,
  todoExportBlock,
  todoResultBlock,
  todoStateBlock,
  todoWarningBlock,
} from "../operator/operator-ui.js";
import { applyTodoOps, findTask, normalizeInProgressTask } from "../state/phase-ops.js";
import { commitTodoPhases, loadTodoPhases } from "../state/phase-store.js";

const BATCH_DELIMITER = ";;";

/**
 * Render the latest todo state into the Pi text widget.
 */
export async function showTodos(pi: ExtensionAPI, ctx: ExtensionContext, prefix?: string): Promise<void> {
  const { phases, backend } = await loadTodoPhases(pi, ctx);
  setTodoBlock(ctx, todoStateBlock(phases, backend, prefix));
}

/**
 * Print deterministic Markdown for the current state.
 */
export async function exportTodos(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const { phases, backend } = await loadTodoPhases(pi, ctx);
  setTodoBlock(ctx, todoExportBlock(phases, backend));
}

/**
 * Open the operator editor and round-trip OMP-style Markdown checklist syntax.
 */
export async function editTodos(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const { phases: current } = await loadTodoPhases(pi, ctx);
  const initial = current.length > 0 ? phasesToMarkdown(current) : "# Todos\n- [ ] Replace this with your first task\n";
  const result = await requestOperatorInput(ctx, {
    kind: "editor",
    title: "[INPUT] Edit session todos as Markdown",
    prefill: initial,
  });
  if (result.status === "unavailable") {
    setTodoBlock(
      ctx,
      todoWarningBlock(
        "Interactive todo editing is unavailable in this host mode.",
        [],
        ["Use /todo append, /todo start, /todo done, or todo_write."],
      ),
    );
    return;
  }
  if (result.status === "cancelled") {
    setTodoBlock(ctx, todoResultBlock("Cancelled; session todos were not changed."));
    return;
  }
  const parsed = markdownToPhases(result.value);
  if (parsed.errors.length > 0) {
    setTodoBlock(
      ctx,
      todoWarningBlock(
        "Could not parse session todos; state was not changed.",
        parsed.errors.map((error) => `- ${error}`),
        ["Reopen: /todo edit", "Syntax: /todo help"],
      ),
    );
    return;
  }
  const commit = await commitTodoPhases(pi, ctx, parsed.phases);
  setTodoBlock(
    ctx,
    todoChangeBlock(
      `Todos updated from editor: ${parsed.phases.length} phase(s), ${parsed.phases.reduce((sum, phase) => sum + phase.tasks.length, 0)} task(s).`,
      parsed.phases,
      commit.backend,
    ),
  );
}

/**
 * Append one or more tasks from the operator command path.
 *
 * The command accepts fuzzy phase input for operator ergonomics. The structured
 * tool path remains stricter and addresses phases/tasks by exact values.
 */
export async function appendTodo(pi: ExtensionAPI, ctx: ExtensionContext, rest: string): Promise<void> {
  const segments = rest.split(BATCH_DELIMITER).map((segment) => segment.trim());
  if (segments.length > 20) {
    setTodoBlock(
      ctx,
      todoWarningBlock(
        "Append accepts at most 20 tasks at once; state was not changed.",
        [],
        ["Usage: /todo append [<phase>] <task> [;; <task> ...]"],
      ),
    );
    return;
  }
  if (segments.length === 0 || segments.some((segment) => segment === "")) {
    setTodoBlock(
      ctx,
      todoWarningBlock(
        "Append requires a task in every batch segment; state was not changed.",
        [],
        ["Usage: /todo append [<phase>] <task> [;; <task> ...]"],
      ),
    );
    return;
  }
  const firstTokens = tokenize(segments[0]!);
  if (firstTokens.length === 0) {
    setTodoBlock(
      ctx,
      todoWarningBlock(
        "Append requires a task; state was not changed.",
        [],
        ["Usage: /todo append [<phase>] <task> [;; <task> ...]"],
      ),
    );
    return;
  }
  const phaseName = firstTokens.length === 1 ? undefined : firstTokens[0];
  const rawItems = [
    firstTokens.length === 1 ? firstTokens[0]! : firstTokens.slice(1).join(" "),
    ...segments.slice(1).map((segment) => tokenize(segment).join(" ")),
  ];
  if (rawItems.some((item) => item === "")) {
    setTodoBlock(
      ctx,
      todoWarningBlock(
        "Append requires a task in every batch segment; state was not changed.",
        [],
        ["Usage: /todo append [<phase>] <task> [;; <task> ...]"],
      ),
    );
    return;
  }
  const items = rawItems.map(titleCaseSentence);
  const duplicateBatchItem = items.find((item, index) => items.indexOf(item) !== index);
  const { phases: current } = await loadTodoPhases(pi, ctx);
  const duplicateExistingItem = items.find((item) => findTask(current, item) !== undefined);
  const duplicate = duplicateBatchItem ?? duplicateExistingItem;
  if (duplicate !== undefined) {
    setTodoBlock(
      ctx,
      todoWarningBlock(
        `Task "${duplicate}" already exists; batch state was not changed.`,
        [],
        ["Inspect: /todo", "Retry with unique task text."],
      ),
    );
    return;
  }
  const next = cloneTodoPhases(current);
  let target = phaseName ? findPhaseFuzzy(next, phaseName) : next[next.length - 1];
  if (!target) {
    target = { name: phaseName ? titleCaseWords(phaseName) : "Todos", tasks: [] };
    next.push(target);
  }
  target.tasks.push(...items.map((content) => ({ content, status: "pending" as const })));
  normalizeInProgressTask(next);
  const commit = await commitTodoPhases(pi, ctx, next);
  setTodoBlock(
    ctx,
    todoChangeBlock(
      items.length === 1
        ? `Appended to ${target.name}: ${items[0]}`
        : `Appended ${items.length} tasks to ${target.name}.`,
      next,
      commit.backend,
    ),
  );
}

/**
 * Mark one fuzzy-matched operator task as `in_progress`.
 */
export async function startTodo(pi: ExtensionAPI, ctx: ExtensionContext, rest: string): Promise<void> {
  const { phases: current } = await loadTodoPhases(pi, ctx);
  const hit = findTaskFuzzy(current, rest);
  if (!hit) {
    setTodoBlock(ctx, todoWarningBlock(`No task matched "${rest}".`, [], ["Inspect current state: /todo"]));
    return;
  }
  const { phases } = applyTodoOps(current, [{ op: "start", task: hit.task.content }]);
  const commit = await commitTodoPhases(pi, ctx, phases);
  setTodoBlock(ctx, todoChangeBlock(`Started: ${hit.task.content}`, phases, commit.backend));
}

/**
 * Apply an operator mutation to one task, one phase, or all tasks.
 */
export async function mutateTodo(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  verb: "done" | "drop" | "rm",
  rest: string,
): Promise<void> {
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
    setTodoBlock(
      ctx,
      todoChangeBlock(
        verb === "done" ? "Marked all tasks completed." : "Marked all tasks abandoned.",
        phases,
        commit.backend,
      ),
    );
    return;
  }

  const taskHit = findTaskFuzzy(current, trimmed);
  const phaseHit = taskHit ? undefined : findPhaseFuzzy(current, trimmed);
  if (!taskHit && !phaseHit) {
    setTodoBlock(ctx, todoWarningBlock(`No task or phase matched "${trimmed}".`, [], ["Inspect current state: /todo"]));
    return;
  }

  const { phases } = applyTodoOps(current, [
    taskHit ? { op: verb, task: taskHit.task.content } : { op: verb, phase: phaseHit!.name },
  ]);
  const commit = await commitTodoPhases(pi, ctx, phases);
  const target = taskHit?.task.content ?? phaseHit!.name;
  const label = verb === "done" ? "Marked completed" : verb === "drop" ? "Marked abandoned" : "Removed";
  setTodoBlock(ctx, todoChangeBlock(`${label}: ${target}`, phases, commit.backend));
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
  const matches = phases.flatMap((phase) =>
    phase.tasks.filter((task) => task.content.toLowerCase().includes(normalized)).map((task) => ({ task, phase })),
  );
  if (matches.length === 1) return matches[0];
  const active = matches.filter(({ task }) => task.status === "pending" || task.status === "in_progress");
  return active.length === 1 ? active[0] : undefined;
}
