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
const LANE_X = 40;
const LANE_WIDTH = 5360;
const LANE_LABEL_WIDTH = 400;

const COLORS = {
  operator: "#087f5b",
  workflow: "#7e22ce",
  agent: "#0b1fb3",
  directLlm: "#b45309",
  artifact: "#475569",
  muted: "#64748b",
  operatorFill: "#ecfdf5",
  workflowFill: "#faf5ff",
  agentFill: "#eff6ff",
  directLlmFill: "#fffbeb",
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

const operatorNode = (id, title, body, iconId, x, y, width, height) => {
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

const workflowNode = (id, title, bullets, iconId, x, y, width, height) =>
  nodeRecord(
    id,
    tintBlock(
      layout.iconPanel(scene, x, y, width, height, {
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

const agentNode = (id, title, bullets, iconId, x, y, width, height) =>
  nodeRecord(
    id,
    tintBlock(
      layout.iconPanel(scene, x, y, width, height, {
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

const workflowCheck = (id, title, body, x, y, width, height) => {
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

const artifactNode = (id, title, lines, iconId, x, y, width, height) => {
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
  const frame = scene.rect(LANE_X, y, LANE_WIDTH, height, {
    color,
    strokeWidth: 1,
    dashed: true,
  });
  setFrameFill(frame, fill, 45);
  frame.roughness = 0;
  scene.text(LANE_X + 22, y + 14, title, {
    size: 19,
    color,
    width: LANE_LABEL_WIDTH,
  });
  scene.text(LANE_X + 22, y + 44, subtitle, {
    size: 11,
    color: COLORS.muted,
    width: LANE_LABEL_WIDTH,
  });
};

scene.text(LANE_X, 20, "Curated review workflow — six sequential agent stages and one write-capable publisher", {
  size: 29,
  width: LANE_WIDTH,
  align: "center",
});
scene.text(
  LANE_X,
  61,
  "Strictly linear: R1 → R2a → R2b → R3 → R4 → R5. The workflow renders prompts, enforces capabilities, forwards each exact text, and returns the executive summary.",
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
const legendDirectLlm = scene.rect(1760, 92, 112, 50, {
  color: COLORS.directLlm,
  strokeWidth: 2,
  dashed: true,
});
setFrameFill(legendDirectLlm, COLORS.directLlmFill);
scene.text(1884, 103, "Direct LLM: not used in review", {
  size: 11,
  color: COLORS.directLlm,
  width: 220,
});

lane("OPERATOR", "Owns the review request and edits the published review.", 170, 190, COLORS.operator, "#f0fdf4");
lane(
  "WORKFLOW-OWNED",
  "Prompt rendering, phase names, and capability policy; no review judgment.",
  390,
  330,
  COLORS.workflow,
  "#faf5ff",
);
lane(
  "FULL AGENT SESSIONS",
  "One linear chain: no parallel lane and no adjudicator.",
  750,
  340,
  COLORS.agent,
  "#eff6ff",
);
lane(
  "ARTIFACTS",
  "Workflow source, stage prompts, task-local Markdown, runtime evidence.",
  1120,
  270,
  COLORS.artifact,
  "#f8fafc",
);

const request = operatorNode(
  "operator-request",
  "Operator: request",
  "Free-form intent\nBranch, working tree, commit, or range",
  "chat_message",
  85,
  240,
  400,
  110,
);

const launchScope = workflowNode(
  "launch-agent-r1",
  "Workflow: launch Agent R1",
  ["phase resolve-scope", "Renders resources/scope-resolver.prompt.md", "readOnly: read, git_read, grep, find"],
  "multi_agent_orchestrator",
  480,
  470,
  390,
  145,
);

const scopeAgent = agentNode(
  "agent-r1",
  "Agent: R1 — scope resolver",
  [
    "catalog default · label: resolve review scope",
    "Host-enforced read-only; no shell, write, or edit",
    "Reads Git state and repository guidance",
    "Returns exact scopeText — one explicit scope",
  ],
  "signal_quality_magnifier",
  570,
  815,
  410,
  195,
);

const forwardCheck = workflowCheck(
  "forward-exact-text",
  "Workflow: forward each stage's exact text",
  "No JSON parse · no verdict or status branch\nAn empty or failed child throws\nEach text becomes the next prompt input",
  1040,
  450,
  360,
  230,
);

const launchInventory = workflowNode(
  "launch-agent-r2a",
  "Workflow: launch Agent R2a",
  ["phase inventory-changes", "Renders resources/change-inventory.prompt.md", "readOnly: read, git_read, grep, find"],
  "multi_agent_orchestrator",
  1600,
  470,
  390,
  145,
);

const inventoryAgent = agentNode(
  "agent-r2a",
  "Agent: R2a — change inventory",
  [
    "catalog default · label: inventory changes",
    "Host-enforced read-only; coverage, not meaning",
    "Covers staged, unstaged, and untracked paths",
    "Returns exact inventoryText — full coverage",
  ],
  "change_data_capture",
  1590,
  815,
  410,
  195,
);

const launchUnits = workflowNode(
  "launch-agent-r2b",
  "Workflow: launch Agent R2b",
  ["phase plan-units", "Renders resources/unit-planner.prompt.md", "readOnly + ast_index, grep/find fallback"],
  "multi_agent_orchestrator",
  2160,
  470,
  390,
  145,
);

const unitsAgent = agentNode(
  "agent-r2b",
  "Agent: R2b — review-unit planner",
  [
    "catalog default · label: plan review units",
    "Host-enforced read-only; ast_index for symbols",
    "Groups the inventory into material decisions",
    "Returns exact unitsText — boundaries only",
  ],
  "agent_planner",
  2150,
  815,
  410,
  195,
);

const launchQuestions = workflowNode(
  "launch-agent-r3",
  "Workflow: launch Agent R3",
  ["phase ask-questions", "Renders resources/interrogator.prompt.md", "readOnly + ast_index, grep/find fallback"],
  "multi_agent_orchestrator",
  2720,
  470,
  390,
  145,
);

const questionsAgent = agentNode(
  "agent-r3",
  "Agent: R3 — interrogator",
  [
    "catalog default · label: ask review questions",
    "Host-enforced read-only; ast_index for symbols",
    "Asks falsifiable questions; answers none",
    "Returns exact questionsText — ids mirror units",
  ],
  "agent_debate",
  2710,
  815,
  410,
  195,
);

const launchVerify = workflowNode(
  "launch-agent-r4",
  "Workflow: launch Agent R4",
  ["phase verify-review", "Renders resources/verifier.prompt.md", "readOnly + ast_index, grep/find fallback"],
  "multi_agent_orchestrator",
  3280,
  470,
  390,
  145,
);

const verifyAgent = agentNode(
  "agent-r4",
  "Agent: R4 — verifier and review author",
  [
    "catalog default · label: verify and write review",
    "Host-enforced read-only; reopens the evidence",
    "Answers every question from what it read",
    "Only confirmed problems become findings",
    "Returns exact reviewText — Markdown verdict",
  ],
  "model_validation",
  3270,
  815,
  410,
  195,
);

const launchPublish = workflowNode(
  "launch-agent-r5",
  "Workflow: launch Agent R5",
  ["phase publish-review", "Renders resources/publisher.prompt.md", "Write-capable: read, write, bash, grep, find"],
  "multi_agent_orchestrator",
  3840,
  470,
  390,
  145,
);

const publishAgent = agentNode(
  "agent-r5",
  "Agent: R5 — publisher and presenter",
  [
    "catalog default · label: publish review package",
    "The only write-capable review stage",
    "Proves .tasks/ is ignored; creates one task",
    "Writes review.md plus supporting Markdown",
    "Returns the executive summary as final text",
  ],
  "prompt_template",
  3830,
  815,
  410,
  195,
);

const mapFinalResult = workflowNode(
  "map-final-result",
  "Workflow: return Agent R5 exact text",
  ["No JSON parse", "The executive summary is the result", "No report file is returned as the result"],
  "function_router",
  4400,
  470,
  390,
  145,
);

const humanEdit = operatorNode(
  "operator-edit-review",
  "Operator: edit review.md",
  "Deleting a finding rejects it\nA note under a finding instructs the fix workflow",
  "human_review",
  4880,
  240,
  440,
  110,
);

const sourceFile = artifactNode(
  "source-file",
  "Artifact: review.workflow.mjs\n+ resources/*.prompt.md",
  ["Routing and capability policy in the entry", "R1–R5 complete stage prompts", "phase() and log() name every stage"],
  "prompt_template",
  85,
  1200,
  400,
  175,
);

const journalFile = artifactNode(
  "journal-file",
  "Artifact: journal.ndjson",
  ["Runtime execution journal", "phase, log, and child-session evidence", "Six phases, one per stage"],
  "audit_log",
  1040,
  1200,
  340,
  175,
);

const supportingFiles = artifactNode(
  "supporting-files",
  "Artifact: supporting review Markdown",
  [
    "review-scope.md, review-inventory.md,",
    "review-units.md, review-questions.md",
    "Written under .tasks/<task>/artifacts/",
    "Optional: skipped when empty or duplicated",
  ],
  "aggregation_puzzle",
  3300,
  1200,
  380,
  175,
);

const reportFile = artifactNode(
  "report-file",
  "Artifact: .tasks/<task>/artifacts/review.md",
  [
    "Mandatory. Primary reader-facing report",
    "Verdict, findings, and question resolutions",
    "Live working tree; no snapshot, hash, or SHA",
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
    "result is the Agent R5 executive summary",
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
  label: "free-form request",
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

launchEdge("launch-to-agent-r1", launchScope, scopeAgent, "agent(scopePrompt)");
connect("agent-r1-to-forward", scopeAgent, forwardCheck, {
  direction: "bottom-up",
  label: "exact scopeText",
  labelWidth: 130,
  from: { side: "top", slot: 0.9 },
  to: { side: "left", slot: 0.5 },
});
connect("forward-to-launch-r2a", forwardCheck, launchInventory, {
  label: "scopeText verbatim",
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

launchEdge("launch-to-agent-r2a", launchInventory, inventoryAgent, "scopeText");
handoffEdge("agent-r2a-to-launch-r2b", inventoryAgent, launchUnits, "exact inventoryText");

launchEdge("launch-to-agent-r2b", launchUnits, unitsAgent, "scopeText + inventoryText");
handoffEdge("agent-r2b-to-launch-r3", unitsAgent, launchQuestions, "exact unitsText");

launchEdge("launch-to-agent-r3", launchQuestions, questionsAgent, "scopeText + unitsText");
handoffEdge("agent-r3-to-launch-r4", questionsAgent, launchVerify, "exact questionsText");

launchEdge("launch-to-agent-r4", launchVerify, verifyAgent, "scopeText + unitsText\n+ questionsText");
handoffEdge("agent-r4-to-launch-r5", verifyAgent, launchPublish, "exact reviewText");

launchEdge("launch-to-agent-r5", launchPublish, publishAgent, "all five handoffs verbatim");
handoffEdge("agent-r5-to-map", publishAgent, mapFinalResult, "exact executive summary text");

connect("agent-r5-to-supporting", publishAgent, supportingFiles, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "writes supporting Markdown",
  labelWidth: 160,
  from: { side: "bottom", slot: 0.15 },
  to: { side: "top", slot: 0.5 },
});
connect("agent-r5-to-report", publishAgent, reportFile, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "writes + re-reads review.md",
  labelWidth: 165,
  from: { side: "bottom", slot: 0.85 },
  to: { side: "top", slot: 0.3 },
});
connect("report-to-operator", reportFile, humanEdit, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.operator,
  label: "human edits the report",
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
  renderBounds: new Bounds(0, 0, 5480, 1450),
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
