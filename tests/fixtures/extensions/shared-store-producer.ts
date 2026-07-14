import type { ExtensionAPI } from "../../../extensions/_shared/pi-api.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-sdk-host.js";

export default function sharedStoreProducer(pi: ExtensionAPI): void {
  pi.registerCommand("test-produce-shared-row", {
    handler: () => {
      agentLiveStore.begin({
        id: "two-entrypoint-row",
        agentName: "reviewer",
        label: "row from producer entrypoint",
      });
    },
  });
}
