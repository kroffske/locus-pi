/**
 * extensions/workflows/workflow-tool.ts — The `workflow` tool.
 *
 * Owns its TypeBox parameter schema, the exec-approval detail lines, the
 * launch through the shared command launcher, and the single native toolResult
 * the run is reported through. The tool never renders a widget: the operator
 * surfaces belong to `/workflows`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import type { ToolResult } from "../_shared/host/pi-api.js";
import { errorResult, getProjectRoot, textResult } from "../_shared/host/pi-api.js";
import { validateParams } from "../_shared/host/validation.js";
import { formatWorkflowFailureDiagnosticLines } from "./runtime/workflow-failure.js";
import { applyWorkflowJournalLineToAgentLiveStore } from "./runtime/workflow-journal.js";
import { runWorkflowScript } from "./runtime/workflow-runner.js";
import type { ResolvedWorkflowTarget, RunWorkflowScriptResult } from "./runtime/workflow-runner.js";
import type { WorkflowJournalLine } from "./runtime/workflow-runtime.js";
import { WORKFLOW_INPUT_MAX_CHARS } from "./runtime/workflow-runtime.js";
import {
  formatOperatorScriptIdentity,
  safeOperatorSourceRef,
  workflowResultDisposition,
  type OperatorScriptIdentityInput,
} from "./operator-ui.js";
import { renderAgentLiveRowsText } from "./progress-widget.js";
import type { WorkflowCommandLauncher } from "./workflow-command-launcher.js";
import { createWorkflowTranscript } from "./workflow-transcript.js";
import { WORKFLOW_SAFE_COMPONENT_PATTERN, workflowRunOutputsDir } from "./runtime/workflow-run-layout.js";

const WorkflowArtifactRefParams = Type.Object(
  {
    runId: Type.String({ pattern: WORKFLOW_SAFE_COMPONENT_PATTERN }),
    artifactId: Type.String({ pattern: WORKFLOW_SAFE_COMPONENT_PATTERN }),
    name: Type.String({ pattern: WORKFLOW_SAFE_COMPONENT_PATTERN }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);

const WorkflowContinuationParams = Type.Object(
  {
    originRunId: Type.String({ pattern: WORKFLOW_SAFE_COMPONENT_PATTERN }),
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

export interface WorkflowToolDependencies {
  commandLauncher: WorkflowCommandLauncher;
  /** Records a started run id so this session owns the questions that run publishes. */
  onRunStarted: (runId: string) => void;
  /** Records a settled run id so the session can prune its live rows later. */
  onRunCompleted: (runId: string) => void;
}

export function registerWorkflowTool(pi: ExtensionAPI, deps: WorkflowToolDependencies): void {
  const { commandLauncher } = deps;
  pi.registerTool({
    name: "workflow",
    description:
      "Run a reviewed trusted-file workflow script by saved name or project-relative path with one optional semantic text request and optional host-verified continuation artifacts. The saved JavaScript executes with full Node.js/module access in the Pi host process; it is not sandboxed, and exec approval is consent rather than capability isolation. Saved names resolve from the canonical .pi/workflows/ first (then the additional project directories .claude/workflows/ and .agents/workflows/, then ~/.pi/workflows/, then the curated Package registry); every project directory accepts only a pi-native <name>.workflow.mjs, so a workflow written for another host is neither found nor runnable here. The DSL (agent/parallel/pipeline/phase/log) orchestrates .agents catalog sub-agents through the task/createAgentSession host; agent() is the single model-calling primitive. Legacy script strings normalize to name or path; arbitrary inline JavaScript is not supported. To AUTHOR a new workflow, delegate to the `workflow-author` agent (it writes to .pi/workflows/); the DSL contract is extensions/workflows/AUTHORING.md → docs/extensions/active/workflows.md.",
    parameters: WorkflowParams,
    approval: "exec",
    formatApprovalDetails: workflowApprovalDetails,
    renderResult: renderWorkflowToolResultCard,
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
      if (commandLauncher.currentLease(ctx) === undefined) {
        return errorResult("workflow: this extension session has already shut down", { owner: "workflows" });
      }
      const transcript = createWorkflowTranscript(ctx, workflowTargetLabel(valid.value), "tool", {
        ...(valid.value.input !== undefined ? { input: valid.value.input } : {}),
      });
      const launched = commandLauncher.attach<RunWorkflowScriptResult>(ctx, signal, async (background) =>
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
          onRunStart: ({ runId, runDir }) => {
            background.setRunId(runId);
            deps.onRunStarted(runId);
            transcript.start(runId, runDir);
            update({
              content: [{ type: "text", text: `workflow started\nrunDir: ${runDir}` }],
              details: { runId, runDir },
            });
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
      deps.onRunCompleted(res.runId);

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
          outputDir: workflowRunOutputsDir(res.runDir),
          ...(res.resultTextPath !== undefined ? { resultTextPath: res.resultTextPath } : {}),
          ...(res.primaryOutputPath !== undefined ? { primaryOutputPath: res.primaryOutputPath } : {}),
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
        outputDir: workflowRunOutputsDir(res.runDir),
        ...(res.resultTextPath !== undefined ? { resultTextPath: res.resultTextPath } : {}),
        ...(res.primaryOutputPath !== undefined ? { primaryOutputPath: res.primaryOutputPath } : {}),
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
  const lines = [firstLine, `runDir: ${res.runDir}`, `outputDir: ${workflowRunOutputsDir(res.runDir)}`];
  if (res.resultTextPath !== undefined) lines.push(`result: ${res.resultTextPath}`);
  if (res.primaryOutputPath !== undefined) lines.push(`primary output: ${res.primaryOutputPath}`);
  if (res.scriptIdentity !== undefined) lines.push(formatOperatorScriptIdentity(res.scriptIdentity, res.target?.ref));
  if (!res.resultPersistence.ok) {
    lines.push(`persistence: ${res.resultPersistence.code}`);
  }
  if (res.failureDiagnostic !== undefined) {
    lines.push(...formatWorkflowFailureDiagnosticLines(res.failureDiagnostic, { repairRequest: true }));
  }
  if (res.artifactRefs !== undefined && res.artifactRefs.length > 0) {
    lines.push("artifactRefs:", ...res.artifactRefs.map((ref) => JSON.stringify(ref)));
    if (res.artifactRefsOmitted !== undefined) lines.push(`artifactRefsOmitted: ${res.artifactRefsOmitted}`);
  }
  lines.push("", digest);
  return lines.join("\n");
}

/** Human-only transcript card. The model still receives the bounded `content` digest. */
function renderWorkflowToolResultCard(result: ToolResult): Text {
  const details = (result.details ?? {}) as Record<string, unknown>;
  const lines = [result.isError === true ? "[ERROR] Workflow" : "[RESULT] Workflow"];
  if (typeof details.runId === "string") lines.push(`run: ${details.runId}`);
  if (typeof details.outputDir === "string") lines.push(`outputs: ${details.outputDir}`);
  if (typeof details.primaryOutputPath === "string") lines.push(`primary output: ${details.primaryOutputPath}`);
  if (typeof details.resultTextPath === "string") lines.push(`workflow result: ${details.resultTextPath}`);
  const persistedResult = readPersistedWorkflowResult(details);
  if (persistedResult !== undefined) {
    lines.push("", persistedResult);
  } else {
    const firstText = result.content.find((part) => part.type === "text");
    if (firstText?.type === "text") lines.push("", firstText.text);
  }
  return new Text(lines.join("\n"), 0, 0);
}

function readPersistedWorkflowResult(details: Record<string, unknown>): string | undefined {
  if (typeof details.outputDir !== "string" || typeof details.resultTextPath !== "string") return undefined;
  const outputDir = path.resolve(details.outputDir);
  const resultPath = path.resolve(details.resultTextPath);
  if (resultPath !== path.join(outputDir, "workflow-result.md")) {
    return "[full workflow result unavailable: invalid result path]";
  }
  try {
    return readFileSync(resultPath, "utf8").replace(/\n$/u, "");
  } catch {
    return "[full workflow result unavailable: result file cannot be read]";
  }
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

function workflowTargetLabel(value: { name?: string; scriptPath?: string; script?: string }): string {
  return value.name ?? value.scriptPath ?? value.script ?? "unknown";
}
