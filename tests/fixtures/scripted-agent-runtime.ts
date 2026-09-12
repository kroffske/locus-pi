import {
  createWorkflowRuntime,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../extensions/workflows/runtime/workflow-runtime.js";

/**
 * Build a runtime whose child answers come from a scripted list; records every request.
 *
 * The host it stands in for is one that CAN carry a shaped result: for a request that
 * declares a return contract it reports the `workflow_return` tool receipt the runtime
 * requires, so acceptance under test is the production receipt path rather than text
 * parsing. A request with no contract is answered with the scripted text and nothing else.
 *
 * Answers are consumed in order; once the list runs out the LAST answer repeats, so a
 * suite that scripts one answer for a call that may be attempted twice needs no padding.
 */
export function scriptedRuntime(runId: string, answers: string[]) {
  const requests: WorkflowAgentRequest[] = [];
  const runtime = createWorkflowRuntime({
    runId,
    agentRunner: async (request): Promise<WorkflowAgentResult> => {
      requests.push(request);
      const text = answers[requests.length - 1] ?? answers.at(-1) ?? "";
      return {
        ok: true,
        status: "completed",
        summary: "done",
        text,
        diagnostics: [],
        agent: request.agent,
        ...(request.returnContract === undefined
          ? {}
          : { outputAcceptance: { source: "tool" as const, attempts: 1, toolName: "workflow_return" as const } }),
      };
    },
  });
  return { ...runtime, requests };
}
