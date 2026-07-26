import type { ExtensionAPI, ExtensionContext, ModelLike, ThinkingLevel } from "../_shared/pi-api.js";
import {
  formatAssignment,
  getModelRolesConfigPaths,
  loadModelRolesState,
  MODEL_ROLES_SESSION_ENTRY_TYPE,
  setModelRoleSetting,
  type ModelRoleAssignment,
  type ModelRoleSessionEntry,
  type ModelRolesConfig,
  type ModelRolesConfigPaths,
  type ModelRolesState,
  type ModelRoleValue,
} from "../_shared/model-settings.js";
import { getCommandText, getProjectRoot, getSessionId, getWorkingDirectory } from "../_shared/pi-api.js";
import { registerCommandWithUiLifecycle } from "../_shared/command-ui.js";
import {
  isStaleInlineOperatorInteractionError,
  isSupersededInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
} from "../_shared/operator-interaction.js";
import { clearOperatorStatus, setOperatorStatus, type OperatorStatusContribution } from "../_shared/operator-status.js";
import type { OperatorBlock } from "../_shared/operator-ui.js";
import { createSessionStore, getRuntimeCapabilityReport } from "../_shared/runtime-capabilities.js";
import { setOperatorWidget } from "../_shared/widget-render.js";
import {
  buildModelRows,
  createModelRoleSelectorTheme,
  effortLevelsForModel,
  modelEffortCapability,
  modelSelector,
  ModelRoleSelectorComponent,
  roleSummaries,
  THINKING_LEVELS,
  type AppliedModelRoleState,
  type ModelRoleSelection,
  type RoleSummary,
} from "./model-role-selector.js";

export {
  formatAssignment,
  getModelRolesConfigPaths,
  loadModelRolesState,
  setModelRoleSetting,
  type ModelRoleAssignment,
  type ModelRoleValue,
  type ModelRolesConfig,
  type ModelRolesConfigPaths,
  type ModelRolesState,
};
export {
  effortLevelsForModel,
  modelEffortCapability,
  ModelRoleSelectorComponent,
  MODEL_ROLE_ACTIONS,
  THINKING_LEVELS,
} from "./model-role-selector.js";

interface ModelRoleRuntimeEvent {
  role: string;
  assignment: string;
  requestedThinking: ThinkingLevel;
  beforeModel: string | undefined;
  currentModel: string | undefined;
  currentThinking: ThinkingLevel | undefined;
  modelApplied: boolean;
  thinkingApplied: boolean;
  rolePersisted: boolean;
  rolePersistenceError?: string;
  customEntryAppended: boolean;
  configPath: string;
}

export type EffortCommandOutcome =
  | { kind: "unknown"; requested: string; supported: readonly ThinkingLevel[] }
  | { kind: "unsupported"; requested: ThinkingLevel; model: string; supported: readonly ThinkingLevel[] }
  | {
      kind: "selector-unavailable";
      mode: string;
      current: ThinkingLevel | undefined;
      supported: readonly ThinkingLevel[];
    }
  | { kind: "unavailable"; operation: "control" | "verification"; supported: readonly ThinkingLevel[] }
  | { kind: "clamped"; requested: ThinkingLevel; actual: ThinkingLevel; supported: readonly ThinkingLevel[] }
  | {
      kind: "unchanged";
      level: ThinkingLevel;
      supported: readonly ThinkingLevel[];
      capability: "registry" | "legacy" | "unknown";
    }
  | {
      kind: "changed";
      level: ThinkingLevel;
      supported: readonly ThinkingLevel[];
      capability: "registry" | "legacy" | "unknown";
    };

export function buildEffortOperatorBlock(outcome: EffortCommandOutcome): OperatorBlock {
  const supported = outcome.supported.join(", ") || "none";

  switch (outcome.kind) {
    case "unknown":
      return {
        type: "ERROR",
        subject: "Thinking effort",
        primary: `Unknown effort level: ${outcome.requested}.`,
        body: ["Current session effort was not changed."],
        metadata: [`Supported: ${supported}`],
        controls: ["Use: /effort <level>", "Choose interactively: /effort"],
      };
    case "unsupported":
      return {
        type: "ERROR",
        subject: "Thinking effort",
        primary: `${outcome.model} does not support ${outcome.requested}.`,
        body: ["Current session effort was not changed."],
        metadata: [`Supported: ${supported}`],
        controls: ["Choose a supported level: /effort"],
      };
    case "selector-unavailable":
      return {
        type: "WARN",
        subject: "Thinking effort",
        primary: `Interactive effort selection is unavailable in ${outcome.mode} mode.`,
        metadata: [`Current: ${outcome.current ?? "unknown"}`, `Supported: ${supported}`, "Scope: current Pi session"],
        controls: ["Use an explicit level: /effort <level>"],
      };
    case "unavailable":
      return {
        type: "ERROR",
        subject: "Thinking effort",
        primary:
          outcome.operation === "control"
            ? "Pi host does not expose thinking-level control."
            : "Pi host does not expose thinking-level verification.",
        body: ["Effort was not changed because the result could not be verified."],
        metadata: [`Supported: ${supported}`],
        controls: ["Update or reconfigure the Pi host, then retry /effort."],
      };
    case "clamped":
      return {
        type: "WARN",
        subject: "Thinking effort",
        primary: `Pi kept ${outcome.actual}; ${outcome.requested} was not accepted.`,
        metadata: [
          `Requested: ${outcome.requested}`,
          `Actual: ${outcome.actual}`,
          `Supported: ${supported}`,
          "Scope: current Pi session",
        ],
        controls: ["Choose another level: /effort"],
      };
    case "unchanged":
      return {
        type: "VIEW",
        subject: "Thinking effort",
        primary: `Current session effort remains ${outcome.level}.`,
        metadata: [`Supported: ${supported}`, `Capability: ${outcome.capability}`, "Scope: current Pi session"],
        controls: ["Choose another level: /effort"],
      };
    case "changed":
      return {
        type: "CHANGE",
        subject: "Thinking effort",
        primary: `Current session effort is now ${outcome.level}.`,
        metadata: [`Supported: ${supported}`, `Capability: ${outcome.capability}`, "Scope: current Pi session"],
        controls: ["Choose another level: /effort"],
      };
  }
}

export default function model(pi: ExtensionAPI): void {
  registerCommandWithUiLifecycle(
    pi,
    {
      command: "model-roles",
      group: "model-roles",
      surfaces: ["overlay-selector", "transient-widget", "persistent-state", "status"],
      transientWidgets: ["model-roles"],
    },
    {
      description: "Select the current model and save Locus model role assignments.",
      async handler(_args, ctx) {
        await runModelUi(pi, ctx);
      },
    },
  );

  registerCommandWithUiLifecycle(
    pi,
    {
      command: "effort",
      group: "effort",
      surfaces: ["overlay-selector", "transient-widget"],
      transientWidgets: ["effort"],
    },
    {
      description: "Usage: /effort [off|minimal|low|medium|high|xhigh]. Set the current model's thinking effort.",
      async handler(args, ctx) {
        await runEffortCommand(pi, ctx, getCommandText(args));
      },
    },
  );

  pi.on("session_start", async (_event, ctx) => {
    await updateModelRoleStatus(ctx, undefined, pi);
  });
}

async function runEffortCommand(pi: ExtensionAPI, ctx: ExtensionContext, raw: string): Promise<void> {
  const current = pi.getThinkingLevel?.();
  const levels = effortLevelsForModel(ctx.model);
  const capability = modelEffortCapability(ctx.model);
  const requested = raw.trim().toLowerCase();

  let target: ThinkingLevel | undefined;
  if (requested !== "") {
    if (!(THINKING_LEVELS as readonly string[]).includes(requested)) {
      presentEffortOutcome(ctx, { kind: "unknown", requested, supported: levels });
      return;
    }
    target = requested as ThinkingLevel;
    if (!levels.includes(target)) {
      presentEffortOutcome(ctx, {
        kind: "unsupported",
        requested: target,
        model: ctx.model ? modelSelector(ctx.model) : "Current model",
        supported: levels,
      });
      return;
    }
  } else {
    if (ctx.mode !== "tui" || ctx.hasUI === false) {
      presentEffortOutcome(ctx, {
        kind: "selector-unavailable",
        mode: ctx.mode ?? "noninteractive",
        current,
        supported: levels,
      });
      return;
    }
    const selectorLevels =
      current !== undefined && levels.includes(current)
        ? [current, ...levels.filter((level) => level !== current)]
        : levels;
    const choice = await ctx.ui.select(
      `[SELECT] Thinking effort · current ${current ?? "unknown"} · ${ctx.model ? modelSelector(ctx.model) : "model unset"}`,
      selectorLevels,
    );
    if (typeof choice !== "string" && choice?.cancelled === true) return;
    const value = typeof choice === "string" ? choice : choice?.value;
    if (!value) return;
    target = value as ThinkingLevel;
  }

  if (target === current) {
    presentEffortOutcome(ctx, {
      kind: "unchanged",
      level: current,
      supported: levels,
      capability: capability.known ? capability.source : "unknown",
    });
    return;
  }

  if (!pi.setThinkingLevel) {
    presentEffortOutcome(ctx, { kind: "unavailable", operation: "control", supported: levels });
    return;
  }
  if (!pi.getThinkingLevel) {
    presentEffortOutcome(ctx, { kind: "unavailable", operation: "verification", supported: levels });
    return;
  }
  pi.setThinkingLevel(target);
  const after = pi.getThinkingLevel();
  if (after !== target) {
    presentEffortOutcome(ctx, { kind: "clamped", requested: target, actual: after, supported: levels });
    return;
  }
  presentEffortOutcome(ctx, {
    kind: "changed",
    level: after,
    supported: levels,
    capability: capability.known ? capability.source : "unknown",
  });
}

function presentEffortOutcome(ctx: ExtensionContext, outcome: EffortCommandOutcome): void {
  setOperatorWidget(ctx, "effort", buildEffortOperatorBlock(outcome), {
    fallbackWidth: 80,
  });
}

async function runModelUi(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const models = await availableModels(ctx);
  if (models.length === 0) {
    const state = await loadModelRolesState(ctx);
    const summaries = roleSummaries(state);
    publishModelRoleStatus(ctx, summaries);
    setOperatorWidget(
      ctx,
      "model-roles",
      modelRoleFallbackBlock(pi, ctx, summaries, "No configured models are available; the selector was not opened."),
    );
    return;
  }

  await showModelRoleSelector(pi, ctx, models);
}

async function applyModelRole(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  selection: ModelRoleSelection,
): Promise<AppliedModelRoleState> {
  const assignment = assignmentFromModel(selection.model, selection.thinking);
  if (!assignment) {
    return {
      ...(await currentModelRoleState(pi, ctx, undefined)),
      receipt: { kind: "error", text: "Selected model has no canonical provider/model selector." },
    };
  }

  const supportedEfforts = effortLevelsForModel(selection.model);
  if (!supportedEfforts.includes(selection.thinking)) {
    const message = `${selection.thinking} is not supported by ${assignment.model}; route was not saved.`;
    return {
      ...(await currentModelRoleState(pi, ctx, undefined)),
      receipt: { kind: "error", text: message },
    };
  }

  const targetSelector = formatAssignment(assignment);
  const beforeSelector = ctx.model ? modelSelector(ctx.model) : undefined;
  const beforeThinking = pi.getThinkingLevel?.();
  const shouldApplyModel = selection.action.appliesCurrentModel;
  let currentSelector = beforeSelector;
  let currentThinking = beforeThinking;
  let modelApplied = false;
  let thinkingApplied = false;
  let rolePersisted = false;
  let rolePersistenceError: string | undefined;
  let applyError: string | undefined;
  if (!shouldApplyModel) {
    modelApplied = false;
    thinkingApplied = false;
  } else if (!pi.setModel) {
    applyError = "Pi host did not expose current model switching for /model-roles.";
  } else if (!pi.setThinkingLevel || !pi.getThinkingLevel) {
    applyError = "Pi host did not expose verified thinking-level control for /model-roles.";
  } else {
    try {
      const selected = await pi.setModel(selection.model);
      if (selected === false) {
        applyError = "Pi host refused the selected model for /model-roles.";
      } else {
        currentSelector = ctx.model ? modelSelector(ctx.model) : undefined;
        modelApplied = currentSelector === assignment.model;
        if (!modelApplied) {
          applyError = `Pi accepted the model switch, but Current session stayed ${currentSelector ?? "unset"}.`;
        } else {
          pi.setThinkingLevel(selection.thinking);
          currentThinking = pi.getThinkingLevel();
          thinkingApplied = currentThinking === selection.thinking;
          if (!thinkingApplied) {
            applyError = `Pi clamped effort ${selection.thinking} to ${currentThinking}; DEFAULT route was not saved.`;
          }
        }
      }
    } catch (error) {
      applyError = error instanceof Error ? error.message : String(error);
    }
  }

  let customEntryAppended = false;
  const hostApplySucceeded = !shouldApplyModel || (modelApplied && thinkingApplied);
  if (hostApplySucceeded) {
    try {
      rolePersisted = await setModelRoleSetting(ctx, selection.action.role, assignment);
    } catch (error) {
      rolePersistenceError = error instanceof Error ? error.message : String(error);
      rolePersisted = false;
    }
    customEntryAppended = await appendModelRoleEntry(
      pi,
      selection.action.role,
      assignment,
      beforeSelector,
      currentSelector,
      modelApplied,
      rolePersisted,
    );
  } else {
    customEntryAppended = await appendModelRoleEntry(
      pi,
      selection.action.role,
      assignment,
      beforeSelector,
      currentSelector,
      modelApplied,
      false,
    );
  }

  const runtimeEventRecorded = recordModelRoleRuntimeEvent(ctx, {
    role: selection.action.role,
    assignment: targetSelector,
    requestedThinking: selection.thinking,
    beforeModel: beforeSelector,
    currentModel: currentSelector,
    currentThinking,
    modelApplied,
    thinkingApplied,
    rolePersisted,
    ...(rolePersistenceError === undefined ? {} : { rolePersistenceError }),
    customEntryAppended,
    configPath: getModelRolesConfigPaths(getProjectRoot(ctx)).project,
  });

  const succeeded = rolePersisted && hostApplySucceeded;
  const appliedState = await updateModelRoleStatus(ctx, currentSelector, pi);
  const evidenceWarnings = [
    ...(!customEntryAppended ? ["session evidence unavailable"] : []),
    ...(!runtimeEventRecorded ? ["runtime event unavailable"] : []),
  ];
  const partialSessionApply = shouldApplyModel && modelApplied && thinkingApplied && !rolePersisted;
  let receiptKind: "success" | "warning" | "error";
  let receiptText: string;
  if (succeeded) {
    receiptKind = evidenceWarnings.length > 0 ? "warning" : "success";
    receiptText = [
      `${selection.action.tag} → ${targetSelector} saved${shouldApplyModel ? "; Current session updated" : ""}.`,
      ...(evidenceWarnings.length === 0 ? [] : [`Evidence warning: ${evidenceWarnings.join(", ")}.`]),
    ].join(" ");
  } else if (partialSessionApply) {
    receiptKind = "warning";
    receiptText = `Current session changed to ${assignment.model} · effort ${selection.thinking}, but DEFAULT route was not saved${rolePersistenceError ? `: ${rolePersistenceError}` : "."}`;
  } else {
    receiptKind = "error";
    receiptText = applyError ?? rolePersistenceError ?? `${selection.action.tag} route was not saved.`;
  }
  return {
    ...appliedState,
    receipt: { kind: receiptKind, text: receiptText },
  };
}

async function appendModelRoleEntry(
  pi: ExtensionAPI,
  role: string,
  assignment: ModelRoleAssignment,
  beforeSelector: string | undefined,
  currentSelector: string | undefined,
  modelApplied: boolean,
  rolePersisted = true,
): Promise<boolean> {
  const entry: ModelRoleSessionEntry = {
    version: 1,
    role,
    assignment: formatAssignment(assignment),
    modelApplied,
    rolePersisted,
  };
  try {
    await pi.appendEntry(MODEL_ROLES_SESSION_ENTRY_TYPE, {
      ...entry,
      beforeModel: beforeSelector,
      currentModel: currentSelector,
    });
    return true;
  } catch {
    return false;
  }
}

function recordModelRoleRuntimeEvent(ctx: ExtensionContext, event: ModelRoleRuntimeEvent): boolean {
  const projectRoot = getProjectRoot(ctx);
  const sessionId = getSessionId(ctx);
  const report = getRuntimeCapabilityReport(projectRoot);
  try {
    const store = createSessionStore({ projectRoot });
    if (store.getSession(sessionId) === undefined) {
      store.createSession({
        id: sessionId,
        projectRoot,
        workingDirectory: getWorkingDirectory(ctx),
        metadata: { source: "model-roles" },
      });
    }
    store.appendEntry(sessionId, {
      type: "custom",
      payload: {
        type: "model_role_runtime_event",
        data: {
          version: 1,
          event: "model_role_applied",
          role: event.role,
          assignment: event.assignment,
          requestedThinking: event.requestedThinking,
          beforeModel: event.beforeModel,
          currentModel: event.currentModel,
          currentThinking: event.currentThinking,
          modelApplied: event.modelApplied,
          thinkingApplied: event.thinkingApplied,
          rolePersisted: event.rolePersisted,
          customEntryAppended: event.customEntryAppended,
          configPath: event.configPath,
          runtimeStore: {
            backend: report.sessionStoreBackend,
            durable: report.durableSessionStore,
            path: report.sessionStorePath,
            writable: report.sessionStoreWritable,
            diagnostics: report.diagnostics,
          },
          ...(event.rolePersistenceError === undefined ? {} : { rolePersistenceError: event.rolePersistenceError }),
        },
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function availableModels(ctx: ExtensionContext): Promise<ModelLike[]> {
  const registry = ctx.modelRegistry;
  if (!registry) return [];
  const models = await (registry.getAvailable?.() ?? registry.getAll?.() ?? []);
  return models.filter((model) => modelSelector(model) !== "");
}

async function showModelRoleSelector(pi: ExtensionAPI, ctx: ExtensionContext, models: ModelLike[]): Promise<void> {
  const state = await loadModelRolesState(ctx);
  const summaries = roleSummaries(state);
  if (ctx.mode !== "tui" || ctx.hasUI === false || !ctx.ui.custom) {
    publishModelRoleStatus(ctx, summaries);
    setOperatorWidget(
      ctx,
      "model-roles",
      modelRoleFallbackBlock(
        pi,
        ctx,
        summaries,
        "Interactive model-role selection requires Pi custom UI; no route was changed.",
      ),
    );
    return;
  }
  const currentSelector = ctx.model ? modelSelector(ctx.model) : undefined;
  const rows = buildModelRows(models, state, currentSelector);
  if (rows.length === 0) return;
  publishModelRoleStatus(ctx, summaries);
  try {
    await requestInlineOperatorInteraction<void>(
      ctx,
      (tui, theme, _keybindings, done) =>
        new ModelRoleSelectorComponent(tui, createModelRoleSelectorTheme(theme), {
          rows,
          roleSummaries: summaries,
          currentSelector,
          currentThinking: pi.getThinkingLevel?.(),
          applySelection: (selection) => applyModelRole(pi, ctx, selection),
          done,
        }),
    );
  } catch (error) {
    // Pi shows one inline surface at a time, so a newer prompt taking the screen
    // is a normal outcome here, not a failed command: any role already applied
    // stays applied, and nothing further is claimed.
    if (!isStaleInlineOperatorInteractionError(error)) throw error;
    // A session Pi has already replaced may not accept a notification at all.
    notifyBenignInteractionEnd(
      ctx,
      isSupersededInlineOperatorInteractionError(error)
        ? "Model roles closed: another prompt took the screen. Reopen /model-roles when it is answered."
        : "Model roles did not open: this session's UI surface is no longer the one that asked. Reopen /model-roles.",
    );
  }
}

/** Notify best-effort: a replaced session has nobody left to tell. */
function notifyBenignInteractionEnd(ctx: ExtensionContext, message: string): void {
  try {
    ctx.ui.notify(message, "info");
  } catch {
    // Nothing to recover: the surface this would describe is already gone.
  }
}

function modelRoleFallbackBlock(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  summaries: readonly RoleSummary[],
  primary: string,
): OperatorBlock {
  const defaultRoute = summaries.find((summary) => summary.role === "default");
  const assigned = summaries.filter((summary) => summary.role !== "default" && summary.assignment !== undefined);
  return {
    type: "WARN",
    subject: "Model roles",
    primary,
    metadata: [
      `Current session model: ${ctx.model ? modelSelector(ctx.model) : "unset"}`,
      `Current session effort: ${pi.getThinkingLevel?.() ?? "unknown"}`,
      `DEFAULT route: ${defaultRoute?.assignment === undefined ? "unset" : formatAssignment(defaultRoute.assignment)}`,
      `Other routes: ${assigned.length === 0 ? "none" : assigned.map((summary) => `${summary.tag}=${formatAssignment(summary.assignment!)}`).join(" · ")}`,
      "storage: .pi/model-roles/config.json",
    ],
    hint: ["This fallback is read-only; routing state remains unchanged."],
    controls: ["Open /model-roles in an interactive Pi TUI to assign roles."],
  };
}

type CurrentModelRoleState = Omit<AppliedModelRoleState, "receipt">;

async function updateModelRoleStatus(
  ctx: ExtensionContext,
  fallbackCurrentSelector?: string,
  pi?: ExtensionAPI,
): Promise<CurrentModelRoleState> {
  const appliedState = await currentModelRoleState(pi, ctx, fallbackCurrentSelector);
  publishModelRoleStatus(ctx, appliedState.roleSummaries);
  return appliedState;
}

async function currentModelRoleState(
  pi: ExtensionAPI | undefined,
  ctx: ExtensionContext,
  fallbackCurrentSelector: string | undefined,
): Promise<CurrentModelRoleState> {
  const state = await loadModelRolesState(ctx);
  return {
    currentSelector: ctx.model ? modelSelector(ctx.model) : fallbackCurrentSelector,
    currentThinking: pi?.getThinkingLevel?.(),
    roleSummaries: roleSummaries(state),
  };
}

function publishModelRoleStatus(ctx: ExtensionContext, summaries: readonly RoleSummary[]): void {
  // Remove the pre-T-203 private status key. All Locus contributors now share
  // the bounded `locus` registry without replacing the host footer.
  ctx.ui.setStatus("model-roles", undefined);
  const contribution = modelRoleStatusContribution(summaries);
  if (contribution === undefined) clearOperatorStatus(ctx, "model.roles");
  else setOperatorStatus(ctx, contribution);
}

export function modelRoleStatusContribution(summaries: readonly RoleSummary[]): OperatorStatusContribution | undefined {
  const assigned = summaries.filter((summary) => summary.assignment !== undefined);
  if (assigned.length === 0) return undefined;
  const first = assigned.slice(0, 2);
  const overflow = assigned.length - first.length;
  const suffix = overflow > 0 ? ` +${overflow}` : "";
  const wide = first.map((summary) => `${summary.tag}=${shortModelName(summary.assignment!.model)}`).join(" ");
  const compact = first
    .map((summary) => `${statusRoleAbbreviation(summary.tag)}:${shortModelName(summary.assignment!.model)}`)
    .join(" ");
  return {
    id: "model.roles",
    lane: "route",
    priority: 60,
    wide: `routes ${wide}${suffix}`,
    compact: `routes ${compact}${suffix}`,
    narrow: `routes ${assigned.length}`,
  };
}

function shortModelName(selector: string): string {
  const parts = selector.split("/");
  return parts.at(-1) ?? selector;
}

function statusRoleAbbreviation(tag: string): string {
  return (
    ({ DEFAULT: "D", AGENT: "A", TASK: "T", PLAN: "P", SUMMARY: "S", SMOL: "M" } as Record<string, string>)[tag] ??
    tag.slice(0, 1)
  );
}

function assignmentFromModel(model: ModelLike, thinking: ThinkingLevel): ModelRoleAssignment | undefined {
  const selector = modelSelector(model);
  return selector ? { model: selector, thinking } : undefined;
}
