/**
 * extensions/workflows/index.ts — Extension entrypoint.
 *
 * Registers the `workflow` tool (TypeBox params + validateParams) and the
 * `/workflows` command (run | list | status). Streams live progress via
 * the shared bounded status registry + a custom progress widget; renders final result + journal, and a
 * disk-backed status view over past/in-flight runs. Imports shared via ../_shared/*.js.
 */

import path from "node:path";
import { Type } from "@sinclair/typebox";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type {
  CommandArgumentCompletion,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "../_shared/pi-api.js";
import {
  errorResult,
  getCommandText,
  getProjectRoot,
  getSessionId,
  getWorkingDirectory,
  setTextWidget,
  textResult,
} from "../_shared/pi-api.js";
import {
  pinTransientUiKey,
  registerCommandWithUiLifecycle,
  registerTransientUiCleanup,
  unpinTransientUiKey,
} from "../_shared/command-ui.js";
import { validateParams } from "../_shared/validation.js";
import {
  runWorkflowScript,
  resolveWorkflowTarget,
  CURATED_PACKAGE_WORKFLOW_NAMES,
  WorkflowNameNotFoundError,
} from "../_shared/workflow-runner.js";
import type { ResolvedWorkflowTarget, RunWorkflowScriptResult } from "../_shared/workflow-runner.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  pruneCompletedWorkflowRunLiveRows,
  resetWorkflowLiveExecutions,
  listWorkflowRunIds,
  readWorkflowRunJournal,
  readWorkflowRunJournalState,
  readWorkflowRunResult,
  readWorkflowRunScriptSnapshot,
  readWorkflowRunSummary,
  workflowRunDir,
} from "../_shared/workflow-journal.js";
import type { WorkflowRunResultEnvelope, WorkflowRunStatus } from "../_shared/workflow-journal.js";
import type { WorkflowJournalLine } from "../_shared/workflow-runtime.js";
import { WORKFLOW_INPUT_MAX_CHARS } from "../_shared/workflow-runtime.js";
import { WORKFLOW_ARTIFACT_COMPONENT_PATTERN } from "../_shared/workflow-artifacts.js";
import {
  formatWorkflowResultDetail,
  projectWorkflowDisposition,
  type WorkflowDispositionProjection,
  type WorkflowProjectedStatus,
} from "../_shared/workflow-result.js";
import type { OperatorBlock, OperatorTone } from "../_shared/operator-ui.js";
import { clearOperatorStatus, setOperatorStatus } from "../_shared/operator-status.js";
import { requestInlineOperatorInteraction } from "../_shared/operator-interaction.js";
import { setOperatorWidget } from "../_shared/widget-render.js";
import {
  WORKFLOW_LIVE_WIDGET_KEY,
  installWorkflowProgress,
  renderAgentLiveRowsText,
  type WorkflowProgressComponent,
} from "./progress-widget.js";
import {
  buildWorkflowActionPrompt,
  buildWorkflowCatalogBlockFromModel,
  buildWorkflowCatalogModel,
  buildWorkflowInfoBlock,
  matchWorkflowPhaseGroups,
  readWorkflowMeta,
  staticWorkflowMetaPhases,
  WORKFLOW_SOURCE_LEGEND,
  workflowSourceBadge,
  type WorkflowBrowserIntent,
} from "./workflow-catalog.js";
import { WorkflowCatalogViewer, WorkflowInfoViewer } from "./catalog-viewer.js";
import { WorkflowRunViewer } from "./run-viewer.js";
import {
  createWorkflowTranscript,
  persistCommandWorkflowTranscript,
  renderMainWorkflowStatus,
} from "./workflow-transcript.js";
import {
  workflowBackgroundRunRegistry,
  type WorkflowBackgroundStopResult,
  type WorkflowSessionLease,
} from "./background-run-registry.js";

// ---------------------------------------------------------------------------
// Tool params schema
// ---------------------------------------------------------------------------

const WorkflowArtifactRefParams = Type.Object(
  {
    runId: Type.String({ pattern: WORKFLOW_ARTIFACT_COMPONENT_PATTERN }),
    artifactId: Type.String({ pattern: WORKFLOW_ARTIFACT_COMPONENT_PATTERN }),
    name: Type.String({ pattern: WORKFLOW_ARTIFACT_COMPONENT_PATTERN }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);

const WorkflowContinuationParams = Type.Object(
  {
    originRunId: Type.String({ pattern: WORKFLOW_ARTIFACT_COMPONENT_PATTERN }),
    artifactRefs: Type.Array(WorkflowArtifactRefParams, { minItems: 1, maxItems: 8 }),
  },
  { additionalProperties: false },
);

const WorkflowParams = Type.Object({
  name: Type.Optional(
    Type.String({
      description: "Saved workflow name with no path separators",
      maxLength: 200,
    }),
  ),
  scriptPath: Type.Optional(
    Type.String({
      description: "Project-relative .mjs workflow script path",
      maxLength: 400,
    }),
  ),
  script: Type.Optional(
    Type.String({
      description: "Legacy compatibility alias for name or project-relative scriptPath",
      maxLength: 400,
    }),
  ),
  input: Type.Optional(
    Type.String({
      maxLength: WORKFLOW_INPUT_MAX_CHARS,
      description: "Optional human semantic request passed unchanged to runWorkflow(dsl, input).",
    }),
  ),
  continuation: Type.Optional(WorkflowContinuationParams),
  resumeFromRunId: Type.Optional(
    Type.String({
      description: "Optional prior workflow run id used as persisted retry metadata",
      maxLength: 200,
    }),
  ),
});

const WORKFLOW_RPC_STATUS_ROWS = 4;
const WORKFLOW_RPC_DETAIL_EVENT_LIMIT = 1;

const RUNS_IN_STATUS_LIST = 10;
const WORKFLOW_DETAIL_EVENT_LIMIT = 20;
const WORKFLOW_BUSY_MESSAGE =
  "Workflow not started: Pi is busy streaming. Wait for the current response to finish, then retry /workflows run.";
const WORKFLOW_STATUS_ID = "workflow.run";

function workflowApprovalDetails(args: unknown): string[] {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const target = String(record.name ?? record.scriptPath ?? record.script ?? "unspecified");
  return [
    `Workflow: ${target}`,
    "Surface: trusted-file workflow runner",
    "Trust: reviewed JavaScript with full Node.js/module access in the Pi host process",
    "Isolation: none — exec approval is consent, not a sandbox",
  ];
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function workflows(pi: ExtensionAPI): void {
  const completedRunIds = new Set<string>();
  const backgroundRuns = workflowBackgroundRunRegistry();
  const sessionPanels = new Set<WorkflowProgressComponent>();
  let sessionLease: WorkflowSessionLease | undefined;
  let sessionRevoked = false;
  let completionProjectRoot = process.cwd();
  let completionWorkingDirectory = completionProjectRoot;
  const rememberCompletionContext = (ctx: ExtensionContext): void => {
    completionProjectRoot = getProjectRoot(ctx);
    completionWorkingDirectory = getWorkingDirectory(ctx);
  };
  const disposePanel = (panel: WorkflowProgressComponent): void => {
    panel.dispose();
    sessionPanels.delete(panel);
  };
  const disposeSessionPanels = (): void => {
    for (const panel of sessionPanels) panel.dispose();
    sessionPanels.clear();
  };
  const startSessionLease = (ctx: ExtensionContext): WorkflowSessionLease => {
    sessionRevoked = false;
    sessionLease = backgroundRuns.startSession(getProjectRoot(ctx), workflowSessionId(ctx));
    return sessionLease;
  };
  const currentSessionLease = (ctx: ExtensionContext): WorkflowSessionLease | undefined => {
    if (sessionRevoked) return undefined;
    if (sessionLease === undefined || !backgroundRuns.isCurrent(sessionLease)) return startSessionLease(ctx);
    return sessionLease;
  };
  const hasActiveCommandRun = (): boolean =>
    sessionLease !== undefined &&
    backgroundRuns.isCurrent(sessionLease) &&
    backgroundRuns.active(sessionLease) !== undefined;
  const cleanupCompletedRuns = (_ctx: ExtensionContext): boolean => {
    if (completedRunIds.size === 0) return false;
    for (const runId of completedRunIds) pruneCompletedWorkflowRunLiveRows(runId);
    completedRunIds.clear();
    return true;
  };
  const cleanupCompletedSurface = (ctx: ExtensionContext): void => {
    if (hasActiveCommandRun()) return;
    if (cleanupCompletedRuns(ctx)) clearWorkflowWidget(ctx, WORKFLOW_LIVE_WIDGET_KEY);
    clearOperatorStatus(ctx, WORKFLOW_STATUS_ID);
  };
  const cleanupTransientSurface = (ctx: ExtensionContext): void => {
    if (hasActiveCommandRun()) return;
    cleanupCompletedRuns(ctx);
    clearOperatorStatus(ctx, WORKFLOW_STATUS_ID);
  };
  registerTransientUiCleanup(pi, "workflows", cleanupTransientSurface);
  registerTransientUiCleanup(pi, WORKFLOW_LIVE_WIDGET_KEY, cleanupTransientSurface);
  pi.on("turn_end", (_event, ctx) => cleanupCompletedSurface(ctx));
  pi.on("session_start", (_event, ctx) => {
    resetWorkflowLiveExecutions();
    disposeSessionPanels();
    rememberCompletionContext(ctx);
    startSessionLease(ctx);
  });
  pi.on("session_shutdown", (_event, _ctx) => {
    resetWorkflowLiveExecutions();
    sessionRevoked = true;
    disposeSessionPanels();
    if (sessionLease !== undefined) backgroundRuns.shutdown(sessionLease);
    unpinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
  });

  // -------------------------------------------------------------------------
  // `workflow` tool
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "workflow",
    description:
      "Run a reviewed trusted-file workflow script by saved name or project-relative path with one optional semantic text request and optional host-verified continuation artifacts. The saved JavaScript executes with full Node.js/module access in the Pi host process; it is not sandboxed, and exec approval is consent rather than capability isolation. Saved names resolve from the canonical .pi/workflows/ first (then the additional project directories .claude/workflows/ and .agents/workflows/, then ~/.pi/workflows/, then the curated Package registry); every project directory accepts only a pi-native <name>.workflow.mjs, so a workflow written for another host is neither found nor runnable here. The DSL (agent/parallel/pipeline/phase/log) orchestrates .agents catalog sub-agents through the task/createAgentSession host; agent() is the single model-calling primitive. Legacy script strings normalize to name or path; arbitrary inline JavaScript is not supported. To AUTHOR a new workflow, delegate to the `workflow-author` agent (it writes to .pi/workflows/); the DSL contract is extensions/workflows/AUTHORING.md → docs/extensions/active/workflows.md.",
    parameters: WorkflowParams,
    approval: "exec",
    formatApprovalDetails: workflowApprovalDetails,
    async execute(_toolCallId, params, signal, update, ctx) {
      const valid = validateParams(WorkflowParams, params);
      if (!valid.ok) return valid.result;
      const targetFields = [valid.value.name, valid.value.scriptPath, valid.value.script].filter(
        (v) => v !== undefined,
      );
      if (targetFields.length !== 1)
        return errorResult("workflow: exactly one of name, scriptPath, or script is required", { owner: "workflows" });
      if (valid.value.continuation !== undefined && valid.value.resumeFromRunId !== undefined) {
        return errorResult("workflow: continuation and resumeFromRunId are mutually exclusive", {
          owner: "workflows",
        });
      }
      const lease = currentSessionLease(ctx);
      if (lease === undefined) {
        return errorResult("workflow: this extension session has already shut down", { owner: "workflows" });
      }
      const transcript = createWorkflowTranscript(ctx, workflowTargetLabel(valid.value), "tool");
      const launched = backgroundRuns.attach<RunWorkflowScriptResult>(lease, signal, async (background) =>
        runWorkflowScript({
          pi,
          ctx,
          signal: background.signal,
          ...(valid.value.name !== undefined ? { name: valid.value.name } : {}),
          ...(valid.value.scriptPath !== undefined ? { scriptPath: valid.value.scriptPath } : {}),
          ...(valid.value.script !== undefined ? { script: valid.value.script } : {}),
          ...(valid.value.input !== undefined ? { input: valid.value.input } : {}),
          ...(valid.value.continuation !== undefined ? { continuation: valid.value.continuation } : {}),
          ...(valid.value.resumeFromRunId !== undefined ? { resumeFromRunId: valid.value.resumeFromRunId } : {}),
          onRunStart: ({ runId }) => {
            background.setRunId(runId);
            transcript.start(runId);
          },
          onEvent: (line: WorkflowJournalLine) => {
            applyWorkflowJournalLineToAgentLiveStore(line, getProjectRoot(ctx));
            transcript.event(line);
            // Stream renderable `content`, not just `details`: in the interactive TUI the pi SDK's
            // ToolExecutionComponent renders streamed updates via getTextOutput(result.content) — a
            // content-less partial makes it throw `reading 'filter'` on a detached emit tick, which the
            // workflow host-net then mis-attributes as ok:false on an otherwise-successful run. The live
            // agent rows double as the progress text the model/user see for this tool call.
            const liveAgents = renderAgentLiveRowsText();
            update({ content: [{ type: "text", text: liveAgents }], details: { lastEvent: line, liveAgents } });
          },
        }),
      );
      if (!launched.ok) {
        return errorResult("workflow: this extension session is stale; retry after Pi finishes reloading", {
          owner: "workflows",
        });
      }
      const settlement = await launched.run.terminal;
      if (settlement.status === "rejected") throw settlement.error;
      const res = settlement.value;
      const transcriptCompletion = transcript.finish(res);
      completedRunIds.add(res.runId);

      // Tool execution may still be inside Pi's streaming turn. Persist the
      // bounded lifecycle through this one native toolResult instead of an
      // out-of-band sendMessage that could schedule or corrupt a model turn.
      const summary = renderWorkflowToolResult(res, transcriptCompletion.digest);
      const transcriptDetails = {
        surface: "tool",
        eventKind: transcriptCompletion.eventKind,
        lineCount: transcriptCompletion.lineCount,
      };
      const disposition = workflowResultDisposition(res);
      if (disposition.status === "completed" || disposition.status === "awaiting_operator") {
        return textResult(summary, {
          owner: "workflows",
          disposition: res.disposition,
          transcript: transcriptDetails,
          runId: res.runId,
          runDir: res.runDir,
          resultPath: res.resultPersistence.path,
          resultPersistence: res.resultPersistence,
          ...(res.artifactRefs !== undefined ? { artifactRefs: res.artifactRefs } : {}),
          ...(res.artifactRefsOmitted !== undefined ? { artifactRefsOmitted: res.artifactRefsOmitted } : {}),
          ...(res.resultDiagnostic !== undefined ? { resultDiagnostic: res.resultDiagnostic } : {}),
          journal: res.journal,
          target: operatorWorkflowTarget(res.target),
          ...(res.scriptIdentity !== undefined
            ? { scriptIdentity: operatorScriptIdentity(res.scriptIdentity, res.target?.ref) }
            : {}),
          ...(res.resumeFromRunId !== undefined
            ? {
                resumeFromRunId: res.resumeFromRunId,
                resumeSourceRunSummary: res.resumeSourceRunSummary ?? null,
              }
            : {}),
          ...(res.continuation !== undefined ? { continuation: res.continuation } : {}),
        });
      }
      return errorResult(summary, {
        owner: "workflows",
        disposition: res.disposition,
        transcript: transcriptDetails,
        runId: res.runId,
        runDir: res.runDir,
        resultPath: res.resultPersistence.path,
        resultPersistence: res.resultPersistence,
        ...(res.artifactRefs !== undefined ? { artifactRefs: res.artifactRefs } : {}),
        ...(res.artifactRefsOmitted !== undefined ? { artifactRefsOmitted: res.artifactRefsOmitted } : {}),
        result: res.result,
        ...(res.resultDiagnostic !== undefined ? { resultDiagnostic: res.resultDiagnostic } : {}),
        journal: res.journal,
        error: res.error,
        target: operatorWorkflowTarget(res.target),
        ...(res.scriptIdentity !== undefined
          ? { scriptIdentity: operatorScriptIdentity(res.scriptIdentity, res.target?.ref) }
          : {}),
        ...(res.resumeFromRunId !== undefined
          ? {
              resumeFromRunId: res.resumeFromRunId,
              resumeSourceRunSummary: res.resumeSourceRunSummary ?? null,
            }
          : {}),
        ...(res.continuation !== undefined ? { continuation: res.continuation } : {}),
      });
    },
  });

  // -------------------------------------------------------------------------
  // `/workflows` command
  // -------------------------------------------------------------------------
  registerCommandWithUiLifecycle(
    pi,
    {
      command: "workflows",
      group: "workflows",
      surfaces: ["transient-widget", "status", "artifact-write", "no-ui"],
      transientWidgets: ["workflows", WORKFLOW_LIVE_WIDGET_KEY],
    },
    {
      description:
        "Usage: /workflows | dashboard | list [query] | info [name] | status [runId] | run <name|path> [--resume <runId>] [input] | stop [runId|last]. Browse, inspect persisted evidence, explain, deliberately run, or explicitly stop a slash-launched workflow.",
      getArgumentCompletions: (prefix) =>
        workflowArgumentCompletions(prefix, completionProjectRoot, completionWorkingDirectory),
      handler: async (args, ctx) => {
        const text = getCommandText(args).trim();
        const projectRoot = getProjectRoot(ctx);
        rememberCompletionContext(ctx);

        // Bare `/workflows` is a static command view; it never starts a run.
        if (text === "") {
          clearWorkflowWidget(ctx, WORKFLOW_LIVE_WIDGET_KEY);
          setOperatorWidget(ctx, "workflows", workflowHelpBlock());
          return;
        }

        // `/workflows dashboard` — persisted run/stage/evidence browser. RPC and
        // hosts without custom UI retain the same bounded disk-backed list.
        if (text === "dashboard") {
          if (await openWorkflowRunViewer(ctx, projectRoot)) return;
          setOperatorWidget(
            ctx,
            "workflows",
            buildRunsListBlock(
              projectRoot,
              ctx.mode === "tui" ? RUNS_IN_STATUS_LIST : WORKFLOW_RPC_STATUS_ROWS,
              ctx.mode !== "tui",
            ),
          );
          return;
        }

        // `/workflows list [query]` — operator catalog over the existing sources.
        const listMatch = /^list(?:\s+([\s\S]+))?$/.exec(text);
        if (listMatch !== null) {
          const query = listMatch[1]?.trim();
          const workingDirectory = getWorkingDirectory(ctx);
          const catalog = buildWorkflowCatalogModel(projectRoot, workingDirectory, query === "" ? undefined : query);
          if (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined) {
            clearWorkflowWidget(ctx, "workflows");
            let intent: WorkflowBrowserIntent | undefined;
            try {
              intent = await requestInlineOperatorInteraction<WorkflowBrowserIntent | undefined>(
                ctx,
                (tui, theme, keybindings, done) =>
                  new WorkflowCatalogViewer(tui, theme, keybindings, catalog, projectRoot, workingDirectory, done),
              );
            } catch (error) {
              setOperatorWidget(
                ctx,
                "workflows",
                workflowWarningBlock(
                  `Workflow browser closed with an error: ${errorMessage(error)}.`,
                  "No editor text was changed and no workflow was started.",
                ),
              );
              return;
            }
            if (intent === undefined) return;
            const prompt = buildWorkflowActionPrompt(intent);
            if (ctx.ui.setEditorText === undefined) {
              setOperatorWidget(
                ctx,
                "workflows",
                workflowWarningBlock(
                  "Workflow action could not fill the editor because this Pi host does not expose setEditorText().",
                  "No workflow was started; reopen in an interactive Pi TUI with editor-prefill support.",
                ),
              );
              return;
            }
            try {
              ctx.ui.setEditorText(prompt);
            } catch (error) {
              setOperatorWidget(
                ctx,
                "workflows",
                workflowWarningBlock(
                  `Workflow action could not fill the editor: ${errorMessage(error)}.`,
                  "No workflow was started and no message was sent.",
                ),
              );
            }
            return;
          }
          const passive = buildWorkflowCatalogBlockFromModel(catalog, { compact: ctx.mode !== "tui" });
          setOperatorWidget(
            ctx,
            "workflows",
            ctx.mode === "tui"
              ? {
                  ...passive,
                  hint: [
                    ...(passive.hint ?? []),
                    "Interactive catalog unavailable: this Pi host did not expose custom UI.",
                  ],
                  controls: [
                    ...(passive.controls ?? []),
                    "Read-only fallback shown; retry in an interactive Pi TUI with custom UI support.",
                  ],
                }
              : passive,
          );
          return;
        }

        const infoMatch = /^info(?:\s+([\s\S]+))?$/.exec(text);
        if (infoMatch !== null) {
          const name = infoMatch[1]?.trim();
          const infoBlock = buildWorkflowInfoBlock(
            projectRoot,
            getWorkingDirectory(ctx),
            name === "" ? undefined : name,
          );
          if (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined) {
            try {
              await requestInlineOperatorInteraction<void>(
                ctx,
                (tui, theme, keybindings, done) => new WorkflowInfoViewer(tui, theme, keybindings, infoBlock, done),
              );
            } catch (error) {
              setOperatorWidget(
                ctx,
                "workflows",
                workflowWarningBlock(
                  `Workflow info viewer closed with an error: ${errorMessage(error)}.`,
                  "No editor text was changed and no workflow was started.",
                ),
              );
            }
            return;
          }
          setOperatorWidget(
            ctx,
            "workflows",
            ctx.mode === "tui"
              ? {
                  ...infoBlock,
                  hint: [
                    ...(infoBlock.hint ?? []),
                    "Interactive workflow info unavailable: this Pi host did not expose custom UI.",
                  ],
                  controls: [
                    ...(infoBlock.controls ?? []),
                    "Read-only fallback shown; retry in an interactive Pi TUI with custom UI support.",
                  ],
                }
              : infoBlock,
          );
          return;
        }

        // `/workflows status` — recent runs; `/workflows status <runId>` — one run's progress.
        if (text === "status") {
          if (await openWorkflowRunViewer(ctx, projectRoot)) return;
          const compact = ctx.mode !== "tui";
          setOperatorWidget(
            ctx,
            "workflows",
            buildRunsListBlock(projectRoot, compact ? WORKFLOW_RPC_STATUS_ROWS : RUNS_IN_STATUS_LIST, compact),
          );
          return;
        }
        const statusMatch = /^status\s+(\S+)$/.exec(text);
        if (statusMatch !== null) {
          if (await openWorkflowRunViewer(ctx, projectRoot, statusMatch[1] ?? "")) return;
          setOperatorWidget(
            ctx,
            "workflows",
            buildRunDetailBlock(projectRoot, statusMatch[1] ?? "", ctx.mode !== "tui"),
          );
          return;
        }

        const stopMatch = /^stop(?:\s+(\S+))?$/.exec(text);
        if (stopMatch !== null) {
          const lease = currentSessionLease(ctx);
          if (lease === undefined) {
            setOperatorWidget(
              ctx,
              "workflows",
              workflowWarningBlock(
                "Workflow stop is unavailable because this extension session has already shut down.",
                "Recovery: wait for Pi to finish reloading, then retry /workflows stop last.",
              ),
            );
            return;
          }
          const selector = stopMatch[1] ?? "last";
          setOperatorWidget(ctx, "workflows", workflowStopBlock(selector, backgroundRuns.stop(lease, selector)));
          return;
        }

        // `/workflows run <name|path> [--resume <runId>] [input]` — run with a live progress panel.
        const parsedRun = parseRunCommand(text);
        if (parsedRun !== null) {
          if (parsedRun.missingResumeId === true) {
            setOperatorWidget(
              ctx,
              "workflows",
              workflowWarningBlock(
                "Missing run id after --resume.",
                "Retry: /workflows run <name|path> --resume <runId> [input]",
              ),
            );
            return;
          }
          if (parsedRun.input !== undefined && parsedRun.input.length > WORKFLOW_INPUT_MAX_CHARS) {
            setOperatorWidget(
              ctx,
              "workflows",
              workflowWarningBlock(
                `Workflow input exceeds the ${WORKFLOW_INPUT_MAX_CHARS}-character limit after command trimming.`,
                "Retry with a shorter semantic request.",
              ),
            );
            return;
          }
          const idleBlock = workflowCommandIdleBlock(ctx);
          if (idleBlock !== undefined) {
            setOperatorWidget(
              ctx,
              "workflows",
              workflowWarningBlock(
                idleBlock,
                "Recovery: wait for the current response to finish, then retry the same /workflows run command.",
              ),
            );
            return;
          }
          const scriptRef = parsedRun.scriptRef;
          const workingDirectory = getWorkingDirectory(ctx);
          const targetPreflight = preflightWorkflowCommandTarget(scriptRef, projectRoot, workingDirectory);
          if (targetPreflight.status === "not-found") {
            setOperatorWidget(ctx, "workflows", workflowNotFoundBlock(scriptRef));
            return;
          }
          // Confinement and other resolution failures deliberately continue
          // through the runner once. That owner creates the canonical failed
          // run and result.json instead of losing durable operator evidence.
          const target = targetPreflight.status === "resolved" ? targetPreflight.target : undefined;

          const lease = currentSessionLease(ctx);
          if (lease === undefined) {
            setOperatorWidget(
              ctx,
              "workflows",
              workflowWarningBlock(
                "Workflow not started: this extension session has already shut down.",
                "Recovery: wait for Pi to finish reloading, then retry the same /workflows run command.",
              ),
            );
            return;
          }
          const active = backgroundRuns.active(lease);
          if (active !== undefined) {
            setOperatorWidget(ctx, "workflows", workflowRunConflictBlock(active.runId ?? active.launchId));
            return;
          }

          clearWorkflowWidget(ctx, WORKFLOW_LIVE_WIDGET_KEY);
          const hasUI = ctx.hasUI === true;
          setWorkflowLaunchStatus(ctx, target?.kind ?? "script", target?.ref ?? scriptRef);
          if (hasUI) pinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
          const declaredPhases =
            target === undefined ? [] : readWorkflowMeta(target.path).phases.map((phase) => phase.title);
          const launched = backgroundRuns.launch<RunWorkflowScriptResult>(lease, async (background) => {
            let panel: WorkflowProgressComponent | undefined;
            const cleanupPanel = (): void => {
              if (panel !== undefined) disposePanel(panel);
            };
            const transcript = createWorkflowTranscript(ctx, scriptRef, "command");
            const isCurrent = (): boolean => background.isCurrent();
            try {
              const res = await runWorkflowScript({
                pi,
                ctx,
                signal: background.signal,
                script: scriptRef,
                ...(parsedRun.input !== undefined ? { input: parsedRun.input } : {}),
                ...(parsedRun.resumeFromRunId !== undefined ? { resumeFromRunId: parsedRun.resumeFromRunId } : {}),
                onRunStart: ({ runId }) => {
                  background.setRunId(runId);
                  if (!isCurrent()) return;
                  transcript.start(runId);
                  if (hasUI && !panel) {
                    panel = installWorkflowProgress(ctx, WORKFLOW_LIVE_WIDGET_KEY, scriptRef, runId, {
                      scope: "workflow",
                      declaredPhases,
                    });
                    sessionPanels.add(panel);
                  }
                },
                onEvent: (line: WorkflowJournalLine) => {
                  if (!isCurrent()) return;
                  applyWorkflowJournalLineToAgentLiveStore(line, projectRoot);
                  if (hasUI) {
                    // The adapter completes live-row projection and any replay
                    // artifact I/O before the passive component records the
                    // event and requests its next render.
                    panel?.push(line);
                  } else {
                    setTextWidget(ctx, "workflows", renderAgentLiveRowsText());
                  }
                  transcript.event(line);
                  setWorkflowEventStatus(ctx, line);
                },
              });
              if (!isCurrent()) return res;
              completedRunIds.add(res.runId);
              const transcriptCompletion = transcript.finish(res);
              if (hasUI && panel) {
                panel.finish(res);
                cleanupPanel();
              } else setOperatorWidget(ctx, "workflows", buildWorkflowResultBlock(res, ctx.mode !== "tui"));
              await persistCommandWorkflowTranscript(pi, ctx, transcriptCompletion, isCurrent);
              return res;
            } catch (error) {
              cleanupPanel();
              if (isCurrent()) setOperatorWidget(ctx, "workflows", workflowBackgroundFailureBlock(error));
              throw error;
            } finally {
              cleanupPanel();
              if (hasUI && isCurrent()) unpinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
            }
          });
          if (!launched.ok) {
            if (hasUI) unpinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
            const owner = launched.active?.runId ?? launched.active?.launchId ?? "current run";
            setOperatorWidget(ctx, "workflows", workflowRunConflictBlock(owner));
          }
          return;
        }

        const available = text.startsWith("run") ? listExampleNames() : [];
        setOperatorWidget(ctx, "workflows", {
          type: "WARN",
          subject: "Workflow command",
          primary: `Unknown workflow command: ${text}`,
          body: available.length === 0 ? [] : [`Available curated Package workflows: ${available.join(", ")}`],
          controls: [
            "Usage: /workflows | dashboard | list [query] | info [name] | status [runId] | run <name|path> [--resume <runId>] [input] | stop [runId|last]",
          ],
        });
      },
    },
  );
}

async function openWorkflowRunViewer(
  ctx: ExtensionCommandContext,
  projectRoot: string,
  runId?: string,
): Promise<boolean> {
  if (ctx.mode !== "tui" || ctx.hasUI === false || ctx.ui.custom === undefined) return false;
  clearWorkflowWidget(ctx, "workflows");
  try {
    await requestInlineOperatorInteraction<void>(
      ctx,
      (tui, theme, keybindings, done) => new WorkflowRunViewer(tui, theme, keybindings, projectRoot, done, runId),
    );
  } catch (error) {
    const fallback =
      runId === undefined
        ? buildRunsListBlock(projectRoot, RUNS_IN_STATUS_LIST)
        : buildRunDetailBlock(projectRoot, runId);
    setOperatorWidget(ctx, "workflows", {
      ...fallback,
      metadata: [
        `Interactive evidence viewer failed: ${errorMessage(error)}. Bounded static evidence is shown instead.`,
        ...(fallback.metadata ?? []),
      ],
    });
  }
  return true;
}

function workflowCommandIdleBlock(ctx: ExtensionContext): string | undefined {
  if (typeof ctx.isIdle !== "function") {
    return "Workflow not started: this Pi host cannot prove that the session is idle (ctx.isIdle is unavailable).";
  }
  try {
    return ctx.isIdle() ? undefined : WORKFLOW_BUSY_MESSAGE;
  } catch {
    return "Workflow not started: this Pi host could not read the session idle state.";
  }
}

function workflowSessionId(ctx: ExtensionContext): string {
  const sessionId = getSessionId(ctx);
  return sessionId.trim() === "" ? "unknown-session" : sessionId;
}

interface ParsedRunCommand {
  scriptRef: string;
  input?: string;
  resumeFromRunId?: string;
  missingResumeId?: boolean;
}

type WorkflowCommandTargetPreflight =
  | { status: "resolved"; target: ResolvedWorkflowTarget }
  | { status: "not-found" }
  | { status: "runner-durable-failure" };

function preflightWorkflowCommandTarget(
  scriptRef: string,
  projectRoot: string,
  workingDirectory: string,
): WorkflowCommandTargetPreflight {
  try {
    return {
      status: "resolved",
      target: resolveWorkflowTarget({ script: scriptRef }, projectRoot, workingDirectory),
    };
  } catch (error) {
    if (error instanceof WorkflowNameNotFoundError) return { status: "not-found" };
    return { status: "runner-durable-failure" };
  }
}

function parseRunCommand(text: string): ParsedRunCommand | null {
  const match = /^run\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null) return null;
  const scriptRef = match[1] ?? "";
  const rest = (match[2] ?? "").trim();
  if (rest === "") return { scriptRef };
  if (rest === "--resume") return { scriptRef, missingResumeId: true };
  if (rest.startsWith("--resume ")) {
    const after = rest.slice("--resume ".length).trimStart();
    const idMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(after);
    if (idMatch === null) return { scriptRef, missingResumeId: true };
    const resumeFromRunId = idMatch[1] ?? "";
    if (resumeFromRunId === "") return { scriptRef, missingResumeId: true };
    const input = (idMatch[2] ?? "").trim();
    return {
      scriptRef,
      resumeFromRunId,
      ...(input !== "" ? { input } : {}),
    };
  }
  return { scriptRef, input: rest };
}

function clearWorkflowWidget(ctx: ExtensionContext, key: string): void {
  try {
    ctx.ui.setWidget(key, undefined);
  } catch {
    // Best-effort cleanup; the usage hint still goes through notify.
  }
}

// ---------------------------------------------------------------------------
// Rendering — examples + dashboard
// ---------------------------------------------------------------------------

/** Curated Package names shared with resolution and catalog enumeration. */
function listExampleNames(): string[] {
  return [...CURATED_PACKAGE_WORKFLOW_NAMES];
}

export function workflowArgumentCompletions(
  rawPrefix: string,
  projectRoot: string,
  workingDirectory = projectRoot,
): CommandArgumentCompletion[] | null {
  const prefix = rawPrefix.replace(/^\s+/u, "");
  const rootCommands: CommandArgumentCompletion[] = [
    { value: "dashboard", label: "dashboard", description: "Open persisted run dashboard" },
    { value: "list ", label: "list", description: "Browse workflow catalog" },
    { value: "info ", label: "info", description: "Show one workflow" },
    { value: "status ", label: "status", description: "Inspect persisted run status" },
    { value: "run ", label: "run", description: "Start a workflow" },
    { value: "stop ", label: "stop", description: "Stop a workflow explicitly" },
  ];
  if (!prefix.includes(" ")) return matchingCompletions(rootCommands, prefix);
  if (prefix.startsWith("list ")) return null;

  const runIds = (): string[] => listWorkflowRunIds(projectRoot).slice(0, 20);
  const workflowNames = (): string[] => {
    try {
      return buildWorkflowCatalogModel(projectRoot, workingDirectory).current.map((row) => row.name);
    } catch {
      return listExampleNames();
    }
  };
  if (prefix.startsWith("info ")) {
    return matchingCompletions(
      workflowNames().map((name) => ({ value: `info ${name}`, label: name })),
      prefix,
    );
  }
  if (prefix.startsWith("status ")) {
    return matchingCompletions(
      runIds().map((runId) => ({ value: `status ${runId}`, label: runId })),
      prefix,
    );
  }
  if (prefix.startsWith("stop ")) {
    return matchingCompletions(
      [
        { value: "stop last", label: "last", description: "Most recently started run" },
        ...runIds().map((runId) => ({ value: `stop ${runId}`, label: runId })),
      ],
      prefix,
    );
  }
  if (!prefix.startsWith("run ")) return null;

  const runTail = prefix.slice("run ".length);
  const firstSpace = runTail.search(/\s/u);
  const targetPrefix = firstSpace < 0 ? runTail : runTail.slice(0, firstSpace);
  if (targetPrefix.includes("/") || targetPrefix.startsWith(".")) return null;
  if (firstSpace < 0) {
    return matchingCompletions(
      workflowNames().map((name) => ({ value: `run ${name}`, label: name })),
      prefix,
    );
  }

  const afterTarget = runTail.slice(firstSpace);
  if (" --resume ".startsWith(afterTarget)) {
    return [{ value: `run ${targetPrefix} --resume `, label: "--resume", description: "Resume from a prior run" }];
  }
  if (!afterTarget.startsWith(" --resume ")) return null;
  const resumePrefix = `run ${targetPrefix} --resume `;
  const requestedRunId = afterTarget.slice(" --resume ".length);
  if (/\s/u.test(requestedRunId)) return null;
  return matchingCompletions(
    runIds().map((runId) => ({ value: `${resumePrefix}${runId}`, label: runId })),
    `${resumePrefix}${requestedRunId}`,
  );
}

function matchingCompletions(completions: CommandArgumentCompletion[], prefix: string): CommandArgumentCompletion[] {
  const normalizedPrefix = prefix.toLowerCase();
  return completions.filter((item) => item.value.toLowerCase().startsWith(normalizedPrefix));
}

function workflowHelpBlock(): OperatorBlock {
  return {
    type: "VIEW",
    subject: "Workflow commands",
    primary: "Browse saved workflows, inspect run history, or start a trusted-file workflow.",
    body: [
      "Dashboard: /workflows dashboard",
      "Catalog: /workflows list [query]",
      "Info: /workflows info [exact-name]",
      "History: /workflows status [runId]",
      "Run: /workflows run <name|path> [--resume <runId>] [input]",
      "Stop: /workflows stop [runId|last]",
    ],
    metadata: ["A command starts execution only when the Pi session is provably idle."],
  };
}

function workflowRunConflictBlock(runId: string): OperatorBlock {
  return {
    type: "WARN",
    subject: "Workflow run",
    primary: `Workflow not started: slash-launched workflow ${runId} is still running or stopping.`,
    metadata: ["Only one slash-launched workflow may run in this project session at a time."],
    controls: [`Inspect: /workflows status ${runId}`, `Stop: /workflows stop ${runId}`],
  };
}

function workflowStopBlock(selector: string, result: WorkflowBackgroundStopResult): OperatorBlock {
  if (result.status === "unknown") {
    return {
      type: "ERROR",
      subject: "Workflow stop",
      primary: `No active or recorded workflow matched ${selector}.`,
      controls: ["Inspect durable runs: /workflows status", "Stop the current run: /workflows stop last"],
    };
  }
  const runId = result.run.runId ?? result.run.launchId;
  if (result.status === "settled") {
    return {
      type: "WARN",
      subject: "Workflow stop",
      primary: `Workflow ${runId} has already settled; no stop signal was sent.`,
      controls: [`Inspect: /workflows status ${runId}`],
    };
  }
  return {
    type: "VIEW",
    subject: "Workflow stop",
    primary:
      result.status === "requested"
        ? `Stop requested for workflow ${runId}. Settlement is still pending.`
        : `Workflow ${runId} is already stopping. Settlement is still pending.`,
    metadata: ["A stop request is not a completion claim; durable result evidence remains authoritative."],
    controls: [`Inspect: /workflows status ${runId}`],
  };
}

function workflowBackgroundFailureBlock(error: unknown): OperatorBlock {
  return {
    type: "ERROR",
    subject: "Workflow run",
    primary: `Workflow background runner rejected: ${errorMessage(error)}.`,
    metadata: ["The rejection was observed by the workflow run registry."],
    controls: ["Inspect durable evidence: /workflows status"],
  };
}

function workflowWarningBlock(primary: string, recovery: string): OperatorBlock {
  return {
    type: "WARN",
    subject: "Workflow run",
    primary,
    metadata: ["No workflow execution was started."],
    controls: [recovery],
  };
}

function workflowNotFoundBlock(name: string): OperatorBlock {
  const names = listExampleNames();
  const available = names.length > 0 ? names.join(", ") : "(none)";
  return {
    type: "ERROR",
    subject: "Workflow run",
    primary: `Workflow not found: ${name}`,
    body: [`Available curated Package workflows: ${available}`],
    metadata: ["No workflow execution was started."],
    controls: ["Recovery: /workflows list [query]"],
  };
}

// ---------------------------------------------------------------------------
// Rendering — runs status (disk-backed, works across sessions)
// ---------------------------------------------------------------------------

function buildRunsListBlock(projectRoot: string, limit: number, compact = false): OperatorBlock {
  const ids = listWorkflowRunIds(projectRoot);
  if (ids.length === 0) {
    return {
      type: "VIEW",
      subject: "Workflow runs",
      primary: "No workflow runs yet.",
      metadata: ["status: ok; total=0 shown=0 older=0", WORKFLOW_SOURCE_LEGEND],
      controls: ['Run one: /workflows run requirements-grill "<your request>"'],
    };
  }
  const shownIds = ids.slice(0, Math.max(0, Math.min(limit, ids.length)));
  const older = ids.length - shownIds.length;
  return {
    type: "VIEW",
    subject: "Workflow runs",
    primary: `Showing ${shownIds.length} newest of ${ids.length} workflow run(s).`,
    body: shownIds.map((runId) => formatRunRow(projectRoot, runId, compact)),
    metadata: [
      WORKFLOW_SOURCE_LEGEND,
      `status: ok; total=${ids.length} shown=${shownIds.length} older=${older}`,
      ...(older > 0 ? [`+${older} older run(s) hidden`] : []),
    ],
    controls: ["Detail: /workflows status <runId>"],
  };
}

function formatRunRow(projectRoot: string, runId: string, compact = false): string {
  const s = readWorkflowRunSummary(projectRoot, runId);
  const journalDiagnostics = readWorkflowRunJournalState(projectRoot, runId).diagnostics.length;
  const source = readWorkflowRunResult(projectRoot, runId)?.target?.source;
  if (compact) {
    // The replayed marker survives compaction: a reader must never see a green
    // row and assume every agent in it actually ran.
    const replayed = s.agentsReplayed > 0 ? ` replayed=${s.agentsReplayed}` : "";
    const corruption = journalDiagnostics > 0 ? ` journal-corrupt=${journalDiagnostics}` : "";
    return compactWorkflowLine(
      `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${s.status} ${runId} phase=${s.phase ?? "-"}${replayed}${corruption}`,
    );
  }
  const parts = [
    `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`}`,
    s.status.padEnd(9),
    runId,
    `phase=${s.phase ?? "-"}`,
    `agents=${s.agentsEnded}/${s.agentsStarted}`,
  ];
  if (s.agentsReplayed > 0) parts.push(`replayed=${s.agentsReplayed}`);
  if (s.usage !== null) parts.push(`tok=${s.usage.totalTokens}`);
  if (s.errors > 0) parts.push(`err=${s.errors}`);
  if (journalDiagnostics > 0) parts.push(`journal-corrupt=${journalDiagnostics}`);
  return parts.join("  ");
}

function buildRunDetailBlock(projectRoot: string, runId: string, compact = false): OperatorBlock {
  const journalState = readWorkflowRunJournalState(projectRoot, runId);
  const journal = journalState.lines;
  const summary = readWorkflowRunSummary(projectRoot, runId);
  const persisted = readWorkflowRunResult(projectRoot, runId);
  if (journal.length === 0 && !summary.hasResult) {
    return {
      type: "ERROR",
      subject: "Workflow run",
      primary: `Workflow run not found: ${runId}`,
      controls: ["Recovery: /workflows status"],
    };
  }
  const budgetLine =
    summary.usage !== null
      ? `budget: tokens=${summary.usage.totalTokens} (in ${summary.usage.input} / out ${summary.usage.output}) cost=$${summary.usage.costTotal.toFixed(4)}`
      : null;
  // Stated as evidence provenance, not as a performance note: these agents did
  // not run in this run, so this run's green is partly inherited.
  const replayLine =
    summary.agentsReplayed > 0
      ? `replay: ${summary.agentsReplayed}/${summary.agentsEnded} agent call(s) reused a recorded run — not fresh evidence`
      : null;
  const phaseLine = declaredPhaseProgressLine(projectRoot, runId, journal);
  const allJournalLines = renderJournalLines(journal);
  const journalCorruptionLine = journalDiagnosticSummary(journalState.diagnostics);
  const eventLimit = compact ? WORKFLOW_RPC_DETAIL_EVENT_LIMIT : WORKFLOW_DETAIL_EVENT_LIMIT;
  const newestJournalLines = allJournalLines.slice(-eventLimit).reverse();
  const older = Math.max(0, allJournalLines.length - newestJournalLines.length);
  const resultDetail =
    persisted === null
      ? summary.hasResult
        ? "result detail: unavailable (result.json is unreadable)"
        : "result: unavailable (run is in flight or was interrupted)"
      : persisted.error !== undefined
        ? `error: ${persisted.error}`
        : `result: ${formatWorkflowResultDetail(persisted.result)}`;
  const source = persisted?.target?.source;
  const scriptIdentity = persisted?.scriptIdentity;
  const compactResult =
    persisted === null
      ? resultDetail
      : persisted.error !== undefined
        ? `error: ${persisted.error}`
        : `result: ${persistedWorkflowDisposition(persisted).summary}`;
  return {
    type: "VIEW",
    subject: "Workflow run",
    primary: compact
      ? compactWorkflowLine(
          `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${runId} · ${summary.status}${summary.phase === null ? "" : ` · phase=${summary.phase}`}`,
        )
      : `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${runId} · ${summary.status}${summary.phase === null ? "" : ` · phase=${summary.phase}`}`,
    badges: [
      { text: `status:${summary.status}`, tone: workflowStatusTone(summary.status) },
      ...(source === undefined ? [] : [{ text: workflowSourceBadge(source).slice(1, -1), tone: "muted" as const }]),
    ],
    body:
      newestJournalLines.length === 0
        ? ["No journal events recorded."]
        : compact
          ? newestJournalLines.map(compactWorkflowLine)
          : newestJournalLines,
    metadata: compact
      ? [
          WORKFLOW_SOURCE_LEGEND,
          ...(journalCorruptionLine === null ? [] : [compactWorkflowLine(journalCorruptionLine)]),
          compactWorkflowLine(`runDir: ${workflowRunDir(projectRoot, runId)}`),
          ...(scriptIdentity === undefined
            ? []
            : [compactWorkflowLine(formatOperatorScriptIdentity(scriptIdentity, persisted?.target?.ref))]),
          ...(phaseLine === null ? [] : [compactWorkflowLine(phaseLine)]),
          ...(replayLine === null ? [] : [compactWorkflowLine(replayLine)]),
          ...(budgetLine === null ? [] : [compactWorkflowLine(budgetLine)]),
          compactWorkflowLine(compactResult),
          ...(older > 0 ? [`+${older} older journal row(s) hidden`] : []),
        ]
      : [
          WORKFLOW_SOURCE_LEGEND,
          `Source: [R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`}`,
          ...(journalCorruptionLine === null ? [] : [journalCorruptionLine]),
          `runDir: ${workflowRunDir(projectRoot, runId)}`,
          ...(scriptIdentity === undefined
            ? []
            : [formatOperatorScriptIdentity(scriptIdentity, persisted?.target?.ref)]),
          ...(phaseLine === null ? [] : [phaseLine]),
          ...(replayLine === null ? [] : [replayLine]),
          ...(budgetLine === null ? [] : [budgetLine]),
          resultDetail,
          ...(older > 0 ? [`+${older} older journal row(s) hidden`] : []),
        ],
    controls: ["Refresh/list: /workflows status · Full artifact: result.json"],
  };
}

function journalDiagnosticSummary(
  diagnostics: ReturnType<typeof readWorkflowRunJournalState>["diagnostics"],
): string | null {
  const first = diagnostics[0];
  if (first === undefined) return null;
  const location = first.lineNumber === null ? "journal" : `line ${first.lineNumber}`;
  return `journal corruption: ${diagnostics.length} row(s); first=${location}: ${first.message}`;
}

/**
 * Declared pipeline versus what the run actually did. The declaration is read
 * from the run's retained script snapshot as inert text — the same bounded AST
 * scan the catalog uses, never an import. Absent when the script declared
 * nothing, so a workflow without `meta.phases` renders exactly as before.
 */
function declaredPhaseProgressLine(
  projectRoot: string,
  runId: string,
  journal: readonly WorkflowJournalLine[],
): string | null {
  const snapshot = readWorkflowRunScriptSnapshot(projectRoot, runId);
  if (snapshot.kind !== "ready") return null;
  const declared = staticWorkflowMetaPhases(snapshot.source);
  if (declared.length === 0) return null;
  const observed = journal
    .filter((line) => line.kind === "phase" && typeof line.phase === "string" && line.phase.trim() !== "")
    .map((line) => line.phase!);
  const groups = matchWorkflowPhaseGroups(declared, observed);
  const reached = groups.filter((group) => group.reached).length;
  const rendered = groups
    .map((group) => `${group.reached ? "[x]" : "[ ]"} ${group.title}${group.declared ? "" : " (undeclared)"}`)
    .join(" · ");
  return `phases: ${reached}/${groups.length} reached — ${rendered}`;
}

// ---------------------------------------------------------------------------
// Rendering — single run final result + shared journal lines
// ---------------------------------------------------------------------------

function buildWorkflowResultBlock(res: RunWorkflowScriptResult, compact = false): OperatorBlock {
  const source = res.target?.source;
  const disposition = workflowResultDisposition(res);
  const primary = `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${disposition.summary}`;
  const type = disposition.status === "completed" ? "RESULT" : disposition.status === "failed" ? "ERROR" : "WARN";
  return {
    type,
    subject: "Workflow run",
    primary: compact ? compactWorkflowLine(primary) : primary,
    badges: [
      { text: `status:${disposition.status}`, tone: workflowStatusTone(disposition.status) },
      ...(source === undefined ? [] : [{ text: workflowSourceBadge(source).slice(1, -1), tone: "muted" as const }]),
    ],
    metadata: [
      WORKFLOW_SOURCE_LEGEND,
      `runId: ${res.runId}`,
      `Source: [R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`}`,
      compact ? compactWorkflowLine(`runDir: ${res.runDir}`) : `runDir: ${res.runDir}`,
      ...(res.scriptIdentity === undefined
        ? []
        : [
            compact
              ? compactWorkflowLine(formatOperatorScriptIdentity(res.scriptIdentity, res.target?.ref))
              : formatOperatorScriptIdentity(res.scriptIdentity, res.target?.ref),
          ]),
      compact
        ? compactWorkflowLine(`resultPath: ${res.resultPersistence.path}`)
        : `resultPath: ${res.resultPersistence.path}`,
      ...(res.resultPersistence.ok
        ? []
        : [
            compact
              ? compactWorkflowLine(`persistence: ${res.resultPersistence.code}`)
              : `persistence: ${res.resultPersistence.code}`,
          ]),
    ],
    controls: [compactWorkflowLine(`Detail: /workflows status ${res.runId}`)],
  };
}

function compactWorkflowLine(value: string): string {
  const plain = value.replace(/\s+/gu, " ").trim();
  if (visibleWidth(plain) <= 72) return plain;
  return `${sliceByColumn(plain, 0, 71)}…`;
}

function workflowStatusTone(status: WorkflowRunStatus | WorkflowProjectedStatus): OperatorTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "running":
      return "accent";
    case "awaiting_operator":
    case "cancelled":
      return "warning";
    case "unknown":
      return "muted";
    default:
      return assertNever(status);
  }
}

/**
 * The native toolResult owns one semantic completion: the bounded digest. Keep
 * artifact/persistence metadata around it, but do not repeat success/failure or
 * error text before the final workflow_end line.
 */
function renderWorkflowToolResult(res: RunWorkflowScriptResult, digest: string): string {
  const disposition = workflowResultDisposition(res);
  const firstLine =
    disposition.status === "awaiting_operator"
      ? `workflow ${res.runId} · ${disposition.status} · ${disposition.summary}`
      : `workflow ${res.runId} · ${disposition.status}`;
  const lines = [firstLine, `runDir: ${res.runDir}`];
  if (res.scriptIdentity !== undefined) lines.push(formatOperatorScriptIdentity(res.scriptIdentity, res.target?.ref));
  if (!res.resultPersistence.ok) {
    lines.push(`persistence: ${res.resultPersistence.code}`);
  }
  if (res.artifactRefs !== undefined && res.artifactRefs.length > 0) {
    lines.push("artifactRefs:", ...res.artifactRefs.map((ref) => JSON.stringify(ref)));
    if (res.artifactRefsOmitted !== undefined) lines.push(`artifactRefsOmitted: ${res.artifactRefsOmitted}`);
  }
  lines.push("", digest);
  return lines.join("\n");
}

function workflowResultDisposition(res: RunWorkflowScriptResult): WorkflowDispositionProjection {
  return projectWorkflowDisposition({
    ok: res.ok,
    result: res.result,
    ...(res.error !== undefined ? { error: res.error } : {}),
    ...(res.disposition !== undefined ? { disposition: res.disposition } : {}),
  });
}

function persistedWorkflowDisposition(res: WorkflowRunResultEnvelope): WorkflowDispositionProjection {
  return projectWorkflowDisposition({
    ok: res.ok === true,
    result: res.result,
    ...(res.error !== undefined ? { error: res.error } : {}),
    ...(res.disposition !== undefined ? { disposition: res.disposition } : {}),
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled workflow status: ${String(value)}`);
}

function formatOperatorScriptIdentity(identity: OperatorScriptIdentityInput, sourceRef?: string): string {
  const source = safeOperatorSourceRef(sourceRef);
  const coverage = identity.identityCoverage ?? "entry-only-legacy";
  const execution = identity.executionSource ?? "source";
  const dependencySummary =
    coverage === "self-contained-static"
      ? `builtins=${identity.builtinImports?.length ?? 0}`
      : coverage === "entry-only-legacy"
        ? "unbound=unknown"
        : `unbound=${identity.unboundDependencies?.length ?? "?"}`;
  const node = identity.nodeVersion === undefined ? "" : ` · node=${identity.nodeVersion}`;
  return `script: ${source} · coverage=${coverage} · exec=${execution} · ${dependencySummary} · snapshot=${path.basename(identity.snapshotPath)} · sha256=${identity.scriptSha256.slice(0, 12)}${node}`;
}

function operatorScriptIdentity(
  identity: OperatorScriptIdentityInput,
  sourceRef?: string,
): {
  sourceRef: string;
  snapshot: string;
  scriptSha256: string;
  identityCoverage: string;
  executionSource: string;
  nodeVersion: string;
  builtinImportCount: number | null;
  unboundDependencyCount: number | null;
} {
  return {
    sourceRef: safeOperatorSourceRef(sourceRef),
    snapshot: path.basename(identity.snapshotPath),
    scriptSha256: identity.scriptSha256,
    identityCoverage: identity.identityCoverage ?? "entry-only-legacy",
    executionSource: identity.executionSource ?? "source",
    nodeVersion: identity.nodeVersion ?? "unknown",
    builtinImportCount:
      (identity.identityCoverage ?? "entry-only-legacy") === "entry-only-legacy"
        ? null
        : (identity.builtinImports?.length ?? 0),
    unboundDependencyCount:
      (identity.identityCoverage ?? "entry-only-legacy") === "entry-only-legacy"
        ? null
        : (identity.unboundDependencies?.length ?? null),
  };
}

function operatorWorkflowTarget(target: ResolvedWorkflowTarget | undefined): {
  kind: ResolvedWorkflowTarget["kind"];
  ref: string;
  source: ResolvedWorkflowTarget["source"];
} | null {
  if (target === undefined) return null;
  return {
    kind: target.kind,
    ref: safeOperatorSourceRef(target.ref),
    source: target.source,
  };
}

function safeOperatorSourceRef(sourceRef: string | undefined): string {
  if (sourceRef === undefined || sourceRef === "") return "workflow";
  if (!path.isAbsolute(sourceRef)) return sourceRef;
  return path.basename(sourceRef) || "workflow";
}

interface OperatorScriptIdentityInput {
  snapshotPath: string;
  scriptSha256: string;
  identityCoverage?: string;
  executionSource?: string;
  nodeVersion?: string;
  builtinImports?: readonly string[];
  unboundDependencies?: readonly string[];
}

/** Shared journal-line renderer used by live progress, final result, and status detail. */
function renderJournalLines(journal: readonly WorkflowJournalLine[]): string[] {
  const out: string[] = [];
  for (const line of journal) {
    if (line.kind === "phase") {
      out.push(`  [phase] ${line.phase ?? ""}`);
    } else if (line.kind === "log") {
      const label = line.source === "script" ? "script" : line.source === "runtime" ? "runtime" : "journal";
      out.push(`  [${label}] ${line.message ?? ""}`);
    } else if (line.kind === "agent_start") {
      out.push(
        `  [agent] -> ${line.agent ?? ""}${line.label !== undefined ? ` (${line.label})` : ""}${line.replayed === true ? " [replayed]" : ""}`,
      );
    } else if (line.kind === "agent_end") {
      out.push(
        `  [agent] <- ${line.agent ?? ""} ${line.status ?? ""}${line.durationMs !== undefined ? ` ${line.durationMs}ms` : ""}${line.replayed === true ? " [replayed]" : ""}`,
      );
    } else if (line.kind === "error") {
      out.push(`  [error] ${line.message ?? ""}`);
    }
  }
  return out;
}

function setWorkflowLaunchStatus(ctx: ExtensionContext, kind: string, ref: string): void {
  setOperatorStatus(ctx, {
    id: WORKFLOW_STATUS_ID,
    lane: "activity",
    priority: 70,
    wide: `WF launch · operator command · ${kind}:${ref}`,
    compact: `WF launch · operator cmd · ${ref}`,
    narrow: "WF launch",
  });
}

function setWorkflowEventStatus(ctx: ExtensionContext, line: WorkflowJournalLine): void {
  const status = renderMainWorkflowStatus(line);
  if (status === undefined) return;
  setOperatorStatus(ctx, {
    id: WORKFLOW_STATUS_ID,
    lane: "activity",
    priority: 70,
    wide: `WF ${status}`,
    compact: `WF ${status}`,
    narrow: line.kind === "error" ? "WF error" : line.kind === "phase" ? "WF phase" : "WF active",
  });
}

function workflowTargetLabel(value: { name?: string; scriptPath?: string; script?: string }): string {
  return value.name ?? value.scriptPath ?? value.script ?? "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}
