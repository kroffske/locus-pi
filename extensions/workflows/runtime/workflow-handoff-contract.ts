/**
 * workflow-handoff-contract.ts — what a workflow may declare when it hands off
 * to an operator: the question/declaration types and their normalization.
 *
 * Declarations only, never storage. This module must stay free of node:fs,
 * node:path, the journal and the run layout so the DSL core can import it;
 * rule 7 of scripts/check-extension-layers.ts enforces that. Its durable
 * counterpart is workflow-handoff.ts, which turns a normalized declaration into
 * a published envelope and owns the adjacent claim state.
 */

import type { WorkflowArtifactRef } from "./workflow-artifacts.js";

export const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 20;
const MAX_TITLE_CHARS = 200;
const MAX_PROMPT_CHARS = 500;
const MAX_LABEL_CHARS = 200;

export interface WorkflowOperatorSelectQuestion {
  kind: "select";
  id: string;
  prompt: string;
  detailArtifactRef?: WorkflowArtifactRef;
  options: Array<{ label: string }>;
  recommended?: string;
  allowCustom?: boolean;
}

export interface WorkflowOperatorTextQuestion {
  kind: "text";
  id: string;
  prompt: string;
  detailArtifactRef?: WorkflowArtifactRef;
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
function normalizeQuestion(value: unknown, index: number): WorkflowOperatorQuestion {
  const record = requireRecord(value, `operatorHandoff question ${index + 1}`);
  if (record.kind === "select") {
    const allowed = ["allowCustom", "detailArtifactRef", "id", "kind", "options", "prompt", "recommended"];
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
    const detailArtifactRef =
      record.detailArtifactRef === undefined ? undefined : normalizeArtifactRef(record.detailArtifactRef);
    return {
      kind: "select",
      id,
      prompt,
      ...(detailArtifactRef !== undefined ? { detailArtifactRef } : {}),
      options,
      ...(recommended !== undefined ? { recommended } : {}),
      ...(record.allowCustom !== undefined ? { allowCustom: record.allowCustom } : {}),
    };
  }
  if (record.kind === "text") {
    requireAllowedKeys(
      record,
      ["detailArtifactRef", "id", "kind", "prompt"],
      `operatorHandoff text question ${index + 1}`,
    );
    const id = normalizeQuestionId(record.id);
    const detailArtifactRef =
      record.detailArtifactRef === undefined ? undefined : normalizeArtifactRef(record.detailArtifactRef);
    return {
      kind: "text",
      id,
      prompt: normalizeBoundedString(record.prompt, `operatorHandoff question ${id} prompt`, MAX_PROMPT_CHARS),
      ...(detailArtifactRef !== undefined ? { detailArtifactRef } : {}),
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
export function normalizeArtifactRefs(value: unknown, allowEmpty = false, maxItems = 8): WorkflowArtifactRef[] {
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
export function sameArtifactRef(left: WorkflowArtifactRef, right: WorkflowArtifactRef): boolean {
  return (
    left.runId === right.runId &&
    left.artifactId === right.artifactId &&
    left.name === right.name &&
    left.sha256 === right.sha256
  );
}

export function cloneArtifactRef(ref: WorkflowArtifactRef): WorkflowArtifactRef {
  return { runId: ref.runId, artifactId: ref.artifactId, name: ref.name, sha256: ref.sha256 };
}
function normalizeBoundedString(value: unknown, label: string, maxChars: number, collapseWhitespace = false): string {
  if (typeof value !== "string") throw new Error(`${label} must be non-empty`);
  const normalized = collapseWhitespace ? value.replace(/\s+/gu, " ").trim() : value.trim();
  if (normalized === "") throw new Error(`${label} must be non-empty`);
  if (normalized.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`);
  return normalized;
}

export function assertSafeComponent(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_COMPONENT.test(value)) {
    throw new Error(`${label} must be a safe 1-128 character component`);
  }
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

export function requireExactRecord(
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

export function requireAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error(`${label} has unexpected fields`);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
