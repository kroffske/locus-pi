import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const WORKFLOW_ARTIFACT_INDEX_VERSION = "locus.workflow.artifacts.v1" as const;
export const DEFAULT_WORKFLOW_TEXT_ARTIFACT_LIMIT = 2 * 1024 * 1024;
export const WORKFLOW_ARTIFACT_COMPONENT_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const WORKFLOW_ARTIFACT_COMPONENT_REGEX = new RegExp(WORKFLOW_ARTIFACT_COMPONENT_PATTERN, "u");

export interface WorkflowArtifactRef {
  runId: string;
  artifactId: string;
  name: string;
  sha256: string;
}

export type WorkflowArtifactKind = "answer" | "transcript" | "result" | "published" | "input";
export type WorkflowArtifactProvenance = "fresh" | "replay" | "published" | "consumed";

export interface WorkflowArtifactRecord extends WorkflowArtifactRef {
  kind: WorkflowArtifactKind;
  mediaType: string;
  size: number;
  relativePath: string;
  provenance: WorkflowArtifactProvenance;
  createdAt: string;
  callId?: string;
  stage?: string;
  childSessionId?: string;
  source?: WorkflowArtifactRef;
  replaySourceRunId?: string;
}

export interface WorkflowArtifactIndex {
  version: typeof WORKFLOW_ARTIFACT_INDEX_VERSION;
  runId: string;
  artifacts: WorkflowArtifactRecord[];
}

export interface WorkflowArtifactSourceTarget {
  kind: "name" | "scriptPath";
  ref: string;
  source: "project" | "personal" | "package";
}

export interface WorkflowConsumedTextArtifact {
  ref: WorkflowArtifactRef;
  text: string;
  source: {
    runId: string;
    target: WorkflowArtifactSourceTarget;
    artifact: { kind: WorkflowArtifactKind; stage?: string };
    terminal: {
      result?: unknown;
      artifactRefs: WorkflowArtifactRef[];
    };
  };
}

/** Closed cross-run control input. Semantic workflow input remains a string. */
export interface WorkflowContinuation {
  originRunId: string;
  artifactRefs: WorkflowArtifactRef[];
}

/** One verified source ref bound to the immutable copy created in the current run. */
export interface WorkflowContinuationArtifact {
  readonly sourceRef: Readonly<WorkflowArtifactRef>;
  readonly consumedArtifact: WorkflowReadonlyConsumedTextArtifact;
}

export interface WorkflowReadonlyConsumedTextArtifact {
  readonly ref: Readonly<WorkflowArtifactRef>;
  readonly text: string;
  readonly source: {
    readonly runId: string;
    readonly target: Readonly<WorkflowArtifactSourceTarget>;
    readonly artifact: Readonly<{ kind: WorkflowArtifactKind; stage?: string }>;
    readonly terminal: {
      readonly result?: unknown;
      readonly artifactRefs: readonly Readonly<WorkflowArtifactRef>[];
    };
  };
}

export interface WorkflowBoundContinuation {
  readonly originRunId: string;
  readonly artifacts: readonly WorkflowContinuationArtifact[];
}

export interface WorkflowContinuationJournal {
  originRunId: string;
  artifacts: Array<{ sourceRef: WorkflowArtifactRef; consumedRef: WorkflowArtifactRef }>;
}

export interface WorkflowAgentEvidenceInput {
  callId: string;
  name: string;
  stage?: string;
  text?: string;
  replayed: boolean;
  replaySourceRunId?: string;
  childSessionId?: string;
  childTracePath?: string;
  resultArtifactPath?: string;
}

export interface WorkflowAgentEvidence {
  answer?: WorkflowArtifactRef;
  transcript?: WorkflowArtifactRef;
  result?: WorkflowArtifactRef;
}

export interface WorkflowArtifactPorts {
  recordAgentEvidence(input: WorkflowAgentEvidenceInput): WorkflowAgentEvidence;
  publishText(name: string, text: string, stage?: string): WorkflowArtifactRef;
  consumeText(ref: WorkflowArtifactRef, stage?: string): WorkflowConsumedTextArtifact;
}

export interface WorkflowChildEvidenceDestinations {
  transcriptDir: string;
  resultArtifactsDir: string;
}

export interface WorkflowArtifactStore extends WorkflowArtifactPorts {
  readonly runId: string;
  readonly artifactsDir: string;
  childEvidenceDestinations(callId: string): WorkflowChildEvidenceDestinations;
  list(): WorkflowArtifactRecord[];
  read(ref: WorkflowArtifactRef): Buffer;
}

/** Validate the complete continuation before copying any bytes into the new run. */
export function assertWorkflowContinuation(value: unknown): asserts value is WorkflowContinuation {
  if (!isRecord(value)) throw new Error("Workflow continuation must be an object.");
  if (hasUnexpectedFields(value, ["originRunId", "artifactRefs"])) {
    throw new Error("Workflow continuation has unexpected fields.");
  }
  assertSafeComponent(value.originRunId as string, "continuation originRunId");
  if (!Array.isArray(value.artifactRefs) || value.artifactRefs.length < 1 || value.artifactRefs.length > 8) {
    throw new Error("Workflow continuation must contain 1-8 artifactRefs.");
  }
  const identities = new Set<string>();
  for (const candidate of value.artifactRefs) {
    validateRef(candidate as WorkflowArtifactRef);
    const ref = candidate as WorkflowArtifactRef;
    if (ref.runId !== value.originRunId) {
      throw new Error("Every continuation artifact ref must belong to originRunId.");
    }
    const identity = `${ref.runId}\u001f${ref.artifactId}`;
    if (identities.has(identity)) throw new Error("Workflow continuation has a duplicate artifact identity.");
    identities.add(identity);
  }
}

/** Digest-verify and consume a validated continuation as exact source/current pairs. */
export function consumeWorkflowContinuation(store: WorkflowArtifactStore, value: unknown): WorkflowBoundContinuation {
  assertWorkflowContinuation(value);
  const artifacts = value.artifactRefs.map((sourceRef) => {
    const consumedArtifact = store.consumeText(sourceRef);
    return freezeContinuationArtifact({ sourceRef: cloneRef(sourceRef), consumedArtifact });
  });
  return Object.freeze({ originRunId: value.originRunId, artifacts: Object.freeze(artifacts) });
}

export function continuationJournalProjection(binding: WorkflowBoundContinuation): WorkflowContinuationJournal {
  return {
    originRunId: binding.originRunId,
    artifacts: binding.artifacts.map(({ sourceRef, consumedArtifact }) => ({
      sourceRef: cloneRef(sourceRef),
      consumedRef: cloneRef(consumedArtifact.ref),
    })),
  };
}

export interface CreateWorkflowArtifactStoreOptions {
  projectRoot: string;
  runId: string;
  runDir: string;
  now?: () => string;
  maxTextBytes?: number;
}

export type WorkflowArtifactIndexRead =
  { status: "ready"; index: WorkflowArtifactIndex } | { status: "missing" | "invalid"; message: string };

export type WorkflowArtifactRecordRead =
  | { status: "ready"; record: WorkflowArtifactRecord; bytes: Buffer }
  | { status: "missing" | "invalid" | "tampered"; message: string };

/** Side-effect-free persisted index read for viewers and diagnostics. */
export function readWorkflowArtifactIndex(projectRoot: string, runId: string): WorkflowArtifactIndexRead {
  try {
    assertSafeComponent(runId, "runId");
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
  const runDir = path.join(projectRoot, ".locus", "runtime", "workflows", runId);
  const artifactsDir = path.join(runDir, "artifacts");
  const indexPath = path.join(artifactsDir, "index.json");
  try {
    assertCanonicalRunDirectory(projectRoot, runDir, runId);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { status: "missing", message: `Workflow artifact index is missing for run ${runId}.` };
    }
    return { status: "invalid", message: errorMessage(error) };
  }
  if (!existsSync(indexPath)) {
    return { status: "missing", message: `Workflow artifact index is missing for run ${runId}.` };
  }
  try {
    const index = parseIndex(readRegularConfinedFile(artifactsDir, indexPath).toString("utf8"), runId);
    return { status: "ready", index: cloneIndex(index) };
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
}

/** Side-effect-free, digest-verifying read of one indexed artifact. */
export function readWorkflowArtifactRecord(
  projectRoot: string,
  runId: string,
  artifactId: string,
): WorkflowArtifactRecordRead {
  try {
    assertSafeComponent(artifactId, "artifactId");
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
  const indexRead = readWorkflowArtifactIndex(projectRoot, runId);
  if (indexRead.status !== "ready") return indexRead;
  const record = indexRead.index.artifacts.find((entry) => entry.artifactId === artifactId);
  if (record === undefined) {
    return { status: "missing", message: `Workflow artifact ${artifactId} is not indexed for run ${runId}.` };
  }
  const artifactsDir = path.join(projectRoot, ".locus", "runtime", "workflows", runId, "artifacts");
  try {
    const bytes = readRegularConfinedFile(artifactsDir, path.join(artifactsDir, record.relativePath));
    if (bytes.byteLength !== record.size || sha256(bytes) !== record.sha256) {
      return { status: "tampered", message: `Workflow artifact digest mismatch: ${record.artifactId}` };
    }
    return { status: "ready", record: cloneRecord(record), bytes };
  } catch (error) {
    return { status: "invalid", message: errorMessage(error) };
  }
}

export function createWorkflowArtifactStore(options: CreateWorkflowArtifactStoreOptions): WorkflowArtifactStore {
  assertSafeComponent(options.runId, "runId");
  const expectedRunDir = path.join(options.projectRoot, ".locus", "runtime", "workflows", options.runId);
  if (path.resolve(options.runDir) !== path.resolve(expectedRunDir)) {
    throw new Error("Workflow artifact run directory does not match the canonical run root.");
  }
  const artifactsDir = path.join(options.runDir, "artifacts");
  const indexPath = path.join(artifactsDir, "index.json");
  const now = options.now ?? (() => new Date().toISOString());
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_WORKFLOW_TEXT_ARTIFACT_LIMIT;
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1) {
    throw new Error("Workflow text artifact limit must be a positive safe integer.");
  }
  assertCanonicalRunDirectory(options.projectRoot, options.runDir, options.runId);
  ensureDirectoryNoSymlink(options.runDir, artifactsDir);
  assertCanonicalRunDirectory(options.projectRoot, options.runDir, options.runId);
  let index = existsSync(indexPath)
    ? parseIndex(readFileSync(indexPath, "utf8"), options.runId)
    : { version: WORKFLOW_ARTIFACT_INDEX_VERSION, runId: options.runId, artifacts: [] };
  let indexDigest = existsSync(indexPath) ? sha256(readFileSync(indexPath)) : undefined;

  function verifyIndexUnchanged(): void {
    if (indexDigest === undefined) {
      if (existsSync(indexPath)) throw new Error("Workflow artifact index changed outside its owner.");
      return;
    }
    const bytes = readRegularConfinedFile(artifactsDir, indexPath);
    if (sha256(bytes) !== indexDigest) throw new Error("Workflow artifact index changed outside its owner.");
  }

  function persistIndex(next: WorkflowArtifactIndex): void {
    verifyIndexUnchanged();
    const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
    const temp = path.join(artifactsDir, `.index-${process.pid}-${Date.now()}.tmp`);
    let tempCreated = false;
    try {
      writeFileSync(temp, bytes, { flag: "wx" });
      tempCreated = true;
      renameSync(temp, indexPath);
    } catch (error) {
      if (tempCreated && existsSync(temp)) unlinkSync(temp);
      throw error;
    }
    index = next;
    indexDigest = sha256(bytes);
  }

  function addRecord(
    input: Omit<WorkflowArtifactRecord, "runId" | "sha256" | "size" | "createdAt" | "relativePath"> & {
      bytes: Buffer;
      relativePath: string;
    },
  ): WorkflowArtifactRef {
    verifyIndexUnchanged();
    assertSafeComponent(input.artifactId, "artifactId");
    assertArtifactName(input.name);
    const relativePath = normalizeRelativePath(input.relativePath);
    if (index.artifacts.some((entry) => entry.artifactId === input.artifactId || entry.relativePath === relativePath)) {
      throw new Error(`Duplicate workflow artifact identity: ${input.artifactId}`);
    }
    const destination = path.join(artifactsDir, relativePath);
    ensureDirectoryNoSymlink(artifactsDir, path.dirname(destination));
    if (existsSync(destination)) throw new Error(`Workflow artifact destination already exists: ${relativePath}`);
    writeFileSync(destination, input.bytes, { flag: "wx" });
    try {
      const digest = sha256(input.bytes);
      const record: WorkflowArtifactRecord = {
        runId: options.runId,
        artifactId: input.artifactId,
        name: input.name,
        sha256: digest,
        kind: input.kind,
        mediaType: input.mediaType,
        size: input.bytes.byteLength,
        relativePath,
        provenance: input.provenance,
        createdAt: now(),
        ...(input.callId !== undefined ? { callId: input.callId } : {}),
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
        ...(input.source !== undefined ? { source: cloneRef(input.source) } : {}),
        ...(input.replaySourceRunId !== undefined ? { replaySourceRunId: input.replaySourceRunId } : {}),
      };
      persistIndex({ ...index, artifacts: [...index.artifacts, record] });
      return refFromRecord(record);
    } catch (error) {
      if (existsSync(destination)) unlinkSync(destination);
      throw error;
    }
  }

  function adoptFile(input: {
    artifactId: string;
    name: string;
    kind: "transcript" | "result";
    mediaType: string;
    sourcePath: string;
    callId: string;
    stage?: string;
    childSessionId?: string;
  }): WorkflowArtifactRef {
    const bytes = readRegularConfinedFile(artifactsDir, input.sourcePath);
    const relativePath = normalizeRelativePath(path.relative(artifactsDir, input.sourcePath));
    if (input.kind === "transcript") validateTranscript(bytes, input.childSessionId);
    return addExistingRecord({ ...input, relativePath, bytes, provenance: "fresh" });
  }

  function addExistingRecord(input: {
    artifactId: string;
    name: string;
    kind: WorkflowArtifactKind;
    mediaType: string;
    sourcePath: string;
    relativePath: string;
    callId: string;
    provenance: WorkflowArtifactProvenance;
    bytes: Buffer;
    stage?: string;
    childSessionId?: string;
  }): WorkflowArtifactRef {
    verifyIndexUnchanged();
    const relativePath = normalizeRelativePath(input.relativePath);
    if (index.artifacts.some((entry) => entry.artifactId === input.artifactId || entry.relativePath === relativePath)) {
      throw new Error(`Duplicate workflow artifact identity: ${input.artifactId}`);
    }
    const record: WorkflowArtifactRecord = {
      runId: options.runId,
      artifactId: input.artifactId,
      name: input.name,
      sha256: sha256(input.bytes),
      kind: input.kind,
      mediaType: input.mediaType,
      size: input.bytes.byteLength,
      relativePath,
      provenance: input.provenance,
      createdAt: now(),
      callId: input.callId,
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
    };
    persistIndex({ ...index, artifacts: [...index.artifacts, record] });
    return refFromRecord(record);
  }

  function recordAgentEvidence(input: WorkflowAgentEvidenceInput): WorkflowAgentEvidence {
    assertSafeComponent(input.callId, "callId");
    assertArtifactName(input.name);
    const evidence: WorkflowAgentEvidence = {};
    if (input.text !== undefined && input.text.trim() !== "") {
      const bytes = boundedText(input.text, maxTextBytes);
      evidence.answer = addRecord({
        artifactId: `${input.callId}-answer`,
        name: input.name,
        kind: "answer",
        mediaType: "text/markdown; charset=utf-8",
        bytes,
        relativePath: path.join("answers", `${input.callId}-${safeFilename(input.name)}.md`),
        provenance: input.replayed ? "replay" : "fresh",
        callId: input.callId,
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.replaySourceRunId !== undefined ? { replaySourceRunId: input.replaySourceRunId } : {}),
      });
    }
    if (input.replayed) return evidence;
    if (input.childSessionId !== undefined && input.childTracePath === undefined) {
      throw new Error(`Fresh child ${input.childSessionId} did not export a transcript.`);
    }
    if (input.childSessionId !== undefined && input.resultArtifactPath === undefined) {
      throw new Error(`Fresh child ${input.childSessionId} did not persist a result envelope.`);
    }
    if (input.childTracePath !== undefined) {
      evidence.transcript = adoptFile({
        artifactId: `${input.callId}-transcript`,
        name: `${input.name}.transcript`,
        kind: "transcript",
        mediaType: "application/x-ndjson",
        sourcePath: input.childTracePath,
        callId: input.callId,
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
      });
    }
    if (input.resultArtifactPath !== undefined) {
      evidence.result = adoptFile({
        artifactId: `${input.callId}-result`,
        name: `${input.name}.result`,
        kind: "result",
        mediaType: "application/json",
        sourcePath: input.resultArtifactPath,
        callId: input.callId,
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
      });
    }
    return evidence;
  }

  function publishText(name: string, text: string, stage?: string): WorkflowArtifactRef {
    assertArtifactName(name);
    const ordinal = index.artifacts.filter((entry) => entry.kind === "published").length + 1;
    const artifactId = `published-${String(ordinal).padStart(4, "0")}`;
    return addRecord({
      artifactId,
      name,
      kind: "published",
      mediaType: "text/markdown; charset=utf-8",
      bytes: boundedText(text, maxTextBytes),
      relativePath: path.join("published", `${artifactId}-${markdownFilename(name)}`),
      provenance: "published",
      ...(stage !== undefined ? { stage } : {}),
    });
  }

  function consumeText(ref: WorkflowArtifactRef, stage?: string): WorkflowConsumedTextArtifact {
    validateRef(ref);
    if (ref.runId === options.runId) throw new Error("Workflow artifact self-reference is not allowed.");
    const sourceRunDir = path.join(options.projectRoot, ".locus", "runtime", "workflows", ref.runId);
    const sourceResult = path.join(sourceRunDir, "result.json");
    assertCanonicalRunDirectory(options.projectRoot, sourceRunDir, ref.runId);
    const resultBytes = readRegularConfinedFile(sourceRunDir, sourceResult);
    const sourceEnvelope = parseSourceRunEnvelope(resultBytes, ref.runId);
    const sourceRead = readWorkflowArtifactRecord(options.projectRoot, ref.runId, ref.artifactId);
    if (sourceRead.status !== "ready") throw new Error(sourceRead.message);
    const sourceRecord = sourceRead.record;
    if (!sameRef(sourceRecord, ref)) throw new Error("Workflow artifact reference does not match its source index.");
    if (!sourceEnvelope.terminal.artifactRefs.some((projected) => sameArtifactRef(projected, ref))) {
      throw new Error("Workflow artifact reference is not present in the source run terminal projection.");
    }
    if (!sourceRecord.mediaType.startsWith("text/")) throw new Error("Workflow artifact is not text media.");
    if (sourceRecord.size > maxTextBytes) throw new Error("Workflow text artifact exceeds the configured size limit.");
    const bytes = sourceRead.bytes;
    const text = bytes.toString("utf8");
    const ordinal = index.artifacts.filter((entry) => entry.kind === "input").length + 1;
    const artifactId = `input-${String(ordinal).padStart(4, "0")}`;
    const currentRef = addRecord({
      artifactId,
      name: ref.name,
      kind: "input",
      mediaType: sourceRecord.mediaType,
      bytes,
      relativePath: path.join("inputs", `${artifactId}-${markdownFilename(ref.name)}`),
      provenance: "consumed",
      source: cloneRef(ref),
      ...(stage !== undefined ? { stage } : {}),
    });
    return {
      ref: currentRef,
      text,
      source: {
        runId: ref.runId,
        target: sourceEnvelope.target,
        artifact: {
          kind: sourceRecord.kind,
          ...(sourceRecord.stage !== undefined ? { stage: sourceRecord.stage } : {}),
        },
        terminal: sourceEnvelope.terminal,
      },
    };
  }

  if (indexDigest === undefined) persistIndex(index);

  return {
    runId: options.runId,
    artifactsDir,
    recordAgentEvidence,
    publishText,
    consumeText,
    childEvidenceDestinations(callId) {
      assertSafeComponent(callId, "callId");
      const transcriptDir = path.join(artifactsDir, "transcripts", callId);
      const resultArtifactsDir = path.join(artifactsDir, "results", callId);
      ensureDirectoryNoSymlink(artifactsDir, transcriptDir);
      ensureDirectoryNoSymlink(artifactsDir, resultArtifactsDir);
      return { transcriptDir, resultArtifactsDir };
    },
    list() {
      verifyIndexUnchanged();
      return index.artifacts.map(cloneRecord);
    },
    read(ref) {
      validateRef(ref);
      if (ref.runId !== options.runId) throw new Error("Workflow artifact belongs to another run.");
      verifyIndexUnchanged();
      const record = index.artifacts.find((entry) => entry.artifactId === ref.artifactId);
      if (record === undefined || !sameRef(record, ref))
        throw new Error("Workflow artifact reference does not match its index.");
      const bytes = readRegularConfinedFile(artifactsDir, path.join(artifactsDir, record.relativePath));
      if (bytes.byteLength !== record.size || sha256(bytes) !== record.sha256) {
        throw new Error(`Workflow artifact digest mismatch: ${record.artifactId}`);
      }
      return bytes;
    },
  };
}

function parseIndex(raw: string, expectedRunId: string): WorkflowArtifactIndex {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Workflow artifact index is corrupt: ${errorMessage(error)}`);
  }
  if (
    !isRecord(value) ||
    value.version !== WORKFLOW_ARTIFACT_INDEX_VERSION ||
    value.runId !== expectedRunId ||
    !Array.isArray(value.artifacts)
  ) {
    throw new Error("Workflow artifact index has an invalid envelope.");
  }
  if (hasUnexpectedFields(value, ["version", "runId", "artifacts"])) {
    throw new Error("Workflow artifact index has unexpected fields.");
  }
  const artifacts = value.artifacts.map((entry) => parseRecord(entry, expectedRunId));
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const record of artifacts) {
    if (ids.has(record.artifactId) || paths.has(record.relativePath))
      throw new Error("Workflow artifact index has duplicate identities.");
    ids.add(record.artifactId);
    paths.add(record.relativePath);
  }
  return { version: WORKFLOW_ARTIFACT_INDEX_VERSION, runId: expectedRunId, artifacts };
}

function parseRecord(value: unknown, runId: string): WorkflowArtifactRecord {
  if (!isRecord(value) || value.runId !== runId)
    throw new Error("Workflow artifact index has an invalid record run id.");
  const required = [
    "artifactId",
    "name",
    "sha256",
    "kind",
    "mediaType",
    "relativePath",
    "provenance",
    "createdAt",
  ] as const;
  for (const field of required)
    if (typeof value[field] !== "string") throw new Error(`Workflow artifact record has invalid ${field}.`);
  const allowed = ["runId", ...required, "size", "callId", "stage", "childSessionId", "source", "replaySourceRunId"];
  if (hasUnexpectedFields(value, allowed)) throw new Error("Workflow artifact record has unexpected fields.");
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0)
    throw new Error("Workflow artifact record has invalid size.");
  validateRef({
    runId,
    artifactId: value.artifactId as string,
    name: value.name as string,
    sha256: value.sha256 as string,
  });
  if (!isArtifactKind(value.kind) || !isProvenance(value.provenance))
    throw new Error("Workflow artifact record has invalid kind/provenance.");
  const relativePath = normalizeRelativePath(value.relativePath as string);
  const callId = optionalSafeComponent(value.callId, "callId");
  const stage = optionalNonEmptyString(value.stage, "stage");
  const childSessionId = optionalNonEmptyString(value.childSessionId, "childSessionId");
  const replaySourceRunId = optionalSafeComponent(value.replaySourceRunId, "replaySourceRunId");
  if (value.source !== undefined) validateRef(value.source as WorkflowArtifactRef);
  return {
    runId,
    artifactId: value.artifactId as string,
    name: value.name as string,
    sha256: value.sha256 as string,
    kind: value.kind as WorkflowArtifactKind,
    mediaType: value.mediaType as string,
    size: value.size as number,
    relativePath,
    provenance: value.provenance as WorkflowArtifactProvenance,
    createdAt: value.createdAt as string,
    ...(callId !== undefined ? { callId } : {}),
    ...(stage !== undefined ? { stage } : {}),
    ...(childSessionId !== undefined ? { childSessionId } : {}),
    ...(value.source !== undefined ? { source: cloneRef(value.source as WorkflowArtifactRef) } : {}),
    ...(replaySourceRunId !== undefined ? { replaySourceRunId } : {}),
  };
}

function parseSourceRunEnvelope(
  bytes: Buffer,
  runId: string,
): {
  target: WorkflowArtifactSourceTarget;
  terminal: { result?: unknown; artifactRefs: WorkflowArtifactRef[] };
} {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Source workflow run is not usable: ${runId}: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || value.ok !== true || !isRecord(value.target)) {
    throw new Error(`Source workflow run is not usable: ${runId}`);
  }
  const target = value.target;
  if (
    (target.kind !== "name" && target.kind !== "scriptPath") ||
    typeof target.ref !== "string" ||
    target.ref.trim() === "" ||
    (target.source !== "project" && target.source !== "personal" && target.source !== "package")
  ) {
    throw new Error(`Source workflow run has an invalid target identity: ${runId}`);
  }
  let artifactRefs: WorkflowArtifactRef[] = [];
  if (value.artifactRefs !== undefined) {
    if (!Array.isArray(value.artifactRefs)) {
      throw new Error(`Source workflow run has invalid artifact references: ${runId}`);
    }
    try {
      artifactRefs = value.artifactRefs.map((ref) => {
        validateRef(ref as WorkflowArtifactRef);
        return cloneRef(ref as WorkflowArtifactRef);
      });
    } catch {
      throw new Error(`Source workflow run has invalid artifact references: ${runId}`);
    }
  }
  return {
    target: { kind: target.kind, ref: target.ref, source: target.source },
    terminal: {
      ...(Object.prototype.hasOwnProperty.call(value, "result") ? { result: value.result } : {}),
      artifactRefs,
    },
  };
}

function optionalSafeComponent(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Workflow artifact record has invalid ${field}.`);
  assertSafeComponent(value, field);
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Workflow artifact record has invalid ${field}.`);
  }
  return value;
}

function hasUnexpectedFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).some((key) => !allowedSet.has(key));
}

function validateRef(ref: WorkflowArtifactRef): void {
  if (!isRecord(ref)) throw new Error("Workflow artifact reference must be an object.");
  assertSafeComponent(ref.runId, "runId");
  assertSafeComponent(ref.artifactId, "artifactId");
  assertArtifactName(ref.name);
  if (typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(ref.sha256)) {
    throw new Error("Workflow artifact reference has an invalid sha256.");
  }
  const keys = Object.keys(ref);
  if (keys.some((key) => !["runId", "artifactId", "name", "sha256"].includes(key))) {
    throw new Error("Workflow artifact reference has unexpected fields.");
  }
}

function readRegularConfinedFile(root: string, file: string): Buffer {
  const lexicalRoot = path.resolve(root);
  const lexicalFile = path.resolve(file);
  const relative = path.relative(lexicalRoot, lexicalFile);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Workflow artifact path escapes its run root.");
  const rootStat = lstatSync(lexicalRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Workflow artifact root is not a regular directory.");
  }
  assertNoSymlinkChain(lexicalRoot, path.dirname(lexicalFile));
  const stat = lstatSync(lexicalFile);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Workflow artifact is not a regular file.");
  const physicalRoot = realpathSync(lexicalRoot);
  const physicalFile = realpathSync(lexicalFile);
  const physicalRelative = path.relative(physicalRoot, physicalFile);
  if (physicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(physicalRelative))
    throw new Error("Workflow artifact escapes its physical run root.");
  return readFileSync(lexicalFile);
}

function assertCanonicalRunDirectory(projectRoot: string, runDir: string, runId: string): void {
  const lexicalProjectRoot = path.resolve(projectRoot);
  const lexicalRunDir = path.resolve(runDir);
  const expectedLexicalRunDir = path.join(lexicalProjectRoot, ".locus", "runtime", "workflows", runId);
  if (lexicalRunDir !== expectedLexicalRunDir) {
    throw new Error("Workflow artifact run directory does not match the canonical run root.");
  }

  const physicalProjectRoot = realpathSync(lexicalProjectRoot);
  const projectStat = lstatSync(physicalProjectRoot);
  if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
    throw new Error("Workflow artifact project root is not a regular directory.");
  }
  const expectedPhysicalRunDir = path.join(physicalProjectRoot, ".locus", "runtime", "workflows", runId);
  assertNoSymlinkChain(physicalProjectRoot, expectedPhysicalRunDir);
  if (realpathSync(lexicalRunDir) !== expectedPhysicalRunDir) {
    throw new Error("Workflow artifact run directory escapes its physical project root.");
  }
}

function ensureDirectoryNoSymlink(root: string, directory: string): void {
  const lexicalRoot = path.resolve(root);
  const lexicalDirectory = path.resolve(directory);
  const relative = path.relative(lexicalRoot, lexicalDirectory);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Workflow artifact directory escapes its run root.");
  if (existsSync(lexicalRoot) && lstatSync(lexicalRoot).isSymbolicLink())
    throw new Error("Workflow run root must not be a symlink.");
  mkdirSync(lexicalDirectory, { recursive: true });
  assertNoSymlinkChain(lexicalRoot, lexicalDirectory);
}

function assertNoSymlinkChain(root: string, target: string): void {
  let current = path.resolve(root);
  const relative = path.relative(current, path.resolve(target));
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Workflow artifact path escapes its root.");
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`Workflow artifact directory is unsafe: ${current}`);
  }
}

function validateTranscript(bytes: Buffer, childSessionId?: string): void {
  const firstLine = bytes.toString("utf8").split("\n", 1)[0]?.trim() ?? "";
  if (firstLine === "") throw new Error("Child transcript header is missing.");
  const header = JSON.parse(firstLine) as unknown;
  if (
    !isRecord(header) ||
    header.type !== "session" ||
    (childSessionId !== undefined && header.id !== childSessionId)
  ) {
    throw new Error("Child transcript header does not match its session.");
  }
}

function boundedText(text: string, limit: number): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > limit) throw new Error(`Workflow text artifact exceeds ${limit} bytes.`);
  return bytes;
}

function normalizeRelativePath(value: string): string {
  const normalized = path.normalize(value);
  if (
    normalized === "." ||
    path.isAbsolute(normalized) ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized === ".."
  ) {
    throw new Error("Workflow artifact relative path is unsafe.");
  }
  return normalized;
}

function assertSafeComponent(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !WORKFLOW_ARTIFACT_COMPONENT_REGEX.test(value))
    throw new Error(`Invalid workflow artifact ${field}: ${JSON.stringify(value)}`);
}

function assertArtifactName(value: unknown): asserts value is string {
  assertSafeComponent(value, "name");
}

function safeFilename(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "artifact"
  );
}

function markdownFilename(value: string): string {
  const safe = safeFilename(value);
  return safe.endsWith(".md") ? safe : `${safe}.md`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function refFromRecord(record: WorkflowArtifactRecord): WorkflowArtifactRef {
  return { runId: record.runId, artifactId: record.artifactId, name: record.name, sha256: record.sha256 };
}

function cloneRef(ref: WorkflowArtifactRef): WorkflowArtifactRef {
  return { ...ref };
}

function freezeContinuationArtifact(input: {
  sourceRef: WorkflowArtifactRef;
  consumedArtifact: WorkflowConsumedTextArtifact;
}): WorkflowContinuationArtifact {
  const sourceRef = Object.freeze(cloneRef(input.sourceRef));
  const consumed = input.consumedArtifact;
  const consumedArtifact = Object.freeze({
    ref: Object.freeze(cloneRef(consumed.ref)),
    text: consumed.text,
    source: Object.freeze({
      runId: consumed.source.runId,
      target: Object.freeze({ ...consumed.source.target }),
      artifact: Object.freeze({ ...consumed.source.artifact }),
      terminal: Object.freeze({
        ...(Object.prototype.hasOwnProperty.call(consumed.source.terminal, "result")
          ? { result: consumed.source.terminal.result }
          : {}),
        artifactRefs: Object.freeze(consumed.source.terminal.artifactRefs.map((ref) => Object.freeze(cloneRef(ref)))),
      }),
    }),
  });
  return Object.freeze({ sourceRef, consumedArtifact });
}

function cloneRecord(record: WorkflowArtifactRecord): WorkflowArtifactRecord {
  return { ...record, ...(record.source !== undefined ? { source: cloneRef(record.source) } : {}) };
}

function cloneIndex(index: WorkflowArtifactIndex): WorkflowArtifactIndex {
  return { ...index, artifacts: index.artifacts.map(cloneRecord) };
}

function sameRef(record: WorkflowArtifactRecord, ref: WorkflowArtifactRef): boolean {
  return (
    record.runId === ref.runId &&
    record.artifactId === ref.artifactId &&
    record.name === ref.name &&
    record.sha256 === ref.sha256
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

function isArtifactKind(value: unknown): value is WorkflowArtifactKind {
  return (
    value === "answer" || value === "transcript" || value === "result" || value === "published" || value === "input"
  );
}

function isProvenance(value: unknown): value is WorkflowArtifactProvenance {
  return value === "fresh" || value === "replay" || value === "published" || value === "consumed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
