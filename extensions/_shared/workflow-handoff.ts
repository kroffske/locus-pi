/**
 * Durable operator handoff contract and source-adjacent claim state.
 *
 * The workflow declares questions; the runner supplies origin and executable
 * identity. result.json remains immutable after publication. Mutable
 * cross-process exclusion lives only in the adjacent claim sidecar.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { WorkflowArtifactRef, WorkflowContinuation } from "./workflow-artifacts.js";
import { workflowRunDir } from "./workflow-journal.js";
import { readWorkflowRunSummary } from "./workflow-journal.js";
import { projectWorkflowDisposition } from "./workflow-result.js";
import {
  assessWorkflowSourceIdentity,
  sha256WorkflowBytes,
  type WorkflowScriptIdentity,
} from "./workflow-script-identity.js";

export const WORKFLOW_OPERATOR_HANDOFF_VERSION = "locus.workflow.operator-handoff.v1" as const;
export const WORKFLOW_HANDOFF_CLAIM_VERSION = "locus.workflow.operator-handoff-claim.v1" as const;
export const DEFAULT_WORKFLOW_HANDOFF_PRESTART_STALE_MS = 5 * 60 * 1000;
const WORKFLOW_HANDOFF_CLAIM_LOCK_VERSION = "locus.workflow.operator-handoff-claim-lock.v1" as const;
const DEFAULT_WORKFLOW_HANDOFF_LOCK_STALE_MS = 30 * 1000;
const HANDOFF_CLAIM_FILE = "operator-handoff-claim.json";
const HANDOFF_CLAIM_LOCK_FILE = "operator-handoff-claim.lock";
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 20;
const MAX_TITLE_CHARS = 200;
const MAX_PROMPT_CHARS = 500;
const MAX_LABEL_CHARS = 200;

export interface WorkflowOperatorSelectQuestion {
  kind: "select";
  id: string;
  prompt: string;
  options: Array<{ label: string }>;
  recommended?: string;
  allowCustom?: boolean;
}

export interface WorkflowOperatorTextQuestion {
  kind: "text";
  id: string;
  prompt: string;
}

export type WorkflowOperatorQuestion = WorkflowOperatorSelectQuestion | WorkflowOperatorTextQuestion;

export interface WorkflowOperatorHandoffDeclaration {
  title: string;
  questions: WorkflowOperatorQuestion[];
  continuationArtifactRefs: WorkflowArtifactRef[];
}

export interface WorkflowAwaitOperatorDeclaration {
  reason: string;
  operatorHandoff?: WorkflowOperatorHandoffDeclaration;
}

export interface WorkflowOperatorTargetIdentity {
  kind: "name" | "scriptPath";
  ref: string;
  source: "project" | "personal" | "package";
}

export interface WorkflowOperatorScriptIdentity {
  schemaVersion: 2;
  identityPolicy: "static-node-only-v1";
  scriptSha256: string;
  identityCoverage: "self-contained-static" | "entry-only";
  executionSource: "snapshot" | "source";
}

export interface WorkflowOperatorHandoffEnvelope {
  version: typeof WORKFLOW_OPERATOR_HANDOFF_VERSION;
  handoffId: string;
  originRunId: string;
  title: string;
  questions: WorkflowOperatorQuestion[];
  continuationArtifactRefs: WorkflowArtifactRef[];
  target: WorkflowOperatorTargetIdentity;
  scriptIdentity: WorkflowOperatorScriptIdentity;
}

export type WorkflowOperatorHandoffRead =
  | { status: "absent" }
  | { status: "invalid"; message: string }
  | { status: "ready"; handoff: WorkflowOperatorHandoffEnvelope };

export interface WorkflowHandoffClaimState {
  version: typeof WORKFLOW_HANDOFF_CLAIM_VERSION;
  handoffId: string;
  sourceRunId: string;
  claimId: string;
  claimedAt: string;
  childRunId?: string;
}

export interface WorkflowHandoffClaimLease {
  projectRoot: string;
  handoffId: string;
  sourceRunId: string;
  claimId: string;
}

export type WorkflowHandoffClaimRead =
  { status: "absent" } | { status: "invalid"; message: string } | { status: "ready"; state: WorkflowHandoffClaimState };

export type WorkflowHandoffClaimAttempt =
  | { status: "claimed"; claim: WorkflowHandoffClaimLease }
  | { status: "active"; state?: WorkflowHandoffClaimState; message: string }
  | { status: "invalid"; message: string };

export type WorkflowHandoffProjectedState =
  | { status: "pending" }
  | { status: "running"; childRunId?: string }
  | { status: "resolved"; childRunId: string }
  | { status: "retryable"; childRunId?: string; message: string };

export interface WorkflowHandoffClaimOptions {
  now?: () => Date;
  prestartStaleMs?: number;
  lockStaleMs?: number;
}

export function normalizeWorkflowAwaitOperatorDeclaration(value: unknown): WorkflowAwaitOperatorDeclaration {
  const record = requireRecord(value, "awaitOperator input");
  const keys = Object.keys(record).sort();
  const hasHandoff = Object.prototype.hasOwnProperty.call(record, "operatorHandoff");
  const expectedKeys = hasHandoff ? ["operatorHandoff", "reason"] : ["reason"];
  if (!sameStrings(keys, expectedKeys)) {
    throw new Error(
      hasHandoff
        ? "awaitOperator input must contain exactly reason and operatorHandoff"
        : "awaitOperator input must contain exactly reason",
    );
  }
  const reason = normalizeBoundedString(record.reason, "awaitOperator reason", 200, true);
  return {
    reason,
    ...(hasHandoff ? { operatorHandoff: normalizeWorkflowOperatorHandoffDeclaration(record.operatorHandoff) } : {}),
  };
}

export function normalizeWorkflowOperatorHandoffDeclaration(value: unknown): WorkflowOperatorHandoffDeclaration {
  const record = requireExactRecord(value, ["continuationArtifactRefs", "questions", "title"], "operatorHandoff");
  const title = normalizeBoundedString(record.title, "operatorHandoff title", MAX_TITLE_CHARS);
  if (!Array.isArray(record.questions) || record.questions.length < 1 || record.questions.length > MAX_QUESTIONS) {
    throw new Error(`operatorHandoff questions must contain 1-${MAX_QUESTIONS} questions`);
  }
  const questions = record.questions.map(normalizeQuestion);
  const ids = new Set<string>();
  for (const question of questions) {
    if (ids.has(question.id)) throw new Error(`operatorHandoff question id is duplicated: ${question.id}`);
    ids.add(question.id);
  }
  const continuationArtifactRefs = normalizeArtifactRefs(record.continuationArtifactRefs);
  return { title, questions, continuationArtifactRefs };
}

export function createWorkflowOperatorHandoffEnvelope(input: {
  declaration: WorkflowOperatorHandoffDeclaration;
  runId: string;
  target: WorkflowOperatorTargetIdentity;
  scriptIdentity: WorkflowScriptIdentity;
  terminalArtifactRefs: readonly WorkflowArtifactRef[];
}): WorkflowOperatorHandoffEnvelope {
  assertSafeComponent(input.runId, "operatorHandoff originRunId");
  const declaration = normalizeWorkflowOperatorHandoffDeclaration(input.declaration);
  const target = normalizeTarget(input.target, true);
  const scriptIdentity = normalizeScriptIdentity(input.scriptIdentity, true);
  const terminalRefs = normalizeArtifactRefs(input.terminalArtifactRefs, true, 20);
  for (const ref of declaration.continuationArtifactRefs) {
    if (ref.runId !== input.runId) {
      throw new Error("Every operatorHandoff continuation artifact must belong to the terminal source run");
    }
    if (!terminalRefs.some((candidate) => sameArtifactRef(candidate, ref))) {
      throw new Error("operatorHandoff continuation artifact is not present in the terminal artifact projection");
    }
  }
  const envelope: WorkflowOperatorHandoffEnvelope = {
    version: WORKFLOW_OPERATOR_HANDOFF_VERSION,
    handoffId: stableWorkflowHandoffId(input.runId),
    originRunId: input.runId,
    title: declaration.title,
    questions: declaration.questions,
    continuationArtifactRefs: declaration.continuationArtifactRefs,
    target,
    scriptIdentity,
  };
  return normalizeWorkflowOperatorHandoffEnvelope(envelope);
}

export function normalizeWorkflowOperatorHandoffEnvelope(value: unknown): WorkflowOperatorHandoffEnvelope {
  const record = requireExactRecord(
    value,
    [
      "continuationArtifactRefs",
      "handoffId",
      "originRunId",
      "questions",
      "scriptIdentity",
      "target",
      "title",
      "version",
    ],
    "operatorHandoff envelope",
  );
  if (record.version !== WORKFLOW_OPERATOR_HANDOFF_VERSION) {
    throw new Error(`Unsupported operatorHandoff version: ${String(record.version)}`);
  }
  assertSafeComponent(record.handoffId, "operatorHandoff handoffId");
  assertSafeComponent(record.originRunId, "operatorHandoff originRunId");
  if (record.handoffId !== stableWorkflowHandoffId(record.originRunId)) {
    throw new Error("operatorHandoff handoffId does not match its origin run");
  }
  const declaration = normalizeWorkflowOperatorHandoffDeclaration({
    title: record.title,
    questions: record.questions,
    continuationArtifactRefs: record.continuationArtifactRefs,
  });
  for (const ref of declaration.continuationArtifactRefs) {
    if (ref.runId !== record.originRunId) {
      throw new Error("Every operatorHandoff continuation artifact must belong to originRunId");
    }
  }
  return {
    version: WORKFLOW_OPERATOR_HANDOFF_VERSION,
    handoffId: record.handoffId,
    originRunId: record.originRunId,
    ...declaration,
    target: normalizeTarget(record.target),
    scriptIdentity: normalizeScriptIdentity(record.scriptIdentity),
  };
}

/**
 * Parse the handoff from an already parsed result envelope. Absence is the only
 * legacy state; a present malformed/future field is always invalid.
 */
export function readWorkflowOperatorHandoff(value: unknown): WorkflowOperatorHandoffRead {
  if (!isRecord(value)) return { status: "invalid", message: "Workflow result envelope must be an object." };
  if (!Object.prototype.hasOwnProperty.call(value, "operatorHandoff")) return { status: "absent" };
  try {
    const handoff = normalizeWorkflowOperatorHandoffEnvelope(value.operatorHandoff);
    if (value.runId !== handoff.originRunId) {
      throw new Error("operatorHandoff originRunId does not match the result runId");
    }
    if (value.ok !== true) throw new Error("operatorHandoff requires a successful awaiting result");
    const disposition = projectWorkflowDisposition({
      ok: value.ok,
      result: value.result,
      disposition: value.disposition,
    });
    if (disposition.status !== "awaiting_operator") {
      throw new Error("operatorHandoff requires an exact awaiting_operator disposition with bounded detail");
    }
    if (!sameTarget(normalizeTarget(value.target, true), handoff.target)) {
      throw new Error("operatorHandoff target identity does not match the result target");
    }
    if (!sameScriptIdentity(normalizeScriptIdentity(value.scriptIdentity, true), handoff.scriptIdentity)) {
      throw new Error("operatorHandoff script identity does not match the result script identity");
    }
    const terminalRefs = normalizeArtifactRefs(value.artifactRefs, true, 20);
    if (
      handoff.continuationArtifactRefs.some((ref) => !terminalRefs.some((candidate) => sameArtifactRef(candidate, ref)))
    ) {
      throw new Error("operatorHandoff continuation artifacts are not present in the terminal projection");
    }
    return { status: "ready", handoff };
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
}

export function readPersistedWorkflowOperatorHandoff(projectRoot: string, runId: string): WorkflowOperatorHandoffRead {
  try {
    assertSafeComponent(runId, "workflow runId");
    const runDir = assertCanonicalRunDirectory(projectRoot, runId);
    const resultPath = path.join(runDir, "result.json");
    // A run directory with no result.json has not published a terminal result
    // yet — it is still executing, or it was interrupted. Such a run cannot
    // carry an operator handoff, so absence is the honest answer; calling it
    // invalid would surface every live or abandoned run as a corrupt-evidence
    // warning on the operator surfaces that scan run history.
    // lstat, not existsSync: a dangling symlink must stay an invalid file
    // rather than masquerade as an absent one.
    if (lstatSync(resultPath, { throwIfNoEntry: false }) === undefined) return { status: "absent" };
    assertRegularConfinedFile(runDir, resultPath, "Workflow result");
    return readWorkflowOperatorHandoff(JSON.parse(readFileSync(resultPath, "utf8")) as unknown);
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
}

export function workflowContinuationForHandoff(handoff: WorkflowOperatorHandoffEnvelope): WorkflowContinuation {
  const normalized = normalizeWorkflowOperatorHandoffEnvelope(handoff);
  return {
    originRunId: normalized.originRunId,
    artifactRefs: normalized.continuationArtifactRefs.map(cloneArtifactRef),
  };
}

export function assertWorkflowHandoffContinuationEligibility(
  handoff: WorkflowOperatorHandoffEnvelope,
  current: {
    target: WorkflowOperatorTargetIdentity;
    scriptIdentity: WorkflowScriptIdentity | WorkflowOperatorScriptIdentity;
  },
): void {
  const normalized = normalizeWorkflowOperatorHandoffEnvelope(handoff);
  if (normalized.scriptIdentity.identityCoverage !== "self-contained-static") {
    throw new Error(
      "Workflow handoff is not actionable because its script identity coverage is not self-contained-static",
    );
  }
  const target = normalizeTarget(current.target, true);
  if (!sameTarget(normalized.target, target)) {
    throw new Error("Workflow handoff target has changed; start the workflow again");
  }
  const identity = normalizeScriptIdentity(current.scriptIdentity, true);
  if (!sameScriptIdentity(normalized.scriptIdentity, identity)) {
    throw new Error("Workflow handoff script identity has changed; start the workflow again");
  }
}

/** Read and assess one exact current source byte sequence without creating a
 * run or snapshot. Controllers pair this with the freshly resolved target. */
export function readCurrentWorkflowScriptIdentity(sourcePath: string): WorkflowOperatorScriptIdentity {
  const bytes = readFileSync(sourcePath);
  const assessment = assessWorkflowSourceIdentity(bytes.toString("utf8"));
  return {
    schemaVersion: 2,
    identityPolicy: "static-node-only-v1",
    scriptSha256: sha256WorkflowBytes(bytes),
    identityCoverage: assessment.identityCoverage,
    executionSource: assessment.identityCoverage === "self-contained-static" ? "snapshot" : "source",
  };
}

export function assertWorkflowHandoffClaimForContinuation(
  claim: WorkflowHandoffClaimLease,
  continuation: WorkflowContinuation,
  projectRoot = claim.projectRoot,
): void {
  assertClaimLease(claim);
  if (path.resolve(projectRoot) !== path.resolve(claim.projectRoot)) {
    throw new Error("Workflow handoff claim belongs to another project root");
  }
  if (continuation.originRunId !== claim.sourceRunId) {
    throw new Error("Workflow handoff claim does not match the continuation origin run");
  }
  const persisted = readPersistedWorkflowOperatorHandoff(claim.projectRoot, claim.sourceRunId);
  if (persisted.status !== "ready") {
    throw new Error(
      persisted.status === "invalid" ? persisted.message : "Workflow handoff claim has no persisted source handoff",
    );
  }
  if (persisted.handoff.handoffId !== claim.handoffId) {
    throw new Error("Workflow handoff claim does not match the persisted source handoff");
  }
  const expected = workflowContinuationForHandoff(persisted.handoff);
  if (
    continuation.artifactRefs.length !== expected.artifactRefs.length ||
    continuation.artifactRefs.some((ref, index) => !sameArtifactRef(ref, expected.artifactRefs[index]!))
  ) {
    throw new Error("Workflow handoff continuation artifacts do not match the persisted handoff");
  }
}

export function assertWorkflowHandoffClaimEligibility(
  claim: WorkflowHandoffClaimLease,
  current: {
    target: WorkflowOperatorTargetIdentity;
    scriptIdentity: WorkflowScriptIdentity | WorkflowOperatorScriptIdentity;
  },
): void {
  assertClaimLease(claim);
  const persisted = readPersistedWorkflowOperatorHandoff(claim.projectRoot, claim.sourceRunId);
  if (persisted.status !== "ready") {
    throw new Error(
      persisted.status === "invalid" ? persisted.message : "Workflow handoff claim has no persisted source handoff",
    );
  }
  if (persisted.handoff.handoffId !== claim.handoffId) {
    throw new Error("Workflow handoff claim does not match the persisted source handoff");
  }
  assertWorkflowHandoffContinuationEligibility(persisted.handoff, current);
}

export function claimWorkflowOperatorHandoff(
  projectRoot: string,
  handoff: WorkflowOperatorHandoffEnvelope,
  options: WorkflowHandoffClaimOptions = {},
): WorkflowHandoffClaimAttempt {
  let normalized: WorkflowOperatorHandoffEnvelope;
  let paths: WorkflowHandoffClaimPaths;
  try {
    normalized = requirePersistedHandoff(projectRoot, handoff);
    paths = claimPaths(projectRoot, normalized.originRunId);
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
  const now = options.now?.() ?? new Date();
  const lock = acquireClaimLock(paths, now, options.lockStaleMs);
  if (lock === undefined) return { status: "active", message: "Workflow handoff claim transition is active." };
  try {
    const existing = readClaimState(paths.claimPath);
    if (existing.status === "invalid") return existing;
    if (existing.status === "ready") {
      if (!claimMatchesHandoff(existing.state, normalized)) {
        return { status: "invalid", message: "Workflow handoff claim does not match the persisted handoff." };
      }
      const staleMs = boundedDuration(options.prestartStaleMs, DEFAULT_WORKFLOW_HANDOFF_PRESTART_STALE_MS);
      const childIsRetryable =
        existing.state.childRunId !== undefined &&
        ["failed", "cancelled"].includes(readWorkflowRunSummary(projectRoot, existing.state.childRunId).status);
      if (
        childIsRetryable ||
        (existing.state.childRunId === undefined && now.getTime() - Date.parse(existing.state.claimedAt) >= staleMs)
      ) {
        unlinkClaimState(paths.claimPath, lock);
      } else {
        return { status: "active", state: existing.state, message: "Workflow handoff already has an active claim." };
      }
    }
    const state: WorkflowHandoffClaimState = {
      version: WORKFLOW_HANDOFF_CLAIM_VERSION,
      handoffId: normalized.handoffId,
      sourceRunId: normalized.originRunId,
      claimId: randomUUID(),
      claimedAt: now.toISOString(),
    };
    writeClaimStateAtomic(paths.claimPath, state, lock);
    return {
      status: "claimed",
      claim: {
        projectRoot: path.resolve(projectRoot),
        handoffId: state.handoffId,
        sourceRunId: state.sourceRunId,
        claimId: state.claimId,
      },
    };
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  } finally {
    releaseClaimLock(lock);
  }
}

export function readWorkflowHandoffClaim(
  projectRoot: string,
  handoff: WorkflowOperatorHandoffEnvelope,
): WorkflowHandoffClaimRead {
  try {
    const normalized = requirePersistedHandoff(projectRoot, handoff);
    const read = readClaimState(claimPaths(projectRoot, normalized.originRunId).claimPath);
    if (read.status === "ready" && !claimMatchesHandoff(read.state, normalized)) {
      return { status: "invalid", message: "Workflow handoff claim does not match the persisted handoff." };
    }
    return read;
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
}

export function bindWorkflowHandoffClaim(
  claim: WorkflowHandoffClaimLease,
  childRunId: string,
): WorkflowHandoffClaimState {
  assertClaimLease(claim);
  assertSafeComponent(childRunId, "workflow handoff childRunId");
  const paths = claimPaths(claim.projectRoot, claim.sourceRunId);
  const lock = acquireClaimLock(paths, new Date());
  if (lock === undefined) throw new Error("Workflow handoff claim transition is active.");
  try {
    const read = readClaimState(paths.claimPath);
    if (read.status !== "ready") {
      throw new Error(read.status === "invalid" ? read.message : "Workflow handoff claim is missing.");
    }
    assertClaimOwnedByLease(read.state, claim);
    if (read.state.childRunId !== undefined && read.state.childRunId !== childRunId) {
      throw new Error("Workflow handoff claim is already bound to another child run.");
    }
    if (read.state.childRunId === childRunId) return read.state;
    const state = { ...read.state, childRunId };
    writeClaimStateAtomic(paths.claimPath, state, lock);
    return state;
  } finally {
    releaseClaimLock(lock);
  }
}

export function releaseWorkflowHandoffClaim(claim: WorkflowHandoffClaimLease): boolean {
  assertClaimLease(claim);
  const paths = claimPaths(claim.projectRoot, claim.sourceRunId);
  const lock = acquireClaimLock(paths, new Date());
  if (lock === undefined) throw new Error("Workflow handoff claim transition is active.");
  try {
    const read = readClaimState(paths.claimPath);
    if (read.status === "absent") return false;
    if (read.status === "invalid") throw new Error(read.message);
    assertClaimOwnedByLease(read.state, claim);
    unlinkClaimState(paths.claimPath, lock);
    return true;
  } finally {
    releaseClaimLock(lock);
  }
}

export function projectWorkflowHandoffState(
  projectRoot: string,
  handoff: WorkflowOperatorHandoffEnvelope,
  options: Pick<WorkflowHandoffClaimOptions, "now" | "prestartStaleMs"> = {},
): WorkflowHandoffProjectedState {
  const read = readWorkflowHandoffClaim(projectRoot, handoff);
  if (read.status === "absent") return { status: "pending" };
  if (read.status === "invalid") throw new Error(read.message);
  const childRunId = read.state.childRunId;
  if (childRunId === undefined) {
    const now = options.now?.() ?? new Date();
    const staleMs = boundedDuration(options.prestartStaleMs, DEFAULT_WORKFLOW_HANDOFF_PRESTART_STALE_MS);
    return now.getTime() - Date.parse(read.state.claimedAt) >= staleMs
      ? { status: "retryable", message: "Workflow handoff claim expired before a continuation run started." }
      : { status: "running" };
  }
  const child = readWorkflowRunSummary(projectRoot, childRunId);
  if (child.status === "completed" || child.status === "awaiting_operator") {
    return { status: "resolved", childRunId };
  }
  if (child.status === "failed" || child.status === "cancelled") {
    return { status: "retryable", childRunId, message: `Continuation run ${childRunId} ${child.status}.` };
  }
  return { status: "running", childRunId };
}

function normalizeQuestion(value: unknown, index: number): WorkflowOperatorQuestion {
  const record = requireRecord(value, `operatorHandoff question ${index + 1}`);
  if (record.kind === "select") {
    const allowed = ["allowCustom", "id", "kind", "options", "prompt", "recommended"];
    requireAllowedKeys(record, allowed, `operatorHandoff select question ${index + 1}`);
    const id = normalizeQuestionId(record.id);
    const prompt = normalizeBoundedString(record.prompt, `operatorHandoff question ${id} prompt`, MAX_PROMPT_CHARS);
    if (!Array.isArray(record.options) || record.options.length < 1 || record.options.length > MAX_OPTIONS) {
      throw new Error(`operatorHandoff question ${id} options must contain 1-${MAX_OPTIONS} choices`);
    }
    const options = record.options.map((option, optionIndex) => {
      const optionRecord = requireExactRecord(
        option,
        ["label"],
        `operatorHandoff question ${id} option ${optionIndex + 1}`,
      );
      return {
        label: normalizeBoundedString(
          optionRecord.label,
          `operatorHandoff question ${id} option ${optionIndex + 1} label`,
          MAX_LABEL_CHARS,
        ),
      };
    });
    if (new Set(options.map((option) => option.label)).size !== options.length) {
      throw new Error(`operatorHandoff question ${id} option labels must be unique`);
    }
    const recommended =
      record.recommended === undefined
        ? undefined
        : normalizeBoundedString(record.recommended, `operatorHandoff question ${id} recommended`, MAX_LABEL_CHARS);
    if (recommended !== undefined && !options.some((option) => option.label === recommended)) {
      throw new Error(`operatorHandoff question ${id} recommended label must match an option`);
    }
    if (record.allowCustom !== undefined && typeof record.allowCustom !== "boolean") {
      throw new Error(`operatorHandoff question ${id} allowCustom must be boolean`);
    }
    return {
      kind: "select",
      id,
      prompt,
      options,
      ...(recommended !== undefined ? { recommended } : {}),
      ...(record.allowCustom !== undefined ? { allowCustom: record.allowCustom } : {}),
    };
  }
  if (record.kind === "text") {
    requireAllowedKeys(record, ["id", "kind", "prompt"], `operatorHandoff text question ${index + 1}`);
    const id = normalizeQuestionId(record.id);
    return {
      kind: "text",
      id,
      prompt: normalizeBoundedString(record.prompt, `operatorHandoff question ${id} prompt`, MAX_PROMPT_CHARS),
    };
  }
  throw new Error(`operatorHandoff question ${index + 1} kind must be select or text`);
}

function normalizeQuestionId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_COMPONENT.test(value)) {
    throw new Error("operatorHandoff question id must be a safe 1-128 character component");
  }
  return value;
}

function normalizeTarget(value: unknown, allowRunnerPath = false): WorkflowOperatorTargetIdentity {
  const record = requireExactRecord(
    value,
    ["kind", "ref", "source"],
    "workflow target",
    allowRunnerPath ? ["path"] : [],
  );
  if (record.kind !== "name" && record.kind !== "scriptPath") throw new Error("Workflow target kind is invalid");
  if (typeof record.ref !== "string" || record.ref.trim() === "") throw new Error("Workflow target ref is invalid");
  if (record.source !== "project" && record.source !== "personal" && record.source !== "package") {
    throw new Error("Workflow target source is invalid");
  }
  return { kind: record.kind, ref: record.ref, source: record.source };
}

function normalizeScriptIdentity(value: unknown, allowRunnerFields = false): WorkflowOperatorScriptIdentity {
  const record = requireRecord(value, "workflow script identity");
  requireAllowedKeys(
    record,
    [
      "executionSource",
      "identityCoverage",
      "identityPolicy",
      "schemaVersion",
      "scriptSha256",
      ...(allowRunnerFields
        ? ["arch", "builtinImports", "nodeVersion", "platform", "snapshotPath", "sourcePath", "unboundDependencies"]
        : []),
    ],
    "workflow script identity",
  );
  if (record.schemaVersion !== 2 || record.identityPolicy !== "static-node-only-v1") {
    throw new Error("Workflow script identity is not a supported v2 identity");
  }
  if (typeof record.scriptSha256 !== "string" || !SHA256.test(record.scriptSha256)) {
    throw new Error("Workflow script identity sha256 is invalid");
  }
  if (record.identityCoverage !== "self-contained-static" && record.identityCoverage !== "entry-only") {
    throw new Error("Workflow script identity coverage is invalid");
  }
  if (record.executionSource !== "snapshot" && record.executionSource !== "source") {
    throw new Error("Workflow script execution source is invalid");
  }
  if (
    (record.identityCoverage === "self-contained-static" && record.executionSource !== "snapshot") ||
    (record.identityCoverage === "entry-only" && record.executionSource !== "source")
  ) {
    throw new Error("Workflow script identity coverage and execution source are inconsistent");
  }
  return {
    schemaVersion: 2,
    identityPolicy: "static-node-only-v1",
    scriptSha256: record.scriptSha256,
    identityCoverage: record.identityCoverage,
    executionSource: record.executionSource,
  };
}

function normalizeArtifactRefs(value: unknown, allowEmpty = false, maxItems = 8): WorkflowArtifactRef[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > maxItems) {
    throw new Error(
      `operatorHandoff continuationArtifactRefs must contain ${allowEmpty ? "0" : "1"}-${maxItems} references`,
    );
  }
  const refs = value.map(normalizeArtifactRef);
  const identities = new Set<string>();
  for (const ref of refs) {
    const identity = `${ref.runId}\u001f${ref.artifactId}`;
    if (identities.has(identity)) throw new Error("operatorHandoff continuationArtifactRefs contain a duplicate");
    identities.add(identity);
  }
  return refs;
}

function normalizeArtifactRef(value: unknown): WorkflowArtifactRef {
  const record = requireExactRecord(value, ["artifactId", "name", "runId", "sha256"], "workflow artifact ref");
  assertSafeComponent(record.runId, "workflow artifact runId");
  assertSafeComponent(record.artifactId, "workflow artifact artifactId");
  if (typeof record.name !== "string" || !SAFE_COMPONENT.test(record.name)) {
    throw new Error("Workflow artifact name is invalid");
  }
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256)) {
    throw new Error("Workflow artifact sha256 is invalid");
  }
  return {
    runId: record.runId,
    artifactId: record.artifactId,
    name: record.name,
    sha256: record.sha256,
  };
}

function requirePersistedHandoff(
  projectRoot: string,
  handoff: WorkflowOperatorHandoffEnvelope,
): WorkflowOperatorHandoffEnvelope {
  const normalized = normalizeWorkflowOperatorHandoffEnvelope(handoff);
  const persisted = readPersistedWorkflowOperatorHandoff(projectRoot, normalized.originRunId);
  if (persisted.status !== "ready") {
    throw new Error(
      persisted.status === "invalid" ? persisted.message : "Workflow run has no actionable operator handoff.",
    );
  }
  if (JSON.stringify(persisted.handoff) !== JSON.stringify(normalized)) {
    throw new Error("Workflow handoff does not match immutable source result evidence.");
  }
  return normalized;
}

interface WorkflowHandoffClaimPaths {
  claimPath: string;
  lockPath: string;
}

function claimPaths(projectRoot: string, runId: string): WorkflowHandoffClaimPaths {
  const runDir = assertCanonicalRunDirectory(projectRoot, runId);
  return {
    claimPath: path.join(runDir, HANDOFF_CLAIM_FILE),
    lockPath: path.join(runDir, HANDOFF_CLAIM_LOCK_FILE),
  };
}

function readClaimState(claimPath: string): WorkflowHandoffClaimRead {
  if (!existsSync(claimPath)) return { status: "absent" };
  try {
    const stat = lstatSync(claimPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Workflow handoff claim sidecar is not a regular non-symlink file.");
    }
    const parsed: unknown = JSON.parse(readFileSync(claimPath, "utf8"));
    return { status: "ready", state: normalizeClaimState(parsed) };
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
}

function normalizeClaimState(value: unknown): WorkflowHandoffClaimState {
  const record = requireRecord(value, "workflow handoff claim");
  const allowed =
    record.childRunId === undefined
      ? ["claimId", "claimedAt", "handoffId", "sourceRunId", "version"]
      : ["childRunId", "claimId", "claimedAt", "handoffId", "sourceRunId", "version"];
  requireAllowedKeys(record, allowed, "workflow handoff claim");
  if (record.version !== WORKFLOW_HANDOFF_CLAIM_VERSION) throw new Error("Workflow handoff claim version is invalid.");
  assertSafeComponent(record.handoffId, "workflow handoff claim handoffId");
  assertSafeComponent(record.sourceRunId, "workflow handoff claim sourceRunId");
  assertSafeComponent(record.claimId, "workflow handoff claim claimId");
  if (typeof record.claimedAt !== "string" || !Number.isFinite(Date.parse(record.claimedAt))) {
    throw new Error("Workflow handoff claim claimedAt is invalid.");
  }
  if (record.childRunId !== undefined) assertSafeComponent(record.childRunId, "workflow handoff claim childRunId");
  return {
    version: WORKFLOW_HANDOFF_CLAIM_VERSION,
    handoffId: record.handoffId,
    sourceRunId: record.sourceRunId,
    claimId: record.claimId,
    claimedAt: record.claimedAt,
    ...(record.childRunId !== undefined ? { childRunId: record.childRunId } : {}),
  };
}

function writeClaimStateAtomic(claimPath: string, state: WorkflowHandoffClaimState, lock: ClaimLock): void {
  const normalized = normalizeClaimState(state);
  const tempPath = `${claimPath}.${normalized.claimId}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag(), 0o600);
    writeFileSync(fd, `${JSON.stringify(normalized)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertClaimLockOwned(lock);
    renameSync(tempPath, claimPath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // The canonical state either won the rename or the caller receives the
      // original write error. Temp cleanup must not hide it.
    }
  }
}

interface ClaimLock {
  path: string;
  ownerToken: string;
}

interface ClaimLockState {
  version: typeof WORKFLOW_HANDOFF_CLAIM_LOCK_VERSION;
  ownerToken: string;
  acquiredAt: string;
}

function acquireClaimLock(
  paths: WorkflowHandoffClaimPaths,
  now: Date,
  configuredStaleMs?: number,
): ClaimLock | undefined {
  const staleMs = boundedDuration(configuredStaleMs, DEFAULT_WORKFLOW_HANDOFF_LOCK_STALE_MS);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state: ClaimLockState = {
      version: WORKFLOW_HANDOFF_CLAIM_LOCK_VERSION,
      ownerToken: randomUUID(),
      acquiredAt: now.toISOString(),
    };
    let fd: number | undefined;
    try {
      fd = openSync(
        paths.lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag(),
        0o600,
      );
      writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      return { path: paths.lockPath, ownerToken: state.ownerToken };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (!isCode(error, "EEXIST")) throw error;
      let stat;
      try {
        stat = lstatSync(paths.lockPath);
      } catch (statError) {
        if (isCode(statError, "ENOENT")) continue;
        throw statError;
      }
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error("Workflow handoff claim lock is not a regular file.");
      if (now.getTime() - stat.mtimeMs < staleMs) return undefined;
      unlinkSync(paths.lockPath);
    }
  }
  return undefined;
}

function releaseClaimLock(lock: ClaimLock): void {
  try {
    const state = readClaimLockState(lock.path);
    if (state === undefined || state.ownerToken !== lock.ownerToken) return;
    unlinkSync(lock.path);
  } catch (error) {
    if (!isCode(error, "ENOENT")) {
      // A malformed or replaced lock is not ours to remove. Claim mutation has
      // already verified ownership independently and reports its own failure.
    }
  }
}

function unlinkClaimState(claimPath: string, lock: ClaimLock): void {
  assertClaimLockOwned(lock);
  unlinkSync(claimPath);
}

function assertClaimLockOwned(lock: ClaimLock): void {
  const state = readClaimLockState(lock.path);
  if (state === undefined || state.ownerToken !== lock.ownerToken) {
    throw new Error("Workflow handoff claim lock ownership was lost before mutation.");
  }
}

function readClaimLockState(lockPath: string): ClaimLockState | undefined {
  if (!existsSync(lockPath)) return undefined;
  const stat = lstatSync(lockPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Workflow handoff claim lock is not a regular file.");
  }
  const value: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
  const record = requireExactRecord(value, ["acquiredAt", "ownerToken", "version"], "workflow handoff claim lock");
  if (record.version !== WORKFLOW_HANDOFF_CLAIM_LOCK_VERSION) {
    throw new Error("Workflow handoff claim lock version is invalid.");
  }
  assertSafeComponent(record.ownerToken, "workflow handoff claim lock ownerToken");
  if (typeof record.acquiredAt !== "string" || !Number.isFinite(Date.parse(record.acquiredAt))) {
    throw new Error("Workflow handoff claim lock acquiredAt is invalid.");
  }
  return {
    version: WORKFLOW_HANDOFF_CLAIM_LOCK_VERSION,
    ownerToken: record.ownerToken,
    acquiredAt: record.acquiredAt,
  };
}

function assertCanonicalRunDirectory(projectRoot: string, runId: string): string {
  const lexicalProjectRoot = path.resolve(projectRoot);
  const runDir = path.resolve(workflowRunDir(lexicalProjectRoot, runId));
  const relative = path.relative(lexicalProjectRoot, runDir);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workflow run directory escapes the project root.");
  }
  let current = lexicalProjectRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Workflow run directory chain must contain only regular directories.");
    }
  }
  const physicalProjectRoot = realpathSync(lexicalProjectRoot);
  const physicalRunDir = realpathSync(runDir);
  const physicalRelative = path.relative(physicalProjectRoot, physicalRunDir);
  if (physicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(physicalRelative)) {
    throw new Error("Workflow run directory escapes the physical project root.");
  }
  return runDir;
}

function assertRegularConfinedFile(root: string, file: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its run directory.`);
  }
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular non-symlink file.`);
  const physicalRoot = realpathSync(root);
  const physicalFile = realpathSync(file);
  const physicalRelative = path.relative(physicalRoot, physicalFile);
  if (physicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(physicalRelative)) {
    throw new Error(`${label} escapes its physical run directory.`);
  }
}

function stableWorkflowHandoffId(runId: string): string {
  return `handoff-${createHash("sha256")
    .update(`${WORKFLOW_OPERATOR_HANDOFF_VERSION}\0${runId}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function assertClaimLease(value: WorkflowHandoffClaimLease): void {
  if (!isRecord(value)) throw new Error("Workflow handoff claim lease must be an object.");
  if (typeof value.projectRoot !== "string" || value.projectRoot.trim() === "") {
    throw new Error("Workflow handoff claim lease projectRoot is invalid.");
  }
  assertSafeComponent(value.handoffId, "workflow handoff claim lease handoffId");
  assertSafeComponent(value.sourceRunId, "workflow handoff claim lease sourceRunId");
  assertSafeComponent(value.claimId, "workflow handoff claim lease claimId");
}

function assertClaimOwnedByLease(state: WorkflowHandoffClaimState, claim: WorkflowHandoffClaimLease): void {
  if (
    state.claimId !== claim.claimId ||
    state.handoffId !== claim.handoffId ||
    state.sourceRunId !== claim.sourceRunId
  ) {
    throw new Error("Workflow handoff claim lease no longer owns the active claim.");
  }
}

function claimMatchesHandoff(state: WorkflowHandoffClaimState, handoff: WorkflowOperatorHandoffEnvelope): boolean {
  return state.handoffId === handoff.handoffId && state.sourceRunId === handoff.originRunId;
}

function sameTarget(left: WorkflowOperatorTargetIdentity, right: WorkflowOperatorTargetIdentity): boolean {
  return left.kind === right.kind && left.ref === right.ref && left.source === right.source;
}

function sameScriptIdentity(left: WorkflowOperatorScriptIdentity, right: WorkflowOperatorScriptIdentity): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.identityPolicy === right.identityPolicy &&
    left.scriptSha256 === right.scriptSha256 &&
    left.identityCoverage === right.identityCoverage &&
    left.executionSource === right.executionSource
  );
}

function sameArtifactRef(left: WorkflowArtifactRef, right: WorkflowArtifactRef): boolean {
  return (
    left.runId === right.runId &&
    left.artifactId === right.artifactId &&
    left.name === right.name &&
    left.sha256 === right.sha256
  );
}

function cloneArtifactRef(ref: WorkflowArtifactRef): WorkflowArtifactRef {
  return { runId: ref.runId, artifactId: ref.artifactId, name: ref.name, sha256: ref.sha256 };
}

function normalizeBoundedString(value: unknown, label: string, maxChars: number, collapseWhitespace = false): string {
  if (typeof value !== "string") throw new Error(`${label} must be non-empty`);
  const normalized = collapseWhitespace ? value.replace(/\s+/gu, " ").trim() : value.trim();
  if (normalized === "") throw new Error(`${label} must be non-empty`);
  if (normalized.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`);
  return normalized;
}

function assertSafeComponent(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_COMPONENT.test(value)) {
    throw new Error(`${label} must be a safe 1-128 character component`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  const record = requireRecord(value, label);
  requireAllowedKeys(record, [...keys, ...optionalKeys], label);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`${label} must contain ${key}`);
  }
  return record;
}

function requireAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error(`${label} has unexpected fields`);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
}

function isCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}
