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
import { homedir } from "node:os";
import { constants as vmConstants, Script } from "node:vm";
import type { ExtensionAPI, ExtensionContext } from "./pi-api.js";
import { getProjectRoot, getWorkingDirectory } from "./pi-api.js";
import type { WorkflowDsl, WorkflowJournalLine } from "./workflow-runtime.js";
import { createWorkflowRuntime, workflowGroupFailureEnvelope } from "./workflow-runtime.js";
import type { AgentExecutor } from "./agent-runner.js";
import { createWorkflowAgentRunner } from "./workflow-agent-bridge.js";
import { createWorkflowLlmRunner } from "./workflow-llm-bridge.js";
import { newWorkflowRunId, workflowRunDir, createWorkflowJournalSink, readWorkflowRunSummary } from "./workflow-journal.js";
import type { WorkflowRunSummary } from "./workflow-journal.js";
import {
  prepareWorkflowResult,
  isWorkflowResultExplicitFailure,
  workflowResultFile,
  writeWorkflowResultJson,
  type WorkflowResultDiagnosticSentinel,
  type WorkflowResultPersistence,
} from "./workflow-result.js";
import {
  createWorkflowScriptSnapshot,
  sha256WorkflowBytes,
  verifyWorkflowScriptSnapshot,
  workflowScriptExecutionPath,
  type WorkflowScriptIdentity,
} from "./workflow-script-identity.js";

export type { WorkflowScriptIdentity } from "./workflow-script-identity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowScriptModule {
  default?: (dsl: WorkflowDsl, input?: unknown) => Promise<unknown> | unknown;
  runWorkflow?: (dsl: WorkflowDsl, input?: unknown) => Promise<unknown> | unknown;
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
  input?: unknown;
  resumeFromRunId?: string;
  /** Global per-run cap across all dsl.agent() calls. Defaults to the runtime default
   *  (DEFAULT_MAX_TOTAL_AGENT_INVOCATIONS) when unset. Exceeding it fails the run. */
  maxTotalAgentInvocations?: number;
  createExecutor?: (o: { model?: unknown }) => AgentExecutor; // pass-through to the bridge (tests)
  resolveModel?: (selector: string) => unknown; // pass-through to the bridge (tests)
  /** Called once after run identity is allocated and before any journal event. Presentation-only. */
  onRunStart?: (run: { runId: string; runDir: string }) => void;
  onEvent?: (line: WorkflowJournalLine) => void;
}

export interface RunWorkflowScriptResult {
  runId: string;
  runDir: string;
  ok: boolean;
  result: unknown;                   // detached JSON value or explicit diagnostic sentinel
  resultDiagnostic?: WorkflowResultDiagnosticSentinel;
  resultPersistence: WorkflowResultPersistence;
  journal: WorkflowJournalLine[];
  error?: string;
  target?: ResolvedWorkflowTarget;
  scriptIdentity?: WorkflowScriptIdentity;
  resumeFromRunId?: string;
  resumeSourceRunSummary?: WorkflowRunSummary | null;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const PACKAGED_EXAMPLES_DIR = fileURLToPath(new URL("../workflows/examples/", import.meta.url));

/** User-facing Package workflows are explicitly curated; other files are authoring/test fixtures. */
export const CURATED_PACKAGE_WORKFLOW_NAMES = [
  "live-smoke",
  "llm-smoke",
  "requirements-grill",
] as const;
const CURATED_PACKAGE_WORKFLOW_NAME_SET = new Set<string>(CURATED_PACKAGE_WORKFLOW_NAMES);

/** Absolute path to this package's shipped workflow examples directory. */
export function packagedExamplesDir(): string {
  return PACKAGED_EXAMPLES_DIR;
}

function hasPathSeparators(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
 * writes). The other two are interop sources: a workflow found under `.claude/workflows/`
 * or `.agents/workflows/` may have been authored for a different tool and can differ
 * slightly in format from the pi-native DSL — they are scanned for convenience, not
 * guaranteed to be pi-native. All three carry `source: "project"`.
 */
const PROJECT_WORKFLOW_DIRS: readonly [string, string][] = [
  [".pi", "workflows"],
  [".claude", "workflows"],
  [".agents", "workflows"],
];

function resolveSavedWorkflowPath(name: string, projectRoot: string, workingDirectory: string): ResolvedWorkflowTarget {
  for (const search of workflowSearchDirectories(projectRoot, workingDirectory)) {
    if (search.source === "package" && !CURATED_PACKAGE_WORKFLOW_NAME_SET.has(name)) continue;
    const candidate = path.join(search.directory, `${name}.workflow.mjs`);
    if (existsSync(candidate)) {
      const targetPath = search.source === "project"
        ? resolveConfinedScriptPath(candidate, projectRoot, `${name}.workflow.mjs`)
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
  let current = workingRelative === "" || (!workingRelative.startsWith("..") && !path.isAbsolute(workingRelative))
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

export function resolveWorkflowTarget(target: { name?: string; scriptPath?: string; script?: string }, projectRoot: string, workingDirectory?: string): ResolvedWorkflowTarget {
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
export function listWorkflowCatalogTargets(projectRoot: string, workingDirectory = projectRoot): ResolvedWorkflowTarget[] {
  const targets = new Map<string, ResolvedWorkflowTarget>();
  for (const search of workflowSearchDirectories(projectRoot, workingDirectory)) {
    addCatalogDirectory(targets, search.directory, search.source);
  }
  return [...targets.values()];
}

function addCatalogDirectory(
  targets: Map<string, ResolvedWorkflowTarget>,
  directory: string,
  source: ResolvedWorkflowTarget["source"],
): void {
  let entries: string[];
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".workflow.mjs"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.slice(0, -".workflow.mjs".length);
    if (source === "package" && !CURATED_PACKAGE_WORKFLOW_NAME_SET.has(name)) continue;
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
      const reason = executionSource === "snapshot"
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
  return await importer(specifier) as WorkflowScriptModule;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runWorkflowScript(opts: RunWorkflowScriptOptions): Promise<RunWorkflowScriptResult> {
  const projectRoot = getProjectRoot(opts.ctx);
  const workingDirectory = getWorkingDirectory(opts.ctx);
  const runId = newWorkflowRunId();
  const runDir = workflowRunDir(projectRoot, runId);
  const journal = createWorkflowJournalSink(projectRoot, runId);
  try {
    opts.onRunStart?.({ runId, runDir });
  } catch {
    // Presentation callback failure must not turn successful workflow execution into a crash.
  }

  const resumeFromRunId = opts.resumeFromRunId?.trim();
  let resumeSourceRunSummary: WorkflowRunSummary | null | undefined;
  const hasResume = resumeFromRunId !== undefined && resumeFromRunId !== "";
  const preludeLines: WorkflowJournalLine[] = [];
  const emitPrelude = (line: WorkflowJournalLine): void => {
    preludeLines.push(line);
    journal.write(line);
    opts.onEvent?.(line);
  };
  const resultMetadata = (): Pick<RunWorkflowScriptResult, "resumeFromRunId" | "resumeSourceRunSummary" | "target"> | Record<string, never> => {
    if (!hasResume) return {};
    return {
      resumeFromRunId: resumeFromRunId!,
      resumeSourceRunSummary: resumeSourceRunSummary ?? null,
    };
  };
  const currentJournal = (runtime?: { getJournal(): WorkflowJournalLine[] }): WorkflowJournalLine[] => [
    ...preludeLines,
    ...(runtime?.getJournal() ?? []),
  ];
  type RunResultFields = Omit<RunWorkflowScriptResult, "runId" | "runDir" | "resultPersistence">;
  const finishRun = (fields: RunResultFields): RunWorkflowScriptResult => {
    const intendedPersistence: WorkflowResultPersistence = { ok: true, path: workflowResultFile(runDir) };
    const resultPersistence = writeWorkflowResultJson(runDir, {
      runId,
      ...fields,
      resultPersistence: intendedPersistence,
    });
    if (resultPersistence.ok) return { runId, runDir, ...fields, resultPersistence };

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
    const failedFields: RunResultFields = {
      ...fields,
      ok: false,
      error: fields.error ?? resultPersistence.message,
      journal: [...fields.journal, persistenceError],
    };
    return { runId, runDir, ...failedFields, resultPersistence };
  };

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

  const agentRunner = createWorkflowAgentRunner({
    pi: opts.pi,
    ctx: opts.ctx,
    signal: opts.signal,
    workflowRunId: runId,
    ...(opts.input !== undefined ? { args: opts.input } : {}),
    ...(opts.createExecutor !== undefined ? { createExecutor: opts.createExecutor } : {}),
    ...(opts.resolveModel !== undefined ? { resolveModel: opts.resolveModel } : {}),
  });

  // dsl.llm() shares the agent bridge's model-routing (resolveModel) but reaches the
  // model directly via pi-ai completeSimple instead of spawning a child session.
  const llmRunner = createWorkflowLlmRunner({
    ctx: opts.ctx,
    signal: opts.signal,
    ...(opts.resolveModel !== undefined ? { resolveModel: opts.resolveModel } : {}),
  });

  const runtime = createWorkflowRuntime({
    runId,
    agentRunner,
    llmRunner,
    journal,
    ...(opts.input !== undefined ? { args: opts.input } : {}),
    ...(opts.maxTotalAgentInvocations !== undefined ? { maxTotalAgentInvocations: opts.maxTotalAgentInvocations } : {}),
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
  });

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
    scriptIdentity = createWorkflowScriptSnapshot(target.path, runDir);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    return finishRun({ ok: false, result: undefined, journal: journalLines, error, target, ...resultMetadata() });
  }

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
    return finishRun({ ok: false, result: undefined, journal: journalLines, error, target, scriptIdentity, ...resultMetadata() });
  }

  const entry = typeof mod.default === "function"
    ? mod.default
    : typeof mod.runWorkflow === "function"
      ? mod.runWorkflow
      : undefined;

  if (entry === undefined) {
    const error = "Workflow script has no default or runWorkflow export";
    const journalLines = currentJournal(runtime);
    return finishRun({ ok: false, result: undefined, journal: journalLines, error, target, scriptIdentity, ...resultMetadata() });
  }

  let result: unknown;
  try {
    // runGuarded contains BOTH awaited throws (already covered) AND out-of-band
    // failures: a detached promise rejection or an uncaught exception thrown from
    // SDK/host machinery we never get a handle to (e.g. a dead-model auth error
    // firing on a detached emit path). Without this run-scoped net those would hit
    // Node's default handler and KILL the whole pi process — the Iskhod-1 defect.
    result = await runGuardedAgainstHostCrash(() => Promise.resolve(entry(runtime.dsl, opts.input)));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const journalLines = currentJournal(runtime);
    const groupFailure = workflowGroupFailureEnvelope(err);
    return finishRun({
      ok: false,
      result: groupFailure,
      journal: journalLines,
      error,
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
    return finishRun({ ok: false, result: undefined, journal: journalLines, error, target, scriptIdentity, ...resultMetadata() });
  }
  return finishRun({
    ok: semanticOk,
    result: prepared.value,
    ...(prepared.diagnostic !== undefined
      ? { resultDiagnostic: prepared.diagnostic, error: prepared.diagnostic.message }
      : {}),
    journal: journalLines,
    target,
    scriptIdentity,
    ...resultMetadata(),
  });
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
    sink = (error: unknown) => reject(error instanceof Error ? error : new Error(`workflow run failed out-of-band: ${String(error)}`));
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
