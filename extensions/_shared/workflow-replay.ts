/**
 * workflow-replay.ts — recorded-call store for `--resume`.
 *
 * A resumed run does not re-spawn a child whose exact request already ran: it
 * returns the recorded answer. This module owns the whole mechanism — the
 * `replay.ndjson` record inside the existing run directory, the call key, the
 * read cursors, and the ONE latch that makes replay a strict prefix.
 *
 * Two invariants shape everything here:
 *
 *   1. FAIL CLOSED. An entry that cannot be resolved — missing, keyed for a
 *      different request, recorded as a failure, or positioned after a
 *      divergence — is reported as a MISS, and the caller runs the real child.
 *      No branch of this module can invent an answer.
 *   2. STRICT PREFIX. The first key mismatch sets `#diverged` and every later
 *      lookup misses, including lookups whose own key would have matched. A
 *      later call's recorded answer was produced in a context that no longer
 *      exists, so reusing it would be a silent lie about what the run observed.
 *
 * Why a sidecar instead of `journal.ndjson`: the journal deliberately records no
 * prompt and no child text (see `WorkflowJournalLine`). Putting them there would
 * push unbounded model output into `/workflows status`, the bounded transcript
 * digest, and the live panel. The journal keeps the `replayed` MARKER; this file
 * keeps the payload, in the same run directory beside `result.json`.
 *
 * Filesystem surface only — the pure runtime talks to `WorkflowReplayController`.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { workflowRunDir } from "./workflow-journal.js";

export const WORKFLOW_REPLAY_FILE = "replay.ndjson";
export const WORKFLOW_REPLAY_SCHEMA_VERSION = 1 as const;

/** Recorded nondeterministic value kinds, one cursor each. */
export type WorkflowReplayValueKind = "clock" | "random";

/** Why a requested replay did not happen. Every value is operator-facing text. */
export type WorkflowReplayRefusalReason =
  | "source-run-unusable"
  | "script-changed"
  | "identity-coverage-unproven"
  | "replay-unsafe-script"
  | "no-recorded-calls";

/** Why this run wrote no replay record a later resume could use. */
export type WorkflowReplayNotRecordedReason = "identity-coverage-unproven" | "replay-unsafe-script";

export type WorkflowReplayEntry =
  | { v: typeof WORKFLOW_REPLAY_SCHEMA_VERSION; seq: number; kind: "agent"; key: string; ok: true; text: string }
  | { v: typeof WORKFLOW_REPLAY_SCHEMA_VERSION; seq: number; kind: "agent"; key: string; ok: false }
  | { v: typeof WORKFLOW_REPLAY_SCHEMA_VERSION; seq: number; kind: WorkflowReplayValueKind; value: number };

export type WorkflowReplayAgentEntry = Extract<WorkflowReplayEntry, { kind: "agent" }>;

/** Why one agent attempt was not served from the record. Never a silent miss. */
export type WorkflowReplayMissReason =
  "no-record" | "key-mismatch" | "recorded-failure" | "side-effecting-call" | "diverged";

export type WorkflowReplayAgentLookup =
  { replayed: true; text: string } | { replayed: false; reason: WorkflowReplayMissReason };

/**
 * What one run did about replay, persisted verbatim into `result.json`.
 *
 * Two independent booleans on purpose: `replayed` answers "did this run reuse
 * recorded evidence" (the honesty question), `recorded` answers "can a later
 * resume reuse THIS run" (the capability question). A run can be neither, one,
 * or both, and collapsing them into a single status word loses a real case.
 */
export interface WorkflowReplayEnvelope {
  replayed: boolean;
  recorded: boolean;
  sourceRunId?: string;
  /** Present exactly when a resume was requested and replay did not happen. */
  refusedReason?: WorkflowReplayRefusalReason;
  /** Present exactly when `recorded` is false. */
  notRecordedReason?: WorkflowReplayNotRecordedReason;
  replayedCalls: number;
  freshCalls: number;
  divergedAtCall?: number;
}

export interface WorkflowReplayCounts {
  replayedCalls: number;
  freshCalls: number;
  /** 0-based ordinal of the first agent attempt that broke the prefix, if any. */
  divergedAtCall?: number;
}

/**
 * The seam the pure runtime receives. It hides the file, the hashing, the
 * cursors, and the latch; the runtime only supplies a canonical request string
 * and says whether the call is safe to serve from a record.
 */
export interface WorkflowReplayController {
  /**
   * Claim the next recorded agent attempt. ALWAYS advances the read cursor, so
   * the caller must invoke it exactly once per attempt, even when it will not
   * use the answer.
   */
  beginAgentAttempt(canonicalRequest: string, replayable: boolean): WorkflowReplayAgentLookup;
  /** Record this run's own outcome for the attempt just begun. */
  recordAgentAttempt(canonicalRequest: string, outcome: { ok: true; text: string } | { ok: false }): void;
  /** Replay a recorded value, or produce and record a fresh one. */
  resolveValue(kind: WorkflowReplayValueKind, produce: () => number): number;
  counts(): WorkflowReplayCounts;
}

export function workflowReplayFile(runDir: string): string {
  return path.join(runDir, WORKFLOW_REPLAY_FILE);
}

/**
 * Read one run's recorded calls. Best-effort in the same sense as the journal
 * reader: a malformed or partially written line is skipped rather than thrown,
 * because a truncated record must degrade into "fewer replayable calls", never
 * into a failed resume.
 */
export function readWorkflowReplayLog(projectRoot: string, runId: string): WorkflowReplayEntry[] {
  let raw: string;
  try {
    raw = readFileSync(workflowReplayFile(workflowRunDir(projectRoot, runId)), "utf8");
  } catch {
    return [];
  }
  const entries: WorkflowReplayEntry[] = [];
  for (const row of raw.split("\n")) {
    const trimmed = row.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = parseReplayEntry(parsed);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

export interface CreateWorkflowReplayControllerOptions {
  /** Run directory of the run being executed now; its record is written here. */
  runDir: string;
  /** Recorded entries from the resume source. Omit to record without replaying. */
  recorded?: readonly WorkflowReplayEntry[];
}

export function createWorkflowReplayController(
  options: CreateWorkflowReplayControllerOptions,
): WorkflowReplayController {
  return new FileBackedWorkflowReplayController(options);
}

class FileBackedWorkflowReplayController implements WorkflowReplayController {
  readonly #recordPath: string;
  readonly #recordedAgents: readonly WorkflowReplayAgentEntry[];
  readonly #recordedValues: ReadonlyMap<WorkflowReplayValueKind, readonly number[]>;
  readonly #replayEnabled: boolean;
  #readCursor = 0;
  #writeCursor = 0;
  readonly #valueCursors = new Map<WorkflowReplayValueKind, number>();
  readonly #valueWriteCursors = new Map<WorkflowReplayValueKind, number>();
  #diverged = false;
  #divergedAtCall: number | undefined;
  #replayedCalls = 0;
  #freshCalls = 0;
  #directoryEnsured = false;

  constructor(options: CreateWorkflowReplayControllerOptions) {
    this.#recordPath = workflowReplayFile(options.runDir);
    const recorded = options.recorded ?? [];
    this.#replayEnabled = options.recorded !== undefined;
    this.#recordedAgents = recorded.filter((entry): entry is WorkflowReplayAgentEntry => entry.kind === "agent");
    const values = new Map<WorkflowReplayValueKind, number[]>();
    for (const entry of recorded) {
      if (entry.kind === "agent") continue;
      const bucket = values.get(entry.kind);
      if (bucket === undefined) values.set(entry.kind, [entry.value]);
      else bucket.push(entry.value);
    }
    this.#recordedValues = values;
  }

  beginAgentAttempt(canonicalRequest: string, replayable: boolean): WorkflowReplayAgentLookup {
    const ordinal = this.#readCursor;
    this.#readCursor += 1;
    const miss = (reason: WorkflowReplayMissReason): WorkflowReplayAgentLookup => {
      this.#freshCalls += 1;
      return { replayed: false, reason };
    };
    if (!this.#replayEnabled) return miss("no-record");
    if (this.#diverged) return miss("diverged");

    const entry = this.#recordedAgents[ordinal];
    if (entry === undefined) return miss("no-record");
    if (entry.key !== hashCanonicalRequest(canonicalRequest)) {
      // The recorded request at this position is not the request being made, so
      // every later recorded answer belongs to a run that no longer exists.
      this.#diverged = true;
      this.#divergedAtCall = ordinal;
      return miss("key-mismatch");
    }
    // From here the key matches, so the prefix stays intact whatever we return:
    // the caller re-executes the identical request and the run continues in the
    // same shape the record describes.
    if (!entry.ok) return miss("recorded-failure");
    if (!replayable) return miss("side-effecting-call");

    this.#replayedCalls += 1;
    return { replayed: true, text: entry.text };
  }

  recordAgentAttempt(canonicalRequest: string, outcome: { ok: true; text: string } | { ok: false }): void {
    const seq = this.#writeCursor;
    this.#writeCursor += 1;
    const key = hashCanonicalRequest(canonicalRequest);
    this.#append(
      outcome.ok
        ? { v: WORKFLOW_REPLAY_SCHEMA_VERSION, seq, kind: "agent", key, ok: true, text: outcome.text }
        : { v: WORKFLOW_REPLAY_SCHEMA_VERSION, seq, kind: "agent", key, ok: false },
    );
  }

  // TODO(iteration-2026-07-21): value entries have no integrity key. An agent
  // entry fails closed on a request-hash mismatch; a `clock`/`random` entry is
  // matched by per-kind array POSITION only, and `readWorkflowReplayLog` skips
  // malformed lines silently — so one truncated value line shifts every later
  // `dsl.now()`/`dsl.random()` by one and replays a WRONG value with no
  // divergence signal. The recorded `seq` is parsed and then never used; keying
  // or ordinal-checking against it is the obvious fix. Deferred: deterministic
  // replay is out of scope this iteration (MVP = one working chain of agents).
  // See `.locus/reviews/2026-07-21-workflow-dsl/reconciliation-1.md` (A5, S3).
  resolveValue(kind: WorkflowReplayValueKind, produce: () => number): number {
    const ordinal = this.#valueCursors.get(kind) ?? 0;
    this.#valueCursors.set(kind, ordinal + 1);
    const recorded = this.#replayEnabled && !this.#diverged ? this.#recordedValues.get(kind)?.[ordinal] : undefined;
    const value = recorded ?? produce();
    const seq = this.#valueWriteCursors.get(kind) ?? 0;
    this.#valueWriteCursors.set(kind, seq + 1);
    this.#append({ v: WORKFLOW_REPLAY_SCHEMA_VERSION, seq, kind, value });
    return value;
  }

  counts(): WorkflowReplayCounts {
    return {
      replayedCalls: this.#replayedCalls,
      freshCalls: this.#freshCalls,
      ...(this.#divergedAtCall !== undefined ? { divergedAtCall: this.#divergedAtCall } : {}),
    };
  }

  #append(entry: WorkflowReplayEntry): void {
    try {
      if (!this.#directoryEnsured) {
        mkdirSync(path.dirname(this.#recordPath), { recursive: true });
        this.#directoryEnsured = true;
      }
      appendFileSync(this.#recordPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // A record that cannot be written costs a future resume, never this run.
      // Same discipline as the journal sink: never throw into the DSL.
    }
  }
}

/**
 * Stable identity of one child request. The canonical string already carries the
 * prompt and every resolved option; hashing keeps the record line bounded and
 * keeps prompt bytes out of the comparison path.
 */
export function hashCanonicalRequest(canonicalRequest: string): string {
  return createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
}

function parseReplayEntry(value: unknown): WorkflowReplayEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== WORKFLOW_REPLAY_SCHEMA_VERSION) return undefined;
  if (typeof record.seq !== "number" || !Number.isInteger(record.seq) || record.seq < 0) return undefined;
  if (record.kind === "agent") {
    if (typeof record.key !== "string" || !/^[a-f0-9]{64}$/u.test(record.key)) return undefined;
    if (record.ok === true) {
      return typeof record.text === "string"
        ? {
            v: WORKFLOW_REPLAY_SCHEMA_VERSION,
            seq: record.seq,
            kind: "agent",
            key: record.key,
            ok: true,
            text: record.text,
          }
        : undefined;
    }
    if (record.ok === false) {
      return { v: WORKFLOW_REPLAY_SCHEMA_VERSION, seq: record.seq, kind: "agent", key: record.key, ok: false };
    }
    return undefined;
  }
  if (record.kind !== "clock" && record.kind !== "random") return undefined;
  if (typeof record.value !== "number" || !Number.isFinite(record.value)) return undefined;
  return { v: WORKFLOW_REPLAY_SCHEMA_VERSION, seq: record.seq, kind: record.kind, value: record.value };
}
