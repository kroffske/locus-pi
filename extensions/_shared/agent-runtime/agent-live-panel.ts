import type { AgentLiveRow, AgentLiveStatus } from "./agent-sdk-host.js";

const SPINNER_FRAMES = ["⠿", "⠻", "⠽", "⠾"];
export const AGENT_LIVE_SPINNER_FRAME_COUNT = SPINNER_FRAMES.length;

/** `<icon> <name>  <title>  ·  <model> <effort>  ·  <elapsed>  ·  ↑<in> ↓<out>` (REQ-001). */
const ROW_SEP = "  ·  ";
/** Petname column budget (REQ-001 width rule: name ≤ 12 cols). */
const AGENT_NAME_MAX_COLS = 12;

export interface AgentLiveThemeLike {
  fg?: (color: string, text: string) => string;
  bold?: (s: string) => string;
}

export interface AgentLivePanelOptions {
  spinnerIndex?: number;
  theme?: AgentLiveThemeLike;
  /**
   * Per-status color override for one panel instance. The workflow roster paints
   * the row that is working right now in `warning` so it separates from settled
   * rows in a long list; the status icon still carries the state.
   */
  statusColors?: Partial<Record<AgentLiveStatus, string>>;
}

export class AgentLivePanel {
  constructor(private readonly options: AgentLivePanelOptions = {}) {}

  renderRows(rows: AgentLiveRow[], width: number): string[] {
    // Each row is one line, plus an optional `└ <tool-action>` sub-line BENEATH it
    // while a tool is executing (REQ-004): `[rowLine, subLine?]` flattened.
    return orderAgentLiveRows(withWorkflowGroupTokenTotals(rows)).flatMap((row) => {
      const rowLine = this.renderRow(row, width);
      const latestLine = this.#renderLatestMessageSubLine(row, width);
      const subLine = this.#renderToolActivitySubLine(row, width);
      return [rowLine, ...(latestLine === undefined ? [] : [latestLine]), ...(subLine === undefined ? [] : [subLine])];
    });
  }

  renderRow(row: AgentLiveRow, width: number): string {
    const meta = statusMeta(row.status, this.options.spinnerIndex ?? 0);
    return this.#fg(this.options.statusColors?.[row.status] ?? meta.color, formatAgentLiveRowLine(row, meta, width));
  }

  /** Indented, dimmed `└ <verb> · <gist>[ · <t-elapsed>]`, or nothing when idle. */
  #renderToolActivitySubLine(row: AgentLiveRow, width: number): string | undefined {
    const activity = formatToolActivity(row);
    if (activity === undefined) return undefined;
    const line = `${TOOL_ACTIVITY_INDENT}${TOOL_ACTIVITY_HOOK} ${activity}`;
    return this.#fg("dim", clampLine(line, width));
  }

  #renderLatestMessageSubLine(row: AgentLiveRow, width: number): string | undefined {
    const latest = row.latestMessage ?? (row.status === "done" ? firstLineOf(row.finalAnswer) : "");
    if (latest === "") return undefined;
    return this.#fg("dim", clampLine(`${TOOL_ACTIVITY_INDENT}${TOOL_ACTIVITY_HOOK} ${latest}`, width));
  }

  #fg(color: string, text: string): string {
    return this.options.theme?.fg ? this.options.theme.fg(color, text) : text;
  }
}

export function orderAgentLiveRows(rows: AgentLiveRow[]): AgentLiveRow[] {
  const byParent = new Map<string, AgentLiveRow[]>();
  for (const row of rows) {
    if (row.parentRowId === undefined) continue;
    const siblings = byParent.get(row.parentRowId) ?? [];
    siblings.push(row);
    byParent.set(row.parentRowId, siblings);
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: AgentLiveRow[] = [];
  const seen = new Set<string>();

  function appendTree(row: AgentLiveRow): void {
    if (seen.has(row.id)) return;
    ordered.push(row);
    seen.add(row.id);
    for (const child of byParent.get(row.id) ?? []) appendTree(child);
  }

  for (const row of rows) {
    if (row.parentRowId !== undefined && byId.has(row.parentRowId)) continue;
    appendTree(row);
  }
  for (const row of rows) appendTree(row);
  return ordered;
}

export function selectAgentLiveRowsForParents(rows: AgentLiveRow[], parentIds: Iterable<string>): AgentLiveRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byParent = new Map<string, AgentLiveRow[]>();
  for (const row of rows) {
    if (row.parentRowId === undefined) continue;
    const children = byParent.get(row.parentRowId) ?? [];
    children.push(row);
    byParent.set(row.parentRowId, children);
  }
  const selected: AgentLiveRow[] = [];
  const seen = new Set<string>();
  function append(id: string): void {
    const row = byId.get(id);
    if (row === undefined || seen.has(row.id)) return;
    selected.push(row);
    seen.add(row.id);
    for (const child of byParent.get(row.id) ?? []) append(child.id);
  }
  for (const id of parentIds) append(id);
  return selected;
}

/**
 * Short, durable per-instance suffix for a row (last 6 alphanumerics of the
 * child-session id, else the row id). No longer shown in the fleet row — the
 * petname carries identity there (REQ-002) — but still used by the drill header
 * and `/agent drill <suffix>` resolution (T-188 W5).
 */
export function agentLiveShortId(row: AgentLiveRow): string {
  return agentShortIdFromSource(row.childSessionId ?? row.id);
}

/** Last-6-alphanumerics of any id source (child-session id or row id). */
export function agentShortIdFromSource(source: string): string {
  const compact = source.replace(/[^a-zA-Z0-9]/g, "");
  const base = compact.length > 0 ? compact : source;
  return base.length <= 6 ? base : base.slice(-6);
}

/** Actor identity for the drill header / observer report: `agentName#<shortId>` (T-188 W3). */
export function formatAgentIdentity(row: AgentLiveRow): string {
  return `${row.agentName ?? "agent"}#${agentLiveShortId(row)}`;
}

/**
 * The fleet row grammar (REQ-001), normative per spec "### Agent row anatomy":
 *
 *   `<icon> <name>  <title>  ·  <model> <effort>  ·  <elapsed>  ·  ↑<in> ↓<out>`
 *
 * The status icon+color carries the state, so the row deliberately omits
 * `[Working]`, `on task`, `activity=`, `args=`, `steps=…`, `tokens=…`,
 * `childSession=` and raw JSON. The `└ <tool-action>` sub-line is rendered by the
 * panel (T-196); the `· r<N>` round badge (T-193) is added by `agentRowRightSegments`
 * from r2 up (see `formatRoundBadge`).
 */
export function formatAgentLiveRowLine(
  row: AgentLiveRow,
  meta = statusMeta(row.status, 0),
  width = Number.POSITIVE_INFINITY,
): string {
  if (row.groupKind !== undefined) return formatAgentGroupRowLine(row, meta, width);
  const prefix = row.parentRowId !== undefined ? "↳ " : "";
  const name = truncate(agentRowName(row), AGENT_NAME_MAX_COLS);
  const title = agentRowTitle(row);
  return assembleRowLine(prefix, meta.icon, name, title, agentRowRightSegments(row), width);
}

/** Petname is the row's name; falls back to the agent name, then a generic label. */
function agentRowName(row: AgentLiveRow): string {
  return row.displayName ?? row.agentName ?? "agent";
}

/** Public display-name projection shared by fleet, drill, and transcript events. */
export function agentLiveDisplayName(row: AgentLiveRow): string {
  return agentRowName(row);
}

/** Explicit title wins; otherwise the label, unwrapped from any `agentName (…)` form. */
function agentRowTitle(row: AgentLiveRow): string {
  if (row.title !== undefined && row.title.trim() !== "") return row.title.trim();
  return cleanRowLabel(row);
}

/** Public title projection with the same label-unwrapping fallback as the fleet row. */
export function agentLiveTitle(row: AgentLiveRow): string {
  return agentRowTitle(row);
}

/** `<Name> — <title>` drill heading from REQ-008. */
export function formatAgentDrillTitle(row: AgentLiveRow): string {
  const title = agentRowTitle(row);
  return title === "" ? agentRowName(row) : `${agentRowName(row)} — ${title}`;
}

function cleanRowLabel(row: AgentLiveRow): string {
  if (row.agentName !== undefined) {
    const prefix = `${row.agentName} (`;
    if (row.label.startsWith(prefix) && row.label.endsWith(")")) return row.label.slice(prefix.length, -1);
  }
  return row.label;
}

/** Right-hand meta segments: model+effort, round badge, elapsed, token counter (each optional). */
function agentRowRightSegments(row: AgentLiveRow): string[] {
  const segments: string[] = [];
  const badge = formatModelBadge(row);
  if (badge !== "") segments.push(badge);
  // `[· r<N>]` slot from "### Agent row anatomy" (REQ-009): after model+effort, before
  // elapsed. Rendered only from r2 up — r1 is implicit, so a linear run shows no badge.
  const round = formatRoundBadge(row);
  if (round !== undefined) segments.push(round);
  const elapsed = formatDuration(row.elapsedMs ?? elapsedSinceStart(row));
  if (elapsed !== "") segments.push(elapsed);
  const tokens = formatRowTokens(row);
  if (tokens !== undefined) segments.push(tokens);
  return segments;
}

/**
 * Loop-round badge `r<N>` (REQ-009), shown only when a slot has been re-invoked
 * (`round ≥ 2`). r1 is implicit, so the badge is absent for a linear (non-loop) run.
 */
export function formatRoundBadge(row: { round?: number }): string | undefined {
  return row.round !== undefined && row.round >= 2 ? `r${row.round}` : undefined;
}

/**
 * Model badge (REQ-005): short model name (provider prefix stripped) + effort as
 * a bare word, e.g. `{model:"anthropic/claude-fable-5", thinking:"medium"}` →
 * `claude-fable-5 medium`. No `/effort=` label.
 */
export function formatModelBadge(model: { model?: string; thinking?: string }): string {
  const parts: string[] = [];
  if (model.model !== undefined && model.model !== "") parts.push(shortModelName(model.model));
  if (model.thinking !== undefined && model.thinking !== "") parts.push(model.thinking);
  return parts.join(" ");
}

function shortModelName(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function formatRowTokens(row: AgentLiveRow): string | undefined {
  if (row.tokenCount === undefined) return undefined;
  return `↑${formatTokenCount(row.tokenCount.input)} ↓${formatTokenCount(row.tokenCount.output)}`;
}

/**
 * Humanized token counter (REQ-006): `999`→`999`, `12_400`→`12.4k`,
 * `1_260_000`→`1.3M`. One decimal for k/M, trailing `.0` trimmed.
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 1000) return String(Math.max(0, Math.trunc(tokens)));
  if (tokens < 1_000_000) return `${trimTrailingZero((tokens / 1000).toFixed(1))}k`;
  return `${trimTrailingZero((tokens / 1_000_000).toFixed(1))}M`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/**
 * Compose the row, sacrificing the title first when the line overflows a finite
 * width (REQ-001: the title truncates first; the right-hand meta never truncates). At infinite
 * width (unit tests / unbounded panels) the full line is returned untouched.
 */
function assembleRowLine(
  prefix: string,
  icon: string,
  name: string,
  title: string,
  segments: string[],
  width: number,
): string {
  const left = `${prefix}${icon} ${name}`;
  const right = segments.length > 0 ? `${ROW_SEP}${segments.join(ROW_SEP)}` : "";
  if (title === "") return clampLine(`${left}${right}`, width);
  const full = `${left}  ${title}${right}`;
  if (!Number.isFinite(width) || full.length <= width) return full;
  const room = Math.floor(width) - left.length - 2 - right.length;
  if (room >= 2) return `${left}  ${truncate(title, room)}${right}`;
  return clampLine(`${left}${right}`, width);
}

function clampLine(line: string, width: number): string {
  return Number.isFinite(width) ? truncate(line, Math.floor(width)) : line;
}

/** Workflow group summary row (parallel/pipeline): label + elapsed + k/n done. */
function formatAgentGroupRowLine(row: AgentLiveRow, meta: StatusMeta, width: number): string {
  const prefix = row.parentRowId !== undefined ? "↳ " : "";
  const segments: string[] = [];
  const elapsed = formatDuration(row.elapsedMs ?? elapsedSinceStart(row));
  if (elapsed !== "") segments.push(elapsed);
  if (row.groupTotal !== undefined) segments.push(`${row.groupCompleted ?? 0}/${row.groupTotal} done`);
  if ((row.groupFailed ?? 0) > 0) segments.push(`${row.groupFailed} failed`);
  const tokens = formatRowTokens(row);
  if (tokens !== undefined) segments.push(tokens);
  const right = segments.length > 0 ? `${ROW_SEP}${segments.join(ROW_SEP)}` : "";
  return clampLine(`${prefix}${meta.icon} ${row.label}${right}`, width);
}

/** Sum token-bearing descendants into workflow parallel/pipeline summary rows. */
export function withWorkflowGroupTokenTotals(rows: AgentLiveRow[]): AgentLiveRow[] {
  const byParent = new Map<string, AgentLiveRow[]>();
  for (const row of rows) {
    if (row.parentRowId === undefined) continue;
    const children = byParent.get(row.parentRowId) ?? [];
    children.push(row);
    byParent.set(row.parentRowId, children);
  }
  return rows.map((row) => {
    if (row.groupKind === undefined) return row;
    const total = sumDescendantTokens(row.id, byParent, new Set());
    return total === undefined ? row : { ...row, tokenCount: total };
  });
}

function sumDescendantTokens(
  parentId: string,
  byParent: Map<string, AgentLiveRow[]>,
  seen: Set<string>,
): { input: number; output: number } | undefined {
  let input = 0;
  let output = 0;
  let found = false;
  for (const child of byParent.get(parentId) ?? []) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    if (child.groupKind === undefined && child.tokenCount !== undefined) {
      input += child.tokenCount.input;
      output += child.tokenCount.output;
      found = true;
    }
    const nested = sumDescendantTokens(child.id, byParent, seen);
    if (nested !== undefined) {
      input += nested.input;
      output += nested.output;
      found = true;
    }
  }
  return found ? { input, output } : undefined;
}

/** `● agent <Name> started — <title> (<model> <effort>)` (REQ-011). */
export function formatAgentStartedEventLine(row: AgentLiveRow): string {
  const title = agentRowTitle(row);
  const badge = formatModelBadge(row);
  return `● agent ${agentRowName(row)} started${title !== "" ? ` — ${title}` : ""}${badge !== "" ? ` (${badge})` : ""}`;
}

/**
 * Terminal lifecycle line with status-specific marker and verb (REQ-011).
 */
export function formatAgentFinishedEventLine(row: AgentLiveRow): string {
  const lifecycle =
    row.status === "done"
      ? { marker: "✓", verb: "finished" }
      : row.status === "cancelled"
        ? { marker: "⊘", verb: "cancelled" }
        : { marker: "✗", verb: "failed" };
  const parts = [`${lifecycle.marker} agent ${agentRowName(row)} ${lifecycle.verb}`];
  const elapsed = formatDuration(row.elapsedMs ?? elapsedSinceStart(row));
  if (elapsed !== "") parts.push(elapsed);
  const tokens = formatRowTokens(row);
  if (tokens !== undefined) parts.push(tokens);
  const tail = row.status === "done" ? firstLineOf(row.finalAnswer) : firstLineOf(row.errors[0] ?? row.finalAnswer);
  return `${parts.join(" · ")}${tail !== "" ? ` — ${tail}` : ""}`;
}

function firstLineOf(value: string | undefined): string {
  if (value === undefined) return "";
  return (value.split(/\r?\n/, 1)[0] ?? "").trim();
}

/**
 * Verbose key=value dump for the drill overlay's `details:` line — a debug view,
 * NOT a fleet row, so the compact-grammar bans (REQ-001) do not apply here.
 */
export function formatAgentLiveRowDetails(row: AgentLiveRow): string[] {
  const details: string[] = [];
  details.push(...formatLiveModelDetails(row));
  if (row.activityState !== undefined) details.push(`activity=${row.activityState}`);
  if (row.currentPath !== undefined) details.push(`path=${JSON.stringify(row.currentPath)}`);
  if (row.currentTools.length > 0) details.push(`tools=${row.currentTools.join(",")}`);
  if (row.currentToolArgs !== undefined) details.push(`args=${JSON.stringify(row.currentToolArgs)}`);
  details.push(formatStepsDetail(row.stepCount));
  if (row.turnCount !== undefined) details.push(formatTurnsDetail(row.turnCount));
  if (row.tokenCount !== undefined) details.push(`tokens=in${row.tokenCount.input}/out${row.tokenCount.output}`);
  if (row.childSessionId !== undefined) details.push(`childSession=${row.childSessionId}`);
  if (row.resultArtifact !== undefined) details.push(`artifact=${JSON.stringify(row.resultArtifact)}`);
  if (row.finalAnswer !== undefined) details.push(`answer=${JSON.stringify(row.finalAnswer)}`);
  if (row.groupTotal !== undefined) {
    const completed = row.groupCompleted ?? 0;
    const failed = row.groupFailed ?? 0;
    details.push(`group=${completed}/${row.groupTotal}${failed > 0 ? ` failed=${failed}` : ""}`);
  }
  const flags = formatFlagsDetail(row);
  if (flags !== undefined) details.push(flags);
  if (row.errors.length > 0) details.push(`errors=${row.errors.join("; ")}`);
  return details;
}

function formatLiveModelDetails(row: AgentLiveRow): string[] {
  const details: string[] = [];
  if (row.model !== undefined) details.push(`model=${row.model}`);
  if (row.thinking !== undefined) details.push(`/effort=${row.thinking}`);
  return details;
}

function formatStepsDetail(stepCount: number): string {
  return `steps=${stepCount}(events)`;
}

function formatTurnsDetail(turnCount: number): string {
  return `turns=${turnCount}(model turns)`;
}

function formatFlagsDetail(row: AgentLiveRow): string | undefined {
  const flags = [
    row.isolated ? "isolated(worktree)" : undefined,
    row.noMcp ? "no-mcp(no MCP tools)" : undefined,
  ].filter((value): value is string => value !== undefined);
  return flags.length > 0 ? `flags=${flags.join(",")}` : undefined;
}

// ── Tool-activity action sub-line (REQ-004, T-196) ───────────────────────────
//
// adapted from @oh-my-pi/pi-coding-agent (MIT, Can Boluk)
//
// Ports the *logic* (not the panel): OMP's `extractToolArgsPreview` priority-key
// order (`task/executor.ts:421`) and the `renderAgentProgress` sub-line composition
// (`task/render.ts:632-645`). The sub-line is a short activity *signal*, not a raw
// command echo — the raw command / output tail live in drill (spec "Action line").

/** Tree hook + indent for the sub-line, per "### Agent row anatomy". */
const TOOL_ACTIVITY_HOOK = "└";
const TOOL_ACTIVITY_INDENT = "   ";
/** Field separator inside the sub-line (` · `, single-spaced — see the mockups). */
const TOOL_ACTIVITY_SEP = " · ";
/** Max columns for the extracted gist (REQ-004: the final gist is at most 24 columns). */
const TOOL_GIST_MAX_COLS = 24;
/** Tool elapsed shows only once past this — OMP's 5s quiets fast-call noise (V3). */
const TOOL_ELAPSED_THRESHOLD_MS = 5000;
/** OMP `extractToolArgsPreview` priority-key order (`task/executor.ts:421`). */
const TOOL_ARG_PRIORITY_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"] as const;

/**
 * The action content (REQ-004): `<verb> · <gist>[ · <t-elapsed>]`, e.g.
 * `bash · npm test`, `read · app.ts`, `bash · npm test · 8s`. Returns `undefined`
 * when no tool is active — the «thinking» kind (a) carries state through the row's
 * own spinner/elapsed/↓tok and gets NO sub-line. The `· <t-elapsed>` timer appears
 * only once the tool has run `> 5s` (kind (c)); ≤5s stays `<verb> · <gist>` (kind (b)).
 *
 * The caller prepends the `└ ` hook + indent (see `#renderToolActivitySubLine`).
 */
export function formatToolActivity(row: AgentLiveRow, now: number = Date.now()): string | undefined {
  const verb = activeToolVerb(row);
  if (verb === undefined) return undefined; // kind (a): no active tool → no sub-line
  // Resolution seam (REQ-004): `gist = intent ?? heuristic(args)`. model-intent
  // (`_i`/lastIntent) is a named future (Q-006/D-009) and is NOT sourced here — only
  // the heuristic runs today; an intent would slot in front without changing this format.
  const gist = toolActivityGist(row.currentToolArgs);
  const parts = [verb];
  if (gist !== "") parts.push(gist);
  const elapsed = toolElapsedLabel(row.currentToolStartMs, now);
  if (elapsed !== undefined) parts.push(elapsed);
  return parts.join(TOOL_ACTIVITY_SEP);
}

/** The active tool = the most recently started tool still in flight, else undefined. */
function activeToolVerb(row: AgentLiveRow): string | undefined {
  return row.currentTools.at(-1);
}

/** `formatDuration` of the running tool, but only past the `>5s` threshold (kind (c)). */
function toolElapsedLabel(startMs: number | undefined, now: number): string | undefined {
  if (startMs === undefined) return undefined;
  const elapsed = now - startMs;
  return elapsed > TOOL_ELAPSED_THRESHOLD_MS ? formatDuration(elapsed) : undefined;
}

/**
 * gist heuristic: pick the first present priority-key from the parsed tool args,
 * then normalize BY KEY — shell command → command-head, path → basename, url → host,
 * everything else (pattern/query/task/prompt) → truncate. Capped at ≤24 columns.
 *
 * Never echoes raw JSON / arg-soup (forbidden by REQ-004): an object with no known
 * key — or an unparseable brace-string — yields `""`, so the composer degrades to a
 * verb-only sub-line (V1) rather than dumping `{…}`.
 */
export function toolActivityGist(argsRaw: string | undefined): string {
  const args = parseToolArgs(argsRaw);
  if (args !== undefined) {
    for (const key of TOOL_ARG_PRIORITY_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value.trim() !== "") return capGist(normalizeToolArg(key, value.trim()));
    }
    return "";
  }
  // Non-object args: a plain descriptive string is usable, but never brace-soup.
  const trimmed = (argsRaw ?? "").trim();
  if (trimmed === "" || trimmed.startsWith("{") || trimmed.startsWith("[")) return "";
  return capGist(trimmed);
}

function normalizeToolArg(key: string, value: string): string {
  if (key === "command") return commandHead(value);
  if (key === "file_path" || key === "path") return basename(value);
  if (key === "url") return urlHost(value);
  return value; // pattern/query/task/prompt → plain truncate (applied by capGist)
}

function capGist(gist: string): string {
  return truncate(gist.trim(), TOOL_GIST_MAX_COLS);
}

/** Parse the args string only when it is a JSON object; otherwise `undefined`. */
function parseToolArgs(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * command-head: a shell command → `binary [subcommand]`. Strips a `/bin/zsh -lc "…"`
 * / `/bin/sh -c '…'` wrapper and surrounding quotes, then keeps the binary plus its
 * next token IFF that token is not a flag: `npm test`, `git commit`; `python3 -c "…"`
 * → `python3` (the `-c` flag is dropped, not a subcommand).
 */
function commandHead(command: string): string {
  const inner = stripSurroundingQuotes(stripShellWrapper(command));
  const tokens = inner.split(/\s+/).filter((token) => token !== "");
  const binary = tokens[0];
  if (binary === undefined) return "";
  const sub = tokens[1];
  return sub !== undefined && !sub.startsWith("-") ? `${binary} ${sub}` : binary;
}

/** Strip a leading `sh -c` / `zsh -lc` / `bash -c` wrapper, returning the inner command. */
function stripShellWrapper(command: string): string {
  const match = command.trim().match(/^(?:\S*\/)?(?:zsh|bash|sh|dash)\s+-[a-z]*c\s+([\s\S]+)$/i);
  return match?.[1] !== undefined ? stripSurroundingQuotes(match[1].trim()) : command.trim();
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Last path segment (POSIX or Windows separators), trailing slashes ignored. */
function basename(pathValue: string): string {
  const cleaned = pathValue.trim().replace(/[/\\]+$/, "");
  const last = cleaned.split(/[/\\]/).at(-1);
  return last !== undefined && last !== "" ? last : cleaned;
}

/** Host of a URL; best-effort strip of scheme+path when it is not absolute. */
function urlHost(url: string): string {
  const value = url.trim();
  try {
    const host = new URL(value).host;
    if (host !== "") return host;
  } catch {
    /* not an absolute URL — fall through to a manual strip */
  }
  const host = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/, 1)[0] ?? "";
  return host !== "" ? host : value;
}

interface StatusMeta {
  icon: string;
  word: string;
  color: string;
}

export function statusMeta(status: AgentLiveStatus, spinnerIndex: number): StatusMeta {
  switch (status) {
    case "queued":
      return { icon: "○", word: "Queued", color: "dim" };
    case "working":
      return { icon: SPINNER_FRAMES[spinnerIndex] ?? "⠿", word: "Working", color: "accent" };
    case "done":
      return { icon: "✓", word: "Done", color: "success" };
    case "cancelled":
      return { icon: "⊘", word: "Cancelled", color: "dim" };
    case "error":
      return { icon: "✗", word: "Error", color: "warning" };
  }
}

export function elapsedSinceStart(row: AgentLiveRow): number | undefined {
  if (row.startedAt === undefined) return undefined;
  return Math.max(0, Date.now() - row.startedAt);
}

/**
 * Human-readable elapsed with s → m → h tiers; sub-second is hidden as `<1s`
 * instead of noisy millisecond counts (T-188 W7, fix-candidate #7).
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds > 0 ? `${totalMinutes}m${seconds}s` : `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

export function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 0) return "";
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}
