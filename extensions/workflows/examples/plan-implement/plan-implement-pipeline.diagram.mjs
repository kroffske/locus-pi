import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { AssetRegistry, Bounds, Scene, assertDiagramHealthy, layout } = require("@kroffske/excalidraw-diagrams");

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = join(outputDirectory, "plan-implement-pipeline.excalidraw");
const scene = new Scene({
  seed: 20260728,
  assetRegistry: AssetRegistry.bundled(),
  background: "#ffffff",
});

// One left-to-right column per stage, exactly like the sibling `review`
// diagram. Lane titles own the left margin, so the first node of every lane
// starts right of LANE_LABEL_WIDTH.
//
// The pipeline is authored as one long strip and then WRAPPED into two bands.
// Unwrapped it renders about 5400x1400 — a ~3.9:1 sliver whose text is
// illegible at fit-to-window — so every node whose authored x is at or past
// BAND_BREAK drops into a second band below, and the four swim lanes are drawn
// once per band. Authored coordinates never change; only bandX/bandY move them.
const BAND_BREAK = 3300;
const BAND_DX = -2750;
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
  "Curated plan-implement workflow — verified plan bytes, one writer per step, independent checks and report",
  {
    size: 29,
    width: LANE_WIDTH,
    align: "center",
  },
);
scene.text(
  LANE_X,
  61,
  "The host binds one digest-verified plan.md separately from semantic text, and the entry proves those exact bytes were a successful plan run\u2019s terminal result. Deterministic code parses the S<n> blocks; a shaped no-tool selector chooses which of them this run implements, the plan\u2019s own order is restored, and one writer owns each step before independent checks and a fresh report.",
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
  "Supplies one semantic request plus one accepted continued plan.md; then reads the diff and the report.",
  170,
  190,
  COLORS.operator,
  "#f0fdf4",
);
lane(
  "WORKFLOW-OWNED",
  "Artifact origin verification, step-block parsing, id validation and plan-order restore, source fingerprints, capability policy.",
  390,
  330,
  COLORS.workflow,
  "#faf5ff",
);
lane(
  "FULL AGENT SESSIONS",
  "No-tool selector → read-only scope → one sequential writer per selected step → read-only checker and fresh reporter.",
  750,
  340,
  COLORS.agent,
  "#eff6ff",
);
lane(
  "ARTIFACTS",
  "Consumed plan bytes, source-state fingerprints, named answers, mutated source, and journal evidence.",
  1120,
  270,
  COLORS.artifact,
  "#f8fafc",
);

const request = operatorNode(
  "operator-request",
  "Operator: implementation request",
  "input:string + continuation containing\nexactly one full plan.md ref",
  "chat_message",
  85,
  240,
  430,
  110,
);

const consumePlan = workflowNode(
  "consume-plan",
  "Workflow: consume the accepted plan",
  [
    "phase select-steps",
    "Verify full ref + digest + terminal result projection",
    "terminal.result must equal these exact bytes",
    "Rejects a same-named draft from an earlier round",
  ],
  "function_router",
  560,
  460,
  430,
  165,
);

const parseSteps = workflowCheck(
  "parse-steps",
  "Workflow: parse complete ### S<n> blocks",
  "Prior-run text nobody here can repair\nMalformed plan fails before the selector",
  1080,
  450,
  400,
  230,
);

const launchSelector = workflowNode(
  "launch-selector",
  "Workflow: launch the step selector",
  ["Embeds the accepted plan verbatim", "tools: [] — no repository access at all", "STEP_SELECTOR_SCHEMA + validate"],
  "multi_agent_orchestrator",
  1600,
  470,
  410,
  145,
);

const selectorAgent = agentNode(
  "agent-selector",
  "Agent: I0 — step selector",
  [
    "catalog default · label: select plan steps",
    "Chooses 1–30 ids with per-step operator notes",
    "Never selects a step without its predecessor",
    "Returns the shaped selection only",
  ],
  "model_validation",
  1590,
  815,
  440,
  215,
);

const orderGate = workflowCheck(
  "order-gate",
  "Workflow: validate ids and restore plan order",
  "Unknown id is re-asked, not fatal\nThe plan's order wins over the selector's list",
  2160,
  450,
  400,
  230,
);

const launchScope = workflowNode(
  "launch-scope",
  "Workflow: launch Agent I1",
  [
    "phase resolve-implementation-scope",
    "Inline task under COMMON + READ_ONLY_NOTE",
    "captureSourceState before any writer",
  ],
  "multi_agent_orchestrator",
  2760,
  470,
  410,
  145,
);

const scopeAgent = agentNode(
  "agent-scope",
  "Agent: I1 — implementation scope",
  [
    "catalog default · label: resolve implementation scope",
    "Host-enforced read-only",
    "Names collisions with work already in the tree",
    "Returns exact scopeText",
  ],
  "aggregation_puzzle",
  2750,
  815,
  440,
  195,
);

const launchWriter = workflowNode(
  "launch-writer",
  "Workflow: launch one writer per step",
  [
    "phase apply-steps · sequential, in plan order",
    "Fingerprints the checkout around every writer",
    "A failure skips the steps after it, not the run",
  ],
  "multi_agent_orchestrator",
  3320,
  470,
  410,
  145,
);

const writerAgent = agentNode(
  "agent-writer",
  "Agent: I2 — one writer for current S<n>",
  [
    "catalog default · label: implement step S<n>",
    "tools: read, write, edit, bash, ast_index, grep, find",
    "Receives one step block + note + predecessors",
    "workspaceMode: project — writes the launch checkout",
  ],
  "prompt_template",
  3310,
  815,
  440,
  235,
);

const launchCheck = workflowNode(
  "launch-check",
  "Workflow: launch the independent checker",
  ["phase collect-check-evidence", "No edit tools; baseline-frozen repository_check", "maxToolCalls 40"],
  "multi_agent_orchestrator",
  3880,
  470,
  410,
  145,
);

const checkAgent = agentNode(
  "agent-check",
  "Agent: I3 — check-evidence collector",
  [
    "catalog default · label: collect check evidence",
    "Reads the full diff; checks in disposable worktrees",
    "Treats every writer claim as a claim",
    "Decides no outcome; a later stage owns that",
  ],
  "model_validation",
  3870,
  815,
  440,
  215,
);

const launchReport = workflowNode(
  "launch-report",
  "Workflow: launch the fresh reporter",
  ["phase report-implementation", "Forwards the accepted plan and the fingerprints", "Host-enforced read-only"],
  "multi_agent_orchestrator",
  4440,
  470,
  410,
  145,
);

const reportAgent = agentNode(
  "agent-report",
  "Agent: I4 — fresh implementation reporter",
  [
    "catalog default · label: report implementation",
    "Accounts for every planned step, selected or not",
    "Separates writer-window change from drift",
    "Runtime persists exact implementation-report.md",
  ],
  "prompt_template",
  4430,
  815,
  440,
  215,
);

const mapFinalResult = workflowNode(
  "map-final-result",
  "Workflow: return report or partial envelope",
  [
    "Complete run returns the exact report text",
    "A failed writer returns ok:false + partial:true",
    "unresolvedRows names the steps nobody reached",
  ],
  "function_router",
  5000,
  470,
  410,
  145,
);

const operatorRead = operatorNode(
  "operator-read-report",
  "Operator: inspect the diff and report",
  "Reads implementation-report.md, then\nkeeps, amends, or reverts the changes",
  "human_review",
  5480,
  240,
  460,
  110,
);

const sourceFile = artifactNode(
  "source-file",
  "Artifact: plan-implement.workflow.mjs\n(inline COMMON + 5 stage tasks)",
  [
    "Continuation routing and step parsing in the entry",
    "No prompt resources; no local agent files",
    "phase() and log() name every stage",
  ],
  "prompt_template",
  85,
  1200,
  430,
  175,
);

const planInput = artifactNode(
  "plan-input",
  "Artifact: accepted plan.md reference",
  [
    "Host-consumed before the workflow module runs",
    "Package plan · draft-plan answer only",
    "Full {runId, artifactId, name, sha256}",
  ],
  "news_document",
  580,
  1200,
  430,
  175,
);

const journalFile = artifactNode(
  "journal-file",
  "Artifact: journal.ndjson",
  ["Runtime execution journal", "phase, log, and child-session evidence", "Records the step a failed run stopped on"],
  "audit_log",
  1060,
  1200,
  400,
  175,
);

const launchCheckout = artifactNode(
  "launch-checkout",
  "Artifact: the launch checkout",
  [
    "The one surface this workflow mutates",
    "source-state-*.json fingerprints per window",
    "Never committed, pushed, or stashed",
  ],
  "data_catalog",
  3320,
  1200,
  430,
  175,
  true,
);

const supportingFiles = artifactNode(
  "supporting-files",
  "Artifact: runtime-owned named stage answers",
  [
    "step-selection.json, scope.md,",
    "worker-S<n>.md per attempted step,",
    "check-evidence.md + implementation-report.md",
    "Indexed with digest and provenance",
  ],
  "aggregation_puzzle",
  3920,
  1200,
  430,
  175,
);

const resultFile = artifactNode(
  "result-file",
  "Artifact: result.json",
  [
    "Mandatory machine-readable run envelope",
    "result is the exact report text",
    "Partial run: ok:false, partial:true, failedStep",
  ],
  "data_catalog",
  4980,
  1200,
  400,
  175,
);

const reportFile = artifactNode(
  "report-file",
  "Artifact: <runId>/.../implementation-report.md",
  [
    "Primary reader-facing runtime artifact",
    "Per-step outcome, checks, unexpected changes",
    "Exact Agent I4 text; digest stored in the index",
  ],
  "news_document",
  5460,
  1200,
  480,
  175,
);

const nodes = [
  request,
  consumePlan,
  parseSteps,
  launchSelector,
  selectorAgent,
  orderGate,
  launchScope,
  scopeAgent,
  launchWriter,
  writerAgent,
  launchCheck,
  checkAgent,
  launchReport,
  reportAgent,
  mapFinalResult,
  operatorRead,
  sourceFile,
  planInput,
  journalFile,
  launchCheckout,
  supportingFiles,
  resultFile,
  reportFile,
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

connect("operator-to-consume", request, consumePlan, {
  label: "input:string + continuation",
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("source-to-workflow", sourceFile, consumePlan, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.artifact,
  label: "workflow definition",
  from: { side: "top", slot: 0.5 },
  to: { side: "bottom", slot: 0.15 },
  labelOffset: { dx: -80, dy: 0 },
});
connect("plan-input-to-consume", planInput, consumePlan, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.artifact,
  label: "verified prior-run bytes",
  labelWidth: 150,
  from: { side: "top", slot: 0.5 },
  to: { side: "bottom", slot: 0.7 },
});
connect("consume-to-parse", consumePlan, parseSteps, {
  label: "exact accepted plan text",
  labelWidth: 140,
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("parse-to-launch-selector", parseSteps, launchSelector, {
  label: "host-parsed S<n> blocks",
  labelWidth: 140,
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("parse-to-journal", parseSteps, journalFile, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "phase + log events",
  from: { side: "bottom", slot: 0.5 },
  to: { side: "top", slot: 0.5 },
  labelOffset: { dx: 96, dy: 0 },
});

launchEdge("launch-to-agent-i0", launchSelector, selectorAgent, "operator request + accepted plan");
connect("agent-i0-to-order", selectorAgent, orderGate, {
  direction: "bottom-up",
  label: "{ steps[] } with ids and notes",
  labelWidth: 150,
  from: { side: "top", slot: 0.9 },
  to: { side: "left", slot: 0.5 },
});
connect("order-to-launch-i1", orderGate, launchScope, {
  label: "ordered steps, in the plan's own order",
  labelWidth: 160,
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});

launchEdge("launch-to-agent-i1", launchScope, scopeAgent, "intent + ordered steps");
// The wrap edge: band 1 ends after the scope stage and band 2 carries every
// writer, the checker, and the reporter.
connect("agent-i1-to-launch-writer", scopeAgent, launchWriter, {
  direction: "top-down",
  label: "exact scopeText — continues in the band below",
  labelWidth: 230,
  from: { side: "right", slot: 0.5 },
  to: { side: "top", slot: 0.35 },
  path: "outer",
  routeBounds: new Bounds(40, 800, 3100, 590),
  outerSide: "bottom",
  outerGap: 26,
  labelOffset: { dx: 0, dy: 30 },
});
launchEdge("launch-to-agent-i2", launchWriter, writerAgent, "one step block + predecessor results");
handoffEdge("agent-i2-to-launch-check", writerAgent, launchCheck, "all exact step results");
launchEdge("launch-to-agent-i3", launchCheck, checkAgent, "step results + fingerprints");
handoffEdge("agent-i3-to-launch-report", checkAgent, launchReport, "exact check evidence");
launchEdge("launch-to-agent-i4", launchReport, reportAgent, "plan + step results + check evidence");
handoffEdge("agent-i4-to-map", reportAgent, mapFinalResult, "exact report text");

connect("agent-i2-to-checkout", writerAgent, launchCheckout, {
  direction: "top-down",
  dashed: true,
  color: COLORS.write,
  label: "the only stage that changes files",
  labelWidth: 165,
  from: { side: "bottom", slot: 0.5 },
  to: { side: "top", slot: 0.5 },
});
connect("agent-i4-to-supporting", reportAgent, supportingFiles, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "runtime indexes all named answers",
  labelWidth: 160,
  from: { side: "bottom", slot: 0.15 },
  to: { side: "top", slot: 0.5 },
});
connect("agent-i4-to-report-file", reportAgent, reportFile, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "runtime persists exact report",
  labelWidth: 165,
  from: { side: "bottom", slot: 0.85 },
  to: { side: "top", slot: 0.3 },
});
connect("report-to-operator", reportFile, operatorRead, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.operator,
  label: "human reads the report",
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
  throw new Error("Generated plan-implement pipeline is missing Excalidraw elements or embedded assets.");
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
