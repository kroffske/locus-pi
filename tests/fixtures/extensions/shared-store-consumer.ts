import type { ExtensionAPI } from "../../../extensions/_shared/pi-api.js";
import { agentLiveStore } from "../../../extensions/_shared/agent-sdk-host.js";

export default function sharedStoreConsumer(pi: ExtensionAPI): void {
  pi.registerCommand("test-consume-shared-row", {
    handler: (_args, ctx) => {
      const visible = agentLiveStore.rows.has("two-entrypoint-row") ? "shared row visible" : "shared row missing";
      ctx.ui.setWidget("shared-store-proof", [visible]);
    },
  });
}
