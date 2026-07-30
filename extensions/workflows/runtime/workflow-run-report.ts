/**
 * workflow-run-report.ts — the reader's copy of one workflow run, under
 * `<projectRoot>/.locus-pi/<runId>/`.
 *
 * The state directory (`.locus/runtime/workflows/<runId>/`) stays machine-owned:
 * journal, replay record, result envelope, script snapshot, transcripts, and the
 * hash-verified artifact store that replay and continuations depend on. This
 * module projects the human-facing part of that evidence — the task, the final
 * result, and the run's documents — so that opening the report folder answers
 * "what happened here" without opening a single machine file.
 *
 * Documents are projected as an update cycle, not an accumulation: an artifact
 * NAME is one document, and a name that was written several times (a plan
 * redrafted each round, a task ledger republished per step) becomes ONE file
 * holding the newest revision, with the README listing every revision and
 * linking each one's verbatim bytes in the machine store. A reader who opens
 * `plan.md` gets the plan as it stood when the run ended; a reader who wants
 * round 2 follows the revision link. The superseded projection — one
 * `NN-author-name` copy per write — duplicated every revision into the folder
 * and made the current document a filename guess.
 *
 * Best-effort by contract, like result.md: a failed report write costs the
 * reader's copy, never the run or its durable evidence.
 */

import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXECUTED_MODEL_UNAVAILABLE } from "../../_shared/agent-runtime/agent-runner.js";
import {
  ensureWorkflowDirectoryNoSymlink,
  WORKFLOW_ARTIFACT_COMPONENT_PATTERN,
  type WorkflowArtifactRecord,
  type WorkflowArtifactRef,
} from "./workflow-artifacts.js";
import type { WorkflowBudget } from "./workflow-budget.js";
import type { WorkflowJournalLine } from "./workflow-runtime.js";

export const WORKFLOW_REPORT_ROOT_DIRNAME = ".locus-pi";

const WORKFLOW_REPORT_COMPONENT_REGEX = new RegExp(WORKFLOW_ARTIFACT_COMPONENT_PATTERN, "u");
/** Extensions worth preserving verbatim; anything else becomes readable Markdown. */
const WORKFLOW_REPORT_EXTENSION_REGEX = /\.[A-Za-z0-9]{1,8}$/u;

export function workflowReportRootDir(projectRoot: string): string {
  return path.join(projectRoot, WORKFLOW_REPORT_ROOT_DIRNAME);
}

export function workflowReportDir(projectRoot: string, runId: string): string {
  return path.join(workflowReportRootDir(projectRoot), runId);
}

export interface WorkflowRunReportInput {
  projectRoot: string;
  runId: string;
  /** Terminal disposition status: completed / awaiting_operator / cancelled / failed. */
  status: string;
  target?: { kind: string; ref: string; source: string };
  result?: unknown;
  error?: string;
  journal: readonly WorkflowJournalLine[];
  /** What this run was allowed to spend, and the one spend figure the journal
   *  cannot produce. Absent only for callers that predate the budget contract. */
  budget?: WorkflowRunReportBudget;
}

export interface WorkflowRunReportBudget {
  applied: WorkflowBudget;
  /**
   * Gate-owned high-water mark of simultaneously executing leaf agents. It cannot
   * be recomputed from the journal: `agent_start` is written before the
   * concurrency gate is acquired, so overlapping start/end intervals count queued
   * children too. That is demand, and printing it against a concurrency limit
   * would show a breach that never happened.
   */
  peakConcurrency: number;
}

/** The slice of the artifact store the report needs; the store itself satisfies it. */
export interface WorkflowRunReportEvidenceSource {
  list(): WorkflowArtifactRecord[];
  read(ref: WorkflowArtifactRef): Buffer;
}

export type WorkflowRunReportOutcome = { ok: true; path: string; documents: number } | { ok: false; message: string };

/** One write of a document: who produced these bytes and where they live verbatim. */
interface WorkflowReportRevision {
  author: string;
  kind: string;
  stage?: string;
  /** For continuation copies (kind `input`): the run the bytes came from. */
  sourceRunId?: string;
  /** For agent answers: the model the child SESSION reported it ran on. */
  executedModel?: string;
  /** For agent answers: the declared tier had no assignment and the session model was used. */
  modelRoleFallback?: string;
  /** Repo-relative-from-report link target of the verbatim machine bytes. */
  machineHref: string;
}

/** One document — one artifact name — with its whole revision chain in creation order. */
interface WorkflowReportDocument {
  fileName: string;
  name: string;
  revisions: WorkflowReportRevision[];
  unavailable?: string;
}

/** One child transcript, named by the stage that produced it. */
interface WorkflowReportTranscript {
  author: string;
  stage?: string;
  machineHref: string;
}

/** Write the whole report folder for one finished run. Never throws. */
export function writeWorkflowRunReport(
  input: WorkflowRunReportInput,
  evidence: WorkflowRunReportEvidenceSource,
): WorkflowRunReportOutcome {
  try {
    const reportDir = canonicalReportDir(input.projectRoot, input.runId);

    let records: WorkflowArtifactRecord[] = [];
    let indexUnavailable: string | undefined;
    try {
      records = evidence.list();
    } catch (error) {
      indexUnavailable = errorMessage(error);
    }

    const authors = authorsByCallId(input.journal);
    const executions = executionsByCallId(input.journal);
    const machineArtifactsHref = `../../.locus/runtime/workflows/${input.runId}/artifacts`;
    const readable = records.filter(
      (record) => record.kind === "answer" || record.kind === "published" || record.kind === "input",
    );
    const taskRecord = readable.find((record) => record.kind === "published" && isTaskName(record.name));
    const chain = readable.filter((record) => record !== taskRecord);

    let taskWritten = false;
    if (taskRecord !== undefined) {
      const bytes = tryRead(evidence, taskRecord);
      if (bytes !== undefined) {
        writeFileSync(path.join(reportDir, "task.md"), bytes);
        taskWritten = true;
      }
    }

    const revisionOf = (record: WorkflowArtifactRecord): WorkflowReportRevision => {
      const execution = record.callId !== undefined ? executions.get(record.callId) : undefined;
      return {
        author: documentAuthor(record, authors),
        kind: record.kind,
        ...(record.stage !== undefined ? { stage: record.stage } : {}),
        ...(record.kind === "input" && record.source?.runId !== undefined ? { sourceRunId: record.source.runId } : {}),
        // Which model produced this revision. Read from `agent_end`, which is the only
        // line that can know it — `agent_start` is written before anything executes.
        ...(execution?.executedModel !== undefined ? { executedModel: execution.executedModel } : {}),
        ...(execution?.modelRoleFallback !== undefined ? { modelRoleFallback: execution.modelRoleFallback } : {}),
        machineHref: `${machineArtifactsHref}/${hrefPath(record.relativePath)}`,
      };
    };

    // One document per artifact NAME, in first-write order; the newest revision's
    // bytes become the document file. `README.md`, `task.md` and `result.md` are
    // runner-owned names, so a document is never allowed to claim them.
    const byName = new Map<string, WorkflowArtifactRecord[]>();
    for (const record of chain) {
      const revisions = byName.get(record.name) ?? [];
      revisions.push(record);
      byName.set(record.name, revisions);
    }
    const claimedFileNames = new Set(["readme.md", "task.md", "result.md"]);
    const documents: WorkflowReportDocument[] = [];
    for (const [name, revisionRecords] of byName) {
      const newest = revisionRecords[revisionRecords.length - 1]!;
      const bytes = tryRead(evidence, newest);
      // A JSON document is machine truth; the reader gets a Markdown rendering
      // of it, and the verbatim bytes stay in the artifact store.
      const rendered = bytes !== undefined && newest.name.endsWith(".json") ? renderedJsonMarkdown(bytes) : undefined;
      const fileName = claimDocumentFileName(name, rendered !== undefined, claimedFileNames);
      const document: WorkflowReportDocument = {
        fileName,
        name,
        revisions: revisionRecords.map(revisionOf),
      };
      if (bytes === undefined) {
        document.unavailable = "the stored artifact could not be read back";
      } else {
        writeFileSync(path.join(reportDir, fileName), rendered ?? bytes);
      }
      documents.push(document);
    }

    const transcripts: WorkflowReportTranscript[] = records
      .filter((record) => record.kind === "transcript")
      .map((record) => {
        const author = record.callId !== undefined ? authors.get(record.callId) : undefined;
        return {
          author: author ?? "agent",
          ...(record.stage !== undefined ? { stage: record.stage } : {}),
          machineHref: `${machineArtifactsHref}/${hrefPath(record.relativePath)}`,
        };
      });

    const resultText = typeof input.result === "string" && input.result.trim() !== "" ? input.result : undefined;
    if (resultText !== undefined) {
      writeFileSync(path.join(reportDir, "result.md"), resultText.endsWith("\n") ? resultText : `${resultText}\n`);
    }

    writeFileSync(
      path.join(reportDir, "README.md"),
      reportReadme({
        input,
        documents,
        transcripts,
        taskWritten,
        hasResultText: resultText !== undefined,
        hasStructuredResult: resultText === undefined && input.result !== undefined,
        ...(indexUnavailable !== undefined ? { indexUnavailable } : {}),
      }),
    );

    return { ok: true, path: reportDir, documents: documents.length };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The report root mirrors the artifact store's path discipline: the directory
 * is created below the physical project root and every component down to the
 * run folder must be a regular, non-symlink directory. A symlinked `.locus-pi`
 * must not redirect run results outside the project.
 */
function canonicalReportDir(projectRoot: string, runId: string): string {
  if (!WORKFLOW_REPORT_COMPONENT_REGEX.test(runId)) {
    throw new Error(`Invalid workflow run id for report: ${JSON.stringify(runId)}`);
  }
  const physicalProjectRoot = realpathSync(path.resolve(projectRoot));
  const rootStat = lstatSync(physicalProjectRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Workflow report project root is not a regular directory.");
  }
  const reportDir = path.join(physicalProjectRoot, WORKFLOW_REPORT_ROOT_DIRNAME, runId);
  // Check the existing chain BEFORE mkdir: a symlinked `.locus-pi` must not have
  // even an empty run directory created through it.
  let current = physicalProjectRoot;
  for (const part of [WORKFLOW_REPORT_ROOT_DIRNAME, runId]) {
    current = path.join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      break; // Missing components are created below, inside the same guard.
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Workflow report path is unsafe: ${current}`);
    }
  }
  ensureWorkflowDirectoryNoSymlink(physicalProjectRoot, reportDir);
  return reportDir;
}

/**
 * The document keeps the artifact's own name: `plan.md` is `plan.md`, with the
 * extension preserved and `.md` appended only when the name carries none. A
 * document rendered from JSON becomes Markdown and takes `.md` in place of
 * `.json`. Names are claimed case-insensitively against the runner-owned files
 * and against each other — two artifact names that sanitize to one filename are
 * two documents, so the later one takes a `-2` suffix rather than silently
 * overwriting the first.
 */
function claimDocumentFileName(artifactName: string, asMarkdown: boolean, claimed: Set<string>): string {
  const extension = WORKFLOW_REPORT_EXTENSION_REGEX.exec(artifactName)?.[0] ?? "";
  const base = safeFileComponent(extension === "" ? artifactName : artifactName.slice(0, -extension.length));
  const finalExtension = asMarkdown || extension === "" ? ".md" : extension.toLowerCase();
  let candidate = `${base}${finalExtension}`;
  for (let suffix = 2; claimed.has(candidate.toLowerCase()); suffix += 1) {
    candidate = `${base}-${suffix}${finalExtension}`;
  }
  claimed.add(candidate.toLowerCase());
  return candidate;
}

/** Markdown link path for a machine-store relative path, in URL separators. */
function hrefPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/**
 * Markdown rendering of one JSON document, or undefined when the bytes are not
 * JSON (then the verbatim file keeps its own extension). A flat object — every
 * top-level value a scalar or a list of scalars — becomes a readable key list
 * ("verdict: accept", numbered defects); anything nested stays pretty-printed
 * JSON inside a fence, because inventing prose for an unknown shape would be a
 * guess, not a rendering.
 */
function renderedJsonMarkdown(bytes: Buffer): Buffer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  const structured = flatObjectMarkdown(value);
  const body = structured ?? `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  return Buffer.from(`${body}\n`, "utf8");
}

function flatObjectMarkdown(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const lines: string[] = [];
  for (const [key, field] of Object.entries(value)) {
    if (isRenderableScalar(field)) {
      lines.push(`- **${key}**: ${scalarText(field)}`);
      continue;
    }
    if (Array.isArray(field) && field.every(isRenderableScalar)) {
      if (field.length === 0) {
        lines.push(`- **${key}**: (none)`);
      } else {
        lines.push(`- **${key}**:`);
        for (const [index, item] of field.entries()) lines.push(`  ${index + 1}. ${scalarText(item)}`);
      }
      continue;
    }
    return undefined;
  }
  return lines.join("\n");
}

function isRenderableScalar(value: unknown): value is string | number | boolean | null {
  if (typeof value === "string") return !value.includes("\n");
  return typeof value === "number" || typeof value === "boolean" || value === null;
}

function scalarText(value: string | number | boolean | null): string {
  return value === null ? "null" : String(value);
}

/**
 * The author is what the workflow itself called the stage: the journal label
 * ("planner round 2") when present, the child agent name otherwise. Published
 * documents belong to the workflow script; inputs came in from a previous run.
 */
function documentAuthor(record: WorkflowArtifactRecord, authors: Map<string, string>): string {
  if (record.kind === "published") return "workflow";
  if (record.kind === "input") return "input";
  const author = record.callId !== undefined ? authors.get(record.callId) : undefined;
  return author ?? "agent";
}

function authorsByCallId(journal: readonly WorkflowJournalLine[]): Map<string, string> {
  const authors = new Map<string, string>();
  for (const line of journal) {
    if (line.kind !== "agent_start" && line.kind !== "agent_end") continue;
    if (line.callId === undefined) continue;
    const author = line.label ?? line.agent;
    if (author !== undefined && author.trim() !== "") authors.set(line.callId, author);
  }
  return authors;
}

/**
 * Per-call model facts, from `agent_end` only.
 *
 * `agent_start` carries a REQUEST, so reading it here would let the report name a
 * model that never ran — the exact confusion the run README exists to remove.
 */
function executionsByCallId(
  journal: readonly WorkflowJournalLine[],
): Map<string, { executedModel?: string; modelRoleFallback?: string }> {
  const executions = new Map<string, { executedModel?: string; modelRoleFallback?: string }>();
  for (const line of journal) {
    if (line.kind !== "agent_end" || line.callId === undefined) continue;
    if (line.executedModel === undefined && line.modelRoleFallback === undefined) continue;
    executions.set(line.callId, {
      ...(line.executedModel !== undefined ? { executedModel: line.executedModel } : {}),
      ...(line.modelRoleFallback !== undefined ? { modelRoleFallback: line.modelRoleFallback } : {}),
    });
  }
  return executions;
}

function isTaskName(name: string): boolean {
  return name === "task.md" || name === "task";
}

function safeFileComponent(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^[-.]+|[-.]+$/gu, "") || "document"
  );
}

// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------

function reportReadme(options: {
  input: WorkflowRunReportInput;
  documents: readonly WorkflowReportDocument[];
  transcripts: readonly WorkflowReportTranscript[];
  taskWritten: boolean;
  hasResultText: boolean;
  hasStructuredResult: boolean;
  indexUnavailable?: string;
}): string {
  const { input, documents } = options;
  const lines: string[] = [];
  const title = input.target !== undefined ? `\`${input.target.ref}\`` : "workflow";
  lines.push(`# Workflow run ${input.runId} — ${stripBackticks(title)}`, "");
  if (input.target !== undefined) {
    lines.push(`- Workflow: \`${input.target.ref}\` (${input.target.source})`);
  }
  lines.push(`- Status: ${input.status}`);
  const finishedAt = lastJournalTimestamp(input.journal);
  if (finishedAt !== undefined) lines.push(`- Last event: ${finishedAt}`);
  if (options.taskWritten) lines.push(`- Task: [task.md](task.md)`);
  if (options.hasResultText) {
    lines.push(`- Result: [result.md](result.md)`);
  } else if (options.hasStructuredResult) {
    lines.push(`- Result: structured — see \`result.json\` in the machine records`);
  }
  if (input.error !== undefined && input.error.trim() !== "") {
    lines.push(`- Error: ${singleLine(input.error)}`);
  }
  lines.push(
    `- Machine records: \`.locus/runtime/workflows/${input.runId}/\` — journal, replay record, ` +
      `result envelope, script snapshot, transcripts and call envelopes`,
  );
  lines.push(...budgetSection(input));
  const retryLines = retriedCallLines(input.journal);
  lines.push("", "## Documents", "");
  if (documents.length === 0) {
    lines.push(
      options.indexUnavailable !== undefined
        ? `- none — the artifact index was unavailable: ${singleLine(options.indexUnavailable)}`
        : "- none",
    );
  } else {
    lines.push(
      "One file per document, holding its newest revision. A document written " +
        "more than once lists every revision below it, each linking the verbatim " +
        "machine bytes.",
      "",
    );
    for (const [position, document] of documents.entries()) {
      lines.push(`${position + 1}. ${documentEntry(document)}`);
      if (document.revisions.length > 1) {
        for (const [index, revision] of document.revisions.entries()) {
          lines.push(`   ${index + 1}. ${revisionEntry(revision)}`);
        }
      }
    }
  }
  lines.push(...logsSection(input.runId, options.transcripts));
  lines.push(...retryLines);
  lines.push("");
  return lines.join("\n");
}

/**
 * Where the raw logs live, by stage name. The journal is one file whose every
 * line names its agent, stage and round; each child's full transcript is its
 * own ndjson. Links, not copies: the report stays a projection, and the
 * machine store keeps the single source of truth.
 */
function logsSection(runId: string, transcripts: readonly WorkflowReportTranscript[]): string[] {
  const lines: string[] = ["", "## Logs", ""];
  lines.push(
    `- [journal.ndjson](../../.locus/runtime/workflows/${runId}/journal.ndjson) — every run event ` +
      "on one line each, tagged with its agent, stage and round",
  );
  for (const transcript of transcripts) {
    const stage = transcript.stage === undefined ? "" : ` · ${transcript.stage}`;
    lines.push(`- ${transcript.author}${stage} — [transcript](${transcript.machineHref})`);
  }
  return lines;
}

/**
 * One logical `agent()` call that had to run more than one child.
 *
 * A discarded attempt is a real agent call: it burned an invocation of the run cap and left
 * its own transcript. Without this section the reader's copy shows the stage as one clean
 * answer and the second bill appears nowhere they would look.
 */
interface WorkflowReportRetriedCall {
  author: string;
  stage?: string;
  attempts: Array<{ callId: string; attempt: number; declared: number; status: string; failureCause?: string }>;
}

/**
 * Group the lines that carry an attempt ordinal into their logical calls.
 *
 * A physical attempt has exactly ONE terminal journal record: `agent_end` when the child
 * returned a result, and `error` when it threw — the runtime emits the error line instead
 * of, never alongside, the end line. Reading only `agent_end` would therefore hide the
 * sequence that matters most: a call that timed out, was re-run, and then threw leaves one
 * `agent_end` behind and would render as a stage that never retried at all.
 *
 * Grouped by the runtime's own `logicalCallId`, which every physical attempt of one
 * `agent()` call carries. Neither adjacency nor (agent, label, phase, group) can do this
 * job: `parallel()` may interleave two retrying calls that agree on all four of those
 * fields, and grouping by them would attribute one call's discarded attempt to the other —
 * worse than no section at all, because this one reads as evidence.
 */
function retriedCalls(journal: readonly WorkflowJournalLine[]): WorkflowReportRetriedCall[] {
  const open = new Map<string, WorkflowReportRetriedCall>();
  const ordered: WorkflowReportRetriedCall[] = [];
  for (const line of journal) {
    if (line.kind !== "agent_end" && line.kind !== "error") continue;
    if (line.attempt === undefined || line.attempts === undefined || line.callId === undefined) continue;
    // The journal reader refuses an ordinal without one, so absence here is a line this
    // reader cannot honestly place — skipped rather than guessed into somebody's group.
    if (line.logicalCallId === undefined) continue;
    let group = open.get(line.logicalCallId);
    if (group === undefined) {
      group = {
        author: line.label ?? line.agent ?? "agent",
        ...(line.phase !== undefined ? { stage: line.phase } : {}),
        attempts: [],
      };
      open.set(line.logicalCallId, group);
      ordered.push(group);
    }
    group.attempts.push({
      callId: line.callId,
      attempt: line.attempt,
      declared: line.attempts,
      // An `error` line carries no status field: the attempt ended by throwing, which is a
      // different fact from a failed result and is named as itself rather than flattened.
      status: line.kind === "error" ? "threw" : (line.status ?? "unknown"),
      ...(line.failureCause !== undefined ? { failureCause: line.failureCause } : {}),
    });
  }
  // A call that declared a budget and never needed it is not a retried call.
  return ordered.filter((group) => group.attempts.length > 1);
}

function retriedCallLines(journal: readonly WorkflowJournalLine[]): string[] {
  const calls = retriedCalls(journal);
  if (calls.length === 0) return [];
  const lines: string[] = ["", "## Retried agent calls", ""];
  lines.push(
    "Each line below is a separate child run charged to this run's budget, with its own " +
      "transcript in the machine records.",
    "",
  );
  for (const call of calls) {
    lines.push(`- ${call.author}${call.stage === undefined ? "" : ` · ${call.stage}`}`);
    for (const attempt of call.attempts) {
      const cause = attempt.failureCause === undefined ? "" : ` (${attempt.failureCause})`;
      lines.push(
        `  - attempt ${attempt.attempt} of ${attempt.declared} — \`${attempt.callId}\` — ${attempt.status}${cause}`,
      );
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Budget versus spend
// ---------------------------------------------------------------------------

/** What the report prints when the evidence for an axis does not exist. Never `0`:
 *  a zero would read as a measured spend of nothing, which is a different claim. */
const NOT_RECORDED = "not recorded";

/**
 * Every axis with the value that applied, beside the spend this run's evidence can
 * actually measure. Three tiers, and the report says which tier each axis is in:
 * measurable from the journal, measurable only because the concurrency gate counts
 * it, and not measurable at all. The last group prints "not recorded" rather than a
 * number nobody counted — the same honesty rule cost is held to.
 */
function budgetSection(input: WorkflowRunReportInput): string[] {
  if (input.budget === undefined) return [];
  const { applied, peakConcurrency } = input.budget;
  const spend = journalSpend(input.journal);
  const rows: Array<[string, string, string]> = [
    ["`concurrency`", String(applied.concurrency), `${String(peakConcurrency)} peak (gate-owned)`],
    [
      "`totalAgents`",
      String(applied.totalAgents),
      // "invocations", not "started": a replayed call spends one against this cap
      // (the runtime counts it before the replay lookup) while starting no child,
      // so the count is right and the word "started" would have been the lie.
      spend.replayedAgents === 0
        ? `${String(spend.agents)} invocations`
        : `${String(spend.agents)} invocations (${String(spend.replayedAgents)} replayed, no child ran)`,
    ],
    ["`runtimeMs`", `${String(applied.runtimeMs)} ms`, `${String(spend.runMs)} ms over the journal`],
    [
      "`timeoutMs`",
      `${String(applied.timeoutMs)} ms`,
      // Fresh children only. A replayed attempt's durationMs measures projecting a
      // recorded answer, which never ran against this fuse; a run served entirely
      // from records therefore has no longest child at all and says so.
      spend.longestChildMs === undefined ? NOT_RECORDED : `${String(spend.longestChildMs)} ms longest child`,
    ],
    ["`toolCalls`", String(applied.toolCalls), NOT_RECORDED],
    ["`turns`", String(applied.turns), NOT_RECORDED],
    ["`answerChars`", String(applied.answerChars), NOT_RECORDED],
    ["tokens", "not enforced", spend.tokens === undefined ? NOT_RECORDED : `${String(spend.tokens)} observed`],
    ["cost", "not enforced", "not available"],
  ];
  return [
    "",
    "## Budget",
    "",
    "| Axis | Applied | Spend |",
    "| --- | --- | --- |",
    ...rows.map(([axis, appliedText, spendText]) => `| ${axis} | ${appliedText} | ${spendText} |`),
    "",
    `Spend is read from this run's own journal, so it can only report what the journal carries. \`toolCalls\`, ` +
      `\`turns\` and \`answerChars\` are enforced per child and counted by nobody, so they read "${NOT_RECORDED}" ` +
      `rather than \`0\`. Cost is unavailable because the host reports a constant zero, and a limit over a stub ` +
      "would report “under budget” forever.",
    "",
    "A replayed call spends an invocation against `totalAgents` but starts no child, so it is counted there and " +
      "excluded from the longest-child duration and from the observed tokens. A run served entirely from records " +
      `reports its longest child as "${NOT_RECORDED}", because no child ran.`,
    "",
    "`runtimeMs` bounds the agent chain: it is checked when a child starts, so a run is bounded by it plus at " +
      "most one child's own `timeoutMs`, and script code that calls no further agent is not bounded by it.",
  ];
}

interface WorkflowJournalSpend {
  /** Agent invocations, replayed ones included — they spend the `totalAgents` cap. */
  agents: number;
  /** How many of those were served from a record, so the count above cannot be
   *  read as "children that ran". */
  replayedAgents: number;
  runMs: number;
  /** Longest FRESH child. Absent when nothing but replays ended. */
  longestChildMs?: number;
  tokens?: number;
}

function journalSpend(journal: readonly WorkflowJournalLine[]): WorkflowJournalSpend {
  let agents = 0;
  let replayedAgents = 0;
  let longestChildMs: number | undefined;
  let tokens: number | undefined;
  let firstMs: number | undefined;
  let lastMs: number | undefined;
  for (const line of journal) {
    if (line.kind === "agent_start") {
      agents += 1;
      // Never inferred from a missing duration or a zero token count — only the
      // explicit marker the runtime writes on both start and end lines counts.
      if (line.replayed === true) replayedAgents += 1;
    }
    // A post-child validator/artifact failure has no agent_end: its `error` line is
    // the sole terminal record and carries executed-model evidence plus usage.
    // Transport throws carry neither and therefore do not masquerade as executed
    // children here.
    const executedTerminal =
      line.kind === "agent_end" ||
      (line.kind === "error" && (line.executedModel !== undefined || line.usage !== undefined));
    if (executedTerminal) {
      // A replayed attempt started no child: its durationMs is how long projecting a
      // recorded answer took, which is not a spend against the per-child wall clock.
      if (
        line.replayed !== true &&
        typeof line.durationMs === "number" &&
        (longestChildMs === undefined || line.durationMs > longestChildMs)
      ) {
        longestChildMs = line.durationMs;
      }
      const total = line.usage?.totalTokens;
      // Absent usage is absent, not zero: the host omits it rather than reporting 0.
      if (typeof total === "number") tokens = (tokens ?? 0) + total;
    }
    const ms = Date.parse(line.ts ?? "");
    if (!Number.isNaN(ms)) {
      if (firstMs === undefined) firstMs = ms;
      lastMs = ms;
    }
  }
  return {
    agents,
    replayedAgents,
    runMs: firstMs === undefined || lastMs === undefined ? 0 : lastMs - firstMs,
    ...(longestChildMs === undefined ? {} : { longestChildMs }),
    ...(tokens === undefined ? {} : { tokens }),
  };
}

function revisionDescription(revision: WorkflowReportRevision): string {
  const describedAs =
    revision.kind === "input"
      ? [`transferred from run ${revision.sourceRunId ?? "(unknown)"}`]
      : revision.kind === "published"
        ? ["workflow", ...(revision.stage !== undefined ? [revision.stage] : [])]
        : [
            revision.author,
            ...(revision.stage !== undefined ? [revision.stage] : []),
            // The reader's answer to "which model wrote this". Absent rather than
            // guessed when the run predates the field. `unavailable` is a SENTINEL
            // meaning "the peer reported nothing", not a model name, so it is spelled
            // out as a missing readback — "ran on unavailable" reads to a human like a
            // model called `unavailable`, which is the kind of surface this task exists
            // to stop.
            ...(revision.executedModel === undefined
              ? []
              : revision.executedModel === EXECUTED_MODEL_UNAVAILABLE
                ? ["executed model unavailable"]
                : [`ran on ${revision.executedModel}`]),
            ...(revision.modelRoleFallback !== undefined ? ["declared tier unassigned"] : []),
          ];
  return describedAs.join(" · ");
}

function documentEntry(document: WorkflowReportDocument): string {
  const newest = document.revisions[document.revisions.length - 1];
  const description = newest === undefined ? "" : ` — ${revisionDescription(newest)}`;
  const revisionCount = document.revisions.length > 1 ? ` — ${document.revisions.length} revisions:` : "";
  return document.unavailable !== undefined
    ? `${document.fileName}${description} — unavailable: ${document.unavailable}`
    : `[${document.fileName}](${document.fileName})${description}${revisionCount}`;
}

function revisionEntry(revision: WorkflowReportRevision): string {
  return `${revisionDescription(revision)} — [machine copy](${revision.machineHref})`;
}

function lastJournalTimestamp(journal: readonly WorkflowJournalLine[]): string | undefined {
  const last = journal.length > 0 ? journal[journal.length - 1] : undefined;
  return typeof last?.ts === "string" && last.ts.trim() !== "" ? last.ts : undefined;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function stripBackticks(value: string): string {
  return value.replace(/`/gu, "");
}

function tryRead(evidence: WorkflowRunReportEvidenceSource, record: WorkflowArtifactRecord): Buffer | undefined {
  try {
    return evidence.read({
      runId: record.runId,
      artifactId: record.artifactId,
      name: record.name,
      sha256: record.sha256,
    });
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
