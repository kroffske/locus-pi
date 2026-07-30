import { stripVTControlCharacters } from "node:util";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { getCommandText } from "../_shared/host/pi-api.js";
import { registerCommandWithUiLifecycle } from "../_shared/operator/command-ui.js";
import { auditEvent, classifyToolCall, getAuditEvents, type AuditEvent } from "./permissions.js";
import { redactSecrets } from "../_shared/host/redaction.js";
import type { OperatorBlock } from "../_shared/operator/operator-ui.js";
import { setOperatorWidget } from "../_shared/operator/widget-render.js";

const DEFAULT_AUDIT_LIMIT = 20;
const MAX_AUDIT_LIMIT = 50;
const AUDIT_TARGET_WIDTH = 72;

export default function securityGate(pi: ExtensionAPI): void {
  registerCommandWithUiLifecycle(
    pi,
    {
      command: "security-audit",
      group: "security-audit",
      surfaces: ["transient-widget"],
      transientWidgets: ["security-audit"],
    },
    {
      description: "Show audit-only security observations for local tool calls.",
      handler: (args, ctx) => {
        const allEvents = getAuditEvents();
        const limit = auditLimit(getCommandText(args));
        const events = allEvents.slice(-limit).reverse();
        setOperatorWidget(ctx, "security-audit", securityAuditBlock(events, allEvents.length, ctx.mode !== "tui"));
      },
    },
  );

  pi.on("tool_call", (event) => {
    const classification = classifyToolCall(event.toolName ?? "", event.input ?? event.toolArgs ?? {});
    const timestamp = new Date().toISOString();

    if (classification.dangerous) {
      auditEvent({
        timestamp,
        extensionId: "security-gate",
        actionType: classification.actionType,
        toolOrCommand: event.toolName ?? "",
        target: classification.target,
        decision: "allow",
        userDecision: "delegated-to-pi",
        enforcement: "pi-original",
        args: JSON.stringify({ reason: classification.reason }),
      });
      return;
    }

    auditEvent({
      timestamp,
      extensionId: "security-gate",
      actionType: classification.actionType,
      toolOrCommand: event.toolName ?? "",
      target: classification.target,
      decision: "allow",
    });
  });
}

function auditLimit(raw: string): number {
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_AUDIT_LIMIT;
  return Math.min(parsed, MAX_AUDIT_LIMIT);
}

function securityAuditBlock(events: readonly AuditEvent[], total: number, compact = false): OperatorBlock {
  const shownEvents = compact ? events.slice(0, 3) : events;
  const hidden = Math.max(0, total - shownEvents.length);
  return {
    type: "VIEW",
    subject: "Security audit",
    primary:
      shownEvents.length === 0
        ? "No historical local security audit events."
        : `Showing ${shownEvents.length} newest of ${total} local observation(s).`,
    badges: [
      { text: "audit-only", tone: "warning" },
      { text: "Pi enforcement", tone: "muted" },
    ],
    body: shownEvents.map((event) => formatAuditRow(event, compact)),
    metadata: compact
      ? [
          "Mode: audit-only; Pi owns enforcement.",
          "Columns: severity | decision | action | tool | target (newest first)",
          "Pi owns approval/deny; process-local observations are not enforcement proof.",
          ...(hidden > 0 ? [`+${hidden} hidden`] : []),
        ]
      : [
          "Mode: audit-only; Pi owns enforcement.",
          "Columns: time | severity | decision | action | tool | target",
          "Pi owns approval, prompt, and deny decisions; Locus records observations without blocking.",
          "Evidence boundary: in-memory process-local audit ring; not durable enforcement proof.",
          ...(hidden > 0 ? [`+${hidden} hidden`] : []),
        ],
    controls: [`Limit: /security-audit <1-${MAX_AUDIT_LIMIT}>`],
  };
}

function formatAuditRow(event: AuditEvent, compact = false): string {
  const severity = event.userDecision === "delegated-to-pi" ? "WARN" : "INFO";
  const decision = `${event.decision}${event.userDecision === undefined ? "" : `/${event.userDecision}`}`;
  if (compact) {
    return [
      severity,
      safeAuditCell(decision, 24),
      safeAuditCell(event.actionType, 12),
      safeAuditCell(event.toolOrCommand, 10),
      safeAuditCell(event.target, 12),
    ].join(" | ");
  }
  return [
    compactAuditTimestamp(event.timestamp),
    severity,
    decision,
    safeAuditCell(event.actionType, 24),
    safeAuditCell(event.toolOrCommand, 24),
    safeAuditCell(event.target, AUDIT_TARGET_WIDTH),
  ].join(" | ");
}

function compactAuditTimestamp(value: string): string {
  return safeAuditCell(value, 24);
}

function safeAuditCell(value: string, width: number): string {
  const plain = stripVTControlCharacters(value).replace(/\s+/gu, " ").trim();
  const redacted = redactSecrets(plain).text;
  if (visibleWidth(redacted) <= width) return redacted;
  return `${sliceByColumn(redacted, 0, Math.max(0, width - 1))}…`;
}
