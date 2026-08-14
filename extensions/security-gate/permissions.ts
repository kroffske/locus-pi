import path from "node:path";
import { redactSecrets } from "../_shared/host/redaction.js";

/**
 * The extension manifest shape this gate grades a capability request against. It lives here
 * rather than in a shared directory because the security gate is its only reader: nothing
 * else in the package asks whether a manifest grants a capability.
 */
export interface PermissionManifest {
  id: string;
  name: string;
  version: string;
  tier: "core-owned" | "audited-fork" | "local-experimental" | "blocked";
  provides: { tools: string[]; commands: string[]; hooks: string[] };
  permissions: {
    filesystem: { read: string[]; write: string[] };
    subprocess: string[];
    network: string[];
    browser: boolean;
    models: boolean;
    ui: string[];
  };
  risk: "low" | "medium" | "high" | "critical";
  review: {
    status: "draft" | "in-review" | "reviewed" | "blocked";
    source: "write-from-scratch" | "rewrite-first" | "fork-after-audit" | "wrapper-first" | "copy-after-audit";
    reviewedBy: string | null;
    reviewedAt: string | null;
  };
}

/** The verdict field of `AuditEvent`; not named anywhere else, so it stays module-private. */
type AuditDecision = "allow" | "block" | "ask";

/**
 * One row of the audit ring below. The gate entrypoint renders it; `auditEvent` is the only
 * writer.
 */
export interface AuditEvent {
  timestamp: string;
  extensionId: string;
  actionType: string;
  toolOrCommand: string;
  target: string;
  decision: AuditDecision;
  userDecision?: string;
  enforcement?: string;
  args?: string;
}

const auditEvents: AuditEvent[] = [];

export const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|[/\\])\.env(?:\.|$)/,
  /(^|[/\\])\.ssh([/\\]|$)/,
  /(^|[/\\])\.aws([/\\]|$)/,
  /(^|[/\\])\.gnupg([/\\]|$)/,
  /(^|[/\\])credentials?([/\\.]|$)/i,
  /(^|[/\\])secrets?([/\\.]|$)/i,
];

export const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  /(^|\s)rm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|--recursive)\b/,
  /(^|\s)dd\s+if=/,
  /(^|\s)(mkfs|mke2fs|newfs)\b/,
  /(^|\s)(shred|wipe)\b/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /while\s+true\s*;/,
  /(^|\s)yes\s*\|/,
  /(^|\s)(sudo|su|pkexec|doas)\b/,
  /git\s+push\s+(?:--force|-f)\b/,
  /git\s+reset\s+--hard\b/,
  /git\s+clean\s+-f(?:d|x|dx|xd)\b/,
  /git\s+branch\s+-D\b/,
  /chmod\s+(?:-R\s+)?777\b/,
  /(^|\s)chown\b/,
  /(^|\s)chattr\b/,
  /(?:curl|wget)[^|]*\|\s*(?:sh|bash)\b/,
  /source\s+<\(\s*curl\b/,
  /systemctl\s+(?:disable|mask)\b/,
  /launchctl\s+unload\b/,
  /pip\s+uninstall\s+-y\b/,
  /npm\s+uninstall\s+-g\b/,
  /brew\s+uninstall\s+--force\b/,
  /(?:npm|cargo)\s+publish\b/,
];

export function requirePermission(manifest: PermissionManifest, capability: string): boolean {
  if (manifest.tier === "blocked" || manifest.review.status === "blocked") return false;
  if (capability === "browser") return manifest.permissions.browser;
  if (capability === "models") return manifest.permissions.models;
  if (capability.startsWith("ui:")) return manifest.permissions.ui.includes(capability.slice(3));
  if (capability.startsWith("subprocess:"))
    return (
      manifest.permissions.subprocess.includes(capability.slice(11)) || manifest.permissions.subprocess.includes("*")
    );
  if (capability.startsWith("network:"))
    return manifest.permissions.network.includes(capability.slice(8)) || manifest.permissions.network.includes("*");
  if (capability.startsWith("fs:read:"))
    return isPathAllowed(capability.slice(8), manifest.permissions.filesystem.read, []);
  if (capability.startsWith("fs:write:"))
    return isPathAllowed(capability.slice(9), manifest.permissions.filesystem.write, []);
  return false;
}

export function auditEvent(event: AuditEvent): void {
  const args = event.args === undefined ? undefined : redactSecrets(event.args).text;
  auditEvents.push(args === undefined ? event : { ...event, args });
  if (auditEvents.length > 1000) auditEvents.splice(0, auditEvents.length - 1000);
}

export function getAuditEvents(): AuditEvent[] {
  return [...auditEvents];
}

export function clearAuditEvents(): void {
  auditEvents.splice(0, auditEvents.length);
}

export function isPathAllowed(candidate: string, allowedPaths: string[], deniedPaths: string[] = []): boolean {
  if (SECRET_PATH_PATTERNS.some((pattern) => pattern.test(candidate))) return false;
  const resolved = path.resolve(candidate);
  for (const denied of deniedPaths) {
    if (isWithin(resolved, path.resolve(denied))) return false;
  }
  if (allowedPaths.includes("*")) return true;
  return allowedPaths.some((allowed) => isWithin(resolved, path.resolve(allowed)));
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function isCommandAllowed(
  command: string,
  allowedCommands: string[] = [],
  deniedPatterns: RegExp[] = DESTRUCTIVE_COMMAND_PATTERNS,
): boolean {
  if (deniedPatterns.some((pattern) => pattern.test(command))) return false;
  if (allowedCommands.includes("*")) return true;
  const trimmed = command.trim();
  return allowedCommands.some((allowed) => trimmed === allowed || trimmed.startsWith(`${allowed} `));
}

type ToolCallClassification = { actionType: string; target: string; dangerous: boolean; reason?: string };

export function classifyToolCall(toolName: string, args: unknown): ToolCallClassification {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (toolName === "bash") {
    const command = String(record.command ?? "");
    const safe = isCommandAllowed(command, [
      "pwd",
      "date",
      "git status",
      "git diff",
      "git log",
      "node --version",
      "npm --version",
      "bun --version",
    ]);
    return safe
      ? { actionType: "subprocess", target: command, dangerous: false }
      : {
          actionType: "subprocess",
          target: command,
          dangerous: true,
          reason: "Command is not allowlisted or matches denylist",
        };
  }
  if (toolName === "ast_edit") {
    return { actionType: "preview", target: astEditTarget(record), dangerous: false };
  }
  if (toolName === "resolve") {
    return classifyAstPreviewFinalizer(record);
  }
  if (["write", "edit"].includes(toolName)) {
    return {
      actionType: "filesystem-write",
      target: String(record.path ?? toolName),
      dangerous: true,
      reason: "Mutation tools are delegated to Pi approval",
    };
  }
  if (toolName === "browser" && ["doctor", "stop", "snapshot"].includes(String(record.action ?? ""))) {
    return { actionType: "browser", target: String(record.action), dangerous: false };
  }
  if (toolName.startsWith("browser")) {
    return {
      actionType: "browser",
      target: String(record.url ?? toolName),
      dangerous: true,
      reason: "Browser/network tools are delegated to Pi approval and user policy",
    };
  }
  if (toolName === "read") {
    const target = String(record.path ?? "");
    const dangerous = SECRET_PATH_PATTERNS.some((pattern) => pattern.test(target));
    return dangerous
      ? {
          actionType: "filesystem-read",
          target,
          dangerous,
          reason: "Secret-path reads are delegated to Pi approval and user policy",
        }
      : { actionType: "filesystem-read", target, dangerous };
  }
  return { actionType: "tool", target: toolName, dangerous: false };
}

function classifyAstPreviewFinalizer(record: Record<string, unknown>): ToolCallClassification {
  const action = String(record.action ?? "");
  return {
    actionType: action === "apply" ? "filesystem-write" : "preview",
    target: astPreviewTarget(record, "resolve"),
    dangerous: false,
  };
}

function astEditTarget(record: Record<string, unknown>): string {
  const paths = record.paths;
  if (Array.isArray(paths) && paths.length) return paths.map(String).join(",");
  return String(record.path ?? "ast_edit");
}

function astPreviewTarget(record: Record<string, unknown>, fallback: string): string {
  const extra =
    record.extra !== null && typeof record.extra === "object" ? (record.extra as Record<string, unknown>) : undefined;
  return String(record.previewId ?? extra?.previewId ?? fallback);
}
