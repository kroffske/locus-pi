import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { AssetRegistry, Bounds, Scene, assertDiagramHealthy, layout } = require("@kroffske/excalidraw-diagrams");

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = join(outputDirectory, "review-pipeline.excalidraw");
const scene = new Scene({
  seed: 20260717,
  assetRegistry: AssetRegistry.bundled(),
  background: "#ffffff",
});

// One left-to-right column per stage. Lane titles own the left margin, so the
// first node of every lane starts right of LANE_LABEL_WIDTH.
//
// The pipeline is authored as one long strip and then WRAPPED into two bands.
// Unwrapped it renders about 5400x1400 — a ~3.9:1 sliver whose text is
// illegible at fit-to-window — so every node whose authored x is at or past
// BAND_BREAK drops into a second band below, and the four swim lanes are drawn
// once per band. Authored coordinates never change; only bandX/bandY move them.
const BAND_BREAK = 2700;
const BAND_DX = -2615;
const BAND_DY = 1360;
const inBand2 = (x) => x >= BAND_BREAK;
const bandX = (x) => (inBand2(x) ? x + BAND_DX : x);
const bandY = (x, y) => (inBand2(x) ? y + BAND_DY : y);

const LANE_X = 40;
const LANE_WIDTH = 2720;
const LANE_LABEL_WIDTH = 400;

const COLORS = {
  operator: "#087f5b",
  workflow: "#7e22ce",
  agent: "#0b1fb3",
  artifact: "#475569",
  muted: "#64748b",
  operatorFill: "#ecfdf5",
  workflowFill: "#faf5ff",
  agentFill: "#eff6ff",
  artifactFill: "#f8fafc",
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

const artifactNode = (id, title, lines, iconId, authoredX, authoredY, width, height) => {
  const x = bandX(authoredX);
  const y = bandY(authoredX, authoredY);
  const frame = scene.rect(x, y, width, height, {
    color: COLORS.artifact,
    strokeWidth: 2,
    roundness: null,
  });
  setFrameFill(frame, COLORS.artifactFill);
  const fold = scene.line(
    [
      [x + width - 34, y],
      [x + width - 34, y + 34],
      [x + width, y + 34],
    ],
    { color: COLORS.artifact, strokeWidth: 1 },
  );
  const icon = scene.placeAsset(iconId, x + 24, y + 42, 42);
  const titleText = scene.text(x + 82, y + 20, title, {
    size: 14,
    color: COLORS.artifact,
    width: width - 112,
    align: "left",
  });
  // Titles wrap by hand, so the body starts below the real title line count.
  const body = scene.text(x + 82, y + 34 + title.split("\n").length * 18, lines.join("\n"), {
    size: 11,
    color: COLORS.artifact,
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

scene.text(LANE_X, 20, "Curated review workflow — agent-decided clarification and five read-only review stages", {
  size: 29,
  width: LANE_WIDTH,
  align: "center",
});
scene.text(
  LANE_X,
  61,
  "One semantic string enters the workflow. A shaped read-only clarifier either continues immediately or pauses with intent.md + clarification-questions.md; a later host-verified continuation supplies those two refs and text answers before the same coverage-reconciled review chain.",
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
lane(
  "OPERATOR",
  "Owns the semantic request, any clarification answers, and the published review.",
  170,
  190,
  COLORS.operator,
  "#f0fdf4",
);
lane(
  "WORKFLOW-OWNED",
  "Host continuation binding, prompt rendering, schema/coverage checks, phase names, and capability policy.",
  390,
  330,
  COLORS.workflow,
  "#faf5ff",
);
lane(
  "FULL AGENT SESSIONS",
  "One shaped clarifier on fresh input, then one linear review chain; every agent is read-only.",
  750,
  340,
  COLORS.agent,
  "#eff6ff",
);
lane(
  "ARTIFACTS",
  "Workflow source, stage prompts, and runtime-owned Markdown below the run root.",
  1120,
  270,
  COLORS.artifact,
  "#f8fafc",
);

const request = operatorNode(
  "operator-request",
  "Operator: request",
  "Semantic input string + optional\nhost continuation metadata",
  "chat_message",
  85,
  240,
  400,
  110,
);

const launchScope = workflowNode(
  "launch-agent-r1",
  "Workflow: bind request / launch clarifier",
  [
    "Fresh: persist intent.md; phase prepare-clarification",
    "Continued: consume exactly two verified refs",
    "Continuation source must be a successful Package review",
  ],
  "multi_agent_orchestrator",
  480,
  470,
  390,
  145,
);

const scopeAgent = agentNode(
  "agent-r1",
  "Agent: shaped clarification decider",
  [
    "catalog default · label: decide clarification",
    "Host-enforced read-only; no tools",
    "CLARIFIER_SCHEMA {decision, questions[]}",
    "continue requires []; needs_operator requires 1–8",
  ],
  "signal_quality_magnifier",
  570,
  815,
  410,
  195,
);

const forwardCheck = workflowCheck(
  "forward-exact-text",
  "Workflow: check clarifier output.decision",
  "CLARIFIER_SCHEMA + domain bounds\nneeds_operator publishes questions and stops\ncontinue or verified continuation starts scope",
  1040,
  450,
  360,
  230,
);

const launchInventory = workflowNode(
  "launch-agent-r2a",
  "Workflow: launch Agent R1",
  ["phase resolve-scope", "Inline task under COMMON", "readOnly: read, git_read, grep, find"],
  "multi_agent_orchestrator",
  1600,
  470,
  390,
  145,
);

const inventoryAgent = agentNode(
  "agent-r2a",
  "Agent: R1 — scope resolver",
  [
    "catalog default · label: resolve review scope",
    "Receives exact intent + clarification",
    "Resolves one explicit review scope",
    "Returns exact scopeText",
  ],
  "change_data_capture",
  1590,
  815,
  410,
  195,
);

const launchUnits = workflowNode(
  "launch-agent-r2b",
  "Workflow: launch Agent R2a",
  ["phase inventory-changes", "Inline task under COMMON", "readOnly: read, git_read, grep, find"],
  "multi_agent_orchestrator",
  2160,
  470,
  390,
  145,
);

const unitsAgent = agentNode(
  "agent-r2b",
  "Agent: R2a — change inventory",
  [
    "catalog default · label: inventory changes",
    "Covers staged, unstaged, and untracked paths",
    "Coverage inventory, not review judgment",
    "Returns exact inventoryText with stable C ids",
  ],
  "agent_planner",
  2150,
  815,
  410,
  195,
);

const launchQuestions = workflowNode(
  "launch-agent-r3",
  "Workflow: launch Agent R2b",
  ["phase plan-units", "Inline task under COMMON + AST_INDEX_NOTE", "readOnly + ast_index, grep/find fallback"],
  "multi_agent_orchestrator",
  2720,
  470,
  390,
  145,
);

const questionsAgent = agentNode(
  "agent-r3",
  "Agent: R2b — review-unit planner",
  [
    "catalog default · label: plan review units",
    "Groups material decisions; owns every C id once",
    "Workflow validates exact-once C<n> ledger",
    "Returns exact unitsText",
  ],
  "agent_debate",
  2710,
  815,
  410,
  195,
);

const launchVerify = workflowNode(
  "launch-agent-r4",
  "Workflow: launch Agent R3",
  [
    "phase ask-questions",
    "Renders resources/interrogator.prompt.md charter",
    "readOnly + ast_index, grep/find fallback",
  ],
  "multi_agent_orchestrator",
  3280,
  470,
  390,
  145,
);

const verifyAgent = agentNode(
  "agent-r4",
  "Agent: R3 — interrogator",
  [
    "catalog default · label: ask review questions",
    "Reconciles inventory C ids against units",
    "Asks falsifiable questions; answers none",
    "Workflow validates coverage section",
  ],
  "model_validation",
  3270,
  815,
  410,
  195,
);

const launchPublish = workflowNode(
  "launch-agent-r5",
  "Workflow: launch Agent R4",
  ["phase verify-review", "Renders resources/verifier.prompt.md charter", "readOnly + ast_index, grep/find fallback"],
  "multi_agent_orchestrator",
  3840,
  470,
  390,
  145,
);

const publishAgent = agentNode(
  "agent-r5",
  "Agent: R4 — verifier and review author",
  [
    "catalog default · label: verify and write review",
    "Reopens evidence; accounts for every C id/question",
    "Only confirmed problems become findings",
    "Runtime persists exact answer as review.md",
  ],
  "prompt_template",
  3830,
  815,
  410,
  215,
);

const mapFinalResult = workflowNode(
  "map-final-result",
  "Workflow: return Agent R4 exact text",
  ["No JSON/status parse", "review.md contains the same exact bytes", "Reference remains in artifact index"],
  "function_router",
  4400,
  470,
  390,
  145,
);

const humanEdit = operatorNode(
  "operator-edit-review",
  "Operator: inspect review.md",
  "Use the run viewer, then pass its\ncomplete reference to remediation",
  "human_review",
  4880,
  240,
  440,
  110,
);

const sourceFile = artifactNode(
  "source-file",
  "Artifact: review.workflow.mjs\n(inline COMMON + 4 stage tasks)\n+ 2 resources/*.prompt.md charters",
  [
    "String + continuation routing in the entry",
    "Inline COMMON contract + 4 stage tasks;\nR3/R4 charters are prompt files",
    "phase() and log() name every stage",
  ],
  "prompt_template",
  85,
  1200,
  400,
  175,
);

const journalFile = artifactNode(
  "journal-file",
  "Artifact: journal.ndjson",
  [
    "Runtime execution journal",
    "phase, log, and child-session evidence",
    "prepare-clarification, consume-clarification, or review stages",
  ],
  "audit_log",
  1040,
  1200,
  340,
  175,
);

const supportingFiles = artifactNode(
  "supporting-files",
  "Artifact: runtime-owned named stage answers",
  [
    "intent.md, clarifier-decision.json, scope.md,",
    "inventory.md, units.md, questions.md, answers",
    "Runtime-owned below <runId>/artifacts/",
    "Indexed with digest and provenance",
  ],
  "aggregation_puzzle",
  3300,
  1200,
  380,
  175,
);

const answerClarification = operatorNode(
  "operator-answer-clarification",
  "Operator: answer clarification",
  "Later run: text answers + exact\nintent/questions continuation refs",
  "human_review",
  1030,
  240,
  420,
  110,
);

const reportFile = artifactNode(
  "report-file",
  "Artifact: <runId>/artifacts/.../review.md",
  [
    "Primary reader-facing runtime artifact",
    "Verdict, findings, and question resolutions",
    "Exact R4 text; digest stored in the index",
  ],
  "news_document",
  4880,
  1200,
  460,
  175,
);

const resultFile = artifactNode(
  "result-file",
  "Artifact: result.json",
  [
    "Mandatory machine-readable run envelope",
    "result is the Agent R4 exact review text",
    "Child metadata stays separate",
  ],
  "data_catalog",
  4400,
  1200,
  380,
  175,
);

const nodes = [
  request,
  answerClarification,
  launchScope,
  scopeAgent,
  forwardCheck,
  launchInventory,
  inventoryAgent,
  launchUnits,
  unitsAgent,
  launchQuestions,
  questionsAgent,
  launchVerify,
  verifyAgent,
  launchPublish,
  publishAgent,
  mapFinalResult,
  humanEdit,
  sourceFile,
  journalFile,
  supportingFiles,
  reportFile,
  resultFile,
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

connect("operator-to-launch", request, launchScope, {
  label: "input:string + optional continuation",
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("source-to-workflow", sourceFile, launchScope, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.artifact,
  label: "workflow definition",
  from: { side: "top", slot: 0.5 },
  to: { side: "bottom", slot: 0.15 },
  labelOffset: { dx: -80, dy: 0 },
});

launchEdge("launch-to-agent-r1", launchScope, scopeAgent, "fresh: agent(clarifier, CLARIFIER_SCHEMA)");
connect("agent-r1-to-forward", scopeAgent, forwardCheck, {
  direction: "bottom-up",
  label: "{ decision, questions[] }",
  labelWidth: 130,
  from: { side: "top", slot: 0.9 },
  to: { side: "left", slot: 0.5 },
});
connect("continued-to-forward", launchScope, forwardCheck, {
  label: "continued intent + questions + answers",
  dashed: true,
  labelWidth: 165,
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("forward-to-operator-answers", forwardCheck, answerClarification, {
  direction: "bottom-up",
  label: "decision=needs_operator",
  color: COLORS.operator,
  from: { side: "top", slot: 0.35 },
  to: { side: "bottom", slot: 0.5 },
});
connect("operator-answers-to-request", answerClarification, request, {
  direction: "right-to-left",
  dashed: true,
  label: "later workflow call",
  color: COLORS.operator,
  from: { side: "left", slot: 0.5 },
  to: { side: "right", slot: 0.15 },
});
connect("forward-to-launch-r2a", forwardCheck, launchInventory, {
  label: "continue or verified continuation",
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

launchEdge("launch-to-agent-r2a", launchInventory, inventoryAgent, "intent + clarification");
handoffEdge("agent-r2a-to-launch-r2b", inventoryAgent, launchUnits, "exact scopeText");

launchEdge("launch-to-agent-r2b", launchUnits, unitsAgent, "scopeText");
// The wrap edge: band 1 ends after the unit planner and band 2 continues below.
connect("agent-r2b-to-launch-r3", unitsAgent, launchQuestions, {
  direction: "top-down",
  label: "exact unitsText — continues in the band below",
  labelWidth: 230,
  from: { side: "right", slot: 0.5 },
  to: { side: "top", slot: 0.35 },
  path: "outer",
  routeBounds: new Bounds(40, 800, 2560, 590),
  outerSide: "bottom",
  outerGap: 26,
  labelOffset: { dx: 0, dy: 30 },
});

launchEdge("launch-to-agent-r3", launchQuestions, questionsAgent, "scopeText + inventoryText");
handoffEdge("agent-r3-to-launch-r4", questionsAgent, launchVerify, "exact unitsText");

launchEdge("launch-to-agent-r4", launchVerify, verifyAgent, "scopeText + inventoryText\n+ unitsText");
handoffEdge("agent-r4-to-launch-r5", verifyAgent, launchPublish, "exact questionsText");

connect("launch-to-agent-r5", launchPublish, publishAgent, {
  direction: "top-down",
  label: "all handoffs + exact questionsText",
  labelWidth: 180,
  from: { side: "bottom", slot: 0.3 },
  to: { side: "top", slot: 0.3 },
});
handoffEdge("agent-r5-to-map", publishAgent, mapFinalResult, "exact reviewText");

connect("agent-r5-to-supporting", publishAgent, supportingFiles, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "runtime indexes every named answer",
  labelWidth: 160,
  from: { side: "bottom", slot: 0.15 },
  to: { side: "top", slot: 0.5 },
});
connect("agent-r5-to-report", publishAgent, reportFile, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "runtime persists exact review.md",
  labelWidth: 165,
  from: { side: "bottom", slot: 0.85 },
  to: { side: "top", slot: 0.3 },
});
connect("report-to-operator", reportFile, humanEdit, {
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
  renderBounds: new Bounds(0, 0, 2820, 2810),
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
  throw new Error("Generated review pipeline is missing Excalidraw elements or embedded assets.");
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
