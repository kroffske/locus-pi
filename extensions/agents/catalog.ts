/**
 * extensions/agents/catalog.ts — the agent catalog.
 *
 * Owns discovery refresh into `catalog-state.ts`, the `TaskParams` schema whose
 * `agent` parameter description IS the published catalog (see writeAgentCatalogHint),
 * name resolution with the built-in aliases, and the flat catalog projections the
 * unknown-agent report reads.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  BUNDLED_AGENTS_DIR,
  discoverAgentDefinitions,
  formatAgentCatalogHint,
  loadAgentsFromDir,
} from "../_shared/agent-runtime/agents.js";
import { DEFAULT_MODEL_ROLES } from "../_shared/model/model-settings.js";
import { agentCatalog } from "./catalog-state.js";
import type { AgentDefinition } from "../_shared/agent-runtime/agents.js";

const AGENT_PARAM_BASE_DESCRIPTION =
  "Agent catalog name. Omit, use default, or use general to run task unless a project/user definition with that name exists.";
const AGENT_PARAM_CATALOG_HEADING = "Available agents (name — description):";

export const TaskParams = Type.Object({
  agent: Type.Optional(Type.String({ description: AGENT_PARAM_BASE_DESCRIPTION })),
  task: Type.String({ description: "Self-contained subagent instructions", minLength: 1, maxLength: 16000 }),
  title: Type.Optional(
    Type.String({
      description: "Short work title shown in the live agent row; falls back to the first words of task",
      maxLength: 128,
    }),
  ),
  parentContext: Type.Optional(
    Type.Object({
      inline: Type.Optional(Type.String({ description: "Explicit parent-provided context text", maxLength: 32000 })),
      artifactPath: Type.Optional(Type.String({ description: "Path to an explicit parent context artifact" })),
    }),
  ),
});

export const DEFAULT_TASK_AGENT_NAME = "task";
const BUILT_IN_AGENT_ALIASES = { default: DEFAULT_TASK_AGENT_NAME, general: DEFAULT_TASK_AGENT_NAME } as const;

export interface ExtensionAgentCatalogEntry {
  extensionId: string;
  agentName: string;
  description: string;
  profilePath: string;
  manifestPath: string;
}

interface ExtensionManifest {
  id: string;
  agent?: { name?: unknown; description?: unknown };
}

interface PackageMetadata {
  pi?: { extensions?: unknown };
}

const PACKAGE_ROOT = path.resolve(BUNDLED_AGENTS_DIR, "..", "..");

/**
 * Validate and read the package-owned extension-to-agent catalog. Keeping this
 * derived from package.json prevents a new default entrypoint from silently
 * shipping without a resolvable dedicated profile.
 */
export function loadExtensionAgentCatalog(
  options: { packageRoot?: string; bundledAgentsDir?: string } = {},
): ExtensionAgentCatalogEntry[] {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const bundledAgentsDir = options.bundledAgentsDir ?? path.join(packageRoot, ".agents", "agents");
  const packageMetadata = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as PackageMetadata;
  const entrypoints = packageMetadata.pi?.extensions;
  if (!Array.isArray(entrypoints)) throw new Error("package.json#pi.extensions must be an array");

  const extensionIds = entrypoints.map((entrypoint) => {
    if (typeof entrypoint !== "string") throw new Error("package.json#pi.extensions contains a non-string entrypoint");
    const match = /^\.\/extensions\/([^/]+)\/index\.ts$/.exec(entrypoint);
    if (!match?.[1]) throw new Error(`invalid default extension entrypoint: ${entrypoint}`);
    return match[1];
  });
  if (new Set(extensionIds).size !== extensionIds.length) throw new Error("duplicate default extension entrypoint");

  const loaded = loadAgentsFromDir(bundledAgentsDir, "bundled");
  if (loaded.diagnostics.length) {
    throw new Error(loaded.diagnostics.map(({ filePath, message }) => `${filePath}: ${message}`).join("; "));
  }
  const profiles = new Map<string, AgentDefinition>();
  for (const profile of loaded.definitions) {
    if (profiles.has(profile.name)) throw new Error(`duplicate bundled agent profile: ${profile.name}`);
    profiles.set(profile.name, profile);
  }

  const assigned = new Set<string>();
  const entries = extensionIds.map((extensionId) => {
    const manifestPath = path.join(packageRoot, "extensions", extensionId, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;
    if (manifest.id !== extensionId) throw new Error(`manifest id mismatch: ${manifestPath}`);
    const name = manifest.agent?.name;
    const description = manifest.agent?.description;
    if (typeof name !== "string" || !name || typeof description !== "string" || !description) {
      throw new Error(`extension manifest has no complete agent assignment: ${manifestPath}`);
    }
    if (assigned.has(name)) throw new Error(`duplicate extension agent assignment: ${name}`);
    assigned.add(name);
    const profile = profiles.get(name);
    if (!profile) throw new Error(`unknown bundled agent profile: ${name}`);
    if (profile.description !== description) {
      throw new Error(`extension agent description drift for ${name}: manifest and profile frontmatter must match`);
    }
    if (
      profile.model?.length !== 1 ||
      profile.model[0]!.includes("/") ||
      !DEFAULT_MODEL_ROLES.some((role) => role === profile.model![0])
    ) {
      throw new Error(`invalid model role for extension agent: ${name}`);
    }
    return {
      extensionId,
      agentName: name,
      description,
      profilePath: path.relative(packageRoot, profile.filePath ?? path.join(bundledAgentsDir, `${name}.md`)),
      manifestPath: path.relative(packageRoot, manifestPath),
    };
  });
  return entries;
}

const EXTENSION_AGENT_CATALOG = loadExtensionAgentCatalog();

export interface AgentResolution {
  requestedAgent: string;
  resolvedAgent: string;
  agent: AgentDefinition;
  aliasApplied?: string;
}

export function refreshAgents(projectRoot: string) {
  const extensionAgents = new Map(EXTENSION_AGENT_CATALOG.map((entry) => [entry.agentName, entry]));
  const discovered = discoverAgentDefinitions(projectRoot);
  agentCatalog.clear();
  const resolvedDefinitions = discovered.definitions.map((agent) => {
    const assignment = agent.source === "bundled" ? extensionAgents.get(agent.name) : undefined;
    return assignment ? { ...agent, description: assignment.description } : agent;
  });
  for (const agent of resolvedDefinitions) {
    agentCatalog.set(agent.name, agent);
  }
  writeAgentCatalogHint(resolvedDefinitions);
  return discovered;
}

/**
 * T-111: publish the resolved catalog on the `agent` parameter of
 * `spawn_agent`, which is where the calling model chooses the name. The
 * tools are registered with the same `TaskParams` object and Pi hands
 * `ToolDefinition.parameters` to the provider by reference on every request
 * (unlike `description`, which it snapshots when the tool is wrapped), so
 * rewriting the schema field here is what makes the catalog refreshable instead
 * of frozen at registration. Every `refreshAgents` caller therefore republishes
 * it, and `before_agent_start` runs one refresh per turn so an agent added to
 * `.agents/agents/` mid-session is selectable without a restart.
 */
function writeAgentCatalogHint(definitions: readonly AgentDefinition[]): void {
  const catalog = formatAgentCatalogHint(definitions);
  TaskParams.properties.agent.description =
    catalog === ""
      ? AGENT_PARAM_BASE_DESCRIPTION
      : `${AGENT_PARAM_BASE_DESCRIPTION}\n${AGENT_PARAM_CATALOG_HEADING}\n${catalog}`;
}

export function resolveAgentSelection(agentName: string | undefined): AgentResolution | undefined {
  const requestedAgent = normalizeRequestedAgentName(agentName);
  if (requestedAgent === "default") {
    const aliased = agentCatalog.get(DEFAULT_TASK_AGENT_NAME);
    if (aliased !== undefined)
      return { requestedAgent, resolvedAgent: aliased.name, agent: aliased, aliasApplied: requestedAgent };
    return undefined;
  }
  const exact = agentCatalog.get(requestedAgent);
  if (exact !== undefined && (!isBuiltInAgentAlias(requestedAgent) || isProjectOrUserAgent(exact))) {
    return { requestedAgent, resolvedAgent: exact.name, agent: exact };
  }
  const aliasTarget = builtInAliasTarget(requestedAgent);
  if (aliasTarget !== undefined) {
    const aliased = agentCatalog.get(aliasTarget);
    if (aliased !== undefined)
      return { requestedAgent, resolvedAgent: aliased.name, agent: aliased, aliasApplied: requestedAgent };
  }
  if (exact !== undefined) return { requestedAgent, resolvedAgent: exact.name, agent: exact };
  return undefined;
}

export function normalizeRequestedAgentName(agentName: string | undefined): string {
  const trimmed = agentName?.trim();
  return trimmed === undefined || trimmed === "" ? DEFAULT_TASK_AGENT_NAME : trimmed;
}

function isProjectOrUserAgent(agent: AgentDefinition): boolean {
  return agent.source === "project" || agent.source === "user";
}

function isBuiltInAgentAlias(name: string): name is keyof typeof BUILT_IN_AGENT_ALIASES {
  return name === "default" || name === "general";
}

function builtInAliasTarget(name: string): string | undefined {
  return isBuiltInAgentAlias(name) ? BUILT_IN_AGENT_ALIASES[name] : undefined;
}

export function listAvailableAgents(): Array<{ name: string; source: string; description: string }> {
  return [...agentCatalog.values()]
    .map((agent) => ({ name: agent.name, source: agent.source ?? "unknown", description: agent.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listBuiltInAliases(): Array<{ alias: string; target: string; condition?: string }> {
  return [
    { alias: "default", target: DEFAULT_TASK_AGENT_NAME },
    { alias: "general", target: DEFAULT_TASK_AGENT_NAME, condition: "only when no project/user general agent exists" },
  ];
}
