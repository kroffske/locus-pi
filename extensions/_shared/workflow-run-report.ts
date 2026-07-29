/**
 * workflow-run-report.ts — the reader's copy of one workflow run, under
 * `<projectRoot>/.locus-pi/<runId>/`.
 *
 * The state directory (`.locus/runtime/workflows/<runId>/`) stays machine-owned:
 * journal, replay record, result envelope, script snapshot, transcripts, and the
 * hash-verified artifact store that replay and continuations depend on. This
 * module projects the human-facing part of that evidence — the task, the final
 * result, and every document in creation order under a name that says who wrote
 * it, with the README grouping them by origin (agent documents, transferred
 * inputs, workflow-published) — so that opening the report folder answers "what
 * happened here" without opening a single machine file.
 *
 * Best-effort by contract, like result.md: a failed report write costs the
 * reader's copy, never the run or its durable evidence.
 */

import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXECUTED_MODEL_UNAVAILABLE } from "./agent-runner.js";
import {
  ensureWorkflowDirectoryNoSymlink,
  WORKFLOW_ARTIFACT_COMPONENT_PATTERN,
  type WorkflowArtifactRecord,
  type WorkflowArtifactRef,
} from "./workflow-artifacts.js";
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
}

/** The slice of the artifact store the report needs; the store itself satisfies it. */
export interface WorkflowRunReportEvidenceSource {
  list(): WorkflowArtifactRecord[];
  read(ref: WorkflowArtifactRef): Buffer;
}

export type WorkflowRunReportOutcome = { ok: true; path: string; documents: number } | { ok: false; message: string };

interface WorkflowReportDocument {
  fileName: string;
  author: string;
  kind: string;
  stage?: string;
  /** For continuation copies (kind `input`): the run the bytes came from. */
  sourceRunId?: string;
  /** For agent answers: the model the child SESSION reported it ran on. */
  executedModel?: string;
  /** For agent answers: the declared tier had no assignment and the session model was used. */
  modelRoleFallback?: string;
  unavailable?: string;
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

    const documents: WorkflowReportDocument[] = [];
    for (const [position, record] of chain.entries()) {
      const author = documentAuthor(record, authors);
      const bytes = tryRead(evidence, record);
      // A JSON document is machine truth; the reader gets a Markdown rendering
      // of it, and the verbatim bytes stay in the artifact store.
      const rendered = bytes !== undefined && record.name.endsWith(".json") ? renderedJsonMarkdown(bytes) : undefined;
      const fileName = documentFileName(position + 1, author, record.name, rendered !== undefined);
      const execution = record.callId !== undefined ? executions.get(record.callId) : undefined;
      const document: WorkflowReportDocument = {
        fileName,
        author,
        kind: record.kind,
        ...(record.stage !== undefined ? { stage: record.stage } : {}),
        ...(record.kind === "input" && record.source?.runId !== undefined ? { sourceRunId: record.source.runId } : {}),
        // Which model produced this document. Read from `agent_end`, which is the only
        // line that can know it — `agent_start` is written before anything executes.
        ...(execution?.executedModel !== undefined ? { executedModel: execution.executedModel } : {}),
        ...(execution?.modelRoleFallback !== undefined ? { modelRoleFallback: execution.modelRoleFallback } : {}),
      };
      if (bytes === undefined) {
        document.unavailable = "the stored artifact could not be read back";
      } else {
        writeFileSync(path.join(reportDir, fileName), rendered ?? bytes);
      }
      documents.push(document);
    }

    const resultText = typeof input.result === "string" && input.result.trim() !== "" ? input.result : undefined;
    if (resultText !== undefined) {
      writeFileSync(path.join(reportDir, "result.md"), resultText.endsWith("\n") ? resultText : `${resultText}\n`);
    }

    writeFileSync(
      path.join(reportDir, "README.md"),
      reportReadme({
        input,
        documents,
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
 * `NN-<author>-<name>` with the artifact's own extension preserved and `.md`
 * appended only when the name carries none — the rule that retires
 * `call-0002-plan.md.md`. A document rendered from JSON becomes Markdown and
 * takes `.md` in place of `.json`.
 */
function documentFileName(position: number, author: string, artifactName: string, asMarkdown: boolean): string {
  const ordinal = String(position).padStart(2, "0");
  const extension = WORKFLOW_REPORT_EXTENSION_REGEX.exec(artifactName)?.[0] ?? "";
  const base = extension === "" ? artifactName : artifactName.slice(0, -extension.length);
  const finalExtension = asMarkdown || extension === "" ? ".md" : extension;
  return `${ordinal}-${safeFileComponent(author)}-${safeFileComponent(base)}${finalExtension}`;
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
  if (documents.length === 0) {
    lines.push("", "## Documents", "");
    lines.push(
      options.indexUnavailable !== undefined
        ? `- none — the artifact index was unavailable: ${singleLine(options.indexUnavailable)}`
        : "- none",
    );
    lines.push("");
    return lines.join("\n");
  }
  // Grouped by origin so a reader can tell at a glance what an agent wrote
  // versus what arrived automatically. The `NN-` file prefix stays the run-wide
  // creation order.
  const groups: Array<{ heading: string; documents: WorkflowReportDocument[] }> = [
    { heading: "## Agent documents, in creation order", documents: documents.filter((d) => d.kind === "answer") },
    { heading: "## Transferred inputs", documents: documents.filter((d) => d.kind === "input") },
    { heading: "## Published by the workflow", documents: documents.filter((d) => d.kind === "published") },
  ];
  for (const group of groups) {
    if (group.documents.length === 0) continue;
    lines.push("", group.heading, "");
    for (const [position, document] of group.documents.entries()) {
      lines.push(`${position + 1}. ${documentEntry(document)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function documentEntry(document: WorkflowReportDocument): string {
  const describedAs =
    document.kind === "input"
      ? [`transferred from run ${document.sourceRunId ?? "(unknown)"}`]
      : document.kind === "published"
        ? document.stage !== undefined
          ? [document.stage]
          : []
        : [
            document.author,
            ...(document.stage !== undefined ? [document.stage] : []),
            // The reader's answer to "which model wrote this". Absent rather than
            // guessed when the run predates the field. `unavailable` is a SENTINEL
            // meaning "the peer reported nothing", not a model name, so it is spelled
            // out as a missing readback — "ran on unavailable" reads to a human like a
            // model called `unavailable`, which is the kind of surface this task exists
            // to stop.
            ...(document.executedModel === undefined
              ? []
              : document.executedModel === EXECUTED_MODEL_UNAVAILABLE
                ? ["executed model unavailable"]
                : [`ran on ${document.executedModel}`]),
            ...(document.modelRoleFallback !== undefined ? ["declared tier unassigned"] : []),
          ];
  const description = describedAs.length === 0 ? "" : ` — ${describedAs.join(" · ")}`;
  return document.unavailable !== undefined
    ? `${document.fileName}${description} — unavailable: ${document.unavailable}`
    : `[${document.fileName}](${document.fileName})${description}`;
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
