import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, ThinkingLevel } from "./pi-api.js";
import { getProjectRoot } from "./pi-api.js";

const USER_HOME_ENV = "PI_MODEL_ROLES_HOME";
export const DEFAULT_MODEL_ROLES = ["default", "smol", "slow", "plan", "summary", "agent", "vision", "designer", "commit", "task"] as const;
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

export interface EffectiveRole {
  role: string;
  source: ModelRoleSource;
  inherited: boolean;
  assignment?: ModelRoleAssignment;
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

export function getModelRolesConfigPaths(projectRoot: string, env: NodeJS.ProcessEnv = process.env): ModelRolesConfigPaths {
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

export function buildModelRolesState(paths: ModelRolesConfigPaths, session: ModelRolesConfig, settings: ModelRolesConfig, user: ModelRolesConfig, project: ModelRolesConfig): ModelRolesState {
  const cycleOrder = session.cycleOrder ?? settings.cycleOrder ?? project.cycleOrder ?? user.cycleOrder ?? [...DEFAULT_MODEL_CYCLE_ORDER];
  const roles = new Set([...DEFAULT_MODEL_ROLES, ...Object.keys(user.roles ?? {}), ...Object.keys(project.roles ?? {}), ...Object.keys(settings.roles ?? {}), ...Object.keys(session.roles ?? {}), ...cycleOrder]);
  const effective = new Map<string, EffectiveRole>();
  for (const role of roles) {
    const sessionValue = session.roles?.[role];
    const settingsValue = settings.roles?.[role];
    const projectValue = project.roles?.[role];
    const userValue = user.roles?.[role];
    if (sessionValue !== undefined && sessionValue !== null) {
      const assignment = normalizeAssignment(sessionValue);
      effective.set(role, assignment ? { role, source: "session", inherited: false, assignment } : { role, source: "unset", inherited: false });
    } else if (settingsValue !== undefined && settingsValue !== null) {
      const assignment = normalizeAssignment(settingsValue);
      effective.set(role, assignment ? { role, source: "settings", inherited: false, assignment } : { role, source: "unset", inherited: false });
    } else if (projectValue !== undefined && projectValue !== null) {
      const assignment = normalizeAssignment(projectValue);
      effective.set(role, assignment ? { role, source: "project", inherited: false, assignment } : { role, source: "unset", inherited: false });
    } else if (userValue !== undefined && userValue !== null) {
      const assignment = normalizeAssignment(userValue);
      effective.set(role, assignment ? { role, source: "user", inherited: projectValue === null, assignment } : { role, source: "unset", inherited: projectValue === null });
    } else {
      effective.set(role, { role, source: "unset", inherited: projectValue === null });
    }
  }
  return { paths, session, settings, user, project, effective, cycleOrder };
}

export function resolveModelRoleForPurpose(state: ModelRolesState, purpose: ModelRolePurpose, preferredRoles: string[] = []): ModelRoleResolution {
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
  return {
    purpose,
    requestedRoles,
    role: requestedRoles[0] ?? "default",
    source: "unset",
    inherited: false,
    fallback: true,
  };
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
    return resolveModelRoleForPurpose(state, "agent", [first]);
  }
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

export async function setModelRoleSetting(ctx: ExtensionContext, role: string, assignment: ModelRoleAssignment): Promise<boolean> {
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
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
