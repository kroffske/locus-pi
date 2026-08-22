/**
 * beta-gate.ts — the one switch a beta-tier extension asks before it registers anything.
 *
 * WHY THE GATE LIVES INSIDE THE EXTENSION
 *
 * Pi reads only `pi.extensions` from a package manifest. There is no "shipped but off by
 * default" flag for a package to set, and the per-package `extensions` filter is the
 * user's setting to write, not the package's. When Pi loads an entrypoint it calls the
 * factory with `api` alone — no cwd, no session context — and tools, commands and hooks
 * may only be registered during that call. So a beta extension cannot be withheld by the
 * host; it can only decline to register itself, and it has to decide synchronously from
 * process-level state.
 *
 * TWO SOURCES, EITHER ONE ENABLES
 *
 *   LOCUS_PI_BETA=loop,plan                            one session, nothing to clean up;
 *   <cwd>/.locus-pi/config.json -> { "beta": ["loop"] } the project's standing choice.
 *
 * `all` or `*` in either list enables every beta extension. The config file shares the
 * `.locus-pi/` project root that already holds `runs/`, `plans/` and `fusion/config.json`
 * — spelled out below rather than imported, because a `_shared` layer may not depend on
 * the workflows feature directory that owns `WORKFLOW_ROOT_DIRNAME`.
 *
 * `<cwd>` is `process.cwd()`, the directory Pi was started in, because that is the only
 * project location a factory can see. A user who starts Pi elsewhere and expects a
 * project file to be read is the one case this cannot serve; `LOCUS_PI_BETA` is the
 * answer there.
 *
 * FAIL CLOSED
 *
 * Anything that is not an explicit opt-in leaves the extension off: no file, no `beta`
 * key, unreadable file, unparseable JSON, a `beta` that is not a list of ids. A malformed
 * config writes one line to stderr and returns false. It never throws: a throw here
 * happens inside Pi's extension loader, which would turn a typo in a config file into a
 * failed session.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** Session-scoped opt-in. Comma-separated ids; `all` or `*` enables every beta extension. */
export const BETA_ENV_VAR = "LOCUS_PI_BETA";

/** Project runtime root. Kept in sync by hand with `workflows/runtime/workflow-run-layout.ts`. */
export const BETA_CONFIG_DIRNAME = ".locus-pi";

/** Project-local settings file, read for its `beta` array and nothing else. */
export const BETA_CONFIG_FILENAME = "config.json";

/** Either list may name this instead of an id to enable every beta extension. */
const WILDCARDS = new Set(["all", "*"]);

/**
 * One warning per config path per process, so three beta entrypoints reporting the same
 * malformed file produce one line rather than three. Pi loads each entrypoint with the
 * module cache disabled, giving every one its own copy of this module, so a plain
 * module-level Set would dedupe within an entrypoint and not across them. The versioned
 * `globalThis` slot is the package's declared mechanism for exactly that; it is owned
 * here and named in `scripts/check-extension-layers.ts#REGISTRIES`.
 */
const WARNED_CONFIGS = Symbol.for("locus-pi.beta-config-warnings.v1");

interface WarningRegistryHost {
  [WARNED_CONFIGS]?: Set<string>;
}

export interface BetaGateOptions {
  /** Defaults to `process.env`. Tests pass their own so they never mutate the real one. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.cwd()`, the project directory Pi was started in. */
  cwd?: string;
}

/** Where `betaEnabled` looks for the standing project opt-in. */
export function betaConfigPath(cwd: string): string {
  return path.join(cwd, BETA_CONFIG_DIRNAME, BETA_CONFIG_FILENAME);
}

/**
 * Whether the beta extension `id` may register its surfaces. Enabled by either source;
 * everything else, including every malformed input, answers false.
 */
export function betaEnabled(id: string, options: BetaGateOptions = {}): boolean {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  // Both sources are consulted on every call rather than short-circuited, so whether a
  // malformed config is reported never depends on which ids the environment happens to name.
  const fromEnv = listEnables(parseList(env[BETA_ENV_VAR]), id);
  const fromConfig = listEnables(configuredBeta(cwd), id);
  return fromEnv || fromConfig;
}

function listEnables(entries: readonly string[], id: string): boolean {
  return entries.some((entry) => entry === id || WILDCARDS.has(entry));
}

/** `"loop, plan"` and `"loop,,plan"` both mean the same two ids; blank means none. */
function parseList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** The `beta` array of the project config, or an empty list plus one warning. */
function configuredBeta(cwd: string): string[] {
  const configPath = betaConfigPath(cwd);
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    // No config is the normal case for every project that never opted in, and a path
    // component that is not a directory is the same absence with a different errno.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") warnOnce(configPath, `cannot be read: ${messageOf(error)}`);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warnOnce(configPath, `is not valid JSON: ${messageOf(error)}`);
    return [];
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnOnce(configPath, "must contain a JSON object");
    return [];
  }

  // A config with no `beta` key is a complete, valid config that enables nothing.
  const beta = (parsed as Record<string, unknown>)["beta"];
  if (beta === undefined) return [];
  if (!Array.isArray(beta) || beta.some((entry) => typeof entry !== "string")) {
    warnOnce(configPath, `"beta" must be an array of extension ids`);
    return [];
  }
  return (beta as string[]).map((entry) => entry.trim()).filter((entry) => entry !== "");
}

function warnOnce(configPath: string, reason: string): void {
  const host = globalThis as WarningRegistryHost;
  const warned = (host[WARNED_CONFIGS] ??= new Set<string>());
  if (warned.has(configPath)) return;
  warned.add(configPath);
  process.stderr.write(`locus-pi: ${configPath} ignored: ${reason}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
