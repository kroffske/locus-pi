/**
 * workflow-runner.ts — Constrained script loader + executor (trusted-script loader).
 *
 * Loads a workflow script and runs it with ONLY the DSL in scope.
 * This is the trust boundary (worktree isolation, not a security boundary): the script receives `runtime.dsl` as its only argument.
 * No fs / process / require / globals injected from the runtime side.
 *
 * PoC trust-model honesty (documented limitation):
 *   Node ESM has no first-class module isolation here. A trusted script can use
 *   Node built-ins, and an explicit entry-only script can import other modules.
 *   Mitigation: (a) bare names resolve only through the documented saved-workflow
 *   directories (project and personal), then the curated Package registry;
 *   (b) lexical + physical path-escape checks; (c) docs plainly state author scripts are trusted input.
 *   Hard VM/worker isolation is a pending seam — see TODO(trust-model) marker below.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { constants as vmConstants, Script } from "node:vm";
import type { ExtensionAPI, ExtensionContext } from "../../_shared/host/pi-api.js";
import { getProjectRoot, getWorkingDirectory, isOneShotHostMode } from "../../_shared/host/pi-api.js";
import type {
  WorkflowAwaitOperatorDeclaration,
  WorkflowDsl,
  WorkflowJournalLine,
  WorkflowRuntime,
} from "./workflow-runtime.js";
import {
  formatWorkflowBudgetPrelude,
  formatWorkflowBudgetRaise,
  resolveWorkflowBudget,
  type WorkflowBudget,
} from "./workflow-budget.js";
import {
  assertWorkflowInput,
  createWorkflowRuntime,
  createWorkflowSharedExecutionState,
  snapshotWorkflowItems,
  workflowGroupFailureEnvelope,
  WORKFLOW_NO_OPERATOR_HEADLESS_PRELUDE,
  WORKFLOW_NO_OPERATOR_PRELUDE,
  type WorkflowSavedChildResult,
  type WorkflowSharedExecutionState,
} from "./workflow-runtime.js";
import type { AgentExecutor } from "../../_shared/agent-runtime/agent-runner.js";
import {
  createWorkflowAgentPreflight,
  createWorkflowAgentRunner,
  type WorkflowAgentBridgeOptions,
} from "./workflow-agent-bridge.js";
import {
  buildWorkflowFailureDiagnostic,
  type WorkflowFailureDiagnostic,
  type WorkflowFailureOrigin,
} from "./workflow-failure.js";
import {
  newWorkflowRunId,
  workflowJournalFile,
  workflowRunDir,
  createWorkflowJournalSink,
  readWorkflowRunResult,
  readWorkflowRunSummary,
  workflowPersistedResultInvalidity,
} from "./workflow-journal.js";
import type { WorkflowRunResultEnvelope, WorkflowRunSummary } from "./workflow-journal.js";
import {
  readWorkflowLaunchBinding,
  workflowLaunchBindingExists,
  workflowLaunchBindingMatchesResult,
  writeWorkflowLaunchBinding,
  type WorkflowLaunchBinding,
} from "./workflow-launch-binding.js";
import {
  isPostCodeReviewTargetProjection,
  isWorkflowSavedName,
  workflowTargetIdentityKey,
  type WorkflowTargetIdentity,
} from "./workflow-saved-name.js";
import {
  assertResolvedWorkflowTargetBinding,
  listPackagedWorkflowEntries,
  listWorkflowCatalogTargets,
  packagedExamplesDir,
  packagedWorkflowNames,
  packagedWorkflowPath,
  resolveOwnedWorkflowChild,
  resolveWorkflowTarget,
  WORKFLOW_ENTRY_SUFFIX,
  WorkflowNameNotFoundError,
  WorkflowGroupOnlyError,
  type PackagedWorkflowEntry,
  type ResolvedWorkflowTarget,
  type WorkflowTargetKind,
} from "./workflow-discovery.js";

export {
  listPackagedWorkflowEntries,
  listWorkflowCatalogTargets,
  packagedExamplesDir,
  packagedWorkflowNames,
  packagedWorkflowPath,
  resolveWorkflowTarget,
  WorkflowNameNotFoundError,
  WorkflowGroupOnlyError,
};
export type { PackagedWorkflowEntry, ResolvedWorkflowTarget, WorkflowTargetKind };
import {
  createWorkflowReplayController,
  readWorkflowReplayLog,
  type WorkflowReplayController,
  type WorkflowReplayEntry,
  type WorkflowReplayEnvelope,
  type WorkflowReplayNotRecordedReason,
  type WorkflowReplayRefusalReason,
} from "./workflow-replay.js";
import {
  prepareWorkflowResult,
  isWorkflowResultExplicitFailure,
  workflowDispositionForCompletion,
  workflowResultFile,
  workflowResultText,
  writeWorkflowResultJson,
  writeWorkflowResultText,
  type WorkflowDisposition,
  type WorkflowResultDiagnosticSentinel,
  type WorkflowResultPersistence,
} from "./workflow-result.js";
import {
  assessWorkflowReplaySafety,
  createWorkflowScriptSnapshot,
  sha256WorkflowBytes,
  verifyWorkflowScriptSnapshot,
  workflowScriptExecutionPath,
  type WorkflowReplaySafety,
  type WorkflowScriptIdentity,
} from "./workflow-script-identity.js";
import {
  acquireWorkflowRootLease,
  assertFreshWorkflowOutputNamespace,
  assertFreshWorkflowOutputNamespacePath,
  assertUniqueWorkflowItemKeys,
  assertWorkflowItemKey,
  assertWorkflowRootLease,
  commitWorkflowCompletedCheckpoint,
  ensureWorkflowWorkspaceFile,
  isWorkflowPathWithinRoot,
  readWorkflowCompletedCheckpoint,
  referenceWorkflowPrimaryFile,
  revalidateWorkflowPrimaryFile,
  releaseWorkflowRootLease,
  resolveWorkflowOutputDirectory,
  resolveWorkflowOutputDirectoryPath,
  resolveWorkflowOutputDirectoryForReuse,
  taskWorkspaceRelativePathForRunName,
  type WorkflowCheckpointIdentity,
  type WorkflowOutputDirectory,
  type WorkflowPrimaryFileReference,
  type WorkflowWorkspaceReuseBinding,
  type WorkflowRootLease,
} from "./workflow-output.js";
import {
  createWorkflowResourceLoader,
  type WorkflowResourceEvidence,
  type WorkflowResourceLoader,
} from "./workflow-resources.js";
import {
  createWorkflowWorkspaceManager,
  type WorkflowWorkspaceEvidence,
  type WorkflowWorkspaceManager,
} from "./workflow-worktree.js";
import {
  assertWorkflowContinuation,
  consumeWorkflowContinuation,
  continuationJournalProjection,
  createWorkflowArtifactStore,
  type WorkflowArtifactRef,
  type WorkflowArtifactStore,
  type WorkflowBoundContinuation,
  type WorkflowContinuation,
  type WorkflowContinuationJournal,
} from "./workflow-artifacts.js";
import {
  assertWorkflowRunId,
  isTaskWorkspaceName,
  readWorkflowRunTextFile,
  workflowLegacyRunMigrationMessage,
  workflowRunRuntimeDir,
} from "./workflow-run-layout.js";
import { verifyWorkflowPersistedSnapshot } from "./workflow-persisted-binding.js";
import { workflowReportDir, writeWorkflowRunReport } from "./workflow-run-report.js";
import {
  assertWorkflowHandoffClaimEligibility,
  assertWorkflowHandoffClaimForContinuation,
  bindWorkflowHandoffClaim,
  createWorkflowOperatorHandoffEnvelope,
  releaseWorkflowHandoffClaim,
  type WorkflowHandoffClaimLease,
  type WorkflowOperatorHandoffEnvelope,
} from "./workflow-handoff.js";

export type { WorkflowScriptIdentity } from "./workflow-script-identity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowScriptModule {
  default?: (dsl: WorkflowDsl, input?: string) => Promise<unknown> | unknown;
  runWorkflow?: (dsl: WorkflowDsl, input?: string) => Promise<unknown> | unknown;
  meta?: {
    name?: string;
    description?: string;
    identityCoverage?: "self-contained-static" | "entry-only";
  };
}

export interface WorkflowRunLineage {
  rootRunId: string;
  depth: 0 | 1;
  parentRunId?: string;
  parentItemKey?: string;
}

export interface WorkflowChildRunEvidence extends Omit<WorkflowSavedChildResult, "status"> {
  status: "running" | "completed" | "skipped" | "awaiting_operator" | "cancelled" | "failed";
  runDir?: string;
  childScriptSha256: string;
}

interface ExpectedWorkflowChildSource {
  canonicalPath: string;
  scriptSha256: string;
}

interface WorkflowRunnerCoordination {
  rootRunId: string;
  depth: 0 | 1;
  parentRunId?: string;
  parentItemKey?: string;
  sharedExecution: WorkflowSharedExecutionState;
  lease: WorkflowRootLease;
  output: WorkflowOutputDirectory;
  ancestry: readonly { sourcePath: string; scriptSha256: string }[];
  budget: WorkflowBudget;
  /** Run-level no-operator mode. Lives on coordination so a saved child can
   *  neither drop nor weaken it: one run, one guarantee. */
  noOperator?: true;
  expectedChildSource?: ExpectedWorkflowChildSource;
}

const RUN_COORDINATION = Symbol("workflow-run-coordination");

/** Validate a host-owned target binding before any snapshot or import. */
export function assertWorkflowTargetBinding(
  binding: unknown,
  request: { name?: string; scriptPath?: string; script?: string },
  projectRoot: string,
  workingDirectory = projectRoot,
): ResolvedWorkflowTarget {
  return assertResolvedWorkflowTargetBinding(binding, request, projectRoot, workingDirectory);
}

/** T-154 owner policy: only this workflow has a fresh-namespace requirement. */
export function isPostCodeReviewTarget(target: ResolvedWorkflowTarget, projectRoot?: string): boolean {
  return isPostCodeReviewTargetProjection(
    { kind: target.kind, ref: target.ref, source: target.source },
    { projectRoot, resolvedPath: target.path },
  );
}

function targetIdentityKey(target: ResolvedWorkflowTarget, projectRoot: string): string {
  return workflowTargetIdentityKey(
    { kind: target.kind, ref: target.ref, source: target.source },
    { projectRoot, resolvedPath: target.path },
  );
}

function persistedTargetIdentityKey(target: WorkflowTargetIdentity, projectRoot: string, sourcePath?: string): string {
  return workflowTargetIdentityKey(target, { projectRoot, resolvedPath: sourcePath });
}

export function postCodeReviewFreshLaunchError(): string {
  return (
    "post-code-review fresh launch requires an explicit project-relative outputDir, e.g. " +
    '"tmp/post-code-review/<review-id>"; resume the original run with its exact workspace instead'
  );
}

export interface RunWorkflowScriptOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  signal: AbortSignal;
  name?: string;
  scriptPath?: string;
  script?: string;
  /** Host-owned resolved target; prevents launch-time raw-reference re-resolution. */
  targetBinding?: ResolvedWorkflowTarget;
  /** Optional bounded human semantic request. */
  input?: string;
  /** Optional exact text work units, separate from semantic input. */
  items?: readonly string[];
  /** Optional project-relative workflow workspace. */
  outputDir?: string;
  /** Short Package task workspace name expanded under `.locus-pi/plans/`. */
  runName?: string;
  /** Closed host-owned cross-run artifact binding. */
  continuation?: WorkflowContinuation;
  /** Atomic source-handoff claim. The runner binds it to this run before
   * trusted workflow code starts; presentation callbacks are not authoritative. */
  operatorHandoffClaim?: WorkflowHandoffClaimLease;
  /** Host-owned exact source workspace proof for a validated handoff continuation. */
  operatorHandoffWorkspaceReuse?: WorkflowHandoffWorkspaceReuseBinding;
  resumeFromRunId?: string;
  /**
   * Per-run narrowing or raising of the package budget contract, axis by axis.
   * Unstated axes take `DEFAULT_WORKFLOW_BUDGET`. Narrowing is silent; a raise is
   * journalled, never quiet.
   *
   * Host-side by design (D3): neither production entrypoint passes it and a
   * `*.workflow.mjs` cannot reach it, so the three run-level axes — `concurrency`,
   * `totalAgents`, `runtimeMs` — are overridable by embedders and tests only. The
   * four per-call axes additionally have an author surface in `agent(prompt, opts)`.
   */
  budget?: Partial<WorkflowBudget>;
  /**
   * Run-level guarantee for unattended launches: while on, ANY request for
   * operator input — `dsl.awaitOperator()` or a stage's `agent({ ask: true })`
   * — fails closed with a named reason instead of parking the run or mounting
   * a question. No auto-answer exists; a fabricated operator input would be
   * worse than the refusal. Saved children inherit the mode through run
   * coordination and cannot unset it. The launch surfaces turn it on by
   * default for headless (`print`/`json`) hosts, where no operator can be
   * reached; embedders that call the runner directly opt in themselves.
   */
  noOperator?: true;
  createExecutor?: (o: {
    model?: unknown;
    live?: import("../../_shared/agent-runtime/agent-sdk-host.js").AgentSdkSessionExecutorOptions["live"];
    maxToolCalls?: number;
    turnTimeoutMs?: number;
    reportsDir?: string;
  }) => AgentExecutor; // pass-through to the bridge (tests)
  resolveModel?: import("../../_shared/model/workflow-model-resolve.js").WorkflowModelResolver; // pass-through to the bridge (tests)
  /** Called once after the run directory and first journal line exist. Presentation-only. */
  onRunStart?: (run: { runId: string; runDir: string }) => void;
  onEvent?: (line: WorkflowJournalLine) => void;
  [RUN_COORDINATION]?: WorkflowRunnerCoordination;
}

export interface RunWorkflowScriptResult {
  runId: string;
  runDir: string;
  ok: boolean;
  /** Runtime-owned terminal meaning. Optional only for legacy/test envelopes. */
  disposition?: WorkflowDisposition;
  result: unknown; // detached JSON value or explicit diagnostic sentinel
  resultDiagnostic?: WorkflowResultDiagnosticSentinel;
  resultPersistence: WorkflowResultPersistence;
  /** Path of the verbatim text copy of a prose result, when the run produced one. */
  resultTextPath?: string;
  /** Semantic named document whose newest revision equals the terminal prose. */
  primaryOutputPath?: string;
  /** Project-local workflow workspace, distinct from run evidence. */
  workspaceDir?: string;
  workspaceDirRelative?: string;
  /** Canonical physical workspace identity, project-relative and portable. */
  workspacePhysicalIdentity?: string;
  workspacePhysicalIdentitySchemaVersion?: 1;
  /** Whether the caller supplied outputDir instead of accepting the default. */
  workspaceDirExplicit?: boolean;
  /** Exact semantic input identity, persisted for the owner-specific resume contract. */
  semanticInputPresent?: boolean;
  semanticInputSha256?: string;
  /** @deprecated Use workspaceDir. */
  stableOutputDir?: string;
  /** @deprecated Use workspaceDirRelative. */
  stableOutputDirRelative?: string;
  primaryFile?: WorkflowPrimaryFileReference;
  lineage?: WorkflowRunLineage;
  childRuns?: WorkflowChildRunEvidence[];
  journal: WorkflowJournalLine[];
  error?: string;
  /** Who failed, when the run failed. Presentation-only; wording, not truth. */
  failureOrigin?: WorkflowFailureOrigin;
  /** Actionable projection of a failed run: stage, script, evidence, repair request. */
  failureDiagnostic?: WorkflowFailureDiagnostic;
  target?: ResolvedWorkflowTarget;
  scriptIdentity?: WorkflowScriptIdentity;
  resourceEvidence?: WorkflowResourceEvidence[];
  workspaceEvidence?: WorkflowWorkspaceEvidence[];
  /** Bounded reader-facing output refs (answers and workflow-published text),
   *  newest slice when a run produced more than the projection limit. */
  artifactRefs?: WorkflowArtifactRef[];
  artifactRefsOmitted?: number;
  resumeFromRunId?: string;
  resumeSourceRunSummary?: WorkflowRunSummary | null;
  continuation?: WorkflowContinuationJournal;
  operatorHandoff?: WorkflowOperatorHandoffEnvelope;
  /** What this run did about recorded-call replay. Absent only when the run
   *  failed before its script identity was established. */
  replay?: WorkflowReplayEnvelope;
}

interface SavedChildLifecycleOwner {
  recordSkipped(checkpoint: {
    childRunId: string;
    primaryFile?: WorkflowPrimaryFileReference;
  }): WorkflowSavedChildResult;
  recordStarted(run: { runId: string; runDir: string }): void;
  recordTerminal(
    child: RunWorkflowScriptResult,
    overrideStatus?: WorkflowChildRunEvidence["status"],
  ): WorkflowChildRunEvidence;
  recordThrownFailure(): void;
}

function savedChildResult(evidence: WorkflowChildRunEvidence): WorkflowSavedChildResult {
  if (evidence.status !== "completed" && evidence.status !== "skipped") {
    throw new Error(`saved child result cannot expose non-success status ${evidence.status}`);
  }
  return {
    status: evidence.status,
    key: evidence.key,
    outputDir: evidence.outputDir,
    ...(evidence.runId === undefined ? {} : { runId: evidence.runId }),
    ...(evidence.sourceRunId === undefined ? {} : { sourceRunId: evidence.sourceRunId }),
    ...(evidence.primaryFile === undefined ? {} : { primaryFile: evidence.primaryFile }),
  };
}

/** One parent-owned source of truth for saved-child evidence and navigation lines. */
function createSavedChildLifecycleOwner(input: {
  key: string;
  outputDir: string;
  childScriptSha256: string;
  childRuns: WorkflowChildRunEvidence[];
  record: (message: string) => void;
}): SavedChildLifecycleOwner {
  let evidenceIndex: number | undefined;
  let startedEvidence: WorkflowChildRunEvidence | undefined;

  return {
    recordSkipped(checkpoint) {
      const evidence: WorkflowChildRunEvidence = {
        status: "skipped",
        key: input.key,
        outputDir: input.outputDir,
        sourceRunId: checkpoint.childRunId,
        childScriptSha256: input.childScriptSha256,
        ...(checkpoint.primaryFile === undefined ? {} : { primaryFile: checkpoint.primaryFile }),
      };
      input.childRuns.push(evidence);
      input.record(
        `[workflow:child-skip] key=${JSON.stringify(input.key)} sourceRunId=${checkpoint.childRunId} ` +
          `childScriptSha256=${input.childScriptSha256}`,
      );
      return savedChildResult(evidence);
    },

    recordStarted(run) {
      const evidence: WorkflowChildRunEvidence = {
        status: "running",
        key: input.key,
        outputDir: input.outputDir,
        runId: run.runId,
        runDir: run.runDir,
        childScriptSha256: input.childScriptSha256,
      };
      startedEvidence = evidence;
      evidenceIndex = input.childRuns.push(evidence) - 1;
      input.record(
        `[workflow:child-start] key=${JSON.stringify(input.key)} runId=${run.runId} ` +
          `childScriptSha256=${input.childScriptSha256}`,
      );
    },

    recordTerminal(child, overrideStatus) {
      const status = overrideStatus ?? child.disposition?.status ?? (child.ok ? "completed" : "failed");
      const evidence: WorkflowChildRunEvidence = {
        status,
        key: input.key,
        outputDir: input.outputDir,
        runId: child.runId,
        runDir: child.runDir,
        childScriptSha256: input.childScriptSha256,
        ...(child.primaryFile === undefined ? {} : { primaryFile: child.primaryFile }),
      };
      if (evidenceIndex === undefined) evidenceIndex = input.childRuns.push(evidence) - 1;
      else input.childRuns[evidenceIndex] = evidence;
      input.record(`[workflow:child-end] key=${JSON.stringify(input.key)} runId=${child.runId} status=${status}`);
      return evidence;
    },

    recordThrownFailure() {
      if (evidenceIndex === undefined || startedEvidence === undefined) return;
      const evidence: WorkflowChildRunEvidence = { ...startedEvidence, status: "failed" };
      input.childRuns[evidenceIndex] = evidence;
      input.record(`[workflow:child-end] key=${JSON.stringify(input.key)} runId=${evidence.runId} status=failed`);
    },
  };
}

interface SavedChildExecutionOwnerOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  signal: AbortSignal;
  projectRoot: string;
  workingDirectory: string;
  parentRunId: string;
  parentTarget: ResolvedWorkflowTarget;
  parentScriptSha256: string;
  coordination: WorkflowRunnerCoordination;
  childRuns: WorkflowChildRunEvidence[];
  createExecutor?: RunWorkflowScriptOptions["createExecutor"];
  resolveModel?: RunWorkflowScriptOptions["resolveModel"];
  onEvent?: RunWorkflowScriptOptions["onEvent"];
  record: (message: string) => void;
}

interface ValidatedSavedChildInvocation {
  key: string;
  items: readonly string[];
}

interface ResolvedSavedChildSource {
  target: ResolvedWorkflowTarget;
  path: string;
  scriptSha256: string;
}

interface WorkflowResumeWorkspaceIdentity {
  relativePath: string;
  absolutePath: string;
  physicalPath: string;
  physicalIdentity: string;
  explicit: boolean;
}

interface WorkflowResumeSourceBinding {
  result: WorkflowRunResultEnvelope;
  owner: boolean;
  workspace: WorkflowResumeWorkspaceIdentity;
  launchBinding?: WorkflowLaunchBinding;
}

export interface WorkflowHandoffWorkspaceReuseBinding extends WorkflowWorkspaceReuseBinding {
  sourceRunId: string;
}

interface WorkflowSemanticInputIdentity {
  present: boolean;
  sha256: string;
}

function workflowSemanticInputIdentity(input: string | undefined): WorkflowSemanticInputIdentity {
  const text = typeof input === "string" ? input : "";
  return { present: input !== undefined, sha256: sha256WorkflowBytes(Buffer.from(text, "utf8")) };
}

function readWorkflowResumeSemanticInputIdentity(
  sourceResult: WorkflowRunResultEnvelope | null,
  runId: string,
): WorkflowSemanticInputIdentity {
  if (sourceResult?.runIdInvalid !== undefined || sourceResult?.runUnbound !== undefined) {
    throw new Error(`Cannot resume workflow: source run ${runId} is not bound to its persisted result envelope.`);
  }
  if (sourceResult?.scriptIdentityInvalid !== undefined) {
    throw new Error(
      `Cannot resume workflow: source run ${runId} has malformed script identity: ${sourceResult.scriptIdentityInvalid}.`,
    );
  }
  if (sourceResult?.semanticInputInvalid !== undefined) {
    throw new Error(
      `Cannot resume workflow: source run ${runId} has malformed semantic input identity: ${sourceResult.semanticInputInvalid}.`,
    );
  }
  if (
    typeof sourceResult?.semanticInputPresent !== "boolean" ||
    typeof sourceResult.semanticInputSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sourceResult.semanticInputSha256)
  ) {
    throw new Error(`Cannot resume workflow: source run ${runId} has no persisted semantic input identity.`);
  }
  return { present: sourceResult.semanticInputPresent, sha256: sourceResult.semanticInputSha256 };
}

/** Require the source run to carry the workspace identity that resume must reuse. */
export function readWorkflowResumeWorkspaceIdentity(
  projectRoot: string,
  runId: string,
): WorkflowResumeWorkspaceIdentity {
  const sourceResult = readWorkflowRunResult(projectRoot, runId);
  const bindingPresent = workflowLaunchBindingExists(projectRoot, runId);
  const binding = readWorkflowLaunchBinding(projectRoot, runId);
  if (bindingPresent) {
    if (binding === null || sourceResult === null || !workflowLaunchBindingMatchesResult(binding, sourceResult)) {
      throw new Error(`Cannot resume post-code-review workflow: source run ${runId} has no valid host launch binding.`);
    }
    return {
      relativePath: binding.workspace.relativePath,
      absolutePath: binding.workspace.absolutePath,
      physicalPath: binding.workspace.physicalPath,
      physicalIdentity: binding.workspace.physicalIdentity,
      explicit: binding.workspace.explicit,
    };
  }
  if (
    sourceResult !== null &&
    sourceResult.target !== undefined &&
    isPostCodeReviewTargetProjection(sourceResult.target, {
      projectRoot,
      resolvedPath: sourceResult.scriptIdentity?.sourcePath,
    })
  ) {
    throw new Error(`Cannot resume post-code-review workflow: source run ${runId} has no valid host launch binding.`);
  }
  return readWorkflowResumeWorkspaceIdentityFromResult(projectRoot, sourceResult, runId);
}

function readWorkflowResumeWorkspaceIdentityFromResult(
  projectRoot: string,
  sourceResult: WorkflowRunResultEnvelope | null,
  runId: string,
): WorkflowResumeWorkspaceIdentity {
  if (sourceResult?.runIdInvalid !== undefined || sourceResult?.runUnbound !== undefined) {
    throw new Error(`Cannot resume workflow: source run ${runId} is not bound to its persisted result envelope.`);
  }
  const relativePath = sourceResult?.workspaceDirRelative;
  const absolutePath = sourceResult?.workspaceDir;
  const physicalIdentity = sourceResult?.workspacePhysicalIdentity;
  const physicalIdentitySchemaVersion = sourceResult?.workspacePhysicalIdentitySchemaVersion;
  if (sourceResult?.workspaceDirExplicitInvalid !== undefined) {
    throw new Error(
      `Cannot resume workflow: source run ${runId} has malformed workspaceDirExplicit: ${sourceResult.workspaceDirExplicitInvalid}.`,
    );
  }
  const requiresPhysicalIdentity =
    sourceResult?.target !== undefined &&
    isPostCodeReviewTargetProjection(sourceResult.target, {
      projectRoot,
      resolvedPath: sourceResult.scriptIdentity?.sourcePath,
    });
  if (requiresPhysicalIdentity && sourceResult?.workspacePhysicalIdentityInvalid !== undefined) {
    throw new Error(
      `Cannot resume workflow: source workspace physical identity is malformed: ${sourceResult.workspacePhysicalIdentityInvalid}`,
    );
  }
  if (requiresPhysicalIdentity && physicalIdentitySchemaVersion !== 1) {
    throw new Error(
      `Cannot resume workflow: source workspace physical identity schema is missing or unsupported ` +
        `(recorded ${JSON.stringify(physicalIdentitySchemaVersion)}).`,
    );
  }
  if (typeof relativePath !== "string" || relativePath.trim() === "" || typeof absolutePath !== "string") {
    throw new Error(`Cannot resume workflow: source run ${runId} has no persisted workspace identity.`);
  }

  const lexicalRoot = path.resolve(projectRoot);
  const lexicalWorkspace = path.resolve(absolutePath);
  if (!isWorkflowPathWithinRoot(lexicalRoot, lexicalWorkspace)) {
    throw new Error(`Cannot resume workflow: source workspace escapes the project root: ${absolutePath}`);
  }

  let physicalRoot: string;
  let physicalWorkspace: string;
  try {
    physicalRoot = realpathSync(lexicalRoot);
    physicalWorkspace = realpathSync(lexicalWorkspace);
  } catch (error) {
    throw new Error(`Cannot resume workflow: source workspace identity is unavailable: ${String(error)}`);
  }
  if (!isWorkflowPathWithinRoot(physicalRoot, physicalWorkspace)) {
    throw new Error(`Cannot resume workflow: source workspace escapes the project root: ${absolutePath}`);
  }

  const physicalRelativePath = path.relative(physicalRoot, physicalWorkspace).split(path.sep).join("/");
  if (physicalRelativePath === "" || physicalRelativePath !== relativePath) {
    throw new Error(
      `Cannot resume workflow: source workspace identity is inconsistent ` +
        `(recorded ${JSON.stringify(relativePath)}, physical ${JSON.stringify(physicalRelativePath)}).`,
    );
  }
  if (requiresPhysicalIdentity && (typeof physicalIdentity !== "string" || physicalIdentity !== physicalRelativePath)) {
    throw new Error(
      `Cannot resume workflow: source workspace physical identity is missing or changed ` +
        `(recorded ${JSON.stringify(physicalIdentity)}, current ${JSON.stringify(physicalRelativePath)}).`,
    );
  }
  return {
    relativePath,
    absolutePath: lexicalWorkspace,
    physicalPath: physicalWorkspace,
    physicalIdentity: physicalIdentity ?? physicalRelativePath,
    explicit: sourceResult?.workspaceDirExplicit === true,
  };
}

function assertWorkflowHandoffWorkspaceReuse(
  projectRoot: string,
  binding: WorkflowHandoffWorkspaceReuseBinding,
  claim: WorkflowHandoffClaimLease,
  continuation: WorkflowContinuation,
  target: ResolvedWorkflowTarget,
): WorkflowOutputDirectory {
  if (binding.sourceRunId !== claim.sourceRunId || continuation.originRunId !== binding.sourceRunId) {
    throw new Error("Workflow handoff workspace reuse does not match the source run");
  }
  const source = readWorkflowRunResult(projectRoot, binding.sourceRunId);
  const sourceLaunchBindingPresent = workflowLaunchBindingExists(projectRoot, binding.sourceRunId);
  const sourceLaunchBinding = readWorkflowLaunchBinding(projectRoot, binding.sourceRunId);
  if (
    source === null ||
    source.runIdInvalid !== undefined ||
    source.runUnbound !== undefined ||
    source.targetInvalid !== undefined ||
    source.scriptIdentityInvalid !== undefined ||
    source.target === undefined
  ) {
    throw new Error("Workflow handoff source has no valid persisted target");
  }
  if (
    sourceLaunchBindingPresent &&
    (sourceLaunchBinding === null || !workflowLaunchBindingMatchesResult(sourceLaunchBinding, source))
  ) {
    throw new Error("Workflow handoff source has no valid host launch binding");
  }
  const sourceTarget = sourceLaunchBinding?.target ?? source.target;
  const sourceScriptPath = sourceLaunchBinding?.scriptIdentity.sourcePath ?? source.scriptIdentity?.sourcePath;
  if (
    persistedTargetIdentityKey(sourceTarget, projectRoot, sourceScriptPath) !== targetIdentityKey(target, projectRoot)
  ) {
    throw new Error("Workflow handoff source target does not match the continuation target");
  }
  const sourceWorkspace = readWorkflowResumeWorkspaceIdentity(projectRoot, binding.sourceRunId);
  if (
    sourceWorkspace.relativePath !== binding.relativePath ||
    sourceWorkspace.absolutePath !== binding.absolutePath ||
    sourceWorkspace.physicalPath !== binding.physicalPath ||
    sourceWorkspace.physicalIdentity !== binding.physicalIdentity ||
    sourceWorkspace.explicit !== binding.explicit
  ) {
    throw new Error("Workflow handoff source workspace identity changed");
  }
  return resolveWorkflowOutputDirectoryForReuse(projectRoot, binding, { create: false });
}

/** Owns validation, checkpoint reuse, and recursive execution for one root run. */
class SavedChildExecutionOwner {
  readonly invoke = async (
    input: import("./workflow-runtime.js").WorkflowSavedChildInvocation,
  ): Promise<WorkflowSavedChildResult> => {
    const validated = this.validateInvocation(input);
    const source = this.resolveSource(input);
    const checkpointIdentity = {
      parentScriptSha256: this.options.parentScriptSha256,
      childScriptSha256: source.scriptSha256,
      outputDir: this.options.coordination.output.identity,
      itemKey: validated.key,
    };
    const lifecycle = createSavedChildLifecycleOwner({
      key: validated.key,
      outputDir: this.options.coordination.output.relativePath,
      childScriptSha256: source.scriptSha256,
      childRuns: this.options.childRuns,
      record: this.options.record,
    });
    const skipped = this.reuseCheckpoint(checkpointIdentity, lifecycle, validated.key);
    if (skipped !== undefined) return skipped;
    const child = await this.runChild(input, validated, source, lifecycle);
    if ((child.disposition?.status ?? (child.ok ? "completed" : "failed")) === "completed") {
      try {
        this.verifySourceAfterRun(source, child);
      } catch (error) {
        lifecycle.recordTerminal(child, "failed");
        throw error;
      }
    }
    const evidence = lifecycle.recordTerminal(child);
    if (evidence.status !== "completed") {
      throw new Error(
        `saved child workflow ${JSON.stringify(source.target.ref)} ${evidence.status}: ${child.error ?? "no terminal detail"}`,
      );
    }
    commitWorkflowCompletedCheckpoint(this.options.coordination.lease, {
      ...checkpointIdentity,
      childRunId: child.runId,
      ...(child.primaryFile === undefined ? {} : { primaryFile: child.primaryFile }),
    });
    return savedChildResult(evidence);
  };

  private declaredKeys: readonly string[] | undefined;
  private readonly invokedKeys = new Set<string>();

  constructor(private readonly options: SavedChildExecutionOwnerOptions) {}

  private resolveSource(input: import("./workflow-runtime.js").WorkflowSavedChildInvocation): ResolvedSavedChildSource {
    const target: ResolvedWorkflowTarget =
      input.child !== undefined
        ? resolveOwnedWorkflowChild(
            this.options.parentTarget,
            input.child,
            this.options.projectRoot,
            this.options.workingDirectory,
          )
        : input.packageName === undefined
          ? resolveWorkflowTarget(
              {
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
              },
              this.options.projectRoot,
              this.options.workingDirectory,
            )
          : {
              kind: "name",
              ref: input.packageName,
              path: packagedWorkflowPath(input.packageName),
              source: "package",
            };
    const sourcePath = realpathSync(target.path);
    const scriptSha256 = sha256WorkflowBytes(readFileSync(sourcePath));
    if (
      this.options.coordination.ancestry.some(
        (ancestor) => ancestor.sourcePath === sourcePath || ancestor.scriptSha256 === scriptSha256,
      )
    ) {
      throw new Error(`saved workflow cycle detected for ${JSON.stringify(target.ref)}`);
    }
    return { target, path: sourcePath, scriptSha256 };
  }

  private reuseCheckpoint(
    identity: WorkflowCheckpointIdentity,
    lifecycle: SavedChildLifecycleOwner,
    key: string,
  ): WorkflowSavedChildResult | undefined {
    const checkpoint = readWorkflowCompletedCheckpoint(this.options.coordination.lease, identity);
    if (checkpoint === undefined) return undefined;
    let primaryFile = checkpoint.primaryFile;
    if (primaryFile !== undefined) {
      try {
        primaryFile = revalidateWorkflowPrimaryFile(this.options.coordination.output, primaryFile);
      } catch (error) {
        this.options.record(
          `[workflow:checkpoint-stale] key=${JSON.stringify(key)} reason=${JSON.stringify(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
        return undefined;
      }
    }
    assertWorkflowRootLease(this.options.coordination.lease);
    return lifecycle.recordSkipped({
      ...checkpoint,
      ...(primaryFile === undefined ? {} : { primaryFile }),
    });
  }

  private async runChild(
    input: import("./workflow-runtime.js").WorkflowSavedChildInvocation,
    validated: ValidatedSavedChildInvocation,
    source: ResolvedSavedChildSource,
    lifecycle: SavedChildLifecycleOwner,
  ): Promise<RunWorkflowScriptResult> {
    const childCoordination: WorkflowRunnerCoordination = {
      rootRunId: this.options.coordination.rootRunId,
      depth: 1,
      parentRunId: this.options.parentRunId,
      parentItemKey: validated.key,
      sharedExecution: this.options.coordination.sharedExecution,
      lease: this.options.coordination.lease,
      output: this.options.coordination.output,
      ancestry: [...this.options.coordination.ancestry, { sourcePath: source.path, scriptSha256: source.scriptSha256 }],
      budget: this.options.coordination.budget,
      ...(this.options.coordination.noOperator === undefined
        ? {}
        : { noOperator: this.options.coordination.noOperator }),
      expectedChildSource: { canonicalPath: source.path, scriptSha256: source.scriptSha256 },
    };
    try {
      return await runWorkflowScript({
        pi: this.options.pi,
        ctx: this.options.ctx,
        signal: this.options.signal,
        ...(source.target.kind === "name" ? { name: source.target.ref } : { scriptPath: source.target.ref }),
        // packageName is the legacy exact-Package selector. Let the child
        // source snapshot reject a newly introduced project shadow with the
        // established source-change error instead of rebinding it.
        ...(input.packageName === undefined ? { targetBinding: source.target } : {}),
        ...(input.input === undefined ? {} : { input: input.input }),
        items: validated.items,
        outputDir: this.options.coordination.output.relativePath,
        ...(this.options.createExecutor === undefined ? {} : { createExecutor: this.options.createExecutor }),
        ...(this.options.resolveModel === undefined ? {} : { resolveModel: this.options.resolveModel }),
        ...(this.options.onEvent === undefined ? {} : { onEvent: this.options.onEvent }),
        onRunStart: lifecycle.recordStarted,
        [RUN_COORDINATION]: childCoordination,
      });
    } catch (error) {
      lifecycle.recordThrownFailure();
      throw error;
    }
  }

  private verifySourceAfterRun(source: ResolvedSavedChildSource, child: RunWorkflowScriptResult): void {
    const sourcePath = realpathSync(source.target.path);
    const scriptSha256 = sha256WorkflowBytes(readFileSync(sourcePath));
    if (
      child.scriptIdentity?.scriptSha256 !== source.scriptSha256 ||
      sourcePath !== source.path ||
      scriptSha256 !== source.scriptSha256
    ) {
      throw new Error(`saved child workflow source changed during execution: ${JSON.stringify(source.target.ref)}`);
    }
  }

  private validateInvocation(
    input: import("./workflow-runtime.js").WorkflowSavedChildInvocation,
  ): ValidatedSavedChildInvocation {
    if (this.options.coordination.depth >= 1) {
      throw new Error("saved child workflows may not invoke another saved workflow");
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("invokeWorkflow requires one closed invocation object");
    }
    const allowed = new Set([
      "child",
      "name",
      "scriptPath",
      "packageName",
      "input",
      "items",
      "key",
      "keys",
      "outputDir",
    ]);
    const unknown = Object.keys(input).find((key) => !allowed.has(key));
    if (unknown !== undefined) throw new Error(`invokeWorkflow has no field ${JSON.stringify(unknown)}`);
    const targetCount = [input.child, input.name, input.scriptPath, input.packageName].filter(
      (value) => value !== undefined,
    ).length;
    if (targetCount !== 1) {
      throw new Error("invokeWorkflow requires exactly one of child, name, scriptPath, or packageName");
    }
    assertWorkflowInput(input.input, "saved child input");
    const items = snapshotWorkflowItems(input.items);
    if (!Array.isArray(input.keys)) throw new Error("invokeWorkflow keys must be an array");
    const keys = assertUniqueWorkflowItemKeys(input.keys);
    if (this.declaredKeys === undefined) this.declaredKeys = keys;
    else if (JSON.stringify(keys) !== JSON.stringify(this.declaredKeys)) {
      throw new Error("invokeWorkflow keys must remain the same complete list for one parent run");
    }
    const key = assertWorkflowItemKey(input.key);
    if (!keys.includes(key)) throw new Error(`invokeWorkflow key is not present in keys: ${JSON.stringify(key)}`);
    if (this.invokedKeys.has(key)) {
      throw new Error(`invokeWorkflow key was already used in this parent run: ${JSON.stringify(key)}`);
    }
    if (input.outputDir !== this.options.coordination.output.relativePath) {
      throw new Error(
        `invokeWorkflow outputDir must equal ${JSON.stringify(this.options.coordination.output.relativePath)}`,
      );
    }
    this.invokedKeys.add(key);
    return { key, items };
  }
}

const MAX_PROJECTED_WORKFLOW_ARTIFACT_REFS = 20;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function resolveExampleScriptPath(scriptRef: string, projectRoot: string): string {
  return resolveWorkflowTarget(
    isWorkflowSavedName(scriptRef) ? { name: scriptRef } : { scriptPath: scriptRef },
    projectRoot,
    projectRoot,
  ).path;
}

function workflowDefaultOutputName(target: ResolvedWorkflowTarget): string {
  return target.kind === "name" ? target.ref : path.basename(target.path, WORKFLOW_ENTRY_SUFFIX);
}

// ---------------------------------------------------------------------------
// Script loader
// ---------------------------------------------------------------------------

// TODO(trust-model): load workflow scripts in a node:vm/worker isolate with an import
// allow-list before executing untrusted author scripts. Currently scripts run in
// the host Node process with full module access — author scripts are trusted input.
export async function loadWorkflowScript(
  scriptPath: string,
  expectedSha256?: string,
  executionSource: "snapshot" | "source" = "source",
  cacheScope?: string,
): Promise<WorkflowScriptModule> {
  const scriptBytes = readFileSync(scriptPath);
  const actualSha256 = sha256WorkflowBytes(scriptBytes);
  if (expectedSha256 !== undefined && actualSha256 !== expectedSha256) {
    const subject = executionSource === "snapshot" ? "snapshot" : "source";
    throw new Error(`Workflow script ${subject} hash mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  const scriptUrl = pathToFileURL(scriptPath);
  scriptUrl.searchParams.set("sha256", actualSha256);
  if (cacheScope !== undefined) scriptUrl.searchParams.set("run", cacheScope);
  // Pi loads extension TypeScript through Jiti, which can rewrite a lexical
  // import() and reuse the original path despite a different URL query. Creating
  // the native importer at runtime keeps Node's full content-addressed URL as the
  // module cache key.
  const mod = await importWorkflowModule(scriptUrl.href);
  if (expectedSha256 !== undefined) {
    const afterImportSha256 = sha256WorkflowBytes(readFileSync(scriptPath));
    if (afterImportSha256 !== expectedSha256) {
      const reason =
        executionSource === "snapshot"
          ? "Workflow script snapshot hash mismatch during module import"
          : "Workflow script changed during module import";
      throw new Error(`${reason}: expected ${expectedSha256}, got ${afterImportSha256}`);
    }
  }
  return mod;
}

async function importWorkflowModule(specifier: string): Promise<WorkflowScriptModule> {
  const importer = new Script("(value) => import(value)", {
    importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }).runInThisContext() as (value: string) => Promise<unknown>;
  return (await importer(specifier)) as WorkflowScriptModule;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runWorkflowScript(opts: RunWorkflowScriptOptions): Promise<RunWorkflowScriptResult> {
  const projectRoot = getProjectRoot(opts.ctx);
  const workingDirectory = getWorkingDirectory(opts.ctx);
  const runId = newWorkflowRunId();
  const runDir = workflowRunDir(projectRoot, runId);
  const runtimeDir = workflowRunRuntimeDir(runDir);
  const outputDir = workflowReportDir(projectRoot, runId);
  const inheritedCoordination = opts[RUN_COORDINATION];
  const journal = createWorkflowJournalSink(projectRoot, runId);
  let items: readonly string[];
  const resolvedBudget = inheritedCoordination?.budget === undefined ? resolveWorkflowBudget(opts.budget) : undefined;
  const budget = inheritedCoordination?.budget ?? resolvedBudget!.budget;
  const budgetRaises = resolvedBudget?.raises ?? [];
  const budgetPrelude: WorkflowJournalLine = {
    ts: new Date().toISOString(),
    runId,
    kind: "log",
    source: "runtime",
    message: formatWorkflowBudgetPrelude(budget),
  };
  // Inherited coordination is the only authority for children: a saved child
  // can neither drop nor introduce the mode, exactly like `budget`.
  const noOperator =
    inheritedCoordination !== undefined
      ? inheritedCoordination.noOperator
      : opts.noOperator === true
        ? true
        : undefined;
  const noOperatorPrelude: WorkflowJournalLine | undefined =
    noOperator === undefined
      ? undefined
      : {
          ts: new Date().toISOString(),
          runId,
          kind: "log",
          source: "runtime",
          // A headless launch turns the mode on by default, so its journal has
          // to say why input was refused to a reader who typed no flag.
          message: isOneShotHostMode(opts.ctx) ? WORKFLOW_NO_OPERATOR_HEADLESS_PRELUDE : WORKFLOW_NO_OPERATOR_PRELUDE,
        };
  journal.initialize(budgetPrelude);
  if (noOperatorPrelude !== undefined) journal.write(noOperatorPrelude);

  const requestedResumeFromRunId = opts.resumeFromRunId;
  let selectedOutputDir = opts.outputDir;
  const requestedSemanticInput = workflowSemanticInputIdentity(opts.input);
  let resumeFromRunId: string | undefined;
  let resumeSourceRunSummary: WorkflowRunSummary | null | undefined;
  let resumeSourceWorkspace: WorkflowResumeWorkspaceIdentity | undefined;
  let resumeSourceBinding: WorkflowResumeSourceBinding | undefined;
  let replayPlan: WorkflowReplayPlan | undefined;
  let replayController: WorkflowReplayController | undefined;
  let resourceLoader: WorkflowResourceLoader | undefined;
  let workspaceManager: WorkflowWorkspaceManager | undefined;
  let runtime: WorkflowRuntime | undefined;
  let artifactStore: WorkflowArtifactStore | undefined;
  let boundContinuation: WorkflowBoundContinuation | undefined;
  let continuationProjection: WorkflowContinuationJournal | undefined;
  let awaitOperatorDeclaration: WorkflowAwaitOperatorDeclaration | undefined;
  let handoffClaimBound = false;
  let stableOutput: WorkflowOutputDirectory | undefined = inheritedCoordination?.output;
  let handoffReuseOutput: WorkflowOutputDirectory | undefined;
  let rootLease: WorkflowRootLease | undefined = inheritedCoordination?.lease;
  let coordination: WorkflowRunnerCoordination | undefined = inheritedCoordination;
  let primaryFile: WorkflowPrimaryFileReference | undefined;
  // Result metadata can be projected by pre-resolution validation failures.
  // Keep this separate from the later definite target so those terminal paths
  // never read a lexical binding while it is still in its TDZ.
  let targetForMetadata: ResolvedWorkflowTarget | undefined;
  const childRuns: WorkflowChildRunEvidence[] = [];
  let leaseReleased = false;
  const hasResume = requestedResumeFromRunId !== undefined;
  const preludeLines: WorkflowJournalLine[] = [
    budgetPrelude,
    ...(noOperatorPrelude === undefined ? [] : [noOperatorPrelude]),
  ];
  const emitPrelude = (line: WorkflowJournalLine): void => {
    preludeLines.push(line);
    journal.write(line);
    opts.onEvent?.(line);
  };
  /**
   * Evidence without a live announcement: the durable journal, `result.json` and
   * the run report get the line; the progress surface does not.
   *
   * Used for facts that are true of EVERY run. Pushing those through `onEvent`
   * would turn a run that emitted nothing into an eventful one and make the no-UI
   * surface claim delivery for a workflow that never spoke — the same reason the
   * default replay plan is silent below.
   */
  const recordPrelude = (line: WorkflowJournalLine): void => {
    preludeLines.push(line);
    journal.write(line);
  };
  // The applied budget is initialized as the FIRST durable line before the live
  // start callback. A start announcement therefore always names an existing run
  // directory and journal, or initialization throws before any child can run.
  // A narrowing applies silently; a raise never does. The line names the axis, the
  // package default and what was asked for, so a raise is auditable from the run
  // evidence alone instead of living in whoever's memory chose it.
  for (const raise of budgetRaises) {
    emitPrelude({
      ts: new Date().toISOString(),
      runId,
      kind: "log",
      source: "runtime",
      message: formatWorkflowBudgetRaise(raise, "run"),
    });
  }
  const resultMetadata = (): Pick<
    RunWorkflowScriptResult,
    | "resumeFromRunId"
    | "resumeSourceRunSummary"
    | "continuation"
    | "target"
    | "workspaceDir"
    | "workspaceDirRelative"
    | "workspacePhysicalIdentity"
    | "workspacePhysicalIdentitySchemaVersion"
    | "workspaceDirExplicit"
    | "semanticInputPresent"
    | "semanticInputSha256"
    | "stableOutputDir"
    | "stableOutputDirRelative"
    | "primaryFile"
    | "lineage"
    | "childRuns"
  > => {
    const lineage: WorkflowRunLineage =
      inheritedCoordination === undefined
        ? { rootRunId: runId, depth: 0 }
        : {
            rootRunId: inheritedCoordination.rootRunId,
            depth: inheritedCoordination.depth,
            ...(inheritedCoordination.parentRunId === undefined
              ? {}
              : { parentRunId: inheritedCoordination.parentRunId }),
            ...(inheritedCoordination.parentItemKey === undefined
              ? {}
              : { parentItemKey: inheritedCoordination.parentItemKey }),
          };
    return {
      ...(resumeFromRunId !== undefined
        ? { resumeFromRunId, resumeSourceRunSummary: resumeSourceRunSummary ?? null }
        : {}),
      ...(continuationProjection !== undefined ? { continuation: continuationProjection } : {}),
      ...(stableOutput === undefined
        ? {}
        : {
            workspaceDir: stableOutput.absolutePath,
            workspaceDirRelative: stableOutput.relativePath,
            workspacePhysicalIdentity: stableOutput.identity,
            workspacePhysicalIdentitySchemaVersion: 1,
            // A handoff continuation carries a host-validated workspace binding.
            // Its explicit bit is authoritative even though the launcher does not
            // repeat the source outputDir as an ordinary option.
            workspaceDirExplicit:
              handoffReuseOutput === undefined
                ? resumeSourceWorkspace?.explicit === true || selectedOutputDir !== undefined
                : opts.operatorHandoffWorkspaceReuse?.explicit === true,
            ...(targetForMetadata !== undefined && isPostCodeReviewTarget(targetForMetadata, projectRoot)
              ? {
                  semanticInputPresent: requestedSemanticInput.present,
                  semanticInputSha256: requestedSemanticInput.sha256,
                }
              : {}),
            stableOutputDir: stableOutput.absolutePath,
            stableOutputDirRelative: stableOutput.relativePath,
          }),
      ...(primaryFile === undefined ? {} : { primaryFile }),
      lineage,
      ...(childRuns.length === 0 ? {} : { childRuns: [...childRuns] }),
    };
  };
  const currentJournal = (runtime?: { getJournal(): WorkflowJournalLine[] }): WorkflowJournalLine[] => [
    ...preludeLines,
    ...(runtime?.getJournal() ?? []),
  ];
  type RunResultFields = Omit<RunWorkflowScriptResult, "runId" | "runDir" | "resultPersistence">;
  const finishRun = (fields: RunResultFields): RunWorkflowScriptResult => {
    let primaryOutputPath: string | undefined;
    let enrichedFields: RunResultFields = {
      ...fields,
      ...(resourceLoader === undefined ? {} : { resourceEvidence: resourceLoader.evidence() }),
      ...(replayPlan === undefined ? {} : { replay: workflowReplayEnvelope(replayPlan, replayController) }),
    };
    if (inheritedCoordination === undefined && rootLease !== undefined) {
      try {
        assertWorkflowRootLease(rootLease);
      } catch (error) {
        leaseReleased = true;
        enrichedFields = {
          ...enrichedFields,
          ok: false,
          error: enrichedFields.error ?? (error instanceof Error ? error.message : String(error)),
        };
      }
    }
    if (workspaceManager !== undefined) {
      try {
        enrichedFields = { ...enrichedFields, workspaceEvidence: workspaceManager.evidence() };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        enrichedFields = {
          ...enrichedFields,
          ok: false,
          error: enrichedFields.error ?? message,
        };
      }
    }
    if (artifactStore !== undefined) {
      try {
        const outputRecords = artifactStore
          .list()
          .filter((record) => record.kind === "published" || record.kind === "primary");
        const artifactRefs = outputRecords.slice(-MAX_PROJECTED_WORKFLOW_ARTIFACT_REFS).map((record) => ({
          runId: record.runId,
          artifactId: record.artifactId,
          name: record.name,
          sha256: record.sha256,
        }));
        enrichedFields = {
          ...enrichedFields,
          ...(artifactRefs.length > 0 ? { artifactRefs } : {}),
          ...(outputRecords.length > artifactRefs.length
            ? { artifactRefsOmitted: outputRecords.length - artifactRefs.length }
            : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        enrichedFields = {
          ...enrichedFields,
          ok: false,
          error: enrichedFields.error ?? message,
        };
      }
    }
    if (awaitOperatorDeclaration?.operatorHandoff !== undefined && enrichedFields.ok) {
      try {
        if (enrichedFields.target === undefined || enrichedFields.scriptIdentity === undefined) {
          throw new Error("Workflow operator handoff requires persisted target and script identity.");
        }
        enrichedFields = {
          ...enrichedFields,
          operatorHandoff: createWorkflowOperatorHandoffEnvelope({
            declaration: awaitOperatorDeclaration.operatorHandoff,
            runId,
            target: enrichedFields.target,
            scriptIdentity: enrichedFields.scriptIdentity,
            terminalArtifactRefs: enrichedFields.artifactRefs ?? [],
          }),
        };
      } catch (error) {
        enrichedFields = {
          ...enrichedFields,
          ok: false,
          error: enrichedFields.error ?? (error instanceof Error ? error.message : String(error)),
        };
      }
    }
    const disposition = workflowDispositionForCompletion({
      ok: enrichedFields.ok,
      aborted: opts.signal.aborted,
      ...(opts.signal.aborted ? { abortReason: opts.signal.reason } : {}),
      ...(awaitOperatorDeclaration !== undefined ? { awaitOperatorReason: awaitOperatorDeclaration.reason } : {}),
    });
    if (disposition.status === "cancelled") {
      const cancellationMessage = `[workflow:cancelled] reason=${disposition.reason}`;
      const alreadyRecorded = enrichedFields.journal.some(
        (line) => line.kind === "log" && line.source === "runtime" && line.message === cancellationMessage,
      );
      if (!alreadyRecorded) {
        const cancellationLine: WorkflowJournalLine = {
          ts: new Date().toISOString(),
          runId,
          kind: "log",
          source: "runtime",
          message: cancellationMessage,
        };
        journal.write(cancellationLine);
        try {
          opts.onEvent?.(cancellationLine);
        } catch {
          // Presentation callbacks cannot change durable cancellation truth.
        }
        enrichedFields = { ...enrichedFields, journal: [...enrichedFields.journal, cancellationLine] };
      }
    }
    enrichedFields = {
      ...enrichedFields,
      ok: disposition.status === "completed" || disposition.status === "awaiting_operator",
      disposition,
    };
    if (opts.operatorHandoffClaim !== undefined && !handoffClaimBound) {
      try {
        releaseWorkflowHandoffClaim(opts.operatorHandoffClaim);
      } catch (error) {
        enrichedFields = {
          ...enrichedFields,
          ok: false,
          disposition: { status: "failed" },
          error: enrichedFields.error ?? `Workflow handoff claim release failed: ${String(error)}`,
        };
      }
    }
    // One choke point for actionable failure text: every terminal route above
    // funnels here, so the operator gets the same stage/script/evidence pointer
    // whether the trusted script threw or the runtime around it did.
    enrichedFields = withFailureDiagnostic(enrichedFields);
    // Human-visible terminal prose is mandatory. Persist it once before the
    // best-effort report so every later surface can point at one owned file.
    const terminalText = workflowResultText(enrichedFields.result);
    const resultTextPath = writeWorkflowResultText(runDir, enrichedFields.result);
    if (terminalText !== undefined && resultTextPath === undefined) {
      const message = `Workflow terminal output was not persisted under ${outputDir}.`;
      const outputFailure: WorkflowJournalLine = {
        ts: new Date().toISOString(),
        runId,
        kind: "error",
        source: "runtime",
        message,
      };
      journal.write(outputFailure);
      enrichedFields = withFailureDiagnostic({
        ...enrichedFields,
        ok: false,
        disposition: { status: "failed" },
        error: enrichedFields.error ?? message,
        journal: [...enrichedFields.journal, outputFailure],
      });
    }
    // No workflow-workspace mutation follows this point. Release before writing the
    // run report/result envelope so a release failure becomes terminal evidence
    // instead of escaping after a persisted success.
    if (inheritedCoordination === undefined && rootLease !== undefined && !leaseReleased) {
      try {
        releaseWorkflowRootLease(rootLease);
        leaseReleased = true;
      } catch (error) {
        const message = `Workflow workspace lease release failed: ${error instanceof Error ? error.message : String(error)}`;
        const leaseFailure: WorkflowJournalLine = {
          ts: new Date().toISOString(),
          runId,
          kind: "error",
          source: "runtime",
          message,
        };
        journal.write(leaseFailure);
        leaseReleased = true;
        enrichedFields = withFailureDiagnostic({
          ...enrichedFields,
          ok: false,
          disposition: { status: "failed" },
          error: enrichedFields.error ?? message,
          journal: [...enrichedFields.journal, leaseFailure],
        });
      }
    }
    // The run's human outputs under <runDir>/outputs/: table of contents, task,
    // result, budget-versus-spend, and workflow-published documents under their
    // semantic names. Agent call answers remain evidence under runtime/ unless
    // the workflow explicitly publishes one. Files agents wrote themselves stay
    // under their own names in the separate project-local workflow workspace.
    // The envelope below stays the durable truth, and a report failure never fails
    // the run. It runs BEFORE result.json so a failed write can still be recorded
    // in the journal that result.json persists.
    if (artifactStore !== undefined) {
      const reportOutcome = writeWorkflowRunReport(
        {
          projectRoot,
          runId,
          ...(enrichedFields.workspaceDir === undefined ? {} : { workspaceDir: enrichedFields.workspaceDir }),
          status: enrichedFields.disposition?.status ?? (enrichedFields.ok ? "completed" : "failed"),
          ...(enrichedFields.target === undefined
            ? {}
            : {
                target: {
                  kind: enrichedFields.target.kind,
                  ref: enrichedFields.target.ref,
                  source: enrichedFields.target.source,
                },
              }),
          result: enrichedFields.result,
          ...(enrichedFields.error === undefined ? {} : { error: enrichedFields.error }),
          journal: enrichedFields.journal,
          budget: { applied: budget, peakConcurrency: runtime?.peakAgentConcurrency() ?? 0 },
        },
        artifactStore,
      );
      if (reportOutcome.ok) primaryOutputPath = reportOutcome.primaryOutputPath;
      if (!reportOutcome.ok) {
        // The run disposition is deliberately unchanged — reversing that is the
        // evidence contract's call, not this one's. What changes is the silence:
        // without this line the budget evidence could simply not exist and
        // nothing would say so, which `evidence-over-claim` cannot live with.
        const reportFailure: WorkflowJournalLine = {
          ts: new Date().toISOString(),
          runId,
          kind: "error",
          source: "runtime",
          message: `Workflow run report was not written to ${workflowReportDir(projectRoot, runId)}: ${reportOutcome.message}`,
        };
        journal.write(reportFailure);
        try {
          opts.onEvent?.(reportFailure);
        } catch {
          // A presentation callback cannot change what the durable journal records.
        }
        enrichedFields = { ...enrichedFields, journal: [...enrichedFields.journal, reportFailure] };
      }
    }
    const intendedPersistence: WorkflowResultPersistence = { ok: true, path: workflowResultFile(runDir) };
    const resultPersistence = writeWorkflowResultJson(runDir, {
      runId,
      ...enrichedFields,
      resultPersistence: intendedPersistence,
    });
    if (resultPersistence.ok) {
      return {
        runId,
        runDir,
        ...enrichedFields,
        resultPersistence,
        ...(resultTextPath === undefined ? {} : { resultTextPath }),
        ...(primaryOutputPath === undefined ? {} : { primaryOutputPath }),
      };
    }

    const persistenceError: WorkflowJournalLine = {
      ts: new Date().toISOString(),
      runId,
      kind: "error",
      source: "runtime",
      message: resultPersistence.message,
    };
    journal.write(persistenceError);
    try {
      opts.onEvent?.(persistenceError);
    } catch {
      // Presentation callbacks cannot recover durable evidence and must not hide
      // the typed persistence failure returned below.
    }
    const failedFields: RunResultFields = withFailureDiagnostic({
      ...enrichedFields,
      ok: false,
      disposition: workflowDispositionForCompletion({
        ok: false,
        aborted: opts.signal.aborted,
        ...(opts.signal.aborted ? { abortReason: opts.signal.reason } : {}),
      }),
      error: enrichedFields.error ?? resultPersistence.message,
      journal: [...enrichedFields.journal, persistenceError],
    });
    // result.json is the durable machine envelope, but its own write can fail.
    // Re-project the human README from the now-failed fields so the readable
    // surface cannot keep claiming success after that failure.
    if (artifactStore !== undefined) {
      const failedReport = writeWorkflowRunReport(
        {
          projectRoot,
          runId,
          ...(failedFields.workspaceDir === undefined ? {} : { workspaceDir: failedFields.workspaceDir }),
          status: failedFields.disposition?.status ?? "failed",
          ...(failedFields.target === undefined
            ? {}
            : {
                target: {
                  kind: failedFields.target.kind,
                  ref: failedFields.target.ref,
                  source: failedFields.target.source,
                },
              }),
          result: failedFields.result,
          ...(failedFields.error === undefined ? {} : { error: failedFields.error }),
          journal: failedFields.journal,
          budget: { applied: budget, peakConcurrency: runtime?.peakAgentConcurrency() ?? 0 },
        },
        artifactStore,
      );
      if (failedReport.ok) primaryOutputPath = failedReport.primaryOutputPath;
    }
    const failed = {
      runId,
      runDir,
      ...failedFields,
      resultPersistence,
      ...(resultTextPath === undefined ? {} : { resultTextPath }),
      ...(primaryOutputPath === undefined ? {} : { primaryOutputPath }),
    };
    return failed;
  };

  /** Attach the actionable diagnostic to a failed envelope; other outcomes pass through. */
  function withFailureDiagnostic(fields: RunResultFields): RunResultFields {
    // A script that deliberately returns `{ ok: false }` reported a domain
    // verdict, not a defect: it already owns its own summary and needs no repair
    // request. Only a thrown/transport failure earns a diagnostic.
    if (fields.disposition?.status !== "failed" || fields.error === undefined) return fields;
    let artifacts: readonly { kind: string; stage?: string; relativePath: string }[] = [];
    try {
      artifacts = artifactStore?.list() ?? [];
    } catch {
      // An unreadable artifact index costs the evidence pointer, never the verdict.
    }
    return {
      ...fields,
      failureDiagnostic: buildWorkflowFailureDiagnostic({
        projectRoot,
        runDir,
        journalPath: workflowJournalFile(runDir),
        journal: fields.journal,
        ...(fields.failureOrigin === undefined ? {} : { origin: fields.failureOrigin }),
        ...(fields.error === undefined ? {} : { error: fields.error }),
        ...(fields.target === undefined ? {} : { target: fields.target }),
        ...(fields.scriptIdentity === undefined ? {} : { scriptIdentity: fields.scriptIdentity }),
        artifacts,
      }),
    };
  }

  try {
    items = snapshotWorkflowItems(opts.items);
    try {
      opts.onRunStart?.({ runId, runDir });
    } catch {
      // Presentation callback failure must not turn successful workflow execution into a crash.
    }
    assertWorkflowInput(opts.input);
    if (opts.continuation !== undefined) assertWorkflowContinuation(opts.continuation);
    if (hasResume) resumeFromRunId = assertWorkflowRunId(requestedResumeFromRunId);
    if (hasResume && opts.continuation !== undefined) {
      throw new Error("Workflow continuation and resumeFromRunId are mutually exclusive.");
    }
    if (opts.operatorHandoffClaim !== undefined) {
      if (opts.continuation === undefined) {
        throw new Error("Workflow operator handoff claim requires a continuation.");
      }
      assertWorkflowHandoffClaimForContinuation(opts.operatorHandoffClaim, opts.continuation, projectRoot);
    }
    if (resumeFromRunId !== undefined) {
      const source = readWorkflowRunSummary(projectRoot, resumeFromRunId);
      if (source.status === "unknown") {
        resumeSourceRunSummary = null;
        const persistedSource = readWorkflowRunResult(projectRoot, resumeFromRunId);
        const invalidity = workflowPersistedResultInvalidity(persistedSource);
        const error =
          (invalidity === undefined
            ? undefined
            : `Cannot resume workflow: source run ${resumeFromRunId} has malformed persisted metadata (${invalidity}).`) ??
          workflowLegacyRunMigrationMessage(projectRoot, resumeFromRunId) ??
          `Cannot resume workflow: source run not found or unusable: ${resumeFromRunId}`;
        emitPrelude({
          ts: new Date().toISOString(),
          runId,
          kind: "error",
          message: error,
          resumeFromRunId,
          resumeSourceRunSummary: null,
        });
        const journalLines = currentJournal();
        return finishRun({ ok: false, result: undefined, journal: journalLines, error, ...resultMetadata() });
      }
      resumeSourceRunSummary = source;
      emitPrelude({
        ts: new Date().toISOString(),
        runId,
        kind: "log",
        source: "runtime",
        message: `resumeFromRunId=${resumeFromRunId} sourceStatus=${source.status}`,
        resumeFromRunId,
        resumeSourceRunSummary: source,
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emitPrelude({ ts: new Date().toISOString(), runId, kind: "error", source: "runtime", message: error });
    return finishRun({ ok: false, result: undefined, journal: currentJournal(), error, ...resultMetadata() });
  }

  let target: ResolvedWorkflowTarget;
  try {
    if (opts.targetBinding !== undefined) {
      target = assertWorkflowTargetBinding(
        opts.targetBinding,
        {
          ...(opts.name === undefined ? {} : { name: opts.name }),
          ...(opts.scriptPath === undefined ? {} : { scriptPath: opts.scriptPath }),
          ...(opts.script === undefined ? {} : { script: opts.script }),
        },
        projectRoot,
        workingDirectory,
      );
    } else {
      const targetInput: { name?: string; scriptPath?: string; script?: string } = {};
      if (opts.name !== undefined) targetInput.name = opts.name;
      if (opts.scriptPath !== undefined) targetInput.scriptPath = opts.scriptPath;
      if (opts.script !== undefined) targetInput.script = opts.script;
      target = resolveWorkflowTarget(targetInput, projectRoot, workingDirectory);
    }
    targetForMetadata = target;
    if (opts.runName !== undefined) {
      if (opts.outputDir !== undefined) {
        throw new Error("workflow runName and outputDir are mutually exclusive");
      }
      if (target.kind !== "name") {
        throw new Error("workflow runName requires a saved Package task workflow name");
      }
      selectedOutputDir = taskWorkspaceRelativePathForRunName(target.ref, opts.runName);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    return finishRun({ ok: false, result: undefined, journal: journalLines, error, ...resultMetadata() });
  }

  let scriptIdentity: WorkflowScriptIdentity;
  try {
    scriptIdentity = createWorkflowScriptSnapshot(target.path, runtimeDir);
    if (inheritedCoordination?.expectedChildSource !== undefined) {
      const actualCanonicalPath = realpathSync(target.path);
      const expected = inheritedCoordination.expectedChildSource;
      if (actualCanonicalPath !== expected.canonicalPath || scriptIdentity.scriptSha256 !== expected.scriptSha256) {
        throw new Error(
          `saved child workflow source changed before execution: ${JSON.stringify(target.ref)} ` +
            `(expected ${expected.canonicalPath}#${expected.scriptSha256}, ` +
            `got ${actualCanonicalPath}#${scriptIdentity.scriptSha256})`,
        );
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    return finishRun({ ok: false, result: undefined, journal: journalLines, error, target, ...resultMetadata() });
  }
  try {
    if (opts.operatorHandoffWorkspaceReuse !== undefined) {
      if (opts.operatorHandoffClaim === undefined || opts.continuation === undefined) {
        throw new Error("Workflow handoff workspace reuse requires a validated claim and continuation");
      }
      assertWorkflowHandoffClaimEligibility(opts.operatorHandoffClaim, { target, scriptIdentity });
      handoffReuseOutput = assertWorkflowHandoffWorkspaceReuse(
        projectRoot,
        opts.operatorHandoffWorkspaceReuse,
        opts.operatorHandoffClaim,
        opts.continuation,
        target,
      );
    }
    if (resumeFromRunId !== undefined) {
      let sourceResult = readWorkflowRunResult(projectRoot, resumeFromRunId);
      let sourceLaunchBinding: WorkflowLaunchBinding | undefined;
      const currentOwner = isPostCodeReviewTarget(target, projectRoot);
      const sourceLaunchBindingPresent = workflowLaunchBindingExists(projectRoot, resumeFromRunId);
      if (sourceLaunchBindingPresent) {
        if (sourceResult === null) {
          throw new Error(`Cannot resume workflow: source run ${resumeFromRunId} has no readable result.`);
        }
        sourceLaunchBinding = readWorkflowLaunchBinding(projectRoot, resumeFromRunId) ?? undefined;
        if (
          sourceLaunchBinding === undefined ||
          !workflowLaunchBindingMatchesResult(sourceLaunchBinding, sourceResult)
        ) {
          throw new Error(
            `Cannot resume post-code-review workflow: source run ${resumeFromRunId} has no valid host launch binding.`,
          );
        }
        const sourceOwner = isPostCodeReviewTargetProjection(sourceLaunchBinding.target, {
          projectRoot,
          resolvedPath: sourceLaunchBinding.scriptIdentity.sourcePath,
        });
        if (sourceOwner !== currentOwner) {
          throw new Error(
            `Cannot resume workflow: source/current post-code-review ownership differs ` +
              `(source=${sourceOwner}, current=${currentOwner}).`,
          );
        }
        sourceResult = {
          ...sourceResult,
          target: sourceLaunchBinding.target,
          scriptIdentity: sourceLaunchBinding.scriptIdentity,
          workspaceDir: sourceLaunchBinding.workspace.absolutePath,
          workspaceDirRelative: sourceLaunchBinding.workspace.relativePath,
          workspacePhysicalIdentity: sourceLaunchBinding.workspace.physicalIdentity,
          workspacePhysicalIdentitySchemaVersion: 1,
          workspaceDirExplicit: sourceLaunchBinding.workspace.explicit,
          semanticInputPresent: sourceLaunchBinding.semanticInput.present,
          semanticInputSha256: sourceLaunchBinding.semanticInput.sha256,
        };
      } else if (currentOwner) {
        if (sourceResult === null) {
          throw new Error(
            `Cannot resume post-code-review workflow: source run ${resumeFromRunId} has no readable result.`,
          );
        }
        throw new Error(
          `Cannot resume post-code-review workflow: source run ${resumeFromRunId} has no valid host launch binding.`,
        );
      }
      if (sourceResult?.runIdInvalid !== undefined || sourceResult?.runUnbound !== undefined) {
        throw new Error(
          `Cannot resume workflow: source run ${resumeFromRunId} is not bound to its persisted result envelope.`,
        );
      }
      if (sourceResult?.scriptIdentityInvalid !== undefined) {
        throw new Error(
          `Cannot resume workflow: source run ${resumeFromRunId} has malformed script identity: ${sourceResult.scriptIdentityInvalid}.`,
        );
      }
      if (sourceResult?.scriptIdentity?.executionSource === "snapshot") {
        try {
          verifyWorkflowPersistedSnapshot(projectRoot, resumeFromRunId, sourceResult.scriptIdentity);
        } catch (error) {
          throw new Error(
            `Cannot resume workflow: source run ${resumeFromRunId} has unusable retained snapshot: ${
              error instanceof Error ? error.message : String(error)
            }.`,
          );
        }
      }
      if (sourceResult === null) {
        if (isPostCodeReviewTarget(target, projectRoot)) {
          throw new Error(
            `Cannot resume post-code-review workflow: source run ${resumeFromRunId} has no readable result.`,
          );
        }
      } else if (sourceResult.targetInvalid !== undefined) {
        if (isPostCodeReviewTarget(target, projectRoot)) {
          throw new Error(
            `Cannot resume post-code-review workflow: source run ${resumeFromRunId} has malformed persisted target: ${sourceResult.targetInvalid}.`,
          );
        }
      } else if (sourceResult.target === undefined) {
        if (isPostCodeReviewTarget(target, projectRoot)) {
          throw new Error(
            `Cannot resume post-code-review workflow: source run ${resumeFromRunId} has no persisted target.`,
          );
        }
      } else {
        const sourceOwner = isPostCodeReviewTargetProjection(sourceResult.target, {
          projectRoot,
          resolvedPath: sourceResult.scriptIdentity?.sourcePath,
        });
        if (sourceOwner !== currentOwner) {
          throw new Error(
            `Cannot resume workflow: source/current post-code-review ownership differs ` +
              `(source=${sourceOwner}, current=${currentOwner}).`,
          );
        }
        if (
          (sourceOwner || currentOwner) &&
          persistedTargetIdentityKey(sourceResult.target, projectRoot, sourceResult.scriptIdentity?.sourcePath) !==
            targetIdentityKey(target, projectRoot)
        ) {
          throw new Error(
            `Cannot resume post-code-review workflow: persisted source target does not match current target ` +
              `${JSON.stringify({ kind: target.kind, ref: target.ref, source: target.source })}.`,
          );
        }
        resumeSourceBinding = {
          result: sourceResult,
          owner: sourceOwner,
          workspace: readWorkflowResumeWorkspaceIdentityFromResult(projectRoot, sourceResult, resumeFromRunId),
          ...(sourceLaunchBinding === undefined ? {} : { launchBinding: sourceLaunchBinding }),
        };
      }
      if (resumeSourceBinding === undefined) {
        if (sourceResult === null) {
          throw new Error(`Cannot resume workflow: source run ${resumeFromRunId} has no persisted workspace identity.`);
        }
        resumeSourceBinding = {
          result: sourceResult,
          owner: false,
          workspace: readWorkflowResumeWorkspaceIdentityFromResult(projectRoot, sourceResult, resumeFromRunId),
        };
      }
      resumeSourceWorkspace = resumeSourceBinding.workspace;
    }
    if (
      inheritedCoordination === undefined &&
      !hasResume &&
      handoffReuseOutput === undefined &&
      isPostCodeReviewTarget(target, projectRoot) &&
      selectedOutputDir === undefined
    ) {
      throw new Error(postCodeReviewFreshLaunchError());
    }
    if (
      resumeSourceWorkspace?.explicit === true &&
      selectedOutputDir === undefined &&
      !(target.kind === "name" && isTaskWorkspaceName(target.ref))
    ) {
      throw new Error(
        "Cannot resume workflow: the source workspace was selected explicitly; repeat it with outputDir.",
      );
    }
    const resumeSourceTargetMatches =
      resumeSourceBinding?.result.target !== undefined &&
      persistedTargetIdentityKey(
        resumeSourceBinding.result.target,
        projectRoot,
        resumeSourceBinding.result.scriptIdentity?.sourcePath,
      ) === targetIdentityKey(target, projectRoot);
    const resumeReuseOutput =
      resumeSourceWorkspace !== undefined && selectedOutputDir === undefined && resumeSourceTargetMatches
        ? resolveWorkflowOutputDirectoryForReuse(projectRoot, resumeSourceWorkspace, { create: false })
        : undefined;
    const candidateOutputPath =
      handoffReuseOutput ??
      resumeReuseOutput ??
      resolveWorkflowOutputDirectoryPath(
        projectRoot,
        selectedOutputDir,
        workflowDefaultOutputName(target),
        workingDirectory,
        { runId },
      );
    if (
      resumeSourceWorkspace !== undefined &&
      candidateOutputPath.relativePath !== resumeSourceWorkspace.relativePath
    ) {
      throw new Error(
        `Cannot resume workflow: outputDir must equal the source workspace ` +
          `${JSON.stringify(resumeSourceWorkspace.relativePath)} ` +
          `(got ${JSON.stringify(candidateOutputPath.relativePath)}).`,
      );
    }
    const freshOwnerLaunch =
      inheritedCoordination === undefined &&
      !hasResume &&
      handoffReuseOutput === undefined &&
      isPostCodeReviewTarget(target, projectRoot);
    if (freshOwnerLaunch) {
      assertFreshWorkflowOutputNamespacePath({ projectRoot, output: candidateOutputPath });
    }
    const resolvedOutput =
      handoffReuseOutput ??
      resumeReuseOutput ??
      resolveWorkflowOutputDirectory(
        projectRoot,
        selectedOutputDir,
        workflowDefaultOutputName(target),
        workingDirectory,
        {
          create: !hasResume,
          runId,
        },
      );
    if (freshOwnerLaunch) {
      assertFreshWorkflowOutputNamespace({ projectRoot, output: resolvedOutput });
    }
    if (
      inheritedCoordination !== undefined &&
      (resolvedOutput.identity !== inheritedCoordination.output.identity ||
        resolvedOutput.physicalPath !== inheritedCoordination.output.physicalPath)
    ) {
      throw new Error(
        `saved child outputDir must equal the root outputDir ${JSON.stringify(inheritedCoordination.output.relativePath)}`,
      );
    }
    if (resumeFromRunId !== undefined) {
      if (resumeSourceBinding === undefined) {
        throw new Error(`Cannot resume workflow: source run ${resumeFromRunId} has no validated binding.`);
      }
      if (resumeSourceBinding.owner) {
        const sourceInput =
          resumeSourceBinding.launchBinding?.semanticInput ??
          readWorkflowResumeSemanticInputIdentity(resumeSourceBinding.result, resumeFromRunId);
        if (
          sourceInput.present !== requestedSemanticInput.present ||
          sourceInput.sha256 !== requestedSemanticInput.sha256
        ) {
          throw new Error("Cannot resume post-code-review: semantic input differs from the source run.");
        }
      }
    }
    if (
      resumeSourceWorkspace !== undefined &&
      (resumeSourceWorkspace.relativePath !== resolvedOutput.relativePath ||
        resumeSourceWorkspace.physicalPath !== resolvedOutput.physicalPath ||
        resumeSourceWorkspace.physicalIdentity !== resolvedOutput.identity)
    ) {
      throw new Error(
        `Cannot resume workflow: outputDir must equal the source workspace ` +
          `${JSON.stringify(resumeSourceWorkspace.relativePath)} ` +
          `(got ${JSON.stringify(resolvedOutput.relativePath)}).`,
      );
    }
    stableOutput = inheritedCoordination?.output ?? resolvedOutput;
    if (inheritedCoordination === undefined && isPostCodeReviewTarget(target, projectRoot)) {
      ensureWorkflowWorkspaceFile(stableOutput, "style.md");
    }
    // Persist the independent owner binding before acquiring the lease or
    // starting any child work. The result envelope written at terminal time is
    // only a projection and cannot be the source of resume/handoff authority.
    if (inheritedCoordination === undefined && isPostCodeReviewTarget(target, projectRoot)) {
      const launchBinding: WorkflowLaunchBinding = {
        schema: "locus-pi.workflow-launch-binding.v1",
        runId,
        target: { kind: target.kind, ref: target.ref, source: target.source },
        scriptIdentity,
        workspace: {
          absolutePath: stableOutput.absolutePath,
          relativePath: stableOutput.relativePath,
          physicalPath: stableOutput.physicalPath,
          physicalIdentity: stableOutput.identity,
          physicalIdentitySchemaVersion: 1,
          explicit:
            handoffReuseOutput === undefined
              ? selectedOutputDir !== undefined
              : opts.operatorHandoffWorkspaceReuse?.explicit === true,
        },
        semanticInput: requestedSemanticInput,
      };
      try {
        writeWorkflowLaunchBinding(runDir, launchBinding);
      } catch (error) {
        const message = `Workflow launch binding was not persisted: ${error instanceof Error ? error.message : String(error)}`;
        return finishRun({
          ok: false,
          result: undefined,
          journal: currentJournal(runtime),
          error: message,
          target,
          scriptIdentity,
          ...resultMetadata(),
        });
      }
    }
    if (inheritedCoordination === undefined) {
      rootLease = acquireWorkflowRootLease({ projectRoot, output: stableOutput, rootRunId: runId });
      coordination = {
        rootRunId: runId,
        depth: 0,
        sharedExecution: createWorkflowSharedExecutionState({
          maxConcurrentAgents: budget.concurrency,
          maxTotalAgentInvocations: budget.totalAgents,
          runtimeMs: budget.runtimeMs,
        }),
        lease: rootLease,
        output: stableOutput,
        ancestry: [{ sourcePath: realpathSync(target.path), scriptSha256: scriptIdentity.scriptSha256 }],
        budget,
        ...(noOperator === undefined ? {} : { noOperator }),
      };
    }
    if (coordination === undefined) {
      throw new Error("workflow runner coordination was not initialized before runtime construction");
    }
    recordPrelude({
      ts: new Date().toISOString(),
      runId,
      kind: "log",
      source: "runtime",
      message:
        `[workflow:project-source] policy=live projectRoot=${JSON.stringify(projectRoot)} ` +
        `runBoundaryStartedAt=${JSON.stringify(budgetPrelude.ts)} outputDir=${JSON.stringify(stableOutput.relativePath)}`,
    });
    recordPrelude({
      ts: new Date().toISOString(),
      runId,
      kind: "log",
      source: "runtime",
      message:
        `[workflow:lineage] rootRunId=${coordination.rootRunId} depth=${coordination.depth}` +
        (coordination.parentRunId === undefined ? "" : ` parentRunId=${coordination.parentRunId}`) +
        (coordination.parentItemKey === undefined
          ? ""
          : ` parentItemKey=${JSON.stringify(coordination.parentItemKey)}`),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    return finishRun({
      ok: false,
      result: undefined,
      journal: journalLines,
      error,
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }
  const executionCoordination = coordination;
  if (opts.operatorHandoffClaim !== undefined) {
    try {
      assertWorkflowHandoffClaimEligibility(opts.operatorHandoffClaim, { target, scriptIdentity });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const journalLines = currentJournal(runtime);
      return finishRun({
        ok: false,
        result: undefined,
        journal: journalLines,
        error,
        target,
        scriptIdentity,
        ...resultMetadata(),
      });
    }
  }

  try {
    replayPlan = planWorkflowReplay({
      projectRoot,
      scriptIdentity,
      target,
      ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
      ...(resumeSourceBinding === undefined ? {} : { resumeSourceResult: resumeSourceBinding.result }),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emitPrelude({ ts: new Date().toISOString(), runId, kind: "error", source: "runtime", message: error });
    return finishRun({
      ok: false,
      result: undefined,
      journal: currentJournal(runtime),
      error,
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }
  if (replayPlan.record) {
    replayController = createWorkflowReplayController({
      runDir,
      ...(replayPlan.recorded === undefined ? {} : { recorded: replayPlan.recorded }),
    });
  }
  // Silent on the default path. A plain run that records normally is the norm,
  // and announcing it would turn every zero-event run into an eventful one; the
  // record itself and the `replay` envelope in result.json carry that fact.
  const replayPlanNote = describeWorkflowReplayPlan(replayPlan);
  if (replayPlanNote !== undefined) {
    emitPrelude({
      ts: new Date().toISOString(),
      runId,
      kind: "log",
      source: "runtime",
      message: replayPlanNote,
      ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
    });
  }

  resourceLoader = createWorkflowResourceLoader({
    workflowSourcePath: target.path,
    runDir: runtimeDir,
  });
  workspaceManager = createWorkflowWorkspaceManager({
    projectRoot,
    runId,
  });
  try {
    artifactStore = createWorkflowArtifactStore({ projectRoot, runId, runDir });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    return finishRun({
      ok: false,
      result: undefined,
      journal: journalLines,
      error,
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }
  if (opts.continuation !== undefined) {
    try {
      boundContinuation = consumeWorkflowContinuation(artifactStore, opts.continuation);
      continuationProjection = continuationJournalProjection(boundContinuation);
      emitPrelude({
        ts: new Date().toISOString(),
        runId,
        kind: "log",
        source: "runtime",
        message: "[workflow:continuation]",
        continuation: continuationProjection,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emitPrelude({ ts: new Date().toISOString(), runId, kind: "error", source: "runtime", message: error });
      return finishRun({
        ok: false,
        result: undefined,
        journal: currentJournal(runtime),
        error,
        target,
        scriptIdentity,
        ...resultMetadata(),
      });
    }
  }
  if (opts.operatorHandoffClaim !== undefined) {
    try {
      bindWorkflowHandoffClaim(opts.operatorHandoffClaim, runId);
      handoffClaimBound = true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emitPrelude({ ts: new Date().toISOString(), runId, kind: "error", source: "runtime", message: error });
      return finishRun({
        ok: false,
        result: undefined,
        journal: currentJournal(runtime),
        error,
        target,
        scriptIdentity,
        ...resultMetadata(),
      });
    }
  }
  const agentBridgeOptions: WorkflowAgentBridgeOptions = {
    pi: opts.pi,
    ctx: opts.ctx,
    signal: opts.signal,
    workflowRunId: runId,
    workspaceManager,
    evidenceDestinations: (callId) => artifactStore!.childEvidenceDestinations(callId),
    workflowWorkspaceDir: stableOutput!.absolutePath,
    ...(opts.input !== undefined ? { args: opts.input } : {}),
    ...(opts.createExecutor !== undefined ? { createExecutor: opts.createExecutor } : {}),
    ...(opts.resolveModel !== undefined ? { resolveModel: opts.resolveModel } : {}),
    ...(noOperator === undefined ? {} : { noOperator }),
  };
  const agentRunner = createWorkflowAgentRunner(agentBridgeOptions);
  const preflightAgentRequests = createWorkflowAgentPreflight(agentBridgeOptions);
  const savedChildren = new SavedChildExecutionOwner({
    pi: opts.pi,
    ctx: opts.ctx,
    signal: opts.signal,
    projectRoot,
    workingDirectory,
    parentRunId: runId,
    parentTarget: target,
    parentScriptSha256: scriptIdentity.scriptSha256,
    coordination: executionCoordination,
    childRuns,
    ...(opts.createExecutor === undefined ? {} : { createExecutor: opts.createExecutor }),
    ...(opts.resolveModel === undefined ? {} : { resolveModel: opts.resolveModel }),
    ...(opts.onEvent === undefined ? {} : { onEvent: opts.onEvent }),
    record: (message) => runtime!.recordRuntimeLog(message),
  });
  runtime = createWorkflowRuntime({
    runId,
    agentRunner,
    preflightAgentRequests,
    journal,
    projectRoot,
    outputDir: stableOutput!.relativePath,
    publishPrimaryFile: (relativePath) => {
      primaryFile = referenceWorkflowPrimaryFile(stableOutput!, relativePath);
      return primaryFile;
    },
    invokeWorkflow: savedChildren.invoke,
    sharedExecution: executionCoordination.sharedExecution,
    resourceLoader,
    workspaceManager,
    artifactPorts: artifactStore,
    ...(boundContinuation !== undefined ? { continuation: boundContinuation } : {}),
    ...(resumeFromRunId === undefined ? {} : { replaySourceRunId: resumeFromRunId }),
    ...(replayController !== undefined ? { replay: replayController } : {}),
    ...(opts.input !== undefined ? { args: opts.input } : {}),
    items,
    // The execution-tree axes live in sharedExecution above. Only per-call
    // defaults belong on each runtime instance.
    defaultTimeoutMs: budget.timeoutMs,
    defaultMaxToolCalls: budget.toolCalls,
    defaultMaxTurns: budget.turns,
    defaultMaxAnswerChars: budget.answerChars,
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
    ...(noOperator === undefined ? {} : { operatorInputForbidden: true }),
    onAwaitOperator: (declaration) => {
      if (awaitOperatorDeclaration !== undefined) {
        throw new Error("awaitOperator may be declared only once per workflow run");
      }
      awaitOperatorDeclaration = declaration;
    },
  });

  let mod: WorkflowScriptModule;
  try {
    // Strict sources execute the retained snapshot. Explicit entry-only sources
    // execute the hash-qualified source URL so relative imports/import.meta keep
    // their author-directory semantics while the weaker coverage stays visible.
    mod = await loadWorkflowScript(
      workflowScriptExecutionPath(scriptIdentity),
      scriptIdentity.scriptSha256,
      scriptIdentity.executionSource,
      runId,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    return finishRun({
      ok: false,
      result: undefined,
      journal: journalLines,
      error,
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }

  const entry =
    typeof mod.default === "function"
      ? mod.default
      : typeof mod.runWorkflow === "function"
        ? mod.runWorkflow
        : undefined;

  if (entry === undefined) {
    const error = "Workflow script has no default or runWorkflow export";
    const journalLines = currentJournal(runtime);
    return finishRun({
      ok: false,
      result: undefined,
      journal: journalLines,
      error,
      failureOrigin: "script",
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }

  let result: unknown;
  try {
    // runGuarded contains BOTH awaited throws (already covered) AND out-of-band
    // failures: a detached promise rejection or an uncaught exception thrown from
    // SDK/host machinery we never get a handle to (e.g. a dead-model auth error
    // firing on a detached emit path). Without this run-scoped net those would hit
    // Node's default handler and KILL the whole pi process — the Iskhod-1 defect.
    result = await runGuardedAgainstHostCrash(() => Promise.resolve(entry(runtime!.dsl, opts.input)));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    const groupFailure = workflowGroupFailureEnvelope(err);
    return finishRun({
      ok: false,
      result: groupFailure,
      journal: journalLines,
      error,
      // The trusted script itself rejected the run: the repair belongs in the
      // script or its prompts, not in the host.
      failureOrigin: "script",
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }

  const journalLines = currentJournal(runtime);
  const prepared = prepareWorkflowResult(result);
  const semanticOk = prepared.diagnostic === undefined && !isWorkflowResultExplicitFailure(prepared.value);
  try {
    // Result normalization can invoke script-defined toJSON(). Verify only after
    // that last script-owned callback, then enter the synchronous persistence
    // path without yielding. Read-only mode alone is not immutable to the owner.
    verifyWorkflowScriptSnapshot(scriptIdentity);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return finishRun({
      ok: false,
      result: undefined,
      journal: journalLines,
      error,
      target,
      scriptIdentity,
      ...resultMetadata(),
    });
  }
  return finishRun({
    ok: semanticOk,
    result: prepared.value,
    ...(prepared.diagnostic !== undefined
      ? {
          resultDiagnostic: prepared.diagnostic,
          error: prepared.diagnostic.message,
          failureOrigin: "script" as const,
        }
      : {}),
    journal: journalLines,
    target,
    scriptIdentity,
    ...resultMetadata(),
  });
}

// ---------------------------------------------------------------------------
// Replay gating (T-109)
// ---------------------------------------------------------------------------

interface WorkflowReplayPlan {
  /** Whether this run writes a record a later `--resume` can consume. */
  record: boolean;
  /** Recorded entries to replay from. Present only when replay is active. */
  recorded?: readonly WorkflowReplayEntry[];
  sourceRunId?: string;
  refusedReason?: WorkflowReplayRefusalReason;
  notRecordedReason?: WorkflowReplayNotRecordedReason;
}

interface PlanWorkflowReplayInput {
  projectRoot: string;
  scriptIdentity: WorkflowScriptIdentity;
  target: ResolvedWorkflowTarget;
  resumeFromRunId?: string;
  resumeSourceResult?: WorkflowRunResultEnvelope;
}

/**
 * Decide, once per run, whether recorded calls may be replayed and whether this
 * run may be recorded. Every path out of here is fail-closed: an unproven
 * script, an unreadable source run, or a moved script yields a NAMED refusal and
 * a completely fresh execution, never a partially trusted one.
 */
function planWorkflowReplay(input: PlanWorkflowReplayInput): WorkflowReplayPlan {
  const { projectRoot, scriptIdentity, target, resumeFromRunId } = input;
  // `entry-only` binds only the entry file's bytes, so an imported module can
  // move the call sequence without changing `scriptSha256`. Unproven by
  // construction — the AST never saw those bytes.
  const coverageProven = scriptIdentity.identityCoverage === "self-contained-static";
  const replaySafety = coverageProven ? readWorkflowReplaySafety(scriptIdentity) : "unproven";
  const notRecordedReason: WorkflowReplayNotRecordedReason | undefined = !coverageProven
    ? "identity-coverage-unproven"
    : replaySafety === "unproven"
      ? "replay-unsafe-script"
      : undefined;
  const record = notRecordedReason === undefined;

  if (resumeFromRunId === undefined)
    return { record, ...(notRecordedReason !== undefined ? { notRecordedReason } : {}) };

  const refuse = (refusedReason: WorkflowReplayRefusalReason): WorkflowReplayPlan => ({
    record,
    sourceRunId: resumeFromRunId,
    refusedReason,
    ...(notRecordedReason !== undefined ? { notRecordedReason } : {}),
  });

  const sourceResult = input.resumeSourceResult ?? readWorkflowRunResult(projectRoot, resumeFromRunId);
  const sourceSha256 = sourceResult?.scriptIdentity?.scriptSha256;
  if (
    sourceResult === null ||
    sourceResult.runIdInvalid !== undefined ||
    sourceResult.runUnbound !== undefined ||
    sourceResult.targetInvalid !== undefined ||
    sourceResult.scriptIdentityInvalid !== undefined ||
    sourceResult.target === undefined
  ) {
    return refuse("source-run-unusable");
  }
  if (
    persistedTargetIdentityKey(sourceResult.target, projectRoot, sourceResult.scriptIdentity?.sourcePath) !==
    targetIdentityKey(target, projectRoot)
  ) {
    return refuse("target-changed");
  }
  if (sourceSha256 === undefined) return refuse("source-run-unusable");
  if (sourceSha256 !== scriptIdentity.scriptSha256) return refuse("script-changed");
  if (!coverageProven) return refuse("identity-coverage-unproven");
  if (replaySafety === "unproven") return refuse("replay-unsafe-script");

  const recorded = readWorkflowReplayLog(projectRoot, resumeFromRunId);
  if (recorded.length === 0) return refuse("no-recorded-calls");
  return { record, recorded, sourceRunId: resumeFromRunId };
}

/** Static replay-safety of the exact bytes this run executes; unreadable reads as unproven. */
function readWorkflowReplaySafety(scriptIdentity: WorkflowScriptIdentity): WorkflowReplaySafety {
  try {
    return assessWorkflowReplaySafety(
      readWorkflowRunTextFile(path.dirname(scriptIdentity.snapshotPath), scriptIdentity.snapshotPath),
    ).replaySafety;
  } catch {
    return "unproven";
  }
}

function workflowReplayEnvelope(
  plan: WorkflowReplayPlan,
  controller: WorkflowReplayController | undefined,
): WorkflowReplayEnvelope {
  const counts = controller?.counts() ?? { replayedCalls: 0, freshCalls: 0 };
  return {
    replayed: counts.replayedCalls > 0,
    recorded: plan.record,
    ...(plan.sourceRunId !== undefined ? { sourceRunId: plan.sourceRunId } : {}),
    ...(plan.refusedReason !== undefined ? { refusedReason: plan.refusedReason } : {}),
    ...(plan.notRecordedReason !== undefined ? { notRecordedReason: plan.notRecordedReason } : {}),
    replayedCalls: counts.replayedCalls,
    freshCalls: counts.freshCalls,
    ...(counts.divergedAtCall !== undefined ? { divergedAtCall: counts.divergedAtCall } : {}),
  };
}

/**
 * One journal line for the cases an operator must not have to infer, and
 * `undefined` for the silent default (no resume asked for, recording on).
 */
function describeWorkflowReplayPlan(plan: WorkflowReplayPlan): string | undefined {
  if (plan.recorded !== undefined) {
    return `replay: active source=${plan.sourceRunId ?? "?"} recordedCalls=${plan.recorded.length}`;
  }
  if (plan.refusedReason !== undefined) {
    return `replay: refused source=${plan.sourceRunId ?? "?"} reason=${plan.refusedReason} — every call runs fresh`;
  }
  if (plan.notRecordedReason !== undefined) {
    return `replay: not recorded reason=${plan.notRecordedReason} — this run cannot be resumed`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run-scoped net for host-fatal async failures — REFCOUNTED across active runs.
 *
 * THE CRASH-FIX (Iskhod-1): the awaited try/catch at the call site already contains
 * synchronous throws and awaited rejections. What it CANNOT see is an error that
 * escapes on a detached path — an `unhandledRejection` from a promise we never
 * receive, or an `uncaughtException` thrown from SDK/host event machinery. Those
 * reach Node's default handler and terminate the whole `pi` process. Catching them
 * here and routing them to the active run's `ok:false` is the actual fix.
 *
 * THE REFCOUNT (robustness/simplification, NOT the crash-fix): one SHARED listener
 * pair is installed when the first run becomes active and removed when the last
 * active run finishes (via `activeRuns`). This replaces a per-run install/remove.
 * Note the per-run scheme was already crash-safe under overlap — it used a fresh
 * CLOSURE pair per run, so one run's `removeListener` only removed its own distinct
 * handler and never stripped another run's still-armed guard. The refcount's win is
 * one shared pair instead of N: simpler, no listener accumulation while runs overlap.
 *
 * DOCUMENTED LIMIT (accepted trade-off for the serial surface):
 *   While ANY run's window is open, an out-of-band failure that is genuinely
 *   unrelated to the workflow (some other host machinery's stray rejection) is
 *   still attributed to the active run(s) and surfaced as that run's `ok:false`.
 *   We cannot honestly attribute a detached failure to a specific run, so under
 *   overlap we fan it out to every active run. This can mask an unrelated bug as
 *   a workflow failure — chosen deliberately: keeping `pi` alive (fail-safe)
 *   outweighs not-masking on a surface that runs workflows serially.
 */
const activeRuns = new Set<(error: unknown) => void>();

const onHostUnhandledRejection = (reason: unknown): void => routeOutOfBandFailure(reason);
const onHostUncaughtException = (error: unknown): void => routeOutOfBandFailure(error);

function routeOutOfBandFailure(error: unknown): void {
  // No active run to attribute this to; let Node's default handler take it.
  // Serial case: exactly one sink → exact attribution. Overlap: fan out to all
  // (see DOCUMENTED LIMIT above). Snapshot first; sinks deregister on settle.
  for (const reject of [...activeRuns]) reject(error);
}

async function runGuardedAgainstHostCrash<T>(run: () => Promise<T>): Promise<T> {
  let sink!: (error: unknown) => void;
  const fatal = new Promise<never>((_resolve, reject) => {
    sink = (error: unknown) =>
      reject(error instanceof Error ? error : new Error(`workflow run failed out-of-band: ${String(error)}`));
  });

  activeRuns.add(sink);
  if (activeRuns.size === 1) {
    // First active run installs the one shared listener pair.
    process.on("unhandledRejection", onHostUnhandledRejection);
    process.on("uncaughtException", onHostUncaughtException);
  }
  try {
    // Whichever settles first wins: the real result, or an out-of-band failure
    // routed through `fatal`. Either way the host process survives.
    return await Promise.race([run(), fatal]);
  } finally {
    activeRuns.delete(sink);
    if (activeRuns.size === 0) {
      // Last active run removes the shared pair — no listener leak.
      process.removeListener("unhandledRejection", onHostUnhandledRejection);
      process.removeListener("uncaughtException", onHostUncaughtException);
    }
  }
}
