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

const operatorNode = (id, x, y, width, height) => {
  const frame = scene.ellipse(x, y, width, height, {
    color: COLORS.operator,
    strokeWidth: 2,
  });
  setFrameFill(frame, COLORS.operatorFill);
  const icon = scene.placeAsset("chat_message", x + 28, y + 34, 48);
  const title = scene.text(x + 90, y + 27, "Operator: request", {
    size: 17,
    color: COLORS.operator,
    width: width - 112,
    align: "center",
  });
  const body = scene.text(x + 90, y + 57, "Free-form intent\nLocal branch, working tree, or PR", {
    size: 12,
    color: COLORS.operator,
    width: width - 112,
    align: "center",
  });
  return nodeRecord(id, scene.group([frame, icon, title, body]));
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
        titleSize: 17,
        bulletSize: 12,
        bulletGap: 7,
      }),
      COLORS.agent,
      COLORS.agentFill,
    ),
  );

const workflowCheck = (id, x, y, width, height) => {
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
  const title = scene.text(x + 15, y + 91, "Workflow: check Agent 1 output.status (TARGET_SCHEMA)", {
    size: 10,
    color: COLORS.workflow,
    width: width - 30,
    align: "center",
  });
  const body = scene.text(
    x + 50,
    y + 118,
    "Producer: Agent 1\nSchema: TARGET_SCHEMA\nField: output.status = ready / blocked",
    {
      size: 10,
      color: COLORS.workflow,
      width: width - 100,
      align: "center",
    },
  );
  return nodeRecord(id, scene.group([frame, title, body]));
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
  const body = scene.text(x + 82, y + 52, lines.join("\n"), {
    size: 11,
    color: COLORS.artifact,
    width: width - 106,
    align: "left",
  });
  return nodeRecord(id, scene.group([frame, fold, icon, titleText, body]));
};

const lane = (title, subtitle, y, height, color, fill) => {
  const frame = scene.rect(40, y, 3920, height, {
    color,
    strokeWidth: 1,
    dashed: true,
  });
  setFrameFill(frame, fill, 45);
  frame.roughness = 0;
  scene.text(62, y + 14, title, {
    size: 19,
    color,
    width: 390,
  });
  scene.text(62, y + 44, subtitle, {
    size: 11,
    color: COLORS.muted,
    width: 390,
  });
};

scene.text(40, 20, "Curated review workflow — ownership, decisions, and evidence", {
  size: 29,
  width: 3920,
  align: "center",
});
scene.text(40, 61, "Agents inspect and decide. The workflow launches, waits, schema-checks, routes, and serializes.", {
  size: 15,
  color: COLORS.muted,
  width: 3920,
  align: "center",
});

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

lane("OPERATOR", "Owns review intent and any follow-up answer.", 170, 190, COLORS.operator, "#f0fdf4");
lane(
  "WORKFLOW-OWNED",
  "Orchestration and checks only; no repository review judgment.",
  380,
  320,
  COLORS.workflow,
  "#faf5ff",
);
lane(
  "FULL AGENT SESSIONS",
  "Each session uses its own tools to acquire and verify live evidence.",
  720,
  360,
  COLORS.agent,
  "#eff6ff",
);
lane(
  "ARTIFACTS",
  "Source definition plus runtime-persisted result and journal files.",
  1100,
  250,
  COLORS.artifact,
  "#f8fafc",
);

const request = operatorNode("operator-request", 85, 222, 300, 105);

const launchTarget = workflowNode(
  "launch-agent-1",
  "Workflow: launch Agent 1",
  ["Pass operator request", "Attach TARGET_SCHEMA"],
  "multi_agent_orchestrator",
  455,
  462,
  295,
  120,
);

const targetAgent = agentNode(
  "agent-1",
  "Agent: 1 — resolve target",
  ["Full tool-using child session", "Inspects Git, remotes, guidance, and auth", "Decides status: ready or blocked"],
  "signal_quality_magnifier",
  800,
  790,
  315,
  175,
);

const targetStatusCheck = workflowCheck("agent-1-status", 1080, 430, 380, 210);

const launchReviewLanes = workflowNode(
  "launch-agents-2-3",
  "Workflow: launch Agents 2+3 in parallel",
  ["Same request + target handoff", "Independent child sessions"],
  "multi_agent_orchestrator",
  1530,
  418,
  310,
  125,
);

const mapBlockedTarget = workflowNode(
  "map-blocked-target",
  "Workflow: map blocked target",
  ["No review lanes start", "Return Agent 1 question", "Runtime writes result.json"],
  "function_router",
  1530,
  570,
  310,
  105,
);

const changesAgent = agentNode(
  "agent-2",
  "Agent: 2 — introduced changes",
  ["Obtains diff; reads changed files", "Traces affected consumers", "Reports introduced defects"],
  "robot_agent",
  1900,
  752,
  305,
  145,
);

const contextAgent = agentNode(
  "agent-3",
  "Agent: 3 — whole context",
  [
    "Obtains diff; reads full files",
    "Checks standards, config, tests, and docs",
    "Reports evidenced contract problems",
  ],
  "context_window",
  1900,
  918,
  305,
  145,
);

const waitForLanes = workflowNode(
  "wait-for-lanes",
  "Workflow: wait for both lane results",
  ["Collect 2 × LANE_SCHEMA", "Record stage evidence"],
  "guardrails",
  2260,
  462,
  300,
  120,
);

const launchAdjudicator = workflowNode(
  "launch-agent-4",
  "Workflow: launch Agent 4",
  ["Pass target + both lane outputs", "Attach REPORT_SCHEMA"],
  "multi_agent_orchestrator",
  2620,
  462,
  290,
  120,
);

const adjudicator = agentNode(
  "agent-4",
  "Agent: 4 — adjudicate",
  [
    "Full tool-using child session",
    "Reopens target; verifies findings",
    "Decides verdict: pass / needs_changes / blocked",
    "Fills reportMarkdown",
  ],
  "model_validation",
  2960,
  792,
  325,
  190,
);

const mapFinalResult = workflowNode(
  "map-final-result",
  "Workflow: map Agent 4 result",
  ["No review judgment", "blocked → ok=false; otherwise ok=true", "Missing output → failed stage"],
  "function_router",
  3340,
  442,
  310,
  165,
);

const sourceFile = artifactNode(
  "source-file",
  "Artifact: review.workflow.mjs",
  ["Trusted workflow definition", "agent / parallel / phase / log"],
  "prompt_template",
  455,
  1160,
  310,
  125,
);

const journalFile = artifactNode(
  "journal-file",
  "Artifact: journal.ndjson",
  ["Runtime execution journal", "phase, log, and child-session evidence"],
  "audit_log",
  2580,
  1160,
  315,
  125,
);

const resultFile = artifactNode(
  "result-file",
  "Artifact: result.json",
  [
    "Target-blocked or final-review return",
    "review.reportMarkdown is a JSON field",
    "No separate Markdown report file",
  ],
  "data_catalog",
  3620,
  1138,
  315,
  170,
);

const nodes = [
  request,
  launchTarget,
  targetAgent,
  targetStatusCheck,
  launchReviewLanes,
  mapBlockedTarget,
  changesAgent,
  contextAgent,
  waitForLanes,
  launchAdjudicator,
  adjudicator,
  mapFinalResult,
  sourceFile,
  journalFile,
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

connect("operator-to-launch", request, launchTarget, {
  label: "free-form request",
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("source-to-workflow", sourceFile, launchTarget, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.artifact,
  label: "workflow definition",
  from: { side: "top", slot: 0.5 },
  to: { side: "bottom", slot: 0.5 },
  labelOffset: { dx: -82, dy: 0 },
});
connect("launch-to-agent-1", launchTarget, targetAgent, {
  direction: "top-down",
  label: "agent(...)",
  from: { side: "bottom", slot: 0.7 },
  to: { side: "top", slot: 0.35 },
});
connect("agent-1-to-status", targetAgent, targetStatusCheck, {
  direction: "bottom-up",
  label: "TARGET_SCHEMA",
  from: { side: "top", slot: 0.7 },
  to: { side: "bottom", slot: 0.35 },
});
connect("status-ready", targetStatusCheck, launchReviewLanes, {
  label: "ready",
  labelWidth: 46,
  from: { side: "right", slot: 0.36 },
  to: { side: "left", slot: 0.5 },
});
connect("status-blocked", targetStatusCheck, mapBlockedTarget, {
  label: "blocked",
  labelWidth: 50,
  from: { side: "right", slot: 0.72 },
  to: { side: "left", slot: 0.5 },
});
connect("launch-to-agent-2", launchReviewLanes, changesAgent, {
  direction: "top-down",
  label: "TARGET_SCHEMA",
  from: { side: "right", slot: 0.36 },
  to: { side: "top", slot: 0.35 },
  labelOffset: { dx: 250, dy: -58 },
});
connect("launch-to-agent-3", launchReviewLanes, contextAgent, {
  direction: "top-down",
  label: "TARGET_SCHEMA",
  from: { side: "right", slot: 0.72 },
  to: { side: "left", slot: 0.35 },
  path: "outer",
  outerSide: "left",
  outerGap: 40,
});
connect("agent-2-to-wait", changesAgent, waitForLanes, {
  direction: "bottom-up",
  label: "LANE_SCHEMA",
  from: { side: "top", slot: 0.65 },
  to: { side: "bottom", slot: 0.35 },
});
connect("agent-3-to-wait", contextAgent, waitForLanes, {
  direction: "bottom-up",
  label: "LANE_SCHEMA",
  from: { side: "right", slot: 0.55 },
  to: { side: "bottom", slot: 0.72 },
  path: "outer",
  outerSide: "right",
  outerGap: 46,
  labelOffset: { dx: 180, dy: 0 },
});
connect("wait-to-launch-agent-4", waitForLanes, launchAdjudicator, {
  label: "both lane results",
  labelWidth: 135,
  labelOffset: { dx: 0, dy: -92 },
});
connect("launch-to-agent-4", launchAdjudicator, adjudicator, {
  direction: "top-down",
  label: "TARGET_SCHEMA +\n2 × LANE_SCHEMA",
  labelWidth: 170,
  from: { side: "bottom", slot: 0.62 },
  to: { side: "top", slot: 0.35 },
});
connect("agent-4-to-map", adjudicator, mapFinalResult, {
  direction: "bottom-up",
  label: "REPORT_SCHEMA / reportMarkdown",
  labelWidth: 220,
  labelSize: 10,
  from: { side: "top", slot: 0.65 },
  to: { side: "bottom", slot: 0.35 },
});
connect("map-to-result", mapFinalResult, resultFile, {
  direction: "top-down",
  label: "serialized return",
  from: { side: "bottom", slot: 0.72 },
  to: { side: "top", slot: 0.5 },
});
connect("wait-to-journal", waitForLanes, journalFile, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "phase + log events",
  from: { side: "bottom", slot: 0.72 },
  to: { side: "top", slot: 0.35 },
  labelOffset: { dx: 68, dy: 0 },
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
  renderBounds: new Bounds(0, 0, 4000, 1460),
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
