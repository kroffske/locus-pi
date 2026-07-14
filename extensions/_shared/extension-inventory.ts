export const EXTENSION_CURRENT_STATUSES = ["active", "disabled", "deleted"] as const;
export const EXTENSION_OWNERSHIP_STATUSES = ["compat-wrapper", "locus-specific", "omp-owned-to-import", "redesign-later", "split-required", "deleted"] as const;

export type ExtensionCurrentStatus = typeof EXTENSION_CURRENT_STATUSES[number];
export type ExtensionOwnershipStatus = typeof EXTENSION_OWNERSHIP_STATUSES[number];

export interface ExtensionInventoryRow {
  id: string;
  currentStatus: ExtensionCurrentStatus;
  ownershipStatus: ExtensionOwnershipStatus;
}

export const EXTENSION_INVENTORY: ExtensionInventoryRow[] = [
  { id: "ask-user-question", currentStatus: "active", ownershipStatus: "compat-wrapper" },
  { id: "devext-doctor", currentStatus: "active", ownershipStatus: "locus-specific" },
  { id: "agents", currentStatus: "active", ownershipStatus: "locus-specific" },
  { id: "ast-structural-edit", currentStatus: "active", ownershipStatus: "compat-wrapper" },
  { id: "browser", currentStatus: "disabled", ownershipStatus: "omp-owned-to-import" },
  { id: "context-budget", currentStatus: "disabled", ownershipStatus: "locus-specific" },
  { id: "dynamic-loader", currentStatus: "disabled", ownershipStatus: "omp-owned-to-import" },
  { id: "fusion", currentStatus: "disabled", ownershipStatus: "locus-specific" },
  { id: "goal", currentStatus: "disabled", ownershipStatus: "omp-owned-to-import" },
  { id: "hello-tool", currentStatus: "disabled", ownershipStatus: "locus-specific" },
  { id: "live-terminal", currentStatus: "disabled", ownershipStatus: "redesign-later" },
  { id: "loop", currentStatus: "active", ownershipStatus: "compat-wrapper" },
  { id: "model", currentStatus: "active", ownershipStatus: "compat-wrapper" },
  { id: "plan", currentStatus: "active", ownershipStatus: "locus-specific" },
  { id: "prompt-planning", currentStatus: "disabled", ownershipStatus: "locus-specific" },
  { id: "workflows", currentStatus: "active", ownershipStatus: "locus-specific" },
  { id: "render-mermaid", currentStatus: "disabled", ownershipStatus: "compat-wrapper" },
  { id: "security-gate", currentStatus: "active", ownershipStatus: "locus-specific" },
  { id: "todo-context", currentStatus: "active", ownershipStatus: "compat-wrapper" },
  { id: "tool-router", currentStatus: "disabled", ownershipStatus: "compat-wrapper" },
  { id: "tools-ast-apply", currentStatus: "deleted", ownershipStatus: "deleted" },
  { id: "tools-ast-edit", currentStatus: "deleted", ownershipStatus: "deleted" },
  { id: "tools-ast-grep", currentStatus: "deleted", ownershipStatus: "deleted" },
  { id: "tools-debug", currentStatus: "disabled", ownershipStatus: "omp-owned-to-import" },
  { id: "tools-dev-context", currentStatus: "disabled", ownershipStatus: "split-required" },
  { id: "tools-lsp", currentStatus: "disabled", ownershipStatus: "omp-owned-to-import" },
  { id: "hello", currentStatus: "deleted", ownershipStatus: "deleted" },
  { id: "hello-command", currentStatus: "deleted", ownershipStatus: "deleted" },
  { id: "lifecycle-trace", currentStatus: "deleted", ownershipStatus: "deleted" },
  { id: "session-state-demo", currentStatus: "deleted", ownershipStatus: "deleted" },
];

export function inventoryIds(rows: ExtensionInventoryRow[] = EXTENSION_INVENTORY): string[] {
  return rows.map((row) => row.id).sort();
}

export function retainedInventory(rows: ExtensionInventoryRow[] = EXTENSION_INVENTORY): ExtensionInventoryRow[] {
  return rows.filter((row) => row.currentStatus !== "deleted");
}

export function deletedInventory(rows: ExtensionInventoryRow[] = EXTENSION_INVENTORY): ExtensionInventoryRow[] {
  return rows.filter((row) => row.currentStatus === "deleted");
}

export function idsByCurrentStatus(status: ExtensionCurrentStatus, rows: ExtensionInventoryRow[] = EXTENSION_INVENTORY): string[] {
  return rows.filter((row) => row.currentStatus === status).map((row) => row.id).sort();
}

export function idsByOwnershipStatus(status: ExtensionOwnershipStatus, rows: ExtensionInventoryRow[] = EXTENSION_INVENTORY): string[] {
  return rows.filter((row) => row.ownershipStatus === status).map((row) => row.id).sort();
}
