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
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../_shared/pi-api.js";
import { errorResult, getCommandText, getProjectRoot, getWorkingDirectory, setTextWidget, textResult } from "../_shared/pi-api.js";
import { pinTransientUiKey, registerCommandWithUiLifecycle, registerTransientUiCleanup, unpinTransientUiKey } from "../_shared/command-ui.js";
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
  listWorkflowRunIds,
  readWorkflowRunJournal,
  readWorkflowRunResult,
  readWorkflowRunSummary,
  workflowRunDir,
} from "../_shared/workflow-journal.js";
import type { WorkflowJournalLine } from "../_shared/workflow-runtime.js";
import { formatWorkflowFailureSummary, formatWorkflowResultDetail, formatWorkflowResultSummary } from "../_shared/workflow-result.js";
import type { OperatorBlock, OperatorTone } from "../_shared/operator-ui.js";
import { clearOperatorStatus, setOperatorStatus } from "../_shared/operator-status.js";
import { setOperatorWidget } from "../_shared/widget-render.js";
import { WORKFLOW_LIVE_WIDGET_KEY, installWorkflowProgress, renderAgentLiveRowsText, type WorkflowProgressComponent } from "./progress-widget.js";
import {
  buildWorkflowActionPrompt,
  buildWorkflowCatalogBlockFromModel,
  buildWorkflowCatalogModel,
  buildWorkflowInfoBlock,
  WORKFLOW_SOURCE_LEGEND,
  workflowSourceBadge,
  type WorkflowBrowserIntent,
} from "./workflow-catalog.js";
import { WorkflowCatalogViewer, WorkflowInfoViewer } from "./catalog-viewer.js";
import { createWorkflowTranscript, persistCommandWorkflowTranscript, renderMainWorkflowStatus } from "./workflow-transcript.js";

// ---------------------------------------------------------------------------
// Tool params schema
// ---------------------------------------------------------------------------

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
      description: "Optional free-text input passed to the workflow",
      maxLength: 16000,
    }),
  ),
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
const WORKFLOW_BUSY_MESSAGE = "Workflow not started: Pi is busy streaming. Wait for the current response to finish, then retry /workflows run.";
const WORKFLOW_STATUS_ID = "workflow.run";

function workflowApprovalDetails(args: unknown): string[] {
  const record = args !== null && typeof args === "object" ? args as Record<string, unknown> : {};
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
  let activeCommandRuns = 0;
  const cleanupCompletedRuns = (_ctx: ExtensionContext): boolean => {
    if (completedRunIds.size === 0) return false;
    for (const runId of completedRunIds) pruneCompletedWorkflowRunLiveRows(runId);
    completedRunIds.clear();
    return true;
  };
  const cleanupCompletedSurface = (ctx: ExtensionContext): void => {
    if (activeCommandRuns > 0) return;
    if (cleanupCompletedRuns(ctx)) clearWorkflowWidget(ctx, WORKFLOW_LIVE_WIDGET_KEY);
    clearOperatorStatus(ctx, WORKFLOW_STATUS_ID);
  };
  const cleanupTransientSurface = (ctx: ExtensionContext): void => {
    if (activeCommandRuns > 0) return;
    cleanupCompletedRuns(ctx);
    clearOperatorStatus(ctx, WORKFLOW_STATUS_ID);
  };
  registerTransientUiCleanup(pi, "workflows", cleanupTransientSurface);
  registerTransientUiCleanup(pi, WORKFLOW_LIVE_WIDGET_KEY, cleanupTransientSurface);
  pi.on("turn_end", (_event, ctx) => cleanupCompletedSurface(ctx));

  // -------------------------------------------------------------------------
  // `workflow` tool
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "workflow",
    description:
      "Run a reviewed trusted-file workflow script by saved name or project-relative path. The saved JavaScript executes with full Node.js/module access in the Pi host process; it is not sandboxed, and exec approval is consent rather than capability isolation. Saved names resolve from the canonical .pi/workflows/ first (then .claude/workflows/ and .agents/workflows/ interop sources, then ~/.pi/workflows/, then the curated Package registry). The DSL (agent/llm/parallel/pipeline/phase/log) orchestrates .agents catalog sub-agents through the task/createAgentSession host, and llm() makes direct one-shot model calls via the pi-ai host. Legacy script strings normalize to name or path; arbitrary inline JavaScript is not supported. To AUTHOR a new workflow, delegate to the `workflow-author` agent (it writes to .pi/workflows/); the DSL contract is extensions/workflows/AUTHORING.md → docs/extensions/active/workflows.md.",
    parameters: WorkflowParams,
    approval: "exec",
    formatApprovalDetails: workflowApprovalDetails,
    async execute(_toolCallId, params, signal, update, ctx) {
      const valid = validateParams(WorkflowParams, params);
      if (!valid.ok) return valid.result;
      const targetFields = [valid.value.name, valid.value.scriptPath, valid.value.script].filter((v) => v !== undefined);
      if (targetFields.length !== 1) return errorResult("workflow: exactly one of name, scriptPath, or script is required", { owner: "workflows" });
      const transcript = createWorkflowTranscript(ctx, workflowTargetLabel(valid.value), "tool");

      const res = await runWorkflowScript({
        pi,
        ctx,
        signal,
        ...(valid.value.name !== undefined ? { name: valid.value.name } : {}),
        ...(valid.value.scriptPath !== undefined ? { scriptPath: valid.value.scriptPath } : {}),
        ...(valid.value.script !== undefined ? { script: valid.value.script } : {}),
        input: valid.value.input,
        ...(valid.value.resumeFromRunId !== undefined ? { resumeFromRunId: valid.value.resumeFromRunId } : {}),
        onRunStart: ({ runId }) => transcript.start(runId),
        onEvent: (line: WorkflowJournalLine) => {
          applyWorkflowJournalLineToAgentLiveStore(line);
          transcript.event(line);
          // Stream renderable `content`, not just `details`: in the interactive TUI the pi SDK's
          // ToolExecutionComponent renders streamed updates via getTextOutput(result.content) — a
          // content-less partial makes it throw `reading 'filter'` on a detached emit tick, which the
          // workflow host-net then mis-attributes as ok:false on an otherwise-successful run. The live
          // agent rows double as the progress text the model/user see for this tool call.
          const liveAgents = renderAgentLiveRowsText();
          update({ content: [{ type: "text", text: liveAgents }], details: { lastEvent: line, liveAgents } });
        },
      });
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
      if (res.ok) {
        return textResult(summary, {
          owner: "workflows",
          transcript: transcriptDetails,
          runId: res.runId,
          runDir: res.runDir,
          resultPath: res.resultPersistence.path,
          resultPersistence: res.resultPersistence,
          ...(res.resultDiagnostic !== undefined ? { resultDiagnostic: res.resultDiagnostic } : {}),
          journal: res.journal,
          target: operatorWorkflowTarget(res.target),
          ...(res.scriptIdentity !== undefined ? { scriptIdentity: operatorScriptIdentity(res.scriptIdentity, res.target?.ref) } : {}),
          ...(res.resumeFromRunId !== undefined ? {
            resumeFromRunId: res.resumeFromRunId,
            resumeSourceRunSummary: res.resumeSourceRunSummary ?? null,
          } : {}),
        });
      }
      return errorResult(summary, {
        owner: "workflows",
        transcript: transcriptDetails,
        runId: res.runId,
        runDir: res.runDir,
        resultPath: res.resultPersistence.path,
        resultPersistence: res.resultPersistence,
        result: res.result,
        ...(res.resultDiagnostic !== undefined ? { resultDiagnostic: res.resultDiagnostic } : {}),
        journal: res.journal,
        error: res.error,
        target: operatorWorkflowTarget(res.target),
        ...(res.scriptIdentity !== undefined ? { scriptIdentity: operatorScriptIdentity(res.scriptIdentity, res.target?.ref) } : {}),
        ...(res.resumeFromRunId !== undefined ? {
          resumeFromRunId: res.resumeFromRunId,
          resumeSourceRunSummary: res.resumeSourceRunSummary ?? null,
        } : {}),
      });
    },
  });

  // -------------------------------------------------------------------------
  // `/workflows` command
  // -------------------------------------------------------------------------
  registerCommandWithUiLifecycle(pi, {
    command: "workflows",
    group: "workflows",
    surfaces: ["transient-widget", "status", "artifact-write", "no-ui"],
    transientWidgets: ["workflows", WORKFLOW_LIVE_WIDGET_KEY],
  }, {
    description:
      "Usage: /workflows | list [query] | info [name] | status [runId] | run <name|path> [--resume <runId>] [input]. Browse, inspect, explain, or deliberately run a workflow.",
    handler: async (args, ctx) => {
      const text = getCommandText(args).trim();
      const projectRoot = getProjectRoot(ctx);

      // Bare `/workflows` is a static command view; it never starts a run.
      if (text === "" || text === "dashboard") {
        clearWorkflowWidget(ctx, WORKFLOW_LIVE_WIDGET_KEY);
        setOperatorWidget(ctx, "workflows", workflowHelpBlock());
        return;
      }

      // `/workflows list [query]` — operator catalog over the existing sources.
      const listMatch = /^list(?:\s+([\s\S]+))?$/.exec(text);
      if (listMatch !== null) {
        const query = listMatch[1]?.trim();
        const workingDirectory = getWorkingDirectory(ctx);
        const catalog = buildWorkflowCatalogModel(
          projectRoot,
          workingDirectory,
          query === "" ? undefined : query,
        );
        if (ctx.mode === "tui" && ctx.hasUI !== false && ctx.ui.custom !== undefined) {
          clearWorkflowWidget(ctx, "workflows");
          let intent: WorkflowBrowserIntent | undefined;
          try {
            intent = await ctx.ui.custom<WorkflowBrowserIntent | undefined>((tui, theme, keybindings, done) => new WorkflowCatalogViewer(
              tui,
              theme,
              keybindings,
              catalog,
              projectRoot,
              workingDirectory,
              done,
            ));
          } catch (error) {
            setOperatorWidget(ctx, "workflows", workflowWarningBlock(
              `Workflow browser closed with an error: ${errorMessage(error)}.`,
              "No editor text was changed and no workflow was started.",
            ));
            return;
          }
          if (intent === undefined) return;
          const prompt = buildWorkflowActionPrompt(intent);
          if (ctx.ui.setEditorText === undefined) {
            setOperatorWidget(ctx, "workflows", workflowWarningBlock(
              "Workflow action could not fill the editor because this Pi host does not expose setEditorText().",
              "No workflow was started; reopen in an interactive Pi TUI with editor-prefill support.",
            ));
            return;
          }
          try {
            ctx.ui.setEditorText(prompt);
          } catch (error) {
            setOperatorWidget(ctx, "workflows", workflowWarningBlock(
              `Workflow action could not fill the editor: ${errorMessage(error)}.`,
              "No workflow was started and no message was sent.",
            ));
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
                hint: [...(passive.hint ?? []), "Interactive catalog unavailable: this Pi host did not expose custom UI."],
                controls: [...(passive.controls ?? []), "Read-only fallback shown; retry in an interactive Pi TUI with custom UI support."],
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
            await ctx.ui.custom<void>((tui, theme, keybindings, done) => new WorkflowInfoViewer(
              tui,
              theme,
              keybindings,
              infoBlock,
              done,
            ));
          } catch (error) {
            setOperatorWidget(ctx, "workflows", workflowWarningBlock(
              `Workflow info viewer closed with an error: ${errorMessage(error)}.`,
              "No editor text was changed and no workflow was started.",
            ));
          }
          return;
        }
        setOperatorWidget(
          ctx,
          "workflows",
          ctx.mode === "tui"
            ? {
                ...infoBlock,
                hint: [...(infoBlock.hint ?? []), "Interactive workflow info unavailable: this Pi host did not expose custom UI."],
                controls: [...(infoBlock.controls ?? []), "Read-only fallback shown; retry in an interactive Pi TUI with custom UI support."],
              }
            : infoBlock,
        );
        return;
      }

      // `/workflows status` — recent runs; `/workflows status <runId>` — one run's progress.
      if (text === "status") {
        const compact = ctx.mode !== "tui";
        setOperatorWidget(ctx, "workflows", buildRunsListBlock(
          projectRoot,
          compact ? WORKFLOW_RPC_STATUS_ROWS : RUNS_IN_STATUS_LIST,
          compact,
        ));
        return;
      }
      const statusMatch = /^status\s+(\S+)$/.exec(text);
      if (statusMatch !== null) {
        setOperatorWidget(ctx, "workflows", buildRunDetailBlock(
          projectRoot,
          statusMatch[1] ?? "",
          ctx.mode !== "tui",
        ));
        return;
      }

      // `/workflows run <name|path> [--resume <runId>] [input]` — run with a live progress panel.
      const parsedRun = parseRunCommand(text);
      if (parsedRun !== null) {
        if (parsedRun.missingResumeId === true) {
          setOperatorWidget(ctx, "workflows", workflowWarningBlock(
            "Missing run id after --resume.",
            "Retry: /workflows run <name|path> --resume <runId> [input]",
          ));
          return;
        }
        const idleBlock = workflowCommandIdleBlock(ctx);
        if (idleBlock !== undefined) {
          setOperatorWidget(ctx, "workflows", workflowWarningBlock(
            idleBlock,
            "Recovery: wait for the current response to finish, then retry the same /workflows run command.",
          ));
          return;
        }
        const scriptRef = parsedRun.scriptRef;
        const workingDirectory = getWorkingDirectory(ctx);
        let target;
        try {
          target = resolveWorkflowTarget({ script: scriptRef }, projectRoot, workingDirectory);
        } catch (err) {
          if (err instanceof WorkflowNameNotFoundError) {
            setOperatorWidget(ctx, "workflows", workflowNotFoundBlock(scriptRef));
            return;
          }
          const controller = new AbortController();
          const transcript = createWorkflowTranscript(ctx, scriptRef, "command");
          const res = await runWorkflowScript({
            pi,
            ctx,
            signal: controller.signal,
            script: scriptRef,
            ...(parsedRun.input !== undefined ? { input: parsedRun.input } : {}),
            ...(parsedRun.resumeFromRunId !== undefined ? { resumeFromRunId: parsedRun.resumeFromRunId } : {}),
            onRunStart: ({ runId }) => transcript.start(runId),
            onEvent: (line: WorkflowJournalLine) => {
              applyWorkflowJournalLineToAgentLiveStore(line);
              transcript.event(line);
              setTextWidget(ctx, "workflows", renderAgentLiveRowsText());
              setWorkflowEventStatus(ctx, line);
            },
          });
          const transcriptCompletion = transcript.finish(res);
          completedRunIds.add(res.runId);
          setOperatorWidget(ctx, "workflows", buildWorkflowResultBlock(res, ctx.mode !== "tui"));
          await persistCommandWorkflowTranscript(pi, ctx, transcriptCompletion);
          return;
        }
        clearWorkflowWidget(ctx, WORKFLOW_LIVE_WIDGET_KEY);
        const controller = new AbortController();
        const hasUI = ctx.hasUI === true;
        setWorkflowLaunchStatus(ctx, target.kind, target.ref);
        let panel: WorkflowProgressComponent | undefined;
        const transcript = createWorkflowTranscript(ctx, scriptRef, "command");
        activeCommandRuns += 1;
        if (hasUI) pinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
        let res: RunWorkflowScriptResult;
        try {
          res = await runWorkflowScript({
            pi,
            ctx,
            signal: controller.signal,
            script: scriptRef,
            ...(parsedRun.input !== undefined ? { input: parsedRun.input } : {}),
            ...(parsedRun.resumeFromRunId !== undefined ? { resumeFromRunId: parsedRun.resumeFromRunId } : {}),
            onRunStart: ({ runId }) => {
              transcript.start(runId);
              if (hasUI && !panel) panel = installWorkflowProgress(ctx, WORKFLOW_LIVE_WIDGET_KEY, scriptRef, runId);
            },
            onEvent: (line: WorkflowJournalLine) => {
              if (hasUI) panel?.push(line);
              else {
                applyWorkflowJournalLineToAgentLiveStore(line);
                setTextWidget(ctx, "workflows", renderAgentLiveRowsText());
              }
              transcript.event(line);
              setWorkflowEventStatus(ctx, line);
            },
          });
          completedRunIds.add(res.runId);
        } finally {
          if (hasUI) unpinTransientUiKey(pi, WORKFLOW_LIVE_WIDGET_KEY);
          activeCommandRuns = Math.max(0, activeCommandRuns - 1);
        }
        const transcriptCompletion = transcript.finish(res);
        if (hasUI && panel) {
          panel.finish(res);
        } else {
          setOperatorWidget(ctx, "workflows", buildWorkflowResultBlock(res, ctx.mode !== "tui"));
        }
        await persistCommandWorkflowTranscript(pi, ctx, transcriptCompletion);
        return;
      }

      const available = text.startsWith("run") ? listExampleNames() : [];
      setOperatorWidget(ctx, "workflows", {
        type: "WARN",
        subject: "Workflow command",
        primary: `Unknown workflow command: ${text}`,
        body: available.length === 0 ? [] : [`Available curated Package workflows: ${available.join(", ")}`],
        controls: ["Usage: /workflows | list [query] | info [name] | status [runId] | run <name|path> [--resume <runId>] [input]"],
      });
    },
  });
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

interface ParsedRunCommand {
  scriptRef: string;
  input?: string;
  resumeFromRunId?: string;
  missingResumeId?: boolean;
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

function workflowHelpBlock(): OperatorBlock {
  return {
    type: "VIEW",
    subject: "Workflow commands",
    primary: "Browse saved workflows, inspect run history, or start a trusted-file workflow.",
    body: [
      "Catalog: /workflows list [query]",
      "Info: /workflows info [exact-name]",
      "History: /workflows status [runId]",
      "Run: /workflows run <name|path> [--resume <runId>] [input]",
    ],
    metadata: ["A command starts execution only when the Pi session is provably idle."],
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
      controls: ["Run one: /workflows run requirements-grill \"<your request>\""],
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
  const source = readWorkflowRunResult(projectRoot, runId)?.target?.source;
  if (compact) {
    return compactWorkflowLine(
      `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${s.status} ${runId} phase=${s.phase ?? "-"}`,
    );
  }
  const parts = [
    `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`}`,
    s.status.padEnd(9),
    runId,
    `phase=${s.phase ?? "-"}`,
    `agents=${s.agentsEnded}/${s.agentsStarted}`,
  ];
  if (s.llmStarted > 0) parts.push(`llm=${s.llmEnded}/${s.llmStarted}`);
  if (s.usage !== null) parts.push(`tok=${s.usage.totalTokens}`);
  if (s.errors > 0) parts.push(`err=${s.errors}`);
  return parts.join("  ");
}

function buildRunDetailBlock(projectRoot: string, runId: string, compact = false): OperatorBlock {
  const journal = readWorkflowRunJournal(projectRoot, runId);
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
  const allJournalLines = renderJournalLines(journal);
  const eventLimit = compact ? WORKFLOW_RPC_DETAIL_EVENT_LIMIT : WORKFLOW_DETAIL_EVENT_LIMIT;
  const newestJournalLines = allJournalLines.slice(-eventLimit).reverse();
  const older = Math.max(0, allJournalLines.length - newestJournalLines.length);
  const resultDetail = persisted === null
    ? summary.hasResult
      ? "result detail: unavailable (result.json is unreadable)"
      : "result: unavailable (run is in flight or was interrupted)"
    : persisted.error !== undefined
      ? `error: ${persisted.error}`
      : `result: ${formatWorkflowResultDetail(persisted.result)}`;
  const source = persisted?.target?.source;
  const scriptIdentity = persisted?.scriptIdentity;
  const compactResult = persisted === null
    ? resultDetail
    : persisted.error !== undefined
      ? `error: ${persisted.error}`
      : `result: ${formatWorkflowResultSummary(persisted.result)}`;
  return {
    type: "VIEW",
    subject: "Workflow run",
    primary: compact
      ? compactWorkflowLine(`[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${runId} · ${summary.status}${summary.phase === null ? "" : ` · phase=${summary.phase}`}`)
      : `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${runId} · ${summary.status}${summary.phase === null ? "" : ` · phase=${summary.phase}`}`,
    badges: [
      { text: `status:${summary.status}`, tone: workflowStatusTone(summary.status) },
      ...(source === undefined ? [] : [{ text: workflowSourceBadge(source).slice(1, -1), tone: "muted" as const }]),
    ],
    body: newestJournalLines.length === 0
      ? ["No journal events recorded."]
      : compact
        ? newestJournalLines.map(compactWorkflowLine)
        : newestJournalLines,
    metadata: compact
      ? [
          WORKFLOW_SOURCE_LEGEND,
          compactWorkflowLine(`runDir: ${workflowRunDir(projectRoot, runId)}`),
          ...(scriptIdentity === undefined ? [] : [compactWorkflowLine(formatOperatorScriptIdentity(scriptIdentity, persisted?.target?.ref))]),
          ...(budgetLine === null ? [] : [compactWorkflowLine(budgetLine)]),
          compactWorkflowLine(compactResult),
          ...(older > 0 ? [`+${older} older journal row(s) hidden`] : []),
        ]
      : [
          WORKFLOW_SOURCE_LEGEND,
          `Source: [R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`}`,
          `runDir: ${workflowRunDir(projectRoot, runId)}`,
          ...(scriptIdentity === undefined ? [] : [formatOperatorScriptIdentity(scriptIdentity, persisted?.target?.ref)]),
          ...(budgetLine === null ? [] : [budgetLine]),
          resultDetail,
          ...(older > 0 ? [`+${older} older journal row(s) hidden`] : []),
        ],
    controls: ["Refresh/list: /workflows status · Full artifact: result.json"],
  };
}

// ---------------------------------------------------------------------------
// Rendering — single run final result + shared journal lines
// ---------------------------------------------------------------------------

function buildWorkflowResultBlock(res: RunWorkflowScriptResult, compact = false): OperatorBlock {
  const source = res.target?.source;
  const status = res.ok ? "completed" : "failed";
  const primary = `[R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`} ${res.ok
    ? formatWorkflowResultSummary(res.result)
    : formatWorkflowFailureSummary(res.result, res.error)}`;
  return {
    type: res.ok ? "RESULT" : "ERROR",
    subject: "Workflow run",
    primary: compact ? compactWorkflowLine(primary) : primary,
    badges: [
      { text: `status:${status}`, tone: res.ok ? "success" : "error" },
      ...(source === undefined ? [] : [{ text: workflowSourceBadge(source).slice(1, -1), tone: "muted" as const }]),
    ],
    metadata: [
      WORKFLOW_SOURCE_LEGEND,
      `runId: ${res.runId}`,
      `Source: [R]${source === undefined ? "" : ` ${workflowSourceBadge(source)}`}`,
      compact ? compactWorkflowLine(`runDir: ${res.runDir}`) : `runDir: ${res.runDir}`,
      ...(res.scriptIdentity === undefined ? [] : [compact
        ? compactWorkflowLine(formatOperatorScriptIdentity(res.scriptIdentity, res.target?.ref))
        : formatOperatorScriptIdentity(res.scriptIdentity, res.target?.ref)]),
      compact ? compactWorkflowLine(`resultPath: ${res.resultPersistence.path}`) : `resultPath: ${res.resultPersistence.path}`,
      ...(res.resultPersistence.ok ? [] : [compact
        ? compactWorkflowLine(`persistence: ${res.resultPersistence.code}`)
        : `persistence: ${res.resultPersistence.code}`]),
    ],
    controls: [compactWorkflowLine(`Detail: /workflows status ${res.runId}`)],
  };
}

function compactWorkflowLine(value: string): string {
  const plain = value.replace(/\s+/gu, " ").trim();
  if (visibleWidth(plain) <= 72) return plain;
  return `${sliceByColumn(plain, 0, 71)}…`;
}

function workflowStatusTone(status: string): OperatorTone {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "accent";
  return "muted";
}

/**
 * The native toolResult owns one semantic completion: the bounded digest. Keep
 * artifact/persistence metadata around it, but do not repeat success/failure or
 * error text before the final workflow_end line.
 */
function renderWorkflowToolResult(res: RunWorkflowScriptResult, digest: string): string {
  const lines = [`workflow ${res.runId}`, `runDir: ${res.runDir}`];
  if (res.scriptIdentity !== undefined) lines.push(formatOperatorScriptIdentity(res.scriptIdentity, res.target?.ref));
  if (!res.resultPersistence.ok) {
    lines.push(`persistence: ${res.resultPersistence.code}`);
  }
  lines.push("", digest);
  return lines.join("\n");
}

function formatOperatorScriptIdentity(
  identity: OperatorScriptIdentityInput,
  sourceRef?: string,
): string {
  const source = safeOperatorSourceRef(sourceRef);
  const coverage = identity.identityCoverage ?? "entry-only-legacy";
  const execution = identity.executionSource ?? "source";
  const dependencySummary = coverage === "self-contained-static"
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
    builtinImportCount: (identity.identityCoverage ?? "entry-only-legacy") === "entry-only-legacy"
      ? null
      : identity.builtinImports?.length ?? 0,
    unboundDependencyCount: (identity.identityCoverage ?? "entry-only-legacy") === "entry-only-legacy"
      ? null
      : identity.unboundDependencies?.length ?? null,
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
      out.push(`  [agent] -> ${line.agent ?? ""}${line.label !== undefined ? ` (${line.label})` : ""}`);
    } else if (line.kind === "agent_end") {
      out.push(
        `  [agent] <- ${line.agent ?? ""} ${line.status ?? ""}${line.durationMs !== undefined ? ` ${line.durationMs}ms` : ""}`,
      );
    } else if (line.kind === "llm_start") {
      out.push(`  [llm]   -> ${line.label ?? "model"}`);
    } else if (line.kind === "llm_end") {
      const usage = line.usage !== undefined ? ` tok=${line.usage.totalTokens}` : "";
      const diagnostic = line.message !== undefined ? ` · ${line.message}` : "";
      out.push(
        `  [llm]   <- ${line.label ?? "model"} ${line.status ?? ""}${line.durationMs !== undefined ? ` ${line.durationMs}ms` : ""}${usage}${diagnostic}`,
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
