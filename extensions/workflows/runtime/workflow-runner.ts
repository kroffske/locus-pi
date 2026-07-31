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
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { constants as vmConstants, Script } from "node:vm";
import type { ExtensionAPI, ExtensionContext } from "../../_shared/host/pi-api.js";
import { getProjectRoot, getWorkingDirectory } from "../../_shared/host/pi-api.js";
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
import { assertWorkflowInput, createWorkflowRuntime, workflowGroupFailureEnvelope } from "./workflow-runtime.js";
import type { AgentExecutor } from "../../_shared/agent-runtime/agent-runner.js";
import { createWorkflowAgentRunner } from "./workflow-agent-bridge.js";
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
} from "./workflow-journal.js";
import type { WorkflowRunSummary } from "./workflow-journal.js";
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
import { ensureWorkflowRunWorkspaceDir } from "./workflow-run-layout.js";
import { workflowRunRuntimeDir } from "./workflow-run-layout.js";
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
  meta?: { name?: string; description?: string; identityCoverage?: "self-contained-static" | "entry-only" };
}

export type WorkflowTargetKind = "name" | "scriptPath";

export interface ResolvedWorkflowTarget {
  kind: WorkflowTargetKind;
  ref: string;
  path: string;
  source: "project" | "personal" | "package";
}

export class WorkflowNameNotFoundError extends Error {
  readonly workflowName: string;

  constructor(workflowName: string) {
    super(`Workflow name is not saved or registered by the package: ${workflowName}`);
    this.name = "WorkflowNameNotFoundError";
    this.workflowName = workflowName;
  }
}

export interface RunWorkflowScriptOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  signal: AbortSignal;
  name?: string;
  scriptPath?: string;
  script?: string;
  /** Optional bounded human semantic request. */
  input?: string;
  /** Closed host-owned cross-run artifact binding. */
  continuation?: WorkflowContinuation;
  /** Atomic source-handoff claim. The runner binds it to this run before
   * trusted workflow code starts; presentation callbacks are not authoritative. */
  operatorHandoffClaim?: WorkflowHandoffClaimLease;
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

const MAX_PROJECTED_WORKFLOW_ARTIFACT_REFS = 20;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const PACKAGED_EXAMPLES_DIR = fileURLToPath(new URL("../examples/", import.meta.url));

/** The one filename shape every saved and packaged workflow entry must have. */
const WORKFLOW_ENTRY_SUFFIX = ".workflow.mjs";

export interface PackagedWorkflowEntry {
  name: string;
  path: string;
}

/**
 * The Package registry is the shipped examples directory itself: every
 * `<name>.workflow.mjs` under it is a Package workflow, discovered by existence
 * on each call exactly like a project directory. There is no second allowlist to
 * keep in sync, so adding a workflow is adding a file — and removing one is
 * removing a file.
 *
 * Two bounds make that safe to say. Depth is one nested directory, which is how a
 * workflow that owns prompt resources or a diagram triple keeps them beside its
 * entry; anything deeper is support material, not another entry point. Only
 * `entry.isFile()` is accepted, so a symlink is never followed out of the
 * package. Both are properties of this scan, not of the filesystem it reads.
 *
 * What the *npm artifact* contains is still `package.json#files`, and a test
 * pins the two together: a workflow that lives here and is not packed would
 * resolve in a checkout and be missing after install, which is the one way this
 * simplification could lie to an operator.
 */
export function listPackagedWorkflowEntries(): PackagedWorkflowEntry[] {
  const found = new Map<string, string>();
  const visit = (directory: string, remainingDepth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (remainingDepth > 0) visit(full, remainingDepth - 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(WORKFLOW_ENTRY_SUFFIX)) continue;
      const name = entry.name.slice(0, -WORKFLOW_ENTRY_SUFFIX.length);
      if (name === "" || found.has(name)) continue;
      found.set(name, full);
    }
  };
  visit(PACKAGED_EXAMPLES_DIR, 1);
  // Ordered by entry filename so the catalog, the resolver, and every test see
  // one stable sequence regardless of directory iteration order.
  return [...found.entries()]
    .map(([name, entryPath]) => ({ name, path: entryPath }))
    .sort((left, right) => {
      const leftEntry = `${left.name}${WORKFLOW_ENTRY_SUFFIX}`;
      const rightEntry = `${right.name}${WORKFLOW_ENTRY_SUFFIX}`;
      return leftEntry < rightEntry ? -1 : leftEntry > rightEntry ? 1 : 0;
    });
}

/** Package workflow names currently present in the shipped examples directory. */
export function packagedWorkflowNames(): string[] {
  return listPackagedWorkflowEntries().map((entry) => entry.name);
}

/** Absolute path to this package's shipped workflow examples directory. */
export function packagedExamplesDir(): string {
  return PACKAGED_EXAMPLES_DIR;
}

/** Absolute path to one Package workflow entry module. */
export function packagedWorkflowPath(name: string): string {
  const entry = listPackagedWorkflowEntries().find((candidate) => candidate.name === name);
  if (entry === undefined) throw new WorkflowNameNotFoundError(name);
  return entry.path;
}

function hasPathSeparators(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveConfinedScriptPath(scriptPath: string, projectRoot: string, displayRef = scriptPath): string {
  const lexicalRoot = path.resolve(projectRoot);
  const resolved = path.resolve(lexicalRoot, scriptPath);
  if (!isPathWithinRoot(lexicalRoot, resolved)) {
    throw new Error(`Script path escapes project root: ${displayRef}`);
  }
  if (!existsSync(resolved)) return resolved;

  const physicalRoot = realpathSync(lexicalRoot);
  const physicalTarget = realpathSync(resolved);
  if (!isPathWithinRoot(physicalRoot, physicalTarget)) {
    throw new Error(`Script path escapes project root through a symlink: ${displayRef}`);
  }
  // Keep the public/execution path stable after proving its physical target is
  // confined. Returning the canonical path would silently rewrite sourcePath,
  // script identity, and macOS /var -> /private/var compatibility contracts.
  return resolved;
}

/**
 * Project-relative directories a saved workflow may live in, in first-wins order.
 *
 * `.pi/workflows/` is the canonical pi-native save target (where `workflow-author`
 * writes). The other two exist for repositories that already keep agent assets under
 * `.claude/` or `.agents/`; they are NOT foreign-format interop sources. Every entry
 * here accepts exactly `<name>.workflow.mjs` (see `resolveSavedWorkflowPath`), so a
 * host that writes `<name>.js` is never resolved, and a script authored against a
 * different workflow DSL would fail at execution regardless of its filename. All
 * three carry `source: "project"`.
 */
const PROJECT_WORKFLOW_DIRS: readonly [string, string][] = [
  [".pi", "workflows"],
  [".claude", "workflows"],
  [".agents", "workflows"],
];

function resolveSavedWorkflowPath(name: string, projectRoot: string, workingDirectory: string): ResolvedWorkflowTarget {
  for (const search of workflowSearchDirectories(projectRoot, workingDirectory)) {
    const candidate =
      search.source === "package"
        ? listPackagedWorkflowEntries().find((entry) => entry.name === name)?.path
        : path.join(search.directory, `${name}${WORKFLOW_ENTRY_SUFFIX}`);
    if (candidate !== undefined && existsSync(candidate)) {
      const targetPath =
        search.source === "project"
          ? resolveConfinedScriptPath(candidate, projectRoot, `${name}${WORKFLOW_ENTRY_SUFFIX}`)
          : candidate;
      return { kind: "name", ref: name, path: targetPath, source: search.source };
    }
  }
  throw new WorkflowNameNotFoundError(name);
}

interface WorkflowSearchDirectory {
  directory: string;
  source: ResolvedWorkflowTarget["source"];
}

/** One source-precedence owner shared by execution resolution and catalog listing. */
function workflowSearchDirectories(projectRoot: string, workingDirectory: string): WorkflowSearchDirectory[] {
  const directories: WorkflowSearchDirectory[] = [];
  const currentRoot = path.resolve(projectRoot);
  const requestedWorkingDirectory = path.resolve(workingDirectory);
  const workingRelative = path.relative(currentRoot, requestedWorkingDirectory);
  let current =
    workingRelative === "" || (!workingRelative.startsWith("..") && !path.isAbsolute(workingRelative))
      ? requestedWorkingDirectory
      : currentRoot;

  while (true) {
    for (const [first, second] of PROJECT_WORKFLOW_DIRS) {
      directories.push({ directory: path.join(current, first, second), source: "project" });
    }
    if (current === currentRoot) break;
    const parent = path.dirname(current);
    const parentRelative = path.relative(currentRoot, parent);
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) break;
    current = parent;
  }
  directories.push({ directory: path.join(homedir(), ".pi", "workflows"), source: "personal" });
  directories.push({ directory: PACKAGED_EXAMPLES_DIR, source: "package" });
  return directories;
}

export function resolveWorkflowTarget(
  target: { name?: string; scriptPath?: string; script?: string },
  projectRoot: string,
  workingDirectory?: string,
): ResolvedWorkflowTarget {
  const supplied = [target.name, target.scriptPath, target.script].filter((v) => v !== undefined);
  if (supplied.length !== 1) {
    throw new Error("Exactly one workflow target field is required: name, scriptPath, or script");
  }

  if (target.name !== undefined) {
    const name = target.name.trim();
    if (name === "" || hasPathSeparators(name) || name.endsWith(".mjs")) {
      throw new Error(`Invalid workflow name: ${target.name}`);
    }
    return resolveSavedWorkflowPath(name, projectRoot, workingDirectory ?? projectRoot);
  }

  const raw = target.scriptPath ?? target.script;
  if (raw === undefined) throw new Error("Missing workflow target");
  if (target.script !== undefined && !hasPathSeparators(raw) && !raw.endsWith(".mjs")) {
    return resolveSavedWorkflowPath(raw, projectRoot, workingDirectory ?? projectRoot);
  }

  const resolved = resolveConfinedScriptPath(raw, projectRoot);
  return { kind: "scriptPath", ref: raw, path: resolved, source: "project" };
}

/**
 * Enumerate the saved names that the existing resolver can launch, preserving
 * the same first-wins source precedence. Project and personal names are scanned;
 * Package names are filtered by the curated registry above.
 */
export function listWorkflowCatalogTargets(
  projectRoot: string,
  workingDirectory = projectRoot,
): ResolvedWorkflowTarget[] {
  const targets = new Map<string, ResolvedWorkflowTarget>();
  for (const search of workflowSearchDirectories(projectRoot, workingDirectory)) {
    if (search.source === "package") addPackagedCatalogTargets(targets);
    else addCatalogDirectory(targets, search.directory, search.source);
  }
  return [...targets.values()];
}

function addPackagedCatalogTargets(targets: Map<string, ResolvedWorkflowTarget>): void {
  for (const entry of listPackagedWorkflowEntries()) {
    if (targets.has(entry.name)) continue;
    targets.set(entry.name, { kind: "name", ref: entry.name, path: entry.path, source: "package" });
  }
}

function addCatalogDirectory(
  targets: Map<string, ResolvedWorkflowTarget>,
  directory: string,
  source: ResolvedWorkflowTarget["source"],
): void {
  let entries: string[];
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(WORKFLOW_ENTRY_SUFFIX))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.slice(0, -WORKFLOW_ENTRY_SUFFIX.length);
    if (name === "" || targets.has(name)) continue;
    targets.set(name, { kind: "name", ref: name, path: path.join(directory, entry), source });
  }
}

export function resolveExampleScriptPath(scriptRef: string, projectRoot: string): string {
  return resolveWorkflowTarget({ script: scriptRef }, projectRoot, projectRoot).path;
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
  const journal = createWorkflowJournalSink(projectRoot, runId);
  const { budget, raises: budgetRaises } = resolveWorkflowBudget(opts.budget);
  const budgetPrelude: WorkflowJournalLine = {
    ts: new Date().toISOString(),
    runId,
    kind: "log",
    source: "runtime",
    message: formatWorkflowBudgetPrelude(budget),
  };
  journal.initialize(budgetPrelude);
  try {
    opts.onRunStart?.({ runId, runDir });
  } catch {
    // Presentation callback failure must not turn successful workflow execution into a crash.
  }

  const resumeFromRunId = opts.resumeFromRunId?.trim();
  let resumeSourceRunSummary: WorkflowRunSummary | null | undefined;
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
  const hasResume = resumeFromRunId !== undefined && resumeFromRunId !== "";
  const preludeLines: WorkflowJournalLine[] = [budgetPrelude];
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
    "resumeFromRunId" | "resumeSourceRunSummary" | "continuation" | "target"
  > => {
    return {
      ...(hasResume
        ? { resumeFromRunId: resumeFromRunId!, resumeSourceRunSummary: resumeSourceRunSummary ?? null }
        : {}),
      ...(continuationProjection !== undefined ? { continuation: continuationProjection } : {}),
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
    // The run's human outputs under <runDir>/outputs/: table of contents, task,
    // result, budget-versus-spend, and workflow-published documents under their
    // semantic names. Agent call answers remain evidence under runtime/ unless
    // the workflow explicitly publishes one. Files agents wrote themselves stay
    // under their own names in <runDir>/workspace/. The envelope below stays the durable truth, and a report failure never fails
    // the run. It runs BEFORE result.json so a failed write can still be recorded
    // in the journal that result.json persists.
    if (artifactStore !== undefined) {
      const reportOutcome = writeWorkflowRunReport(
        {
          projectRoot,
          runId,
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
    return {
      runId,
      runDir,
      ...failedFields,
      resultPersistence,
      ...(resultTextPath === undefined ? {} : { resultTextPath }),
      ...(primaryOutputPath === undefined ? {} : { primaryOutputPath }),
    };
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
    assertWorkflowInput(opts.input);
    if (opts.continuation !== undefined) assertWorkflowContinuation(opts.continuation);
    if (hasResume && opts.continuation !== undefined) {
      throw new Error("Workflow continuation and resumeFromRunId are mutually exclusive.");
    }
    if (opts.operatorHandoffClaim !== undefined) {
      if (opts.continuation === undefined) {
        throw new Error("Workflow operator handoff claim requires a continuation.");
      }
      assertWorkflowHandoffClaimForContinuation(opts.operatorHandoffClaim, opts.continuation, projectRoot);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emitPrelude({ ts: new Date().toISOString(), runId, kind: "error", source: "runtime", message: error });
    return finishRun({ ok: false, result: undefined, journal: currentJournal(), error, ...resultMetadata() });
  }

  if (hasResume) {
    const sourceRunId = resumeFromRunId!;
    const source = readWorkflowRunSummary(projectRoot, sourceRunId);
    if (source.status === "unknown") {
      resumeSourceRunSummary = null;
      const error = `Cannot resume workflow: source run not found or unusable: ${sourceRunId}`;
      emitPrelude({
        ts: new Date().toISOString(),
        runId,
        kind: "error",
        message: error,
        resumeFromRunId: sourceRunId,
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
      message: `resumeFromRunId=${sourceRunId} sourceStatus=${source.status}`,
      resumeFromRunId: sourceRunId,
      resumeSourceRunSummary: source,
    });
  }

  let target: ResolvedWorkflowTarget;
  try {
    const targetInput: { name?: string; scriptPath?: string; script?: string } = {};
    if (opts.name !== undefined) targetInput.name = opts.name;
    if (opts.scriptPath !== undefined) targetInput.scriptPath = opts.scriptPath;
    if (opts.script !== undefined) targetInput.script = opts.script;
    target = resolveWorkflowTarget(targetInput, projectRoot, workingDirectory);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    return finishRun({ ok: false, result: undefined, journal: journalLines, error, ...resultMetadata() });
  }

  let scriptIdentity: WorkflowScriptIdentity;
  try {
    scriptIdentity = createWorkflowScriptSnapshot(target.path, runtimeDir);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    return finishRun({ ok: false, result: undefined, journal: journalLines, error, target, ...resultMetadata() });
  }
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

  replayPlan = planWorkflowReplay({
    projectRoot,
    scriptIdentity,
    ...(hasResume ? { resumeFromRunId: resumeFromRunId! } : {}),
  });
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
      ...(hasResume ? { resumeFromRunId: resumeFromRunId! } : {}),
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
  let runWorkspaceDir: string;
  try {
    artifactStore = createWorkflowArtifactStore({ projectRoot, runId, runDir });
    // The run's working directory exists BEFORE any child starts: its path is
    // named in every agent prompt, and a prompt that points at a missing
    // directory is the defect this layout replaced.
    runWorkspaceDir = ensureWorkflowRunWorkspaceDir(projectRoot, runId);
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
  const agentRunner = createWorkflowAgentRunner({
    pi: opts.pi,
    ctx: opts.ctx,
    signal: opts.signal,
    workflowRunId: runId,
    workspaceManager,
    evidenceDestinations: (callId) => artifactStore!.childEvidenceDestinations(callId),
    runWorkspaceDir,
    ...(opts.input !== undefined ? { args: opts.input } : {}),
    ...(opts.createExecutor !== undefined ? { createExecutor: opts.createExecutor } : {}),
    ...(opts.resolveModel !== undefined ? { resolveModel: opts.resolveModel } : {}),
  });
  runtime = createWorkflowRuntime({
    runId,
    agentRunner,
    journal,
    projectRoot,
    runWorkspaceDir,
    resourceLoader,
    workspaceManager,
    artifactPorts: artifactStore,
    ...(boundContinuation !== undefined ? { continuation: boundContinuation } : {}),
    ...(hasResume ? { replaySourceRunId: resumeFromRunId! } : {}),
    ...(replayController !== undefined ? { replay: replayController } : {}),
    ...(opts.input !== undefined ? { args: opts.input } : {}),
    // Every axis of the contract, unconditionally. A run that declares nothing is
    // bounded on all seven; a `...(x !== undefined ? ...)` guard here is what left
    // global concurrency unlimited for the whole life of the runtime.
    maxConcurrentAgents: budget.concurrency,
    maxTotalAgentInvocations: budget.totalAgents,
    runtimeMs: budget.runtimeMs,
    defaultTimeoutMs: budget.timeoutMs,
    defaultMaxToolCalls: budget.toolCalls,
    defaultMaxTurns: budget.turns,
    defaultMaxAnswerChars: budget.answerChars,
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
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
  resumeFromRunId?: string;
}

/**
 * Decide, once per run, whether recorded calls may be replayed and whether this
 * run may be recorded. Every path out of here is fail-closed: an unproven
 * script, an unreadable source run, or a moved script yields a NAMED refusal and
 * a completely fresh execution, never a partially trusted one.
 */
function planWorkflowReplay(input: PlanWorkflowReplayInput): WorkflowReplayPlan {
  const { projectRoot, scriptIdentity, resumeFromRunId } = input;
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

  const sourceSha256 = readWorkflowRunResult(projectRoot, resumeFromRunId)?.scriptIdentity?.scriptSha256;
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
    return assessWorkflowReplaySafety(readFileSync(scriptIdentity.snapshotPath, "utf8")).replaySafety;
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
