import { Type } from "@sinclair/typebox";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "../_shared/pi-api.js";
import { errorResult, getCommandText, getProjectRoot, textResult } from "../_shared/pi-api.js";
import { registerCommandWithUiLifecycle } from "../_shared/command-ui.js";
import { idsByCurrentStatus, idsByOwnershipStatus } from "../_shared/extension-inventory.js";
import {
  planTaskLifecycleTransition,
  type TaskLifecyclePlan,
  type TaskLifecycleTargetStatus,
} from "../_shared/task-bridge.js";
import type { OperatorBlock } from "../_shared/operator-ui.js";
import { setOperatorWidget } from "../_shared/widget-render.js";
import { errorMessage } from "../_shared/error-text.js";

const ReloadParams = Type.Object({});
const DEVEXT_WIDGET_KEY = "devext-doctor";
const DOCTOR_PREVIEW_LIMIT = 2;

export default function devextDoctor(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "devext_reload",
    description:
      "Hot-reload Pi extensions, skills, prompts, themes, and context files when this host exposes a direct reload method to tool contexts; otherwise fail closed with manual reload instructions.",
    parameters: ReloadParams,
    approval: "exec",
    async execute(_toolCallId, _params, _signal, _update, ctx) {
      const reload = reloadMethod(ctx);
      if (reload === undefined) {
        return errorResult(
          [
            "devext_reload cannot reload this running Pi process from a tool context.",
            "This host exposes ctx.reload() only to command handlers, and slash commands injected by tools are delivered as chat in this environment.",
            "Run /devext reload or the built-in /reload from the interactive command input, or restart Pi.",
          ].join("\n"),
          {
            owner: "devext-doctor",
            requestedSurface: "devext_reload",
            status: "blocked",
            hostCapability: "tool-context-reload-unavailable",
            queuedCommand: false,
          },
        );
      }
      try {
        ctx.ui.notify("Reloading Pi runtime via tool ctx.reload().", "info");
        await reload();
      } catch (error) {
        return errorResult(`Could not reload Pi runtime: ${errorMessage(error)}`, {
          owner: "devext-doctor",
          requestedSurface: "devext_reload",
          status: "failed",
        });
      }
      return textResult("Reloaded Pi runtime via tool ctx.reload().", {
        owner: "devext-doctor",
        requestedSurface: "devext_reload",
        status: "completed",
        queuedCommand: false,
      });
    },
  });
  registerCommandWithUiLifecycle(
    pi,
    {
      command: "devext",
      group: "devext-doctor",
      surfaces: ["transient-widget", "no-ui"],
      transientWidgets: [DEVEXT_WIDGET_KEY],
      transientStatuses: [DEVEXT_WIDGET_KEY],
    },
    {
      description:
        "Developer extension package doctor: /devext doctor | /devext task-lifecycle <task-id> <target-status> | /devext reload.",
      handler: async (args, ctx) => {
        const raw = getCommandText(args).trim();
        if (raw === "" || raw === "doctor") {
          setOperatorWidget(ctx, DEVEXT_WIDGET_KEY, doctorBlock(ctx.mode !== "tui"));
          return;
        }

        const [action, ...rest] = raw.split(/\s+/);
        if (action === "reload" || action === "hot-reload") {
          await reloadRuntime(ctx);
          return;
        }

        if (action === "task-lifecycle") {
          const [taskId, targetStatus] = rest;
          if (taskId === undefined || targetStatus === undefined) {
            setOperatorWidget(ctx, DEVEXT_WIDGET_KEY, {
              type: "WARN",
              subject: "Task lifecycle dry-run",
              primary: "Missing task id or target status.",
              metadata: ["Read-only dry-run; no task mutation was attempted."],
              controls: ["Retry: /devext task-lifecycle <task-id> <target-status>"],
            });
            return;
          }

          const plan = planTaskLifecycleTransition(
            getProjectRoot(ctx),
            taskId,
            targetStatus as TaskLifecycleTargetStatus,
          );
          setOperatorWidget(ctx, DEVEXT_WIDGET_KEY, taskLifecycleBlock(plan, ctx.mode !== "tui"));
          return;
        }

        setOperatorWidget(ctx, DEVEXT_WIDGET_KEY, {
          type: "WARN",
          subject: "Developer extension command",
          primary:
            ctx.mode === "tui"
              ? `Unknown /devext action: ${action ?? raw}`
              : compactDevextLine(`Unknown /devext action: ${action ?? raw}`),
          metadata: ["No diagnostic, task mutation, or reload was attempted."],
          controls: ["Usage: /devext doctor · /devext task-lifecycle <task-id> <target-status> · /devext reload"],
        });
      },
    },
  );
}

async function reloadRuntime(ctx: ExtensionCommandContext): Promise<void> {
  const compact = ctx.mode !== "tui";
  if (typeof ctx.reload !== "function") {
    setOperatorWidget(ctx, DEVEXT_WIDGET_KEY, {
      type: "WARN",
      subject: "Pi runtime reload",
      primary: "Reload is unavailable on this host.",
      metadata: ["Host capability: ctx.reload() is not exposed."],
      controls: ["Recovery: run /reload manually or restart Pi."],
    });
    return;
  }
  setOperatorWidget(ctx, DEVEXT_WIDGET_KEY, {
    type: "RUN",
    subject: "Pi runtime reload",
    primary: "Reload requested through host ctx.reload().",
    metadata: ["Pi owns reload completion; this old command frame is not completion proof."],
  });
  try {
    await ctx.reload();
  } catch (error) {
    setOperatorWidget(ctx, DEVEXT_WIDGET_KEY, {
      type: "ERROR",
      subject: "Pi runtime reload",
      primary: "Reload failed.",
      body: [compact ? compactDevextLine(`Reason: ${errorMessage(error)}`) : `Reason: ${errorMessage(error)}`],
      controls: ["Recovery: run /reload manually or restart Pi."],
    });
  }
}

function reloadMethod(ctx: unknown): (() => Promise<void> | void) | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  const candidate = (ctx as { reload?: unknown }).reload;
  return typeof candidate === "function" ? () => candidate.call(ctx) as Promise<void> | void : undefined;
}

function doctorBlock(compact = false): OperatorBlock {
  const activeDefaults = idsByCurrentStatus("active");
  const compatWrappers = idsByOwnershipStatus("compat-wrapper");
  const activeCompatWrappers = activeDefaults.filter((id) => compatWrappers.includes(id)).sort();
  const disabledCompatWrappers = compatWrappers.filter((id) => !activeDefaults.includes(id)).sort();
  const ompOwnedToImport = idsByOwnershipStatus("omp-owned-to-import");
  const redesignLater = idsByOwnershipStatus("redesign-later");
  const splitRequired = idsByOwnershipStatus("split-required");
  const fixtures = idsByOwnershipStatus("locus-specific").filter((id) => !activeDefaults.includes(id));
  const deleted = idsByCurrentStatus("deleted");
  if (compact) {
    return {
      type: "VIEW",
      subject: "Extension doctor",
      primary: `${activeDefaults.length} active default extension(s).`,
      badges: [
        { text: "status:ok", tone: "success" },
        { text: "diagnostic", tone: "muted" },
      ],
      body: [
        `default surface: ${activeDefaults.length} active extension(s)`,
        compactDevextLine(`active defaults: ${summarizeIds(activeDefaults)}`),
        compactDevextLine(
          `compat wrappers: ${activeCompatWrappers.length} active; ${summarizeDisabled(disabledCompatWrappers)}`,
        ),
        compactDevextLine(
          `backlog/design: omp=${ompOwnedToImport.length} redesign=${redesignLater.length} split=${splitRequired.length} fixtures=${fixtures.length} deleted=${deleted.length}`,
        ),
      ],
      metadata: [
        "Evidence boundary: inventory/manifests snapshot only; not runtime proof.",
        "Details: docs/extension-index.md; manifests under extensions/**",
      ],
      controls: ["Actions: /devext task-lifecycle <id> <status> · /devext reload"],
    };
  }
  return {
    type: "VIEW",
    subject: "Extension doctor",
    primary: `${activeDefaults.length} active default extension(s).`,
    badges: [
      { text: "status:ok", tone: "success" },
      { text: "diagnostic", tone: "muted" },
    ],
    body: [
      `default surface: ${activeDefaults.length} active extension(s)`,
      `active defaults: ${summarizeIds(activeDefaults)}`,
      `compat wrappers: ${activeCompatWrappers.length} active; ${summarizeDisabled(disabledCompatWrappers)}`,
      `omp backlog: ${summarizeIds(ompOwnedToImport)}`,
      `redesign/split: ${redesignLater.length} redesign; ${splitRequired.length} split`,
      `fixtures/deleted: ${fixtures.length} fixture(s); ${deleted.length} deleted`,
    ],
    metadata: [
      "Evidence boundary: inventory/manifests snapshot only; disabled or listed extensions are not runtime-proven.",
      "Cleanup: clears on next unrelated input.",
      "Details: docs/extension-index.md; manifests under extensions/**",
    ],
    controls: ["Actions: /devext task-lifecycle <task-id> <target-status> · /devext reload"],
  };
}

function taskLifecycleBlock(plan: TaskLifecyclePlan, compact = false): OperatorBlock {
  if (compact) return compactTaskLifecycleBlock(plan);
  const body = [`ok: ${plan.ok}`, `taskId: ${plan.taskId}`, `targetStatus: ${plan.targetStatus}`];
  if (plan.ok) {
    body.push(`taskTitle: ${plan.taskTitle}`, `taskPath: ${plan.taskPath}`, `currentStatus: ${plan.currentStatus}`);
  } else {
    body.push(`code: ${plan.code}`);
    if (plan.code !== "missing-task") {
      body.push(`taskTitle: ${plan.taskTitle}`, `taskPath: ${plan.taskPath}`, `currentStatus: ${plan.currentStatus}`);
    }
    if (plan.code === "unsupported-transition")
      body.push(`allowedTargets: ${plan.allowedTargets.join(", ") || "none"}`);
    if (plan.code === "done-precondition-failed") {
      body.push("missingPreconditions:", ...plan.missingPreconditions.map((item) => `- ${item}`));
    }
  }
  return {
    type: plan.ok ? "VIEW" : "WARN",
    subject: "Task lifecycle dry-run",
    primary: plan.ok
      ? `${plan.taskId}: ${plan.currentStatus} -> ${plan.targetStatus} is allowed.`
      : `${plan.taskId}: transition to ${plan.targetStatus} is not ready.`,
    badges: [{ text: "dry-run", tone: "muted" }],
    body,
    metadata: [
      "dryRun: true",
      `message: ${plan.message}`,
      "Evidence boundary: this view reads task state and does not mutate it.",
    ],
    controls: [`Mutation path: locus task update ${plan.taskId} --status ${plan.targetStatus}`],
  };
}

function compactTaskLifecycleBlock(plan: TaskLifecyclePlan): OperatorBlock {
  const body = [`taskId: ${plan.taskId} · targetStatus: ${plan.targetStatus}`];
  if (plan.ok) {
    body.push(compactDevextLine(`currentStatus: ${plan.currentStatus} · taskTitle: ${plan.taskTitle}`));
  } else {
    body.push(
      compactDevextLine(
        `code: ${plan.code}${plan.code === "missing-task" ? "" : ` · currentStatus: ${plan.currentStatus}`}`,
      ),
    );
    if (plan.code === "unsupported-transition") {
      body.push(compactDevextLine(`allowedTargets: ${plan.allowedTargets.join(", ") || "none"}`));
    }
    if (plan.code === "done-precondition-failed") {
      body.push(compactDevextLine(`missingPreconditions: ${plan.missingPreconditions.join("; ")}`));
    }
  }
  return {
    type: plan.ok ? "VIEW" : "WARN",
    subject: "Task lifecycle dry-run",
    primary: compactDevextLine(
      plan.ok
        ? `${plan.taskId}: ${plan.currentStatus} -> ${plan.targetStatus} is allowed.`
        : `${plan.taskId}: transition to ${plan.targetStatus} is not ready.`,
    ),
    badges: [{ text: "dry-run", tone: "muted" }],
    body,
    metadata: [
      "dryRun: true",
      compactDevextLine(`message: ${plan.message}`),
      "Evidence boundary: read-only task snapshot; no mutation was attempted.",
    ],
    controls: [compactDevextLine(`Mutation path: locus task update ${plan.taskId} --status ${plan.targetStatus}`)],
  };
}

function compactDevextLine(value: string): string {
  const plain = value.replace(/\s+/gu, " ").trim();
  if (visibleWidth(plain) <= 72) return plain;
  return `${sliceByColumn(plain, 0, 71)}…`;
}

function summarizeIds(ids: string[]): string {
  if (ids.length === 0) return "0 total";
  const preview = ids.slice(0, DOCTOR_PREVIEW_LIMIT);
  const remaining = ids.length - preview.length;
  const more = remaining > 0 ? `, +${remaining} more` : "";
  return `${ids.length} total (${preview.join(", ")}${more})`;
}

function summarizeDisabled(ids: string[]): string {
  if (ids.length === 0) return "0 disabled";
  return `${ids.length} disabled (${summarizePreview(ids)})`;
}

function summarizePreview(ids: string[]): string {
  const preview = ids.slice(0, DOCTOR_PREVIEW_LIMIT);
  const remaining = ids.length - preview.length;
  const more = remaining > 0 ? `, +${remaining} more` : "";
  return `${preview.join(", ")}${more}`;
}
