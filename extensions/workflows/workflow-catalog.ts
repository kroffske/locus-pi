import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import {
  listWorkflowRunIds,
  readWorkflowRunScriptSnapshot,
  type WorkflowRunResultEnvelope,
  type WorkflowRunScriptSnapshot,
} from "./runtime/workflow-journal.js";
import {
  packagedWorkflowNames,
  listWorkflowCatalogTargets,
  type ResolvedWorkflowTarget,
} from "./runtime/workflow-runner.js";
import { isWorkflowSavedName } from "./runtime/workflow-saved-name.js";
import type { OperatorBlock } from "../_shared/operator/operator-ui.js";
import { buildWorkflowRunCommand, formatWorkflowCommandToken, workflowRunUsage } from "./command-parser.js";

const RECENT_WORKFLOW_LIMIT = 5;
const WORKFLOW_METADATA_SCAN_BYTES = 64 * 1024;
const DESCRIPTION_MAX_CHARS = 96;
const HISTORICAL_WORKFLOW_DESCRIPTION = "historical run snapshot";
export const WORKFLOW_SOURCE_LEGEND = "Sources: [P] Project · [U] User · [PKG] Package · [R] immutable run history";
export const WORKFLOW_DISPLAY_ORDER_LEGEND =
  "Display order: Project → User → Package (does not change first-wins resolution)";

/** Explicit, inert Package grouping metadata. Never inferred from names or files. */
export const PACKAGE_WORKFLOW_BUNDLES = [
  {
    version: 1 as const,
    parent: "post-code-review",
    children: [
      "post-code-review-scope",
      "post-code-review-boundaries",
      "post-code-review-simplicity",
      "post-code-review-contracts",
      "post-code-review-necessity",
      "post-code-review-synthesis",
    ] as const,
  },
] as const;
export type WorkflowBundle = (typeof PACKAGE_WORKFLOW_BUNDLES)[number];

/** One statically declared stage from a workflow's exported `meta.phases`. */
export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
}

/** Everything the bounded static scan accepts from one literal exported `meta`. */
export interface WorkflowStaticMeta {
  description: string;
  profile: WorkflowAuthoringProfile;
  /** Empty when nothing was declared, or when a declaration was not fully literal. */
  phases: WorkflowMetaPhase[];
}

export type WorkflowAuthoringProfile = "standard" | "legacy" | "integration" | "unclassified";

export interface WorkflowCatalogRow {
  name: string;
  /** Explicit Package bundle membership; absent means independent. */
  bundle?: { version: number; parent: string; role: "parent" | "child"; children?: readonly string[] } | undefined;
  source: ResolvedWorkflowTarget["source"];
  sourceLabel: "Project" | "User" | "Package";
  originPath: string;
  description: string;
  profile: WorkflowAuthoringProfile;
  phases: WorkflowMetaPhase[];
}

export interface WorkflowCatalogCurrentRow extends WorkflowCatalogRow {
  kind: "current";
  target: ResolvedWorkflowTarget;
}

export interface WorkflowCatalogHistoryRow extends WorkflowCatalogRow {
  kind: "history";
  runId: string;
  target: NonNullable<WorkflowRunResultEnvelope["target"]>;
  snapshot: WorkflowRunScriptSnapshot;
}

export interface WorkflowCatalogModel {
  query: string | undefined;
  totalCurrent: number;
  current: WorkflowCatalogCurrentRow[];
  history: WorkflowCatalogHistoryRow[];
}

export type WorkflowSourceReadState =
  | { kind: "ready"; row: WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow; path: string; source: string }
  | {
      kind: "missing" | "shadowed" | "unreadable" | "legacy" | "invalid" | "tampered" | "stale";
      row: WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow;
      message: string;
    };

export type WorkflowBrowserAction = "start" | "edit" | "review";

export type WorkflowBrowserIntent =
  | {
      action: WorkflowBrowserAction;
      row: WorkflowCatalogCurrentRow;
      sourceState: WorkflowSourceReadState;
    }
  | {
      action: "review";
      row: WorkflowCatalogHistoryRow;
      sourceState: WorkflowSourceReadState;
    };

interface WorkflowCatalogOptions {
  compact?: boolean;
}

/** Build an operator catalog over the shared project/user discovery, curated Package registry, and run index. */
export function buildWorkflowCatalogBlock(
  projectRoot: string,
  workingDirectory: string,
  query?: string,
  options: WorkflowCatalogOptions = {},
): OperatorBlock {
  return buildWorkflowCatalogBlockFromModel(buildWorkflowCatalogModel(projectRoot, workingDirectory, query), options);
}

/** Build one current/history model for both passive and focused projections. */
export function buildWorkflowCatalogModel(
  projectRoot: string,
  workingDirectory: string,
  query?: string,
): WorkflowCatalogModel {
  const targets = listWorkflowCatalogTargets(projectRoot, workingDirectory);
  const completeBundleParents = completePackageBundleParents(targets);
  const catalogRows: WorkflowCatalogCurrentRow[] = targets.map((target) => {
    const meta = readWorkflowMeta(target.path);
    return {
      kind: "current",
      target,
      name: target.ref,
      bundle: workflowBundleFor(target.ref, target.source, completeBundleParents),
      source: target.source,
      sourceLabel: workflowSourceLabel(target.source),
      originPath: target.path,
      description: meta.description,
      profile: meta.profile,
      phases: meta.phases,
    };
  });
  const recentRows = recentWorkflowRows(projectRoot);
  const matches = (row: WorkflowCatalogRow): boolean => workflowCatalogRowMatches(row, query);
  return {
    query,
    totalCurrent: catalogRows.length,
    current: catalogRows.filter(matches),
    history: recentRows.filter(matches),
  };
}

/** Render a catalog model without reading resolver sources again. */
export function buildWorkflowCatalogBlockFromModel(
  model: WorkflowCatalogModel,
  options: WorkflowCatalogOptions = {},
): OperatorBlock {
  const { query, totalCurrent, current: filteredCatalog, history: filteredRecent } = model;

  if (query !== undefined && filteredCatalog.length === 0 && filteredRecent.length === 0) {
    return {
      type: "VIEW",
      subject: "Workflow catalog",
      primary: `No workflows match ${JSON.stringify(query)}.`,
      body: [`Catalog contains ${totalCurrent} runnable workflow(s); search checks name and description.`],
      metadata: [WORKFLOW_SOURCE_LEGEND],
      controls: ["Try: /workflows list <query>"],
    };
  }

  if (options.compact === true) {
    const compactBody = compactWorkflowCatalogBody(filteredRecent, filteredCatalog, query);
    const compactBundle = compactBundleSummary(filteredCatalog);
    const compactTotals = `${filteredCatalog.length} current workflow(s) · ${filteredRecent.length} history row(s); details may be omitted by host line budget`;
    return {
      type: "VIEW",
      subject: "Workflow catalog",
      primary: query === undefined ? `${totalCurrent} runnable workflow(s).` : `Matches for ${JSON.stringify(query)}.`,
      body: compactBody.lines,
      metadata: [
        ...(compactBundle === undefined ? [] : [`${compactBundle} · ${compactTotals}`]),
        WORKFLOW_DISPLAY_ORDER_LEGEND,
        WORKFLOW_SOURCE_LEGEND,
      ],
      controls: [`Run: ${workflowRunUsage()} · Filter: /workflows list <query>`],
    };
  }

  const body: string[] = [];
  appendWorkflowCatalogGroup(
    body,
    "[R] Run history",
    filteredRecent,
    query === undefined ? "none yet" : "no recent matches",
  );
  appendWorkflowCatalogGroup(
    body,
    "[P] Project",
    rowsForSource(filteredCatalog, "project"),
    query === undefined ? "none found" : "no matches",
  );
  appendWorkflowCatalogGroup(
    body,
    "[U] User",
    rowsForSource(filteredCatalog, "personal"),
    query === undefined ? "none found" : "no matches",
  );
  appendWorkflowCatalogGroup(
    body,
    "[PKG] Package",
    rowsForSource(filteredCatalog, "package"),
    query === undefined ? "none installed" : "no matches",
  );

  return {
    type: "VIEW",
    subject: "Workflow catalog",
    primary: query === undefined ? `${totalCurrent} runnable workflow(s).` : `Matches for ${JSON.stringify(query)}.`,
    body: [WORKFLOW_DISPLAY_ORDER_LEGEND, ...body],
    metadata: [WORKFLOW_SOURCE_LEGEND],
    controls: [`Run: ${workflowRunUsage()}`, "Filter: /workflows list <query>", "Status: /workflows status"],
  };
}

/** Revalidate the exact selected first-wins target, then read it as inert UTF-8 text. */
export function readSelectedWorkflowSource(
  selected: WorkflowCatalogCurrentRow,
  projectRoot: string,
  workingDirectory: string,
): WorkflowSourceReadState {
  const current = listWorkflowCatalogTargets(projectRoot, workingDirectory).find(
    (target) => target.ref === selected.target.ref,
  );
  if (current === undefined) {
    return {
      kind: "missing",
      row: selected,
      message: `Selected workflow ${JSON.stringify(selected.name)} is no longer in the current catalog. Return and refresh /workflows list.`,
    };
  }
  if (!sameResolvedTarget(current, selected.target)) {
    return {
      kind: "shadowed",
      row: selected,
      message: `Selected workflow changed precedence from ${selected.target.path} to ${current.path}. Nothing was opened; return and refresh /workflows list.`,
    };
  }
  try {
    return { kind: "ready", row: selected, path: current.path, source: readFileSync(current.path, "utf8") };
  } catch (error) {
    return {
      kind: "unreadable",
      row: selected,
      message: `Selected workflow could not be read: ${errorMessage(error)}. Fix access or return to the catalog.`,
    };
  }
}

/**
 * Deterministic editor handoff. Start uses the direct slash-command runtime
 * path; edit/review name the bundled `workflow-author` catalog agent because
 * they require source work. The pointer must stay something an installed
 * package actually provides: the agent ships in .agents/agents/ with this
 * package, so it resolves through normal agent discovery.
 * The returned text is editable but never submitted here.
 */
export function buildWorkflowActionPrompt(intent: WorkflowBrowserIntent): string {
  if (intent.row.kind === "history" && intent.action !== "review") {
    throw new Error(`Historical workflow actions are review-only; received ${JSON.stringify(intent.action)}.`);
  }
  const row = intent.row;
  if (row.kind === "current" && intent.action === "start") {
    if (intent.sourceState.kind !== "ready") {
      throw new Error(
        `Current workflow start requires a ready source; received ${JSON.stringify(intent.sourceState.kind)}.`,
      );
    }
    return buildWorkflowRunCommand(row.target);
  }
  let request: string;
  if (row.kind === "current") {
    const action = intent.action[0]!.toUpperCase() + intent.action.slice(1);
    request = `${action} the exact current workflow at ${JSON.stringify(row.target.path)}.`;
  } else {
    const identity = [
      `run ${JSON.stringify(row.runId)}`,
      `target ${JSON.stringify(`${row.target.kind}:${row.target.ref}`)}`,
    ];
    if (intent.sourceState.kind === "ready") {
      identity.push(`at ${JSON.stringify(row.originPath)}`);
      if (row.snapshot.sha256 !== undefined) identity.push(`SHA-256 ${JSON.stringify(row.snapshot.sha256)}`);
      request = `Review the immutable workflow snapshot for ${identity.join(", ")}.`;
    } else {
      identity.push(`with snapshot state ${JSON.stringify(intent.sourceState.kind)}`);
      if (row.snapshot.path !== undefined) identity.push(`path ${JSON.stringify(row.snapshot.path)}`);
      if (row.snapshot.sha256 !== undefined) identity.push(`SHA-256 ${JSON.stringify(row.snapshot.sha256)}`);
      request = `Review the recorded workflow identity for ${identity.join(", ")}; diagnose why the immutable snapshot is unavailable.`;
    }
  }
  return [`Request: ${request}`, "Agent: workflow-author", "", "Additional instructions:", ""].join("\n");
}

/** Passive source-backed explanation. It reads static metadata but never imports workflow code. */
export function buildWorkflowInfoBlock(projectRoot: string, workingDirectory: string, name?: string): OperatorBlock {
  const requested = name;
  if (requested !== undefined && !isWorkflowSavedName(requested)) {
    return {
      type: "WARN",
      subject: "Workflow info",
      primary: `Invalid saved workflow name: ${JSON.stringify(requested)}.`,
      body: [
        "Saved workflow names are exact; whitespace and other invalid characters are never trimmed or reinterpreted.",
      ],
      controls: ["Use /workflows list to inspect current names."],
    };
  }
  const model = buildWorkflowCatalogModel(projectRoot, workingDirectory);
  if (requested !== undefined) {
    const row = model.current.find((candidate) => candidate.name === requested);
    if (row === undefined) {
      return {
        type: "WARN",
        subject: "Workflow info",
        primary: `Unknown current workflow: ${JSON.stringify(requested)}.`,
        body: ["Names resolve by exact first-wins catalog identity; history and partial matches are not substituted."],
        controls: ["Use /workflows list to inspect current names and run-specific history."],
      };
    }
    return {
      type: "VIEW",
      subject: `Workflow info: ${row.name}`,
      primary: `${row.description}`,
      body: [
        `source: ${row.sourceLabel} (${row.source})`,
        `target: ${row.target.kind}:${row.target.ref}`,
        `profile: ${row.profile}`,
        "metadata: static top-level export const meta.description, meta.profile, and meta.phases only; the module was not imported or evaluated",
        ...workflowBundleDetailLines(row.bundle),
        ...declaredPhaseLines(row.phases),
        ...workflowContractLines(projectRoot, workingDirectory),
        `resolved path: ${row.target.path}`,
      ],
      metadata: [...workflowBundleCompactLines(row.bundle), WORKFLOW_SOURCE_LEGEND],
      controls: [
        "Inspect: /workflows list",
        `Run deliberately: ${workflowRunUsage(formatWorkflowCommandToken(row.name))}`,
      ],
    };
  }
  return {
    type: "VIEW",
    subject: "Workflow info",
    primary: "Passive workflow resolver, DSL, agent, and model contract.",
    body: workflowContractLines(projectRoot, workingDirectory),
    metadata: [WORKFLOW_SOURCE_LEGEND, "No workflow JavaScript was imported or evaluated."],
    controls: [
      "Browse: /workflows list [query]",
      "Inspect one: /workflows info <exact-name>",
      `Run: ${workflowRunUsage()}`,
      "History: /workflows status [runId]",
    ],
  };
}

/**
 * Project a declared pipeline for `/workflows info <name>`. Nothing is emitted
 * when a workflow declares no phases, so the block that an existing workflow
 * produces is unchanged — `phases` is optional and must stay free.
 */
function declaredPhaseLines(phases: readonly WorkflowMetaPhase[]): string[] {
  if (phases.length === 0) return [];
  return [
    `phases: ${phases.length} declared before the run starts (declaration, not enforcement)`,
    ...phases.map(
      (phase, index) => `  ${index + 1}. ${phase.title}${phase.detail === undefined ? "" : ` — ${phase.detail}`}`,
    ),
  ];
}

function workflowContractLines(projectRoot: string, workingDirectory: string): string[] {
  return [
    "trust: executed workflow files are reviewed JavaScript with full Pi host Node.js/module access; inspection and info are inert text/static-metadata reads",
    "history: run rows inspect only their validated retained snapshot; they never fall back to current source and are never runnable from the browser",
    "agent models: the child session is created with opts.model, else opts.modelRole, else the agent frontmatter tier, else the session model; an unresolvable provider/id fails the call, an unassigned role degrades and is recorded, and agent_end reports the read-back executedModel",
    'agents: agent() is the single model-calling primitive and returns exact non-empty child text; opts.agent selects a discovered catalog prompt/model role, omitted agent uses role "default", and every workflow child always receives tools ["*"] with write/edit/bash available; legacy capability fields are ignored; opts.schema opts into a validated shaped answer instead of text',
    "resources: promptFile() loads one source-relative .prompt.md containing stable stage instructions plus dynamic handoffs; local prompt bytes are copied once into the run directory with SHA-256 evidence",
    "workspaces: workspace() allocates one retained linked worktree and returns an opaque handle reusable by multiple agent() calls",
    "DSL: agent(), parallel(), pipeline(), phase(), log(), workflow(), outputDir(), invokeWorkflow(), publishPrimaryFile(), promptFile(), workspace()",
    "durability: outputDir() selects a confined stable project namespace distinct from run evidence; invokeWorkflow() runs one saved child level with source-bound item checkpoints and shared cancellation/concurrency/physical-call budget; publishPrimaryFile() exposes a verified non-empty file reference",
    `resolver: first name wins; project .pi/workflows, .claude/workflows, and .agents/workflows ascend ${path.resolve(workingDirectory)} to ${path.resolve(projectRoot)}; then user ${path.join(homedir(), ".pi", "workflows")}; then the packaged examples directory, currently ${packagedWorkflowNames().join(", ")}`,
    "registration: every directory including the packaged examples directory is scanned on every call, so a workflow is registered by the existence of its <name>.workflow.mjs file",
  ];
}

/** Read the selected current file or exact run snapshot without importing JavaScript. */
export function readWorkflowCatalogSource(
  selected: WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow,
  projectRoot: string,
  workingDirectory: string,
): WorkflowSourceReadState {
  if (selected.kind === "current") return readSelectedWorkflowSource(selected, projectRoot, workingDirectory);
  const snapshot = readWorkflowRunScriptSnapshot(projectRoot, selected.runId);
  if (!sameRunSnapshotIdentity(selected.snapshot, snapshot)) {
    return {
      kind: "stale",
      row: selected,
      message: `Run ${selected.runId} snapshot identity changed after catalog selection. Nothing was opened; return and refresh /workflows list.`,
    };
  }
  if (snapshot.kind === "ready") {
    return { kind: "ready", row: selected, path: snapshot.path, source: snapshot.source };
  }
  return { kind: snapshot.kind, row: selected, message: snapshot.message };
}

function compactWorkflowCatalogBody(
  recentRows: readonly WorkflowCatalogHistoryRow[],
  catalogRows: readonly WorkflowCatalogCurrentRow[],
  query: string | undefined,
): { lines: string[] } {
  const groups: Array<{
    label: string;
    rows: readonly (WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow)[];
    empty: string;
  }> = [
    { label: "[R]", rows: recentRows, empty: query === undefined ? "none yet" : "no recent matches" },
    {
      label: "[P]",
      rows: rowsForSource([...catalogRows], "project"),
      empty: query === undefined ? "none found" : "no matches",
    },
    {
      label: "[U]",
      rows: rowsForSource([...catalogRows], "personal"),
      empty: query === undefined ? "none found" : "no matches",
    },
    {
      label: "[PKG]",
      rows: rowsForSource([...catalogRows], "package"),
      empty: query === undefined ? "none installed" : "no matches",
    },
  ];
  let hidden = 0;
  const populated = groups.filter((group) => group.rows.length > 0);
  const lines = (populated.length > 0 ? populated : groups.slice(0, 1)).map((group) => {
    const row = group.rows[0];
    hidden += Math.max(0, group.rows.length - 1);
    if (row === undefined) return `${group.label} (${group.empty})`;
    return compactWorkflowCatalogLine(passiveCatalogRowLine(row));
  });
  const bundleParent = catalogRows.find((row) => row.source === "package" && row.bundle?.role === "parent");
  if (bundleParent !== undefined) {
    lines.push(
      compactWorkflowCatalogLine(
        `Bundle: ${bundleParent.name} · ${bundleParent.bundle?.children?.length ?? 0} children · /workflows info ${bundleParent.name}`,
      ),
    );
  }
  if (hidden > 0)
    lines.push(`+${hidden} hidden workflow row(s); use /workflows list <query> or /workflows info <exact-name>`);
  return { lines };
}

function compactBundleSummary(rows: readonly WorkflowCatalogCurrentRow[]): string | undefined {
  const parent = rows.find((row) => row.source === "package" && row.bundle?.role === "parent");
  return parent === undefined
    ? undefined
    : `Bundle: ${parent.name} · ${parent.bundle?.children?.length ?? 0} exact children · /workflows info ${parent.name}`;
}

/**
 * Read only a bounded prefix and accept metadata from the top-level literal
 * `export const meta = { description: <static string>, phases?: [...] }`. One
 * read and one parse serve every field, because the catalog rebuilds this per
 * row on each list/info call. No module is imported or executed: this function
 * only ever holds the file's bytes as a string.
 */
export function readWorkflowMeta(file: string): WorkflowStaticMeta {
  let source: string;
  try {
    source = readBoundedSource(file);
  } catch {
    return { description: "description unavailable", profile: "unclassified", phases: [] };
  }
  const meta = staticWorkflowMeta(source);
  return {
    description: meta.description ?? "no description",
    profile: meta.profile,
    phases: meta.phases,
  };
}

/** Description-only projection of {@link readWorkflowMeta}. */
export function readWorkflowMetaDescription(file: string): string {
  return readWorkflowMeta(file).description;
}

/** Privacy projection for persisted path targets; never returns an absolute path. */
export function safeRecentWorkflowLabel(
  target: { kind: "name" | "scriptPath"; ref: string },
  projectRoot: string,
): string {
  const raw = target.ref.trim();
  if (raw === "") return "unknown";
  if (target.kind === "name" && !raw.includes("/") && !raw.includes("\\")) return raw;
  if (path.isAbsolute(raw)) {
    const relative = path.relative(path.resolve(projectRoot), path.resolve(raw));
    if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
    return path.basename(raw);
  }
  if (path.win32.isAbsolute(raw)) return path.win32.basename(raw);
  const normalized = path.normalize(raw).replace(/^\.([/\\])/u, "");
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return path.basename(normalized);
  return normalized;
}

function recentWorkflowRows(projectRoot: string): WorkflowCatalogHistoryRow[] {
  const recent: WorkflowCatalogHistoryRow[] = [];
  for (const runId of listWorkflowRunIds(projectRoot)) {
    const snapshot = readWorkflowRunScriptSnapshot(projectRoot, runId);
    const target = snapshot.target;
    if (target === undefined) continue;
    const safeName = safeRecentWorkflowLabel(target, projectRoot);
    const meta = snapshot.kind === "ready" ? staticWorkflowMeta(snapshot.source) : undefined;
    recent.push({
      kind: "history",
      runId,
      target,
      snapshot,
      name: safeName,
      source: target.source,
      sourceLabel: workflowSourceLabel(target.source),
      originPath: snapshot.path ?? `(snapshot unavailable for run ${runId})`,
      description: meta?.description ?? HISTORICAL_WORKFLOW_DESCRIPTION,
      profile: meta?.profile ?? "unclassified",
      phases: meta?.phases ?? [],
    });
    if (recent.length >= RECENT_WORKFLOW_LIMIT) break;
  }
  return recent;
}

/**
 * Parse one bounded source prefix and project every accepted literal `meta`
 * field. Both fields come from the same parse; a source with no literal `meta`
 * yields an undefined description and no phases.
 */
export function staticWorkflowMeta(source: string): {
  description: string | undefined;
  profile: WorkflowAuthoringProfile;
  phases: WorkflowMetaPhase[];
} {
  let description: string | undefined;
  let profile: WorkflowAuthoringProfile = "unclassified";
  let phases: WorkflowMetaPhase[] = [];
  try {
    const root = parse(Lang.JavaScript, source).root();
    for (const statement of root.findAll("export const meta = $META")) {
      const value = exportedMetaObject(statement);
      if (value === undefined) continue;
      const pairs = value.children().filter((child) => child.kind() === "pair");
      if (description === undefined) {
        const literal = staticStringValue(
          pairs.find((pair) => staticObjectKey(pair.field("key")) === "description")?.field("value"),
        );
        if (literal !== undefined && literal.trim() !== "") {
          description = compactCatalogText(literal.replace(/\s+/gu, " ").trim());
        }
      }
      const declaredProfile = staticStringValue(
        pairs.find((pair) => staticObjectKey(pair.field("key")) === "profile")?.field("value"),
      );
      if (declaredProfile === "standard" || declaredProfile === "legacy" || declaredProfile === "integration") {
        profile = declaredProfile;
      }
      if (phases.length === 0) {
        phases = staticMetaPhases(
          pairs.find((pair) => staticObjectKey(pair.field("key")) === "phases")?.field("value"),
        );
      }
    }
  } catch {
    return { description: undefined, profile: "unclassified", phases: [] };
  }
  return { description, profile, phases };
}

/** Declared phases from one bounded source prefix; empty when nothing literal was declared. */
export function staticWorkflowMetaPhases(source: string): WorkflowMetaPhase[] {
  return staticWorkflowMeta(source).phases;
}

/**
 * Accept `phases: [{ title: <static string>, detail?: <static string> }, ...]`
 * and nothing else. One non-literal entry discards the whole array: a partially
 * read pipeline would describe a shape the workflow does not have, with no
 * marker telling the reader so.
 */
function staticMetaPhases(node: SgNode | null | undefined): WorkflowMetaPhase[] {
  if (node == null || node.kind() !== "array") return [];
  const declared: WorkflowMetaPhase[] = [];
  for (const element of node.children()) {
    if (isStructuralLiteralNode(element)) continue;
    if (element.kind() !== "object") return [];
    // A spread, shorthand, or method member means the element is not fully
    // literal, so the declaration cannot be trusted as a whole.
    if (element.children().some((child) => !isStructuralLiteralNode(child) && child.kind() !== "pair")) return [];
    const pairs = element.children().filter((child) => child.kind() === "pair");
    const title = staticStringValue(
      pairs.find((pair) => staticObjectKey(pair.field("key")) === "title")?.field("value"),
    );
    if (title === undefined || title.trim() === "") return [];
    const detailPair = pairs.find((pair) => staticObjectKey(pair.field("key")) === "detail");
    if (detailPair !== undefined) {
      const detail = staticStringValue(detailPair.field("value"));
      if (detail === undefined) return [];
      const compacted = detail.replace(/\s+/gu, " ").trim();
      declared.push(
        compacted === "" ? { title: title.trim() } : { title: title.trim(), detail: compactCatalogText(compacted) },
      );
      continue;
    }
    declared.push({ title: title.trim() });
  }
  return declared;
}

/** Punctuation and comments carry no declaration; everything else must be literal. */
function isStructuralLiteralNode(node: SgNode): boolean {
  const kind = node.kind();
  return kind === "{" || kind === "}" || kind === "[" || kind === "]" || kind === "," || kind === "comment";
}

/** One declared-or-observed phase group for a finished or in-flight run. */
export interface WorkflowPhaseGroup {
  title: string;
  detail?: string;
  /** The workflow's `meta.phases` named this stage before the run started. */
  declared: boolean;
  /** The run actually emitted a `phase()` line with this exact title. */
  reached: boolean;
}

/**
 * Match a static declaration against the titles a run actually emitted.
 * Declared order is kept; an observed title with no declaration is appended in
 * first-seen order as its own undeclared group. Nothing fails on a mismatch —
 * a `phase()` inside a branch may legitimately never run, and a drifted
 * declaration is evidence a reader should see, not a rule to enforce.
 */
export function matchWorkflowPhaseGroups(
  declared: readonly WorkflowMetaPhase[],
  observedTitles: readonly string[],
): WorkflowPhaseGroup[] {
  const observed = new Set(observedTitles);
  const declaredTitles = new Set(declared.map((phase) => phase.title));
  const groups: WorkflowPhaseGroup[] = declared.map((phase) => ({
    title: phase.title,
    ...(phase.detail !== undefined ? { detail: phase.detail } : {}),
    declared: true,
    reached: observed.has(phase.title),
  }));
  const appended = new Set<string>();
  for (const title of observedTitles) {
    if (declaredTitles.has(title) || appended.has(title)) continue;
    appended.add(title);
    groups.push({ title, declared: false, reached: true });
  }
  return groups;
}

function sameRunSnapshotIdentity(left: WorkflowRunScriptSnapshot, right: WorkflowRunScriptSnapshot): boolean {
  return (
    left.runId === right.runId &&
    samePersistedTarget(left.target, right.target) &&
    left.path === right.path &&
    left.sha256 === right.sha256 &&
    left.identityCoverage === right.identityCoverage
  );
}

function samePersistedTarget(
  left: WorkflowRunResultEnvelope["target"],
  right: WorkflowRunResultEnvelope["target"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.kind === right.kind && left.ref === right.ref && left.source === right.source;
}

function readBoundedSource(file: string): string {
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(WORKFLOW_METADATA_SCAN_BYTES);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function exportedMetaObject(statement: SgNode): SgNode | undefined {
  const declaration = statement.children().find((child) => child.kind() === "lexical_declaration");
  const variable = declaration
    ?.children()
    .find((child) => child.kind() === "variable_declarator" && child.field("name")?.text() === "meta");
  const value = variable?.field("value");
  return value?.kind() === "object" ? value : undefined;
}

function staticStringValue(node: SgNode | null | undefined): string | undefined {
  if (node == null || (node.kind() !== "string" && node.kind() !== "template_string")) return undefined;
  let value = "";
  for (const child of node.children()) {
    if (child.kind() === "string_fragment") value += child.text();
    else if (child.kind() === "escape_sequence") value += decodeEscapeSequence(child.text());
    else if (child.kind() === "template_substitution") return undefined;
  }
  return value;
}

function staticObjectKey(node: SgNode | null | undefined): string | undefined {
  if (node == null || node.kind() === "computed_property_name") return undefined;
  if (node.kind() === "string") return staticStringValue(node);
  return node.text();
}

function decodeEscapeSequence(value: string): string {
  const body = value.slice(1);
  const fixed: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
  if (fixed[body] !== undefined) return fixed[body];
  const unicodeCodePoint = /^u\{([0-9a-f]+)\}$/iu.exec(body)?.[1];
  if (unicodeCodePoint !== undefined) return String.fromCodePoint(Number.parseInt(unicodeCodePoint, 16));
  const unicode = /^u([0-9a-f]{4})$/iu.exec(body)?.[1];
  if (unicode !== undefined) return String.fromCharCode(Number.parseInt(unicode, 16));
  const hex = /^x([0-9a-f]{2})$/iu.exec(body)?.[1];
  if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16));
  if (body === "\n" || body === "\r\n") return "";
  return body;
}

function completePackageBundleParents(targets: readonly ResolvedWorkflowTarget[]): ReadonlySet<string> {
  const visiblePackageNames = new Set(
    targets.filter((target) => target.source === "package").map((target) => target.ref),
  );
  return new Set(
    PACKAGE_WORKFLOW_BUNDLES.filter(
      (bundle) =>
        visiblePackageNames.has(bundle.parent) && bundle.children.every((child) => visiblePackageNames.has(child)),
    ).map((bundle) => bundle.parent),
  );
}

function workflowBundleFor(
  name: string,
  source: WorkflowCatalogRow["source"],
  completeBundleParents: ReadonlySet<string>,
): WorkflowCatalogRow["bundle"] {
  if (source !== "package") return undefined;
  for (const bundle of PACKAGE_WORKFLOW_BUNDLES) {
    if (!completeBundleParents.has(bundle.parent)) continue;
    if (name === bundle.parent) return { ...bundle, role: "parent" };
    if ((bundle.children as readonly string[]).includes(name))
      return { version: bundle.version, parent: bundle.parent, role: "child" };
  }
  return undefined;
}

function rowsForSource<Row extends WorkflowCatalogRow>(rows: Row[], source: WorkflowCatalogRow["source"]): Row[] {
  return rows.filter((row) => row.source === source).sort(compareCatalogRows);
}

function workflowCatalogRowMatches(row: WorkflowCatalogRow, query: string | undefined): boolean {
  if (query === undefined) return true;
  const needle = query.toLocaleLowerCase();
  return row.name.toLocaleLowerCase().includes(needle) || row.description.toLocaleLowerCase().includes(needle);
}

function appendWorkflowCatalogGroup(
  out: string[],
  title: string,
  rows: readonly (WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow)[],
  empty: string,
): void {
  out.push("", `${title}:`);
  if (rows.length === 0) {
    out.push(`  (${empty})`);
    return;
  }
  for (const row of rows) {
    out.push(`  ${passiveCatalogRowLine(row)}`);
  }
}

function workflowBundleDetailLines(bundle: WorkflowCatalogRow["bundle"]): string[] {
  if (bundle === undefined) return [];
  if (bundle.role === "child") return [`bundle: child of ${bundle.parent} (version ${bundle.version})`];
  return [
    `bundle: parent (version ${bundle.version}; ${bundle.children?.length ?? 0} children)`,
    ...(bundle.children ?? []).map((child, index) => `  child ${index + 1}: ${child}`),
  ];
}

function workflowBundleCompactLines(bundle: WorkflowCatalogRow["bundle"]): string[] {
  if (bundle === undefined) return [];
  return bundle.role === "parent"
    ? [`Bundle: ${bundle.parent} parent · ${bundle.children?.length ?? 0} exact children · version ${bundle.version}`]
    : [`Bundle: exact child of ${bundle.parent} · version ${bundle.version}`];
}

function passiveCatalogRowLine(row: WorkflowCatalogCurrentRow | WorkflowCatalogHistoryRow): string {
  const run = row.kind === "history" ? ` · run ${row.runId}` : "";
  const bundle =
    row.bundle === undefined
      ? ""
      : row.bundle.role === "parent"
        ? ` · bundle parent (${row.bundle.children?.length ?? 0} children)`
        : ` · bundle child of ${row.bundle.parent}`;
  // Stage count only: the full declaration belongs to /workflows info, and a
  // catalog row that grows with the pipeline stops being scannable.
  const phases = row.phases.length > 0 ? ` · phases=${row.phases.length}` : "";
  return `${row.name}${run} · ${workflowSourceBadge(row.source)}${bundle} · ${row.description}${phases} · profile=${row.profile} · ${row.originPath} · /workflows info ${row.name}`;
}

export function workflowSourceBadge(source: WorkflowCatalogRow["source"]): "[P]" | "[U]" | "[PKG]" {
  if (source === "project") return "[P]";
  if (source === "personal") return "[U]";
  return "[PKG]";
}

export function workflowSourceLabel(source: WorkflowCatalogRow["source"]): "Project" | "User" | "Package" {
  if (source === "project") return "Project";
  if (source === "personal") return "User";
  return "Package";
}

function compareCatalogRows(a: WorkflowCatalogRow, b: WorkflowCatalogRow): number {
  return a.name.localeCompare(b.name);
}

function compactCatalogText(value: string): string {
  return value.length <= DESCRIPTION_MAX_CHARS ? value : `${value.slice(0, DESCRIPTION_MAX_CHARS - 3)}...`;
}

function compactWorkflowCatalogLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function sameResolvedTarget(left: ResolvedWorkflowTarget, right: ResolvedWorkflowTarget): boolean {
  return (
    left.kind === right.kind &&
    left.ref === right.ref &&
    left.source === right.source &&
    path.resolve(left.path) === path.resolve(right.path)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}
