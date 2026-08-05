import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  CustomUiComponent,
  ExtensionContext,
  FooterDataProviderLike,
  ReplacementSessionEntryLike,
  ThemeLike,
  WidgetFactoryTui,
} from "../_shared/host/pi-api.js";
import { formatTokenCount } from "../_shared/agent-runtime/agent-live-panel.js";

const BAR_BACKGROUND = "\u001b[48;2;42;27;61m";
const BAR_FOREGROUND = "\u001b[38;2;222;201;255m";
const BAR_RESET = "\u001b[0m";
const SEPARATOR = " │ ";
const COMPACTED_VISIBLE_MS = 12_000;

export type CompactionDisplayState =
  { kind: "idle" } | { kind: "compacting" } | { kind: "compacted"; tokensBefore?: number; completedAt: number };

interface UsageTotals {
  input: number;
  output: number;
}

export interface StatusLineSnapshot {
  model: string;
  cwd: string;
  worktree?: string;
  branch?: string;
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
  usage: UsageTotals;
  extensionStatuses: string[];
  compaction: CompactionDisplayState;
}

export class LocusFooterComponent implements CustomUiComponent {
  #unsubscribeBranch: (() => void) | undefined;
  #clearCompactedTimer: ReturnType<typeof setTimeout> | undefined;
  #compaction: CompactionDisplayState = { kind: "idle" };

  constructor(
    private readonly tui: WidgetFactoryTui,
    private readonly theme: ThemeLike,
    private readonly ctx: ExtensionContext,
    private readonly footerData: FooterDataProviderLike,
  ) {
    this.#unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
  }

  setCompaction(state: CompactionDisplayState): void {
    this.#compaction = state;
    if (this.#clearCompactedTimer !== undefined) clearTimeout(this.#clearCompactedTimer);
    this.#clearCompactedTimer = undefined;
    if (state.kind === "compacted") {
      this.#clearCompactedTimer = setTimeout(() => {
        this.#compaction = { kind: "idle" };
        this.#clearCompactedTimer = undefined;
        this.tui.requestRender();
      }, COMPACTED_VISIBLE_MS);
      this.#clearCompactedTimer.unref?.();
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    this.#unsubscribeBranch?.();
    this.#unsubscribeBranch = undefined;
    if (this.#clearCompactedTimer !== undefined) clearTimeout(this.#clearCompactedTimer);
    this.#clearCompactedTimer = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const plain = renderStatusLine(snapshotStatusLine(this.ctx, this.footerData, this.#compaction), safeWidth);
    const padded = `${plain}${" ".repeat(Math.max(0, safeWidth - visibleWidth(plain)))}`;
    // Stable violet identity. Semantic content remains plain text and survives
    // terminals/themes that strip ANSI styling.
    return [`${BAR_BACKGROUND}${BAR_FOREGROUND}${padded}${BAR_RESET}`];
  }
}

export function snapshotStatusLine(
  ctx: ExtensionContext,
  footerData: FooterDataProviderLike,
  compaction: CompactionDisplayState = { kind: "idle" },
): StatusLineSnapshot {
  const cwd = ctx.sessionManager?.getCwd?.() ?? ctx.session?.workingDirectory ?? ctx.cwd ?? process.cwd();
  const entries = ctx.sessionManager?.getEntries() ?? [];
  const usage = aggregateSessionUsage(Array.isArray(entries) ? entries : []);
  const context = ctx.getContextUsage?.();
  const modelName = ctx.model?.id ?? "no-model";
  const effort = ctx.thinkingLevel;
  const worktree = detectLinkedWorktree(cwd);
  const branch = footerData.getGitBranch();
  return {
    model: effort === undefined || effort === "off" ? modelName : `${modelName} ${effort}`,
    cwd: formatStatusCwd(cwd),
    ...(worktree === undefined ? {} : { worktree }),
    ...(branch === null ? {} : { branch }),
    contextTokens: context?.tokens ?? null,
    contextWindow: context?.contextWindow ?? numericField(ctx.model, "contextWindow") ?? 0,
    contextPercent: context?.percent ?? null,
    usage,
    extensionStatuses: [...footerData.getExtensionStatuses().entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => sanitizeSingleLine(value))
      .filter((value) => value !== ""),
    compaction,
  };
}

export function renderStatusLine(snapshot: StatusLineSnapshot, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const fullContext = formatContext(snapshot, true);
  const compactContext = formatContext(snapshot, false);
  const tokens = formatUsage(snapshot.usage);
  const compact = formatCompaction(snapshot);
  const cwdBase = path.basename(snapshot.cwd) || snapshot.cwd;
  const full = [
    snapshot.model,
    snapshot.cwd,
    ...(snapshot.worktree === undefined ? [] : [`wt:${snapshot.worktree}`]),
    ...(snapshot.branch === undefined ? [] : [`git:${snapshot.branch}`]),
    fullContext,
    tokens,
    compact,
    ...snapshot.extensionStatuses,
  ];
  const medium = [
    snapshot.model,
    cwdBase,
    ...(snapshot.worktree === undefined ? [] : [`wt:${snapshot.worktree}`]),
    ...(snapshot.branch === undefined ? [] : [`git:${shortTail(snapshot.branch, 24)}`]),
    compactContext,
    tokens,
    compact,
  ];
  const mediumEssential = [
    snapshot.model,
    cwdBase,
    ...(snapshot.worktree === undefined ? [] : [`wt:${shortTail(snapshot.worktree, 16)}`]),
    compactContext,
    tokens,
    compact,
  ];
  const wideEssential = [
    snapshot.model,
    snapshot.cwd,
    ...(snapshot.worktree === undefined ? [] : [`wt:${snapshot.worktree}`]),
    ...(snapshot.branch === undefined ? [] : [`git:${shortTail(snapshot.branch, 24)}`]),
    fullContext,
    tokens,
    compact,
  ];
  const narrow = [
    snapshot.model,
    `ctx${snapshot.contextPercent === null ? "?" : `${snapshot.contextPercent.toFixed(1)}%`}`,
    formatShortUsage(snapshot.usage),
    compact === "compact:Pi" ? "Pi" : compact,
  ];
  for (const segments of [full, wideEssential, medium, mediumEssential, narrow]) {
    const candidate = segments.filter((value) => value !== "").join(SEPARATOR);
    if (visibleWidth(candidate) <= safeWidth) return candidate;
  }
  return truncatePlain(narrow.join(SEPARATOR), safeWidth);
}

export function aggregateSessionUsage(entries: readonly ReplacementSessionEntryLike[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0 };
  for (const entry of entries) {
    const usage = entryUsage(entry);
    if (usage === undefined) continue;
    totals.input += numericField(usage, "input") ?? 0;
    totals.output += numericField(usage, "output") ?? 0;
  }
  return totals;
}

export function detectLinkedWorktree(start: string): string | undefined {
  let cursor = path.resolve(start);
  while (true) {
    const gitPath = path.join(cursor, ".git");
    try {
      if (statSync(gitPath).isFile()) {
        const match = /^gitdir:\s*(.+)$/imu.exec(readFileSync(gitPath, "utf8"));
        if (match?.[1] === undefined) return undefined;
        const normalized = match[1].trim().replaceAll("\\", "/");
        const worktreeMatch = /\/worktrees\/([^/]+)\/?$/u.exec(normalized);
        return worktreeMatch?.[1];
      }
      if (statSync(gitPath).isDirectory()) return undefined;
    } catch {
      // Not a repository root; continue upward.
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function entryUsage(entry: ReplacementSessionEntryLike): Record<string, unknown> | undefined {
  if ((entry.type === "compaction" || entry.type === "branch_summary") && isRecord(entry.usage)) return entry.usage;
  if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
  const role = entry.message.role;
  if (role !== "assistant" && role !== "toolResult") return undefined;
  return isRecord(entry.message.usage) ? entry.message.usage : undefined;
}

function formatStatusCwd(cwd: string): string {
  const home = os.homedir();
  const relative = path.relative(home, cwd);
  if (relative === "") return "~";
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return `~${path.sep}${relative}`;
  }
  return cwd;
}

function formatContext(snapshot: StatusLineSnapshot, includeTokens: boolean): string {
  const percent = snapshot.contextPercent === null ? "?" : `${snapshot.contextPercent.toFixed(1)}%`;
  if (!includeTokens)
    return snapshot.contextWindow > 0 ? `ctx:${percent}/${formatTokenCount(snapshot.contextWindow)}` : `ctx:${percent}`;
  const current = snapshot.contextTokens === null ? "?" : formatTokenCount(snapshot.contextTokens);
  const window = snapshot.contextWindow > 0 ? formatTokenCount(snapshot.contextWindow) : "?";
  return `ctx:${current}/${window} ${percent}`;
}

function formatUsage(usage: UsageTotals): string {
  if (usage.input === 0 && usage.output === 0) return "tok:—";
  return `↑${formatTokenCount(usage.input)} ↓${formatTokenCount(usage.output)}`;
}

function formatShortUsage(usage: UsageTotals): string {
  if (usage.input === 0 && usage.output === 0) return "tok:—";
  return `↑${formatRoundedTokens(usage.input)} ↓${formatRoundedTokens(usage.output)}`;
}

function formatRoundedTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.trunc(tokens)));
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${Math.round(tokens / 1_000_000)}M`;
}

function formatCompaction(snapshot: StatusLineSnapshot): string {
  if (snapshot.compaction.kind === "compacting") return "COMPACTING";
  if (snapshot.compaction.kind === "idle") return "compact:Pi";
  const before = snapshot.compaction.tokensBefore;
  const after = snapshot.contextTokens;
  if (before === undefined)
    return after === null ? "COMPACTED · measuring…" : `COMPACTED · → ${formatTokenCount(after)}`;
  return `COMPACTED · ${formatTokenCount(before)} → ${after === null ? "measuring…" : formatTokenCount(after)}`;
}

function shortTail(value: string, max: number): string {
  if (value.length <= max) return value;
  return `…${value.slice(-(max - 1))}`;
}

function sanitizeSingleLine(value: string): string {
  return value
    .replace(/[\r\n\t\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncatePlain(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  if (width <= 1) return "…".slice(0, width);
  const points = Array.from(value);
  while (points.length > 0 && visibleWidth(`${points.join("")}…`) > width) points.pop();
  return `${points.join("")}…`;
}

function numericField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
