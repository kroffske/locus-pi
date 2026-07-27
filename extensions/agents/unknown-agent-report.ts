/**
 * extensions/agents/unknown-agent-report.ts — what the agents surfaces say when a
 * requested name is not in the catalog: the durable JSON artifact, the tool-result
 * text, the structured details, and the operator block. One report shape serves
 * the `task`/`spawn_agent` tool, `/agent run`, and `/agent inspect`.
 */
import { relative } from "node:path";
import { createRuntimeArtifactStore } from "../_shared/artifacts.js";
import type { OperatorBlock } from "../_shared/operator-ui.js";
import type { ExtensionContext } from "../_shared/pi-api.js";
import { getProjectRoot, getSessionId } from "../_shared/pi-api.js";
import { listAvailableAgents, listBuiltInAliases, normalizeRequestedAgentName } from "./catalog.js";
import { compactAgentCatalogLine } from "./operator-ui.js";

export interface UnknownAgentReport {
  text: string;
  block: OperatorBlock;
  details: Record<string, unknown>;
  artifactPath?: string;
}

export function createUnknownAgentReport(
  ctx: ExtensionContext,
  requestedSurface: string,
  agentName: string | undefined,
): UnknownAgentReport {
  const requestedAgent = normalizeRequestedAgentName(agentName);
  const availableAgents = listAvailableAgents();
  const builtInAliases = listBuiltInAliases();
  const artifact = writeUnknownAgentArtifact(ctx, requestedSurface, requestedAgent, availableAgents, builtInAliases);
  const details: Record<string, unknown> = {
    owner: "agents-catalog",
    requestedSurface,
    status: "blocked",
    errorCode: "unknown-agent",
    requestedAgent,
    availableAgents,
    builtInAliases,
    hint: "/agent list",
  };
  if (artifact.ok) details.artifactPath = artifact.path;
  else details.artifactError = artifact.reason;
  return {
    text: formatUnknownAgentMessage(requestedAgent, availableAgents, builtInAliases, artifact, getProjectRoot(ctx)),
    block: unknownAgentBlock(
      requestedAgent,
      availableAgents,
      builtInAliases,
      artifact,
      getProjectRoot(ctx),
      ctx.mode === "tui" ? 5 : 2,
    ),
    details,
    ...(artifact.ok ? { artifactPath: artifact.path } : {}),
  };
}

function unknownAgentBlock(
  requestedAgent: string,
  availableAgents: Array<{ name: string; source: string; description: string }>,
  builtInAliases: Array<{ alias: string; target: string; condition?: string }>,
  artifact: { ok: true; path: string } | { ok: false; reason: string },
  projectRoot: string,
  previewLimit: number,
): OperatorBlock {
  const sourceRank = (source: string): number => (source === "project" ? 0 : source === "user" ? 1 : 2);
  const preview = [...availableAgents]
    .sort((left, right) => sourceRank(left.source) - sourceRank(right.source) || left.name.localeCompare(right.name))
    .slice(0, previewLimit);
  const hidden = availableAgents.length - preview.length;
  return {
    type: "ERROR",
    subject: "Agent catalog",
    primary: compactAgentCatalogLine(`Unknown agent: "${requestedAgent}".`),
    body: [
      `Available agents (${availableAgents.length}):`,
      ...(preview.length === 0
        ? ["- (none)"]
        : preview.map((agent) => compactAgentCatalogLine(`- ${agent.name} [${agent.source}] - ${agent.description}`))),
      ...(hidden > 0 ? [`+${hidden} agent(s) not shown`] : []),
    ],
    metadata: [
      compactAgentCatalogLine(
        `Built-in aliases: ${builtInAliases.map((alias) => `${alias.alias} -> ${alias.target}${alias.condition === undefined ? "" : " (conditional)"}`).join("; ")}`,
      ),
    ],
    hint: [
      compactAgentCatalogLine(
        artifact.ok ? `Artifact: ${relative(projectRoot, artifact.path)}` : `Artifact write failed: ${artifact.reason}`,
      ),
      compactAgentCatalogLine("Evidence boundary: catalog failure only; not child-execution proof."),
    ],
    controls: ["Recovery: /agent list"],
  };
}

function formatUnknownAgentMessage(
  requestedAgent: string,
  availableAgents: Array<{ name: string; source: string; description: string }>,
  builtInAliases: Array<{ alias: string; target: string; condition?: string }>,
  artifact: { ok: true; path: string } | { ok: false; reason: string },
  projectRoot: string,
): string {
  const availableLines =
    availableAgents.length === 0
      ? ["- (none)"]
      : availableAgents.map((agent) => `- ${agent.name} [${agent.source}] - ${agent.description}`);
  const aliasLines = builtInAliases.map(
    (alias) => `- ${alias.alias} -> ${alias.target}${alias.condition === undefined ? "" : ` (${alias.condition})`}`,
  );
  return [
    `Unknown agent: "${requestedAgent}".`,
    "",
    "Available agents:",
    ...availableLines,
    "",
    "Built-in aliases:",
    ...aliasLines,
    "",
    "Run /agent list to inspect the current catalog.",
    artifact.ok ? `Artifact: ${relative(projectRoot, artifact.path)}` : `Artifact write failed: ${artifact.reason}`,
  ].join("\n");
}

function writeUnknownAgentArtifact(
  ctx: ExtensionContext,
  requestedSurface: string,
  requestedAgent: string,
  availableAgents: Array<{ name: string; source: string; description: string }>,
  builtInAliases: Array<{ alias: string; target: string; condition?: string }>,
): { ok: true; path: string } | { ok: false; reason: string } {
  const projectRoot = getProjectRoot(ctx);
  const body = {
    version: "locus.agent.unknown-agent.v1",
    status: "blocked",
    errorCode: "unknown-agent",
    requestedSurface,
    requestedAgent,
    availableAgents,
    builtInAliases,
    hint: "/agent list",
  };
  try {
    const artifact = createRuntimeArtifactStore(projectRoot).writeArtifact({
      kind: "json",
      content: `${JSON.stringify(body, null, 2)}\n`,
      sessionId: getSessionId(ctx),
      title: `Unknown agent: ${requestedAgent}`,
      metadata: {
        source: "agents-catalog",
        requestedSurface,
        errorCode: "unknown-agent",
        requestedAgent,
      },
    });
    return { ok: true, path: artifact.path };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
