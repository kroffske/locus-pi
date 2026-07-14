import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path, { basename, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModeName = "plan" | "workflow";
export type ModeStatus = "active" | "draft";

export interface ModeState {
  version: 1;
  mode: ModeName | null;
  slug: string;
  activeArtifactPath: string;
  enteredAt: string;
  status: ModeStatus;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stale threshold: 24 hours in milliseconds. */
export const STALE_MS = 86_400_000;

/** The project-local path for the active mode state record. */
export function modeStatePath(projectRoot: string): string {
  return path.join(projectRoot, ".locus", "runtime", "mode", "state.json");
}

// ---------------------------------------------------------------------------
// Cleared / empty sentinel
// ---------------------------------------------------------------------------

function clearedSentinel(): ModeState {
  return {
    version: 1,
    mode: null,
    slug: "",
    activeArtifactPath: "",
    enteredAt: "",
    status: "draft",
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidModeState(candidate: unknown): candidate is ModeState {
  if (!candidate || typeof candidate !== "object") return false;
  const obj = candidate as Record<string, unknown>;
  if (obj["version"] !== 1) return false;
  if (obj["mode"] !== null && obj["mode"] !== "plan" && obj["mode"] !== "workflow") return false;
  if (typeof obj["slug"] !== "string") return false;
  if (typeof obj["activeArtifactPath"] !== "string") return false;
  if (typeof obj["enteredAt"] !== "string") return false;
  if (obj["status"] !== "active" && obj["status"] !== "draft") return false;
  return true;
}

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

/**
 * Raw load — no staleness check. Returns null on missing/corrupt/invalid file.
 * Used for diagnostics and round-trip tests.
 */
export function loadModeState(projectRoot: string): ModeState | null {
  const filePath = modeStatePath(projectRoot);
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isValidModeState(parsed)) return parsed;
  } catch {
    // missing or corrupt — return null
  }
  return null;
}

/**
 * Staleness check — true if the state is active and its enteredAt is older than
 * STALE_MS from `now`.
 */
export function isStaleModeState(state: ModeState, now = Date.now()): boolean {
  if (state.mode === null) return false;
  const entered = Date.parse(state.enteredAt);
  if (Number.isNaN(entered)) return true;
  return now - entered > STALE_MS;
}

/**
 * Staleness-aware accessor. Returns null when:
 * - no state file / corrupt
 * - mode is non-null AND the record is stale
 *
 * This is the accessor that the hook and command use so a crashed/abandoned
 * session cannot leave the read-guard armed indefinitely.
 */
export function loadActiveModeState(projectRoot: string, now = Date.now()): ModeState | null {
  const state = loadModeState(projectRoot);
  if (state === null) return null;
  if (state.mode !== null && isStaleModeState(state, now)) return null;
  return state;
}

/** Write mode state to disk, creating parent directories as needed. */
export function writeModeState(projectRoot: string, state: ModeState): void {
  const filePath = modeStatePath(projectRoot);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/**
 * Clear the mode state by writing the cleared sentinel.
 * Concurrent loads see a definite cleared record rather than ENOENT ambiguity.
 */
export function clearModeState(projectRoot: string): void {
  writeModeState(projectRoot, clearedSentinel());
}

/** True when the state record indicates an active plan mode. */
export function isInPlanMode(state: ModeState | null): boolean {
  return state?.mode === "plan";
}

// ---------------------------------------------------------------------------
// Slug / path helpers
// ---------------------------------------------------------------------------

/**
 * Lowercase slugify: replaces non-[a-z0-9] runs with '-', trims edges.
 * Falls back to 'plan' on empty result.
 */
export function slugify(s: string): string {
  const result = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return result || "plan";
}

/**
 * Normalize a git remote URL to a canonical `host/path` string.
 * - Strips credentials (user:pass@)
 * - Folds git@host:path → host/path
 * - Folds https?://host/path → host/path, ssh://host/path → host/path
 * - Drops a single trailing .git
 * - Lowercases
 */
export function normalizeRemote(url: string): string {
  let s = url.trim();

  // git@github.com:Org/Repo.git → github.com/Org/Repo.git
  const sshShort = /^[^/@]+@([^:]+):(.+)$/.exec(s);
  if (sshShort) {
    s = `${sshShort[1]}/${sshShort[2]}`;
  } else {
    // strip scheme + optional credentials
    s = s.replace(/^(?:https?|ssh|git):\/\//, "");
    // strip user:pass@ prefix
    s = s.replace(/^[^@/]*@/, "");
    // strip user:pass@ after scheme was removed (host only case)
    s = s.replace(/^[^:@/]+:[^/@]+@/, "");
  }

  // drop trailing .git (single occurrence)
  s = s.replace(/\.git$/, "");

  // normalize trailing slash
  s = s.replace(/\/+$/, "");

  return s.toLowerCase();
}

/**
 * Returns the normalized canonical git remote URL for the given project root,
 * or undefined if there is no remote or git is unavailable.
 */
export function canonicalGitRemote(projectRoot: string): string | undefined {
  try {
    const raw = execFileSync("git", ["-C", projectRoot, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!raw) return undefined;
    return normalizeRemote(raw);
  } catch {
    return undefined;
  }
}

/**
 * Deterministic project slug: `slugify(basename(key)) + "-" + sha256(key).slice(0,12)`
 * where `key = canonicalGitRemote(projectRoot) ?? realpathSync(projectRoot)`.
 *
 * SSH and HTTPS of the same origin collapse to the same slug.
 * Two distinct repos always produce different slugs.
 */
export function projectSlug(projectRoot: string): string {
  const key = canonicalGitRemote(projectRoot) ?? realpathSync(projectRoot);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `${slugify(basename(key))}-${hash}`;
}

/**
 * Collision-safe plan slug: `<slugified-request-up-to-48-chars>-<YYYYMMDD>-<time36>`.
 * Two calls with the same request on the same day differ via the time36 suffix.
 */
export function planSlug(request: string, now = new Date()): string {
  const body = slugify(request.split(/\r?\n/)[0] ?? "").slice(0, 48).replace(/-+$/, "");
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = now.getTime().toString(36).slice(-4);
  return `${body}-${date}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Home override + user-level paths
// ---------------------------------------------------------------------------

/**
 * Resolves the locus-pi home directory, honouring the env override so tests
 * never touch the real ~/.pi. Uses the same override var as model-settings.ts
 * (PI_MODEL_ROLES_HOME strips to its parent .pi) OR the dedicated
 * LOCUS_PI_HOME var.
 *
 * Priority:
 *   1. process.env.LOCUS_PI_HOME  (dedicated override for mode-state / plan)
 *   2. os.homedir()
 */
export function piHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["LOCUS_PI_HOME"] ?? homedir();
}

/**
 * Directory under which plan artifacts for this project are stored.
 * `<piHome>/.pi/locus-pi/<project-slug>/plans/`
 */
export function userPlansDir(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(piHome(env), ".pi", "locus-pi", projectSlug(projectRoot), "plans");
}

/**
 * Absolute path to a plan artifact file.
 * `<userPlansDir>/<slug>.md`
 */
export function planArtifactPath(projectRoot: string, slug: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(userPlansDir(projectRoot, env), `${slug}.md`);
}

/**
 * Returns all plan slugs available under the user-level plans dir for this
 * project, sorted descending (newest first by filename). Returns [] on ENOENT.
 */
export function listPlanSlugs(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = userPlansDir(projectRoot, env);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => basename(f, ".md"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Mode cycle (default ⇄ plan, extensible)
// ---------------------------------------------------------------------------

/**
 * Ordered, cyclable list of behavioral modes. "default" is the normal harness
 * behavior (no overlay); "plan" overlays a planning framing. Append future modes
 * here (e.g. "workflow") to extend the Shift+Tab / `/mode` cycle — the cycle
 * logic is data-driven off this list, so adding a mode is mechanical.
 */
export const MODE_CYCLE = ["default", "plan"] as const;
export type CycleMode = (typeof MODE_CYCLE)[number];

/** The current cycle position implied by a persisted ModeState. */
export function currentCycleMode(state: ModeState | null): CycleMode {
  return isInPlanMode(state) ? "plan" : "default";
}

/** The next mode after `mode` in the cycle, wrapping around the end. */
export function nextCycleMode(mode: CycleMode, cycle: readonly CycleMode[] = MODE_CYCLE): CycleMode {
  const idx = cycle.indexOf(mode);
  if (idx < 0) return cycle[0] ?? "default";
  return cycle[(idx + 1) % cycle.length] ?? "default";
}

/**
 * Pure: the ModeState to persist when entering a cycle mode via Shift+Tab or
 * `/mode`. "default" yields the cleared sentinel; "plan" arms plan mode with an
 * empty slug — a cycle-armed plan carries no authored artifact (that comes from
 * `/plan <request>`).
 */
export function modeStateForCycle(mode: CycleMode, now: Date = new Date()): ModeState {
  if (mode === "plan") {
    return {
      version: 1,
      mode: "plan",
      slug: "",
      activeArtifactPath: "",
      enteredAt: now.toISOString(),
      status: "active",
    };
  }
  return clearedSentinel();
}

/** Short status-bar label for a mode, or undefined to clear the label. */
export function modeStatusLabel(state: ModeState | null): string | undefined {
  if (!isInPlanMode(state)) return undefined;
  return state?.slug ? `PLAN — ${state.slug}` : "PLAN";
}

/** The theme color key used for the plan-mode badge and editor border. */
export const PLAN_MODE_COLOR = "accent";

/** Minimal theme slice needed to style the status badge. */
interface BadgeTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/**
 * Style a mode status label as a colored badge using the live theme. Returns the
 * label unchanged when no theme is available (e.g. non-interactive mode or the
 * test harness), so plain-text assertions stay stable. The badge color matches
 * the plan-mode editor border so both cues read as the same "plan" signal.
 */
export function styleModeStatusLabel(label: string, theme?: BadgeTheme): string {
  if (!theme) return label;
  return theme.bold(theme.fg(PLAN_MODE_COLOR, label));
}

/**
 * Build a `CustomEditor` subclass whose border color follows the active mode:
 * `planColor` while `isPlanActive()` is true, otherwise the color the host last
 * assigned (thinking-level / bash-mode border). This is the only seam Pi exposes
 * for recoloring the input — `setEditorComponent` installs a factory that returns
 * an instance of this class.
 *
 * Implementation note: Pi's `Editor` declares `borderColor` as a class field, so
 * `super()` creates an own data property on the instance that would shadow a
 * prototype accessor. We therefore redefine `borderColor` as an own accessor in
 * the constructor *after* `super()`, capturing whatever the host assigns into a
 * closed-over `base` and returning `planColor` while plan mode is active. The
 * Base type comes from the host package at runtime, so it is intentionally loose.
 */
export function makeModeAwareEditorClass(
  Base: new (...args: any[]) => any,
  planColor: (str: string) => string,
  isPlanActive: () => boolean,
): new (...args: any[]) => any {
  return class ModeAwareEditor extends Base {
    constructor(...args: any[]) {
      super(...args);
      // Whatever the base constructor stored (the default/theme border color).
      let base: (str: string) => string = (this as any).borderColor;
      Object.defineProperty(this, "borderColor", {
        configurable: true,
        enumerable: true,
        get: () => (isPlanActive() ? planColor : base),
        set: (value: (str: string) => string) => {
          base = value;
        },
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Shift+Tab un-reserve helper (frees the chord for the mode cycle)
// ---------------------------------------------------------------------------

/** The keybindings.json action that, set to `[]`, frees `shift+tab`. */
export const THINKING_CYCLE_ACTION = "app.thinking.cycle";
/** Human-readable description of the disable entry (for command/widget text). */
export const THINKING_CYCLE_DISABLE_LINE = `"${THINKING_CYCLE_ACTION}": []`;

/**
 * Path to the real Pi agent keybindings file. Pi 0.80.x reads
 * `<agentDir>/keybindings.json` (JSON), where agentDir defaults to `~/.pi/agent`
 * and is overridden by PI_CODING_AGENT_DIR. This is the live Pi agent dir, NOT
 * the locus-pi plan home (LOCUS_PI_HOME).
 */
export function agentKeybindingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env["PI_CODING_AGENT_DIR"] ?? path.join(homedir(), ".pi", "agent");
  return path.join(agentDir, "keybindings.json");
}

/**
 * Pure transform that frees Shift+Tab by disabling `app.thinking.cycle` in a Pi
 * keybindings.json (a JSON `action -> chord(s)` map; `[]` means disabled).
 * Idempotent: reports `alreadyDisabled` without changing content. Preserves any
 * other bindings. Reports `parseError` rather than clobbering unparseable JSON.
 */
export function withThinkingCycleDisabled(existing: string): { content: string; changed: boolean; alreadyDisabled: boolean; parseError?: true } {
  const trimmed = existing.trim();
  let parsed: Record<string, unknown> = {};
  if (trimmed !== "") {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return { content: existing, changed: false, alreadyDisabled: false, parseError: true };
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      return { content: existing, changed: false, alreadyDisabled: false, parseError: true };
    }
    parsed = json as Record<string, unknown>;
  }
  const current = parsed[THINKING_CYCLE_ACTION];
  if (Array.isArray(current) && current.length === 0) {
    return { content: existing, changed: false, alreadyDisabled: true };
  }
  parsed[THINKING_CYCLE_ACTION] = [];
  return { content: `${JSON.stringify(parsed, null, 2)}\n`, changed: true, alreadyDisabled: false };
}

// ---------------------------------------------------------------------------
// Plan-mode behavioral injection
// ---------------------------------------------------------------------------

/**
 * The planning-mode system-prompt overlay. v2 plan mode is BEHAVIORAL: it tells
 * the model to compose a plan instead of implementing, while ALLOWING commands
 * and throwaway scripts. It does NOT restrict tools (the v1 read-only block is
 * gone). Injected via `before_agent_start` while the active mode is "plan".
 */
export function planModeInjectionText(state: ModeState | null): string {
  const activePlan = state?.slug ? ` Active plan slug: ${state.slug}.` : "";
  return [
    "<planning_mode>",
    `You are in PLANNING mode.${activePlan} Your job is to produce a clear, actionable`,
    "PLAN for the user's request — NOT to implement the solution.",
    "- Investigate freely: read files, run read-only commands, and you MAY write and",
    "  run a small throwaway script (e.g. python) when running code is the fastest way",
    "  to answer a question the plan depends on.",
    "- Do NOT implement the actual feature or make production code changes here — that",
    "  happens after the user switches out of plan mode (execution).",
    "- Produce a plan: goal, approach, concrete ordered steps, risks, and open questions.",
    "</planning_mode>",
  ].join("\n");
}
