/**
 * extensions/agents/catalog/catalog-state.ts — the resolved agent catalog this extension refreshes
 * from disk, keyed by agent name.
 *
 * `catalog.ts#refreshAgents` is the only writer: it clears and repopulates the map on every
 * discovery pass, and `before_agent_start` runs one pass per turn. `catalog.ts` and
 * `command-router.ts` are the only readers, which is why the map sits inside this extension
 * rather than in a shared directory.
 *
 * It is a per-entrypoint projection of `.agents/agents/`, never a process-wide registry: this
 * binding does not survive Pi's cache-disabled entrypoint loading, so each loaded entrypoint
 * gets its own copy. Nothing may rely on a write made through one entrypoint being visible
 * from another.
 */
import type { AgentDefinition } from "../../_shared/agent-runtime/agents.js";

export const agentCatalog = new Map<string, AgentDefinition>();
