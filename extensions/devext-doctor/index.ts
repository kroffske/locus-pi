import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { getCommandText, getProjectRoot } from "../_shared/host/pi-api.js";
import { registerCommandWithUiLifecycle } from "../_shared/operator/command-ui.js";
import { countBy, readPackageInventory } from "./package-inventory.mjs";
import {
  planTaskLifecycleTransition,
  type TaskLifecyclePlan,
  type TaskLifecycleTargetStatus,
} from "../_shared/project/task-bridge.js";
import type { OperatorBlock } from "../_shared/operator/operator-ui.js";
import { setOperatorWidget } from "../_shared/operator/widget-render.js";
import { compactOperatorLine } from "../_shared/operator/operator-ui.js";

const DEVEXT_WIDGET_KEY = "devext-doctor";
const DOCTOR_PREVIEW_LIMIT = 2;

export default function devextDoctor(pi: ExtensionAPI): void {
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
        "Developer extension package doctor: /devext doctor | /devext task-lifecycle <task-id> <target-status>.",
      handler: async (args, ctx) => {
        const raw = getCommandText(args).trim();
        if (raw === "" || raw === "doctor") {
          setOperatorWidget(ctx, DEVEXT_WIDGET_KEY, doctorBlock(ctx.mode !== "tui"));
          return;
        }

        const [action, ...rest] = raw.split(/\s+/);
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
          metadata: ["No diagnostic or task mutation was attempted."],
          controls: ["Usage: /devext doctor · /devext task-lifecycle <task-id> <target-status>"],
        });
      },
    },
  );
}

/**
 * The installed package surface, not the project's migration history. Everything rendered here comes
 * from `package.json#pi.extensions` and the manifests it points at, read at command time, so a twelfth
 * entrypoint appears without editing this file and a missing one is reported instead of assumed.
 */
function doctorBlock(compact = false): OperatorBlock {
  const inventory = readPackageInventory();
  const declared = inventory.rows.length;
  const ids = inventory.rows.map((row) => row.id).sort();
  const healthy = inventory.problems.length === 0;
  const line = compact ? compactDevextLine : (value: string) => value;
  const body = [
    line(`package: ${inventory.name} ${inventory.version}`),
    line(`declared entrypoints: ${declared}`),
    line(`installed: ${summarizeIds(ids)}`),
    line(`risk: ${countBy(inventory.rows, "risk").join(" ") || "none"}`),
    line(`ownership: ${countBy(inventory.rows, "ownership").join(" ") || "none"}`),
  ];
  if (!healthy) {
    // Compact and RPC projections have a line budget the operator layer would otherwise spend
    // shedding rows; one summarized line keeps the first fault and the count of the rest visible.
    if (compact) body.push(line(`problems: ${summarizeProblems(inventory.problems)}`));
    else body.push(...inventory.problems.map((problem) => `problem: ${problem}`));
  }
  return {
    type: healthy ? "VIEW" : "WARN",
    subject: "Extension doctor",
    primary: line(
      healthy
        ? `${declared} declared entrypoint(s); every entrypoint and manifest is present.`
        : `${declared} declared entrypoint(s); ${inventory.problems.length} problem(s) found.`,
    ),
    badges: [
      { text: healthy ? "status:ok" : "status:degraded", tone: healthy ? "success" : "warning" },
      { text: "diagnostic", tone: "muted" },
    ],
    body,
    metadata: [
      "Evidence boundary: declared entrypoints and their manifests were read from disk; this is not runtime proof that each extension loaded.",
      "Manifest contents are reported, not validated: `npm run check:manifests` owns the manifest contract.",
      "Details: docs/extensions.md; manifests under extensions/**",
    ],
    controls: ["Action: /devext task-lifecycle <task-id> <target-status>"],
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
  return compactOperatorLine(value, 72);
}

function summarizeProblems(problems: string[]): string {
  const [first, ...rest] = problems;
  return rest.length === 0 ? (first ?? "none") : `${first}; +${rest.length} more`;
}

function summarizeIds(ids: string[]): string {
  if (ids.length === 0) return "0 total";
  const preview = ids.slice(0, DOCTOR_PREVIEW_LIMIT);
  const remaining = ids.length - preview.length;
  const more = remaining > 0 ? `, +${remaining} more` : "";
  return `${ids.length} total (${preview.join(", ")}${more})`;
}
