/**
 * extensions/agents/operator-ui.ts — pure OperatorBlock builders for the agents
 * surfaces: the catalog list, one definition's inspect view, and the settled
 * `/agent run` result a headless host gets. No Pi handle, no ExtensionContext,
 * no I/O.
 */
import type { AgentDiagnostic } from "../_shared/agents.js";
import { formatAgentListItem } from "../_shared/agents.js";
import { agentShortIdFromSource } from "../_shared/agent-live-panel.js";
import type { executeAgentRunBoundary } from "../_shared/agent-runner.js";
import type { OperatorBlock } from "../_shared/operator-ui.js";
import type { AgentDefinition } from "../_shared/types.js";
import { compactOperatorLine } from "../_shared/operator-ui.js";

export const AGENTS_WIDGET_FALLBACK_WIDTH = 80;

export const AGENT_CATALOG_FALLBACK_ROWS = 2;

export function agentCatalogBlock(
  catalog: readonly AgentDefinition[],
  diagnostics: readonly AgentDiagnostic[],
  previewLimit?: number,
): OperatorBlock {
  const sourceCounts = { project: 0, user: 0, bundled: 0, workflow: 0 };
  for (const agent of catalog) sourceCounts[agent.source ?? "bundled"] += 1;
  const shown = previewLimit === undefined ? catalog : catalog.slice(0, previewLimit);
  const hidden = catalog.length - shown.length;
  return {
    type: "VIEW",
    subject: "Agent catalog",
    primary: `${catalog.length} loaded definition(s).`,
    body:
      catalog.length === 0
        ? ["No loaded agent definitions."]
        : [
            ...shown.map((agent) =>
              previewLimit === undefined
                ? formatAgentListItem(agent)
                : compactAgentCatalogLine(`${agent.name} [${agent.source ?? "bundled"}] · ${agent.description}`),
            ),
            ...(hidden > 0 ? [`+${hidden} definition(s) hidden`] : []),
          ],
    metadata: [
      `Sources: project=${sourceCounts.project} user=${sourceCounts.user} bundled=${sourceCounts.bundled}`,
      ...(diagnostics.length === 0
        ? []
        : [
            compactAgentCatalogLine(
              `Diagnostics: ${diagnostics.length} issue(s); first: ${diagnostics[0]?.message ?? "unknown"}`,
            ),
          ]),
    ],
    controls: ["Inspect: /agent inspect <name> · Run: /agent run <name> <task>"],
  };
}

export function agentInspectBlock(agent: AgentDefinition, compact = false): OperatorBlock {
  if (compact) {
    return {
      type: "VIEW",
      subject: "Agent definition",
      primary: compactAgentCatalogLine(`${agent.name}: ${agent.description}`),
      badges: [
        { text: agent.source ?? "unknown", tone: "muted" },
        { text: `risk:${agent.risk}`, tone: agent.risk === "high" ? "warning" : "muted" },
      ],
      body: [
        compactAgentCatalogLine(`tools: ${agent.allowedTools.join(", ")}`),
        `readOnly: ${String(agent.readOnly)} · risk: ${agent.risk}`,
        compactAgentCatalogLine(
          `model: ${agent.model?.join(", ") || "host default"} · thinking: ${agent.thinkingLevel ?? "host default"}`,
        ),
      ],
      metadata: [
        `source: ${agent.source ?? "unknown"}`,
        compactAgentCatalogLine(`file: ${agent.filePath ?? "unknown"}`),
      ],
      controls: [`Run: /agent run ${agent.name} <task> · Catalog: /agent list`],
    };
  }
  return {
    type: "VIEW",
    subject: "Agent definition",
    primary: `${agent.name}: ${agent.description}`,
    badges: [
      { text: agent.source ?? "unknown", tone: "muted" },
      { text: `risk:${agent.risk}`, tone: agent.risk === "high" ? "warning" : "muted" },
    ],
    body: [
      `tools: ${agent.allowedTools.join(", ")}`,
      `readOnly: ${String(agent.readOnly)}`,
      `risk: ${agent.risk}`,
      ...(agent.permissionMode === undefined ? [] : [`permissionMode: ${agent.permissionMode}`]),
      ...(agent.spawns === undefined ? [] : [`spawns: ${agent.spawns === "*" ? "*" : agent.spawns.join(", ")}`]),
      ...(agent.model?.length ? [`model: ${agent.model.join(", ")}`] : []),
      ...(agent.thinkingLevel ? [`thinking: ${agent.thinkingLevel}`] : []),
      ...(agent.blocking === undefined ? [] : [`blocking: ${String(agent.blocking)}`]),
    ],
    metadata: [`source: ${agent.source ?? "unknown"}`, `file: ${agent.filePath ?? "unknown"}`],
    controls: [`Run: /agent run ${agent.name} <task> · Catalog: /agent list`],
  };
}

export function compactAgentCatalogLine(value: string): string {
  return compactOperatorLine(value, AGENTS_WIDGET_FALLBACK_WIDTH - 8);
}

export function agentRunBoundaryBlock(boundary: Awaited<ReturnType<typeof executeAgentRunBoundary>>): OperatorBlock {
  const identity =
    boundary.childSession?.id !== undefined
      ? `${boundary.agentName}#${agentShortIdFromSource(boundary.childSession.id)}`
      : boundary.agentName;
  const metadata: string[] = [];
  if (boundary.childSession !== undefined) {
    metadata.push(`childSessionId: ${boundary.childSession.id}`);
    if (boundary.childSession.parentSessionId !== undefined)
      metadata.push(`parentSessionId: ${boundary.childSession.parentSessionId}`);
  }
  if (boundary.resultArtifact !== undefined) metadata.push(`resultArtifact: ${boundary.resultArtifact.path}`);
  if (boundary.childOutputStats !== undefined) {
    // T-188 W6 (fix-candidate #4): units + honest label. childToolCalls is the SDK's
    // genuine tool-call count for this child; entries are its recorded events.
    metadata.push(`childEntries: ${boundary.childOutputStats.entryCount} (events)`);
    metadata.push(`childToolCalls: ${boundary.childOutputStats.assistantToolCallCount} (tool calls)`);
  }
  const isCompleted = boundary.status === "completed";
  const isCancelled = boundary.status === "cancelled";
  return {
    type: isCompleted || isCancelled ? "RESULT" : "ERROR",
    subject: "Agent run",
    primary: `Agent ${identity}: ${boundary.status}`,
    body: [boundary.reason],
    badges: [
      {
        text: `status:${boundary.status}`,
        tone: isCompleted ? "success" : isCancelled ? "muted" : "error",
      },
    ],
    metadata,
    hint: boundary.diagnostics.length === 0 ? [] : ["Diagnostics:", ...boundary.diagnostics.map((item) => `- ${item}`)],
    controls: [`Drill: /agent drill ${boundary.childSession?.id ?? "last"}`],
  };
}
