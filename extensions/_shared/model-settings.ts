import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, ThinkingLevel } from "./pi-api.js";
import { getProjectRoot } from "./pi-api.js";

const USER_HOME_ENV = "PI_MODEL_ROLES_HOME";
export const DEFAULT_MODEL_ROLES = [
  "default",
  "smol",
  "slow",
  "plan",
  "summary",
  "agent",
  "vision",
  "designer",
  "commit",
  "task",
] as const;
export const DEFAULT_MODEL_CYCLE_ORDER = ["smol", "default", "slow"] as const;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const MODEL_ROLES_SESSION_ENTRY_TYPE = "model-roles";

export type ModelRoleSource = "session" | "settings" | "user" | "project" | "agent" | "unset";
export type ModelRolePurpose = "prompt-planning" | "summary" | "agent" | "default";

export interface ModelRoleAssignment {
  model: string;
  thinking?: ThinkingLevel;
}

export type ModelRoleValue = string | ModelRoleAssignment | null;

export interface ModelRolesConfig {
  version?: 1;
  roles?: Record<string, ModelRoleValue>;
  cycleOrder?: string[];
}

export interface ModelRoleSessionEntry {
  version?: 1;
  role?: string;
  assignment?: ModelRoleValue;
  roles?: Record<string, ModelRoleValue>;
  modelApplied?: boolean;
  rolePersisted?: boolean;
}

export interface ModelRolesConfigPaths {
  user: string;
  project: string;
}

/**
 * An assignment the operator DID write and this code could not parse.
 *
 * Distinct from "unset" on purpose. Collapsing the two is what let
 * `smol: "deepseek-v4-flash"` (a missing `provider/`) read as an unassigned role and
 * quietly run the parent's model under the name `smol`, while the degradation note
 * told the operator the role "is not assigned in any model-roles layer" — a false
 * statement about their own config file, and the exact requested-vs-executed
 * conflation this task exists to remove. A typo is OD5's fail-closed case.
 */
export interface MalformedRoleAssignment {
  /** The raw text as written, quoted back so the operator can find it. */
  value: string;
  /** Which layer carried it, so the operator knows which file to edit. */
  layer: ModelRoleSource;
}

export interface EffectiveRole {
  role: string;
  source: ModelRoleSource;
  inherited: boolean;
  assignment?: ModelRoleAssignment;
  malformed?: MalformedRoleAssignment;
}

export interface ModelRolesState {
  paths: ModelRolesConfigPaths;
  settings: ModelRolesConfig;
  session: ModelRolesConfig;
  user: ModelRolesConfig;
  project: ModelRolesConfig;
  effective: Map<string, EffectiveRole>;
  cycleOrder: string[];
}

export interface ModelRoleResolution {
  purpose: ModelRolePurpose;
  requestedRoles: string[];
  role: string;
  source: ModelRoleSource;
  inherited: boolean;
  assignment?: ModelRoleAssignment;
  /** Set when the role's assignment exists but is not a parseable selector. */
  malformed?: MalformedRoleAssignment;
  fallback: boolean;
}

export interface ModelRoleResolutionRecord {
  purpose: ModelRolePurpose;
  requestedRoles: string[];
  role: string;
  source: ModelRoleSource;
  inherited: boolean;
  fallback: boolean;
  model?: string;
  thinking?: ThinkingLevel;
}

export function getModelRolesConfigPaths(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelRolesConfigPaths {
  const userRoot = env[USER_HOME_ENV] ?? join(homedir(), ".pi", "agent");
  return {
    user: join(userRoot, "model-roles", "config.json"),
    project: join(projectRoot, ".pi", "model-roles", "config.json"),
  };
}

export async function loadModelRolesState(ctx: ExtensionContext): Promise<ModelRolesState> {
  const paths = getModelRolesConfigPaths(getProjectRoot(ctx));
  const session = await readSessionConfig(ctx);
  const settings = readSettingsConfig(ctx);
  const user = await readConfig(paths.user);
  const project = await readConfig(paths.project);
  return buildModelRolesState(paths, session, settings, user, project);
}

export function buildModelRolesState(
  paths: ModelRolesConfigPaths,
  session: ModelRolesConfig,
  settings: ModelRolesConfig,
  user: ModelRolesConfig,
  project: ModelRolesConfig,
): ModelRolesState {
  const cycleOrder = session.cycleOrder ??
    settings.cycleOrder ??
    project.cycleOrder ??
    user.cycleOrder ?? [...DEFAULT_MODEL_CYCLE_ORDER];
  const roles = new Set([
    ...DEFAULT_MODEL_ROLES,
    ...Object.keys(user.roles ?? {}),
    ...Object.keys(project.roles ?? {}),
    ...Object.keys(settings.roles ?? {}),
    ...Object.keys(session.roles ?? {}),
    ...cycleOrder,
  ]);
  const effective = new Map<string, EffectiveRole>();
  for (const role of roles) {
    const sessionValue = session.roles?.[role];
    const settingsValue = settings.roles?.[role];
    const projectValue = project.roles?.[role];
    const userValue = user.roles?.[role];
    // A value the operator wrote but this code cannot parse is recorded as
    // `malformed`, never as plain "unset": the caller has to be able to tell a role
    // nobody assigned (degrade, per OD5) from a typo (fail closed, per OD5).
    const present = (
      value: Exclude<ModelRoleValue, null>,
      layer: ModelRoleSource,
      inherited: boolean,
    ): EffectiveRole => {
      const assignment = normalizeAssignment(value);
      if (assignment) return { role, source: layer, inherited, assignment };
      return { role, source: "unset", inherited, malformed: { value: rawAssignmentText(value), layer } };
    };
    if (sessionValue !== undefined && sessionValue !== null) {
      effective.set(role, present(sessionValue, "session", false));
    } else if (settingsValue !== undefined && settingsValue !== null) {
      effective.set(role, present(settingsValue, "settings", false));
    } else if (projectValue !== undefined && projectValue !== null) {
      effective.set(role, present(projectValue, "project", false));
    } else if (userValue !== undefined && userValue !== null) {
      effective.set(role, present(userValue, "user", projectValue === null));
    } else {
      effective.set(role, { role, source: "unset", inherited: projectValue === null });
    }
  }
  return { paths, session, settings, user, project, effective, cycleOrder };
}

export function resolveModelRoleForPurpose(
  state: ModelRolesState,
  purpose: ModelRolePurpose,
  preferredRoles: string[] = [],
): ModelRoleResolution {
  const requestedRoles = [...preferredRoles, ...defaultRolesForPurpose(purpose)];
  for (const role of requestedRoles) {
    const effective = state.effective.get(role);
    if (effective?.assignment) {
      return {
        purpose,
        requestedRoles,
        role,
        source: effective.source,
        inherited: effective.inherited,
        assignment: effective.assignment,
        fallback: role !== requestedRoles[0],
      };
    }
  }
  // Nothing in the chain resolved. If one of the roles we consulted carries a
  // malformed assignment, that is why, and saying "unassigned" here would hide an
  // operator typo behind a silent degrade on the no-tier-declared path too.
  const malformed = requestedRoles
    .map((name) => state.effective.get(name)?.malformed)
    .find((entry) => entry !== undefined);
  return {
    purpose,
    requestedRoles,
    role: requestedRoles[0] ?? "default",
    source: "unset",
    inherited: false,
    ...(malformed !== undefined ? { malformed } : {}),
    fallback: true,
  };
}

/**
 * Resolve ONE declared role, with no purpose fallback chain.
 *
 * `resolveModelRoleForPurpose` walks `preferred → agent → task → default`, which is
 * right for "give me something reasonable for this purpose" and wrong for an author
 * who wrote `modelRole: "smol"`: falling through to `agent` would answer a question
 * nobody asked and run a different tier under the requested tier's name. So a
 * declared role resolves to its own assignment or to none at all, and the caller
 * decides what "none" means (today: degrade to the parent model and record it).
 */
export function resolveDeclaredModelRole(state: ModelRolesState, role: string): ModelRoleResolution {
  const effective = state.effective.get(role);
  return {
    purpose: "agent",
    requestedRoles: [role],
    role,
    source: effective?.source ?? "unset",
    inherited: effective?.inherited ?? false,
    ...(effective?.assignment !== undefined ? { assignment: effective.assignment } : {}),
    ...(effective?.malformed !== undefined ? { malformed: effective.malformed } : {}),
    fallback: false,
  };
}

/**
 * The layers a role lookup read, named so a degradation notice is actionable.
 *
 * A message saying "role unassigned" leaves the operator guessing which file to
 * edit; this names the two on-disk candidates by absolute path.
 */
export function modelRoleLayersConsulted(state: ModelRolesState): string[] {
  return ["session", "settings", `project (${state.paths.project})`, `user (${state.paths.user})`];
}

/**
 * One sentence an operator can act on: what was named, what was read, what happened
 * instead.
 *
 * Shared by the workflow bridge and the interactive launcher so that `/agent run
 * reviewer` and a workflow stage naming `reviewer` degrade with the SAME recorded
 * sentence (OD2). The past tense is deliberate and load-bearing: callers may only
 * emit this once the child has actually been prompted — a built-but-never-prompted
 * session is not an execution, and this is a claim about one. `executedModel` is
 * the gate every caller uses, because it is set only after child kickoff.
 */
export function unassignedRoleNote(role: string, origin: string, state: ModelRolesState): string {
  return (
    `${origin} ${JSON.stringify(role)} is not assigned in any model-roles layer ` +
    `(${modelRoleLayersConsulted(state).join(", ")}); the child inherited the parent session model.`
  );
}

/**
 * The refusal text for a malformed assignment, shared by every caller so the
 * workflow bridge and the interactive launcher name the same file and the same fix.
 *
 * Present tense and no claim about a child: this refusal is issued BEFORE anything
 * is created, which is the point — a typo must never reach `createSession`.
 */
export function malformedRoleAssignmentNote(role: string, origin: string, malformed: MalformedRoleAssignment): string {
  return (
    `${origin} ${JSON.stringify(role)} is assigned ${JSON.stringify(malformed.value)} by the ` +
    `${malformed.layer} model-roles layer, but that is not a "provider/id" selector ` +
    `(an optional ":off|minimal|low|medium|high|xhigh" suffix is allowed and is display-only). ` +
    `Fix or remove that assignment — a malformed assignment is a configuration error, not an ` +
    `unassigned role, so it is NOT degraded to the session model.`
  );
}

export function resolvePromptPlanningModelRole(state: ModelRolesState): ModelRoleResolution {
  return resolveModelRoleForPurpose(state, "prompt-planning");
}

export function resolveSummaryModelRole(state: ModelRolesState): ModelRoleResolution {
  return resolveModelRoleForPurpose(state, "summary");
}

export function resolveAgentModelPreference(state: ModelRolesState, agentModels: string[] = []): ModelRoleResolution {
  const first = agentModels[0];
  if (first) {
    const direct = parseModelSelector(first);
    if (direct) {
      return {
        purpose: "agent",
        requestedRoles: [first],
        role: "agent",
        source: "agent",
        inherited: false,
        assignment: direct,
        fallback: false,
      };
    }
    // A DECLARED role resolves to its own assignment or to none — never through
    // `resolveModelRoleForPurpose`'s `preferred → agent → task → default` walk.
    // An agent whose frontmatter says `model: smol` must not run the `task` tier
    // because `smol` happens to be unassigned and `task` happens not to be: that is
    // a different model under the requested tier's name, which is the silent
    // substitution D3a exists to stop. It reads the same as the per-call
    // `modelRole` rule in the bridge, and all three production callers
    // (workflow bridge, `/agent run`, `spawn_agent`) inherit it from here, which is
    // the parity OD2 asked for.
    return resolveDeclaredModelRole(state, first);
  }
  // No frontmatter tier at all — "no tier declared". The purpose chain is the right
  // answer to "give me something reasonable for an agent", and it is the only case
  // that may reach it.
  return resolveModelRoleForPurpose(state, "agent");
}

export function modelRoleResolutionRecord(resolution: ModelRoleResolution): ModelRoleResolutionRecord {
  const record: ModelRoleResolutionRecord = {
    purpose: resolution.purpose,
    requestedRoles: [...resolution.requestedRoles],
    role: resolution.role,
    source: resolution.source,
    inherited: resolution.inherited,
    fallback: resolution.fallback,
  };
  if (resolution.assignment !== undefined) {
    record.model = resolution.assignment.model;
    if (resolution.assignment.thinking !== undefined) record.thinking = resolution.assignment.thinking;
  }
  return record;
}

export async function setModelRoleSetting(
  ctx: ExtensionContext,
  role: string,
  assignment: ModelRoleAssignment,
): Promise<boolean> {
  const paths = getModelRolesConfigPaths(getProjectRoot(ctx));
  const project = await readConfig(paths.project);
  const roles = stringRecord(project.roles);
  const next: ModelRolesConfig = {
    ...project,
    version: 1,
    roles: { ...roles, [role]: formatAssignment(assignment) },
  };
  await writeConfig(paths.project, next);
  if (ctx.settings) {
    const current = stringRecord(ctx.settings.get("modelRoles"));
    await ctx.settings.set("modelRoles", { ...current, [role]: formatAssignment(assignment) });
  }
  return true;
}

/** The assignment as the operator wrote it, for quoting back in a refusal. */
export function rawAssignmentText(value: Exclude<ModelRoleValue, null>): string {
  return typeof value === "string" ? value : formatAssignment(value);
}

export function normalizeAssignment(value: ModelRoleValue): ModelRoleAssignment | undefined {
  if (value === null) return undefined;
  if (typeof value === "string") return parseModelSelector(value);
  return parseModelSelector(formatAssignment(value));
}

export function parseModelSelector(selector: string): ModelRoleAssignment | undefined {
  const trimmed = selector.trim();
  if (!trimmed.includes("/")) return undefined;
  const colon = trimmed.lastIndexOf(":");
  const suffix = colon > -1 ? trimmed.slice(colon + 1) : "";
  if (suffix && isThinkingLevel(suffix)) return { model: trimmed.slice(0, colon), thinking: suffix };
  return { model: trimmed };
}

export function formatAssignment(assignment: ModelRoleAssignment): string {
  return assignment.thinking ? `${assignment.model}:${assignment.thinking}` : assignment.model;
}

function defaultRolesForPurpose(purpose: ModelRolePurpose): string[] {
  switch (purpose) {
    case "prompt-planning":
      return ["plan", "default"];
    case "summary":
      return ["summary", "smol", "default"];
    case "agent":
      return ["agent", "task", "default"];
    case "default":
      return ["default"];
  }
}

function readSettingsConfig(ctx: ExtensionContext): ModelRolesConfig {
  if (!ctx.settings) return {};
  const roles = stringRecord(ctx.settings.get("modelRoles"));
  const cycleOrder = stringArray(ctx.settings.get("cycleOrder"));
  const config: ModelRolesConfig = {};
  if (Object.keys(roles).length) config.roles = roles;
  if (cycleOrder.length) config.cycleOrder = cycleOrder;
  return config;
}

async function readSessionConfig(ctx: ExtensionContext): Promise<ModelRolesConfig> {
  const entries = await ctx.sessionManager?.getEntries?.();
  if (!entries) return {};
  const roles: Record<string, ModelRoleValue> = {};
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== MODEL_ROLES_SESSION_ENTRY_TYPE) continue;
    const data = sessionEntryData(entry.data ?? entry.payload);
    if (!data || data.rolePersisted === false) continue;
    for (const [role, value] of Object.entries(data.roles ?? {})) roles[role] = value;
    if (data.role && data.assignment !== undefined) roles[data.role] = data.assignment;
  }
  return Object.keys(roles).length ? { version: 1, roles } : {};
}

function sessionEntryData(value: unknown): ModelRoleSessionEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as ModelRoleSessionEntry;
}

async function readConfig(path: string): Promise<ModelRolesConfig> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isConfig(parsed) ? parsed : {};
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }
}

async function writeConfig(path: string, value: ModelRolesConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isConfig(value: unknown): value is ModelRolesConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.has(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") record[key] = item;
  }
  return record;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
  );
}
