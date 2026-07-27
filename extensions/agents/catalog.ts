/**
 * extensions/agents/catalog.ts — the agent catalog.
 *
 * Owns discovery refresh into `sharedState.agents`, the `TaskParams` schema whose
 * `agent` parameter description IS the published catalog (see writeAgentCatalogHint),
 * name resolution with the built-in aliases, and the flat catalog projections the
 * unknown-agent report reads.
 */
import { Type } from "@sinclair/typebox";
import { discoverAgentDefinitions, formatAgentCatalogHint } from "../_shared/agents.js";
import { sharedState } from "../_shared/state.js";
import type { AgentDefinition } from "../_shared/types.js";

const AGENT_PARAM_BASE_DESCRIPTION =
  "Agent catalog name. Omit, use default, or use general to run task unless a project/user definition with that name exists.";
const AGENT_PARAM_CATALOG_HEADING = "Available agents (name — description):";

export const TaskParams = Type.Object({
  agent: Type.Optional(Type.String({ description: AGENT_PARAM_BASE_DESCRIPTION })),
  task: Type.String({ description: "Self-contained subagent instructions", minLength: 1, maxLength: 16000 }),
  title: Type.Optional(
    Type.String({
      description: "Short work title shown in the live agent row; falls back to the first words of task",
      maxLength: 48,
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

export interface AgentResolution {
  requestedAgent: string;
  resolvedAgent: string;
  agent: AgentDefinition;
  aliasApplied?: string;
}

export function refreshAgents(projectRoot: string) {
  const discovered = discoverAgentDefinitions(projectRoot);
  sharedState.agents.clear();
  for (const agent of discovered.definitions) {
    sharedState.agents.set(agent.name, agent);
  }
  writeAgentCatalogHint(discovered.definitions);
  return discovered;
}

/**
 * T-111: publish the resolved catalog on the `agent` parameter of
 * `spawn_agent`/`task`, which is where the calling model chooses the name. Both
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
    const aliased = sharedState.agents.get(DEFAULT_TASK_AGENT_NAME);
    if (aliased !== undefined)
      return { requestedAgent, resolvedAgent: aliased.name, agent: aliased, aliasApplied: requestedAgent };
    return undefined;
  }
  const exact = sharedState.agents.get(requestedAgent);
  if (exact !== undefined && (!isBuiltInAgentAlias(requestedAgent) || isProjectOrUserAgent(exact))) {
    return { requestedAgent, resolvedAgent: exact.name, agent: exact };
  }
  const aliasTarget = builtInAliasTarget(requestedAgent);
  if (aliasTarget !== undefined) {
    const aliased = sharedState.agents.get(aliasTarget);
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
  return [...sharedState.agents.values()]
    .map((agent) => ({ name: agent.name, source: agent.source ?? "unknown", description: agent.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listBuiltInAliases(): Array<{ alias: string; target: string; condition?: string }> {
  return [
    { alias: "default", target: DEFAULT_TASK_AGENT_NAME },
    { alias: "general", target: DEFAULT_TASK_AGENT_NAME, condition: "only when no project/user general agent exists" },
  ];
}
