import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { AssetRegistry, Bounds, Scene, assertDiagramHealthy, layout } = require("@kroffske/excalidraw-diagrams");

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = join(outputDirectory, "review-fix-pipeline.excalidraw");
const scene = new Scene({
  seed: 20260720,
  assetRegistry: AssetRegistry.bundled(),
  background: "#ffffff",
});

// One left-to-right column per stage, exactly like the sibling `review`
// diagram. Lane titles own the left margin, so the first node of every lane
// starts right of LANE_LABEL_WIDTH.
//
// The pipeline is authored as one long strip and then WRAPPED into two bands.
// Unwrapped it renders about 5900x1400 — a ~4.3:1 sliver whose text is
// illegible at fit-to-window — so every node whose authored x is at or past
// BAND_BREAK drops into a second band below, and the four swim lanes are drawn
// once per band. Authored coordinates never change; only bandX/bandY move them.
const BAND_BREAK = 3200;
const BAND_DX = -3115;
const BAND_DY = 1360;
const inBand2 = (x) => x >= BAND_BREAK;
const bandX = (x) => (inBand2(x) ? x + BAND_DX : x);
const bandY = (x, y) => (inBand2(x) ? y + BAND_DY : y);

const LANE_X = 40;
const LANE_WIDTH = 3220;
const LANE_LABEL_WIDTH = 400;

const COLORS = {
  operator: "#087f5b",
  workflow: "#7e22ce",
  agent: "#0b1fb3",
  artifact: "#475569",
  // Reserved for the one surface this workflow mutates: the launch checkout.
  write: "#b91c1c",
  muted: "#64748b",
  operatorFill: "#ecfdf5",
  workflowFill: "#faf5ff",
  agentFill: "#eff6ff",
  artifactFill: "#f8fafc",
  writeFill: "#fef2f2",
};

const setFrameFill = (element, fill, opacity = 100) => {
  element.backgroundColor = fill;
  element.fillStyle = "solid";
  element.opacity = opacity;
};

const tintBlock = (block, color, fill) => {
  for (const element of block.elements) {
    if (element.type !== "image") {
      element.strokeColor = color;
    }
    if (element.type === "rectangle" || element.type === "ellipse") {
      setFrameFill(element, fill);
    }
  }
  return block;
};

const nodeRecord = (id, block) => ({
  id,
  block,
  texts: block.elements.filter((element) => element.type === "text"),
});

const operatorNode = (id, title, body, iconId, authoredX, authoredY, width, height) => {
  const x = bandX(authoredX);
  const y = bandY(authoredX, authoredY);
  const frame = scene.ellipse(x, y, width, height, {
    color: COLORS.operator,
    strokeWidth: 2,
  });
  setFrameFill(frame, COLORS.operatorFill);
  const icon = scene.placeAsset(iconId, x + 28, y + 34, 48);
  const titleText = scene.text(x + 90, y + 27, title, {
    size: 17,
    color: COLORS.operator,
    width: width - 112,
    align: "center",
  });
  const bodyText = scene.text(x + 90, y + 57, body, {
    size: 12,
    color: COLORS.operator,
    width: width - 112,
    align: "center",
  });
  return nodeRecord(id, scene.group([frame, icon, titleText, bodyText]));
};

const workflowNode = (id, title, bullets, iconId, authoredX, authoredY, width, height) =>
  nodeRecord(
    id,
    tintBlock(
      layout.iconPanel(scene, bandX(authoredX), bandY(authoredX, authoredY), width, height, {
        title,
        iconId,
        bullets,
        iconSize: 42,
        titleSize: 16,
        bulletSize: 12,
        bulletGap: 7,
      }),
      COLORS.workflow,
      COLORS.workflowFill,
    ),
  );

const agentNode = (id, title, bullets, iconId, authoredX, authoredY, width, height) =>
  nodeRecord(
    id,
    tintBlock(
      layout.iconPanel(scene, bandX(authoredX), bandY(authoredX, authoredY), width, height, {
        title,
        iconId,
        bullets,
        iconSize: 48,
        titleSize: 15,
        bulletSize: 12,
        bulletGap: 7,
      }),
      COLORS.agent,
      COLORS.agentFill,
    ),
  );

const workflowCheck = (id, title, body, authoredX, authoredY, width, height) => {
  const x = bandX(authoredX);
  const y = bandY(authoredX, authoredY);
  const frame = scene.line(
    [
      [x + width / 2, y],
      [x + width, y + height / 2],
      [x + width / 2, y + height],
      [x, y + height / 2],
      [x + width / 2, y],
    ],
    { color: COLORS.workflow, strokeWidth: 2 },
  );
  setFrameFill(frame, COLORS.workflowFill);
  const titleText = scene.text(x + 15, y + 84, title, {
    size: 10,
    color: COLORS.workflow,
    width: width - 30,
    align: "center",
  });
  const bodyText = scene.text(x + 50, y + 112, body, {
    size: 10,
    color: COLORS.workflow,
    width: width - 100,
    align: "center",
  });
  return nodeRecord(id, scene.group([frame, titleText, bodyText]));
};

const artifactNode = (id, title, lines, iconId, authoredX, authoredY, width, height, write = false) => {
  const x = bandX(authoredX);
  const y = bandY(authoredX, authoredY);
  const color = write ? COLORS.write : COLORS.artifact;
  const frame = scene.rect(x, y, width, height, {
    color,
    strokeWidth: 2,
    roundness: null,
  });
  setFrameFill(frame, write ? COLORS.writeFill : COLORS.artifactFill);
  const fold = scene.line(
    [
      [x + width - 34, y],
      [x + width - 34, y + 34],
      [x + width, y + 34],
    ],
    { color, strokeWidth: 1 },
  );
  const icon = scene.placeAsset(iconId, x + 24, y + 42, 42);
  const titleText = scene.text(x + 82, y + 20, title, {
    size: 14,
    color,
    width: width - 112,
    align: "left",
  });
  // Titles wrap by hand, so the body starts below the real title line count.
  const body = scene.text(x + 82, y + 34 + title.split("\n").length * 18, lines.join("\n"), {
    size: 11,
    color,
    width: width - 106,
    align: "left",
  });
  return nodeRecord(id, scene.group([frame, fold, icon, titleText, body]));
};

const lane = (title, subtitle, y, height, color, fill) => {
  for (const dy of [0, BAND_DY]) {
    const frame = scene.rect(LANE_X, y + dy, LANE_WIDTH, height, {
      color,
      strokeWidth: 1,
      dashed: true,
    });
    setFrameFill(frame, fill, 45);
    frame.roughness = 0;
    scene.text(LANE_X + 22, y + dy + 14, title, {
      size: 19,
      color,
      width: LANE_LABEL_WIDTH,
    });
    scene.text(LANE_X + 22, y + dy + 44, subtitle, {
      size: 11,
      color: COLORS.muted,
      width: LANE_LABEL_WIDTH,
    });
  }
};

scene.text(
  LANE_X,
  20,
  "Curated review-fix workflow — agent-planned finding DAG, one writer per finding, fresh re-review",
  {
    size: 29,
    width: LANE_WIDTH,
    align: "center",
  },
);
scene.text(
  LANE_X,
  61,
  "The host binds one digest-verified review.md separately from semantic text. A shaped no-tool selector proposes ids, notes, and dependencies; deterministic code rejects invalid graphs and computes stable topological order before sequential writers, independent checks, and fresh re-review.",
  {
    size: 15,
    color: COLORS.muted,
    width: LANE_WIDTH,
    align: "center",
  },
);

scene.text(80, 99, "Legend", {
  size: 16,
  color: COLORS.artifact,
  width: 90,
});
const legendOperator = scene.ellipse(170, 92, 92, 50, {
  color: COLORS.operator,
  strokeWidth: 2,
});
setFrameFill(legendOperator, COLORS.operatorFill);
scene.text(274, 103, "Operator", {
  size: 12,
  color: COLORS.operator,
  width: 100,
});
const legendWorkflow = scene.rect(410, 92, 112, 50, {
  color: COLORS.workflow,
  strokeWidth: 2,
});
setFrameFill(legendWorkflow, COLORS.workflowFill);
scene.text(534, 96, "Workflow-owned action\n(round card)", {
  size: 11,
  color: COLORS.workflow,
  width: 185,
});
const legendCheck = scene.line(
  [
    [780, 92],
    [836, 117],
    [780, 142],
    [724, 117],
    [780, 92],
  ],
  { color: COLORS.workflow, strokeWidth: 2 },
);
setFrameFill(legendCheck, COLORS.workflowFill);
scene.text(850, 96, "Workflow-owned check\n(diamond)", {
  size: 11,
  color: COLORS.workflow,
  width: 175,
});
const legendAgent = scene.rect(1080, 92, 112, 50, {
  color: COLORS.agent,
  strokeWidth: 2,
});
setFrameFill(legendAgent, COLORS.agentFill);
scene.text(1204, 96, "Full agent session\n(blue card)", {
  size: 11,
  color: COLORS.agent,
  width: 160,
});
const legendArtifact = scene.rect(1425, 92, 112, 50, {
  color: COLORS.artifact,
  strokeWidth: 2,
  roundness: null,
});
setFrameFill(legendArtifact, COLORS.artifactFill);
scene.line(
  [
    [1513, 92],
    [1513, 116],
    [1537, 116],
  ],
  { color: COLORS.artifact, strokeWidth: 1 },
);
scene.text(1549, 96, "Artifact file\n(gray document)", {
  size: 11,
  color: COLORS.artifact,
  width: 160,
});
const legendWrite = scene.rect(1760, 92, 112, 50, {
  color: COLORS.write,
  strokeWidth: 2,
  roundness: null,
});
setFrameFill(legendWrite, COLORS.writeFill);
scene.line(
  [
    [1848, 92],
    [1848, 116],
    [1872, 116],
  ],
  { color: COLORS.write, strokeWidth: 1 },
);
scene.text(1884, 96, "Mutated source surface\n(red document)", {
  size: 11,
  color: COLORS.write,
  width: 170,
});
lane(
  "OPERATOR",
  "Supplies one semantic fix request plus one immutable continued review.md; then reads the diff and re-review.",
  170,
  190,
  COLORS.operator,
  "#f0fdf4",
);
lane(
  "WORKFLOW-OWNED",
  "Artifact origin verification, complete-block parsing, DAG validation/order, source fingerprints, and capability policy.",
  390,
  330,
  COLORS.workflow,
  "#faf5ff",
);
lane(
  "FULL AGENT SESSIONS",
  "No-tool selector → read-only scope → one sequential writer per selected finding → read-only checker and re-review.",
  750,
  340,
  COLORS.agent,
  "#eff6ff",
);
lane(
  "ARTIFACTS",
  "Consumed review bytes, source-state fingerprints, named answers, mutated source, transcript and journal evidence.",
  1120,
  270,
  COLORS.artifact,
  "#f8fafc",
);

const request = operatorNode(
  "operator-request",
  "Operator: semantic fix request",
  "input:string + continuation containing\nexactly one full review.md ref",
  "chat_message",
  85,
  240,
  430,
  110,
);

const resolveReview = workflowNode(
  "resolve-review",
  "Workflow: consume immutable review",
  [
    "phase resolve-fix-scope · deterministic first",
    "verify full ref + digest + terminal result projection",
    "Requires Package review · verify-review answer",
    "Copies exact bytes into this run's inputs",
    "Never treats artifact editing as approval",
  ],
  "guardrails",
  560,
  460,
  430,
  165,
);

const findingsGate = workflowCheck(
  "findings-gate",
  "Workflow: parse complete finding blocks",
  '"## Findings" contains complete "### F<n>" blocks\nids are unique and source order is retained\nmalformed review fails before selector/writer execution',
  1080,
  450,
  400,
  230,
);

const launchScope = workflowNode(
  "launch-agent-f1",
  "Workflow: launch shaped selector",
  ["phase resolve-fix-scope", "Inline selector task under COMMON", "readOnly + no tools · FINDING_SELECTOR_SCHEMA"],
  "multi_agent_orchestrator",
  1600,
  470,
  410,
  145,
);

const scopeAgent = agentNode(
  "agent-f1",
  "Agent: finding graph selector",
  [
    "label: plan finding graph · finding-plan.json",
    "Chooses 1–20 ids, notes, and dependsOn edges",
    "Sees operator intent + immutable review bytes",
    "Returns shaped object; never edits source",
  ],
  "signal_quality_magnifier",
  1590,
  815,
  440,
  195,
);

const forwardCheck = workflowCheck(
  "forward-exact-text",
  "Workflow: validate and order finding DAG",
  "Reject unknown/duplicate/self edges, note bounds, cycles\nStable Kahn order uses original review order\nNo writer starts until the whole graph is valid",
  2160,
  450,
  360,
  230,
);

const launchUnits = workflowNode(
  "launch-agent-f2",
  "Workflow: launch scope resolver",
  [
    "Inline task under COMMON + READ_ONLY_NOTE",
    "Receives validated ordered findings",
    "readOnly: read, git_read, ast_index, grep, find",
  ],
  "multi_agent_orchestrator",
  2720,
  470,
  410,
  145,
);

const unitsAgent = agentNode(
  "agent-f2",
  "Agent: scope resolver",
  [
    "label: resolve fix scope · artifact: scope.md",
    "Maps selected blocks to live source/dependencies",
    "Host-enforced read-only",
    "Returns exact scopeText",
  ],
  "agent_planner",
  2710,
  815,
  440,
  195,
);

const launchImplement = workflowNode(
  "launch-agent-f3",
  "Workflow: iterate selected findings",
  [
    "phase apply-kept-findings",
    "Inline writer task under COMMON",
    "Sequential topological order; fingerprint each window",
  ],
  "multi_agent_orchestrator",
  3280,
  470,
  410,
  145,
);

const implementAgent = agentNode(
  "agent-f3",
  "Agent: one writer for current F<n>",
  [
    "artifact: worker-F<n>.md",
    "Receives one full block + note + direct dependencies",
    "Write/edit/bash; never handles another finding",
    "Failure skips transitive dependents; independent writers continue",
    "Any failure skips checks and fresh re-review",
  ],
  "sandbox_executor",
  3270,
  815,
  440,
  235,
);

const launchVerify = workflowNode(
  "launch-agent-f4",
  "Workflow: launch independent checker",
  [
    "phase collect-check-evidence",
    "Inline task under COMMON + READ_ONLY_NOTE",
    "readOnly + baseline-frozen repository_check",
  ],
  "multi_agent_orchestrator",
  3840,
  470,
  410,
  145,
);

const verifyAgent = agentNode(
  "agent-f4",
  "Agent: check-evidence collector",
  [
    "artifact: check-evidence.md",
    "Treats every worker result as a claim",
    "Reads full diff; checks in disposable worktrees",
    "Never edits a failure it observes",
  ],
  "model_validation",
  3830,
  815,
  440,
  195,
);

const launchPublish = workflowNode(
  "launch-agent-f5",
  "Workflow: launch fresh re-review",
  [
    "phase re-review-fixes",
    "Inline task under COMMON + READ_ONLY_NOTE",
    "Host-enforced read-only; no shell/write/edit",
  ],
  "multi_agent_orchestrator",
  4400,
  470,
  410,
  145,
);

const publishAgent = agentNode(
  "agent-f5",
  "Agent: fresh read-only re-reviewer",
  [
    "artifact: re-review.md",
    "Receives original review + claims + checks + fingerprints",
    "Rechecks every original finding and dependency surface",
    "Reports remaining, excluded, stale, and new regressions",
  ],
  "prompt_template",
  4390,
  815,
  440,
  215,
);

const mapFinalResult = workflowNode(
  "map-final-result",
  "Workflow: return exact re-review text",
  ["No JSON parse", "Exact Agent re-review answer is the result", "Runtime already stored it as re-review.md"],
  "function_router",
  4960,
  470,
  410,
  145,
);

const operatorDiff = operatorNode(
  "operator-review-diff",
  "Operator: review the diff",
  "Changes stay uncommitted in the launch checkout\nCommit, amend, or discard outside the workflow",
  "human_review",
  5460,
  240,
  460,
  110,
);

const sourceFile = artifactNode(
  "source-file",
  "Artifact: review-fix.workflow.mjs\n(inline COMMON + every stage task;\nno prompt resources)",
  ["Self-contained static workflow identity", "Inline complete-block parser", "phase() and log() name every stage"],
  "prompt_template",
  85,
  1200,
  430,
  175,
);

const reviewInput = artifactNode(
  "review-input",
  "Artifact: immutable review.md reference",
  [
    "Full {runId, artifactId, name, sha256}",
    "Package review · verify-review answer only",
    "Verified bytes copied into this run",
    "Host-consumed before workflow module execution",
    "Selector never mutates the original review",
  ],
  "human_review",
  580,
  1200,
  420,
  175,
);

const journalFile = artifactNode(
  "journal-file",
  "Artifact: journal.ndjson",
  ["Runtime execution journal", "phase, log, and child-session evidence", "Four phases; dynamic writer count"],
  "audit_log",
  2140,
  1200,
  400,
  175,
);

const launchCheckout = artifactNode(
  "launch-checkout",
  "Artifact: uncommitted changes\nin the launch checkout",
  [
    "workspaceMode: project — the launch checkout",
    "Each writer sees the whole launch workspace",
    "A review often covers uncommitted work",
    "Never committed, pushed, or stashed",
  ],
  "sandbox_executor",
  3200,
  1200,
  430,
  175,
  true,
);

const supportingFiles = artifactNode(
  "supporting-files",
  "Artifact: runtime-owned named answers",
  [
    "scope.md + worker-F<n>.md",
    "check-evidence.md + re-review.md",
    "source-state-*.json fingerprints",
    "Answers under <runId>/artifacts/answers/",
    "Indexed with stage, digest, and call identity",
  ],
  "aggregation_puzzle",
  3800,
  1200,
  420,
  175,
);

const resultFile = artifactNode(
  "result-file",
  "Artifact: result.json",
  ["Mandatory machine-readable run envelope", "result is the exact re-review text", "Child metadata stays separate"],
  "data_catalog",
  4880,
  1200,
  400,
  175,
);

const fixReportFile = artifactNode(
  "fix-report-file",
  "Artifact: re-review.md",
  [
    ".locus/runtime/workflows/<runId>/artifacts/answers/",
    "Primary reader-facing remediation verdict",
    "Every original finding + dependencies + regressions",
    "Exact answer; digest-bound in the run index",
  ],
  "news_document",
  5440,
  1200,
  480,
  175,
);

const nodes = [
  request,
  resolveReview,
  findingsGate,
  launchScope,
  scopeAgent,
  forwardCheck,
  launchUnits,
  unitsAgent,
  launchImplement,
  implementAgent,
  launchVerify,
  verifyAgent,
  launchPublish,
  publishAgent,
  mapFinalResult,
  operatorDiff,
  sourceFile,
  reviewInput,
  journalFile,
  launchCheckout,
  supportingFiles,
  resultFile,
  fixReportFile,
];

const edges = [];
const connect = (id, from, to, options = {}) => {
  const routed = layout.connectRouted(scene, from.block, to.block, {
    path: "orthogonal",
    direction: "left-to-right",
    labelSize: 11,
    labelColor: COLORS.artifact,
    labelWidth: 150,
    ...options,
  });
  edges.push({
    id,
    from: from.id,
    to: to.id,
    points: routed.points,
    ...(routed.label
      ? {
          label: {
            id: `${id}-label`,
            bounds: scene.bounds([routed.label]),
          },
        }
      : {}),
  });
};

// Start a stage: the workflow card drops into the agent session it launches.
const launchEdge = (id, launchNode, agent, label) => {
  connect(id, launchNode, agent, {
    direction: "top-down",
    label,
    labelWidth: 160,
    from: { side: "bottom", slot: 0.3 },
    to: { side: "top", slot: 0.3 },
  });
};

// Finish a stage: the agent's exact text rises into the next workflow card.
const handoffEdge = (id, agent, nextNode, label) => {
  connect(id, agent, nextNode, {
    direction: "bottom-up",
    label,
    labelWidth: 145,
    from: { side: "top", slot: 0.78 },
    to: { side: "bottom", slot: 0.35 },
  });
};

connect("operator-to-resolve", request, resolveReview, {
  label: "input:string + continuation",
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("source-to-resolve", sourceFile, resolveReview, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.artifact,
  label: "workflow definition",
  from: { side: "top", slot: 0.5 },
  to: { side: "bottom", slot: 0.15 },
  labelOffset: { dx: -80, dy: 0 },
});
connect("review-to-resolve", reviewInput, resolveReview, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.operator,
  label: "host-consumed review.md",
  labelWidth: 120,
  from: { side: "top", slot: 0.5 },
  to: { side: "bottom", slot: 0.8 },
});
connect("resolve-to-gate", resolveReview, findingsGate, {
  label: "verified exact bytes",
  labelWidth: 130,
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("gate-to-launch-f1", findingsGate, launchScope, {
  label: "complete F<n> blocks",
  labelWidth: 130,
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});

launchEdge("launch-to-agent-f1", launchScope, scopeAgent, "agent(selectorPrompt, FINDING_SELECTOR_SCHEMA)");
connect("agent-f1-to-forward", scopeAgent, forwardCheck, {
  direction: "bottom-up",
  label: "{ findings:[{id,note,dependsOn}] }",
  labelWidth: 130,
  from: { side: "top", slot: 0.9 },
  to: { side: "left", slot: 0.5 },
});
connect("forward-to-launch-f2", forwardCheck, launchUnits, {
  label: "validated topological order",
  labelWidth: 130,
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("forward-to-journal", forwardCheck, journalFile, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "phase + log events",
  from: { side: "bottom", slot: 0.5 },
  to: { side: "top", slot: 0.5 },
  labelOffset: { dx: 96, dy: 0 },
});

launchEdge("launch-to-agent-f2", launchUnits, unitsAgent, "ordered full blocks + notes + dependencies");
handoffEdge("agent-f2-to-launch-f3", unitsAgent, launchImplement, "exact scopeText");

launchEdge(
  "launch-to-agent-f3",
  launchImplement,
  implementAgent,
  "one block + direct dependency results\n+ host fingerprints",
);
handoffEdge("agent-f3-to-launch-f4", implementAgent, launchVerify, "all exact worker results");

launchEdge(
  "launch-to-agent-f4",
  launchVerify,
  verifyAgent,
  "claims + host fingerprints\n+ repository_check capability",
);
handoffEdge("agent-f4-to-launch-f5", verifyAgent, launchPublish, "exact check evidence");

connect("launch-to-agent-f5", launchPublish, publishAgent, {
  direction: "top-down",
  label: "original review + claims + checks\n+ source transitions",
  labelWidth: 160,
  from: { side: "bottom", slot: 0.3 },
  to: { side: "top", slot: 0.3 },
});
handoffEdge("agent-f5-to-map", publishAgent, mapFinalResult, "exact re-review text");

connect("agent-f3-to-checkout", implementAgent, launchCheckout, {
  direction: "top-down",
  color: COLORS.write,
  label: "edits source in place",
  labelWidth: 140,
  from: { side: "bottom", slot: 0.2 },
  to: { side: "top", slot: 0.6 },
});
connect("checkout-to-agent-f4", launchCheckout, verifyAgent, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.write,
  label: "re-reads full diff; scripts run\nin disposable worktree",
  labelWidth: 140,
  from: { side: "top", slot: 0.72 },
  to: { side: "bottom", slot: 0.25 },
});
connect("agent-f5-to-supporting", publishAgent, supportingFiles, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "runtime indexes all named answers",
  labelWidth: 160,
  from: { side: "bottom", slot: 0.15 },
  to: { side: "top", slot: 0.5 },
});
connect("agent-f5-to-report", publishAgent, fixReportFile, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "indexes re-review.md",
  labelWidth: 175,
  from: { side: "bottom", slot: 0.85 },
  to: { side: "top", slot: 0.3 },
  labelOffset: { dx: 210, dy: 0 },
});
connect("report-to-operator", fixReportFile, operatorDiff, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.operator,
  label: "operator reads the report",
  labelWidth: 150,
  from: { side: "top", slot: 0.5 },
  to: { side: "bottom", slot: 0.5 },
});
connect("map-to-result", mapFinalResult, resultFile, {
  direction: "top-down",
  label: "serialized return",
  from: { side: "bottom", slot: 0.5 },
  to: { side: "top", slot: 0.5 },
});

const health = assertDiagramHealthy({
  blocks: nodes.map(({ id, block, texts }) => ({
    id,
    bounds: block.bounds,
    texts,
    padding: 0,
  })),
  edges,
  gap: 8,
  renderBounds: new Bounds(0, 0, 3320, 2810),
  sceneBounds: scene.bounds(),
});

scene.write(outputPath);
const output = JSON.parse(readFileSync(outputPath, "utf8"));
if (
  output.type !== "excalidraw" ||
  !Array.isArray(output.elements) ||
  output.elements.length === 0 ||
  typeof output.files !== "object" ||
  output.files === null ||
  Object.keys(output.files).length === 0
) {
  throw new Error("Generated review-fix pipeline is missing Excalidraw elements or embedded assets.");
}

console.log(
  JSON.stringify(
    {
      outputPath,
      validation: {
        ok: health.ok,
        errors: health.errors.length,
        warnings: health.warnings.length,
      },
      elements: output.elements.length,
      files: Object.keys(output.files).length,
    },
    null,
    2,
  ),
);
