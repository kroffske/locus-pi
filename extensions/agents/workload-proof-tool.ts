/**
 * extensions/agents/workload-proof-tool.ts — the `locus_workload_proof` tool: a
 * child agent's claim that it did bounded work, recorded as diagnostic evidence
 * only.
 */
import { Type } from "@sinclair/typebox";
import { writeAgentWorkloadProof } from "../_shared/agent-runtime/agent-workload-proof.js";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { textResult } from "../_shared/host/pi-api.js";
import { validateParams } from "../_shared/host/validation.js";

const WorkloadProofParams = Type.Object({
  summary: Type.String({
    description: "Short description of the bounded child workload already performed",
    maxLength: 500,
  }),
});

export function registerWorkloadProofTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "locus_workload_proof",
    description:
      "Record diagnostic evidence that an SDK child agent claims bounded workload. This does not make a parser-clean result successful by itself.",
    parameters: WorkloadProofParams,
    approval: "write",
    async execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(WorkloadProofParams, params);
      if (!valid.ok) return valid.result;
      const proofPath = writeAgentWorkloadProof(ctx, "locus_workload_proof");
      return textResult(`Workload proof recorded: ${valid.value.summary}`, {
        proofPath,
        source: "locus-workload-proof",
      });
    },
  });
}
