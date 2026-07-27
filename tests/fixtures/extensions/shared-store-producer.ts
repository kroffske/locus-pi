import type { ExtensionAPI } from "../../../extensions/_shared/pi-api.js";
import { agentLiveStore, type AgentLiveExecutionHandle } from "../../../extensions/_shared/agent-sdk-host.js";

const PRODUCER_EXECUTION_KEY = Symbol.for("locus-pi.test.shared-store-producer-execution");
const CONSUMER_EXECUTION_KEY = Symbol.for("locus-pi.test.shared-store-consumer-execution");

export default function sharedStoreProducer(pi: ExtensionAPI): void {
  pi.registerCommand("test-produce-shared-row", {
    handler: (_args, ctx) => {
      const execution = agentLiveStore.beginExecution({
        id: "two-entrypoint-row",
        agentName: "reviewer",
        label: "row from producer entrypoint",
      });
      (globalThis as unknown as Record<symbol, unknown>)[PRODUCER_EXECUTION_KEY] = execution;
      agentLiveStore.registerCancelForExecution(execution, () => {
        ctx.ui.setWidget("shared-store-cancel", ["producer cancellation reached"]);
      });
    },
  });
  pi.registerCommand("test-producer-consume-shared-row", {
    handler: (_args, ctx) => {
      const execution = (globalThis as unknown as Record<symbol, unknown>)[CONSUMER_EXECUTION_KEY] as
        AgentLiveExecutionHandle | undefined;
      const sameExecution =
        execution !== undefined && agentLiveStore.captureExecutionAuthority("consumer-entrypoint-row") === execution;
      const cancellation = agentLiveStore.captureCancellationAuthority("consumer-entrypoint-row");
      const cancelled = cancellation !== undefined && agentLiveStore.cancelWithAuthority(cancellation);
      ctx.ui.setWidget("shared-store-reverse-proof", [
        sameExecution && cancelled ? "consumer execution reached producer" : "reverse shared authority missing",
      ]);
    },
  });
}
