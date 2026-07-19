import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  AssetRegistry,
  Bounds,
  Scene,
  assertDiagramHealthy,
  boundsFor,
  layout,
} = require("@kroffske/excalidraw-diagrams");

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = join(outputDirectory, "live-smoke-pipeline.excalidraw");
const scene = new Scene({
  seed: 20260717,
  assetRegistry: AssetRegistry.bundled(),
  background: "#ffffff",
});

const canvas = new Bounds(0, 0, 3840, 1260);
const BLUE = "#0b1fb3";
const GREEN = "#087f3f";
const GRAY = "#475569";
const PURPLE = "#7c3aed";

scene.text(40, 24, "LIVE smoke workflow — full agent sessions, no direct LLM call", {
  size: 30,
  width: 3760,
  align: "center",
});
scene.text(
  40,
  68,
  "Source: extensions/workflows/examples/live-smoke.workflow.mjs · sequential agent proof · runtime-owned persistence",
  {
    size: 16,
    color: GRAY,
    width: 3760,
    align: "center",
  },
);

const laneRight = 3160;
const lanes = [
  { label: "OPERATOR", top: 130, bottom: 315 },
  { label: "WORKFLOW-OWNED ORCHESTRATION / CHECKS", top: 315, bottom: 590 },
  { label: "FULL AGENT SESSIONS", top: 590, bottom: 820 },
  { label: "DIRECT LLM CALLS", top: 820, bottom: 985 },
  { label: "ARTIFACTS", top: 985, bottom: 1240 },
];

for (const lane of lanes) {
  scene.text(20, lane.top + 12, lane.label, {
    size: 14,
    color: GRAY,
    width: 280,
    align: "left",
  });
  scene.line(
    [
      [300, lane.top],
      [laneRight, lane.top],
    ],
    { color: "#cbd5e1", strokeWidth: 1, dashed: true },
  );
}
scene.line(
  [
    [300, lanes.at(-1).bottom],
    [3760, lanes.at(-1).bottom],
  ],
  { color: "#cbd5e1", strokeWidth: 1, dashed: true },
);

function operatorNode(id, x, y, width, height) {
  const elements = [
    scene.ellipse(x, y, width, height, { color: GRAY, strokeWidth: 2 }),
    scene.placeAsset("chat_message", x + 24, y + 36, 58),
    scene.text(x + 98, y + 24, "Operator: request", {
      size: 18,
      color: GRAY,
      width: width - 120,
      align: "center",
    }),
    scene.text(x + 98, y + 62, "optional string input", {
      size: 13,
      color: GRAY,
      width: width - 120,
      align: "center",
    }),
    scene.text(x + 98, y + 88, "topic may be blank", {
      size: 13,
      color: GRAY,
      width: width - 120,
      align: "center",
    }),
  ];
  return { id, block: scene.group(elements) };
}

function workflowNode(id, title, iconId, bullets, x, y, width = 310, height = 180) {
  return {
    id,
    block: layout.iconPanel(scene, x, y, width, height, {
      title,
      iconId,
      bullets,
      iconSize: 48,
      bulletSize: 13,
      bulletGap: 23,
    }),
  };
}

function checkNode(id, title, detail, x, y, width = 300, height = 170) {
  const elements = [
    scene.line(
      [
        [x + width / 2, y],
        [x + width, y + height / 2],
        [x + width / 2, y + height],
        [x, y + height / 2],
        [x + width / 2, y],
      ],
      { color: BLUE, strokeWidth: 2 },
    ),
    scene.text(x + 52, y + 38, title, {
      size: 17,
      color: BLUE,
      width: width - 104,
      align: "center",
    }),
    scene.text(x + 54, y + 82, detail, {
      size: 13,
      color: GRAY,
      width: width - 108,
      align: "center",
    }),
  ];
  return { id, block: scene.group(elements) };
}

function agentNode(id, agentName, bullets, x, y, width = 360, height = 205) {
  const panel = layout.iconPanel(scene, x, y, width, height, {
    title: `Agent: ${agentName}`,
    iconId: "robot_agent",
    bullets,
    iconSize: 52,
    bulletSize: 13,
    bulletGap: 24,
  });
  const outer = scene.rect(panel.bounds.x - 7, panel.bounds.y - 7, panel.bounds.width + 14, panel.bounds.height + 14, {
    color: GREEN,
    strokeWidth: 2,
  });
  return { id, block: scene.group([outer, ...panel.elements]) };
}

function directLlmNoneNode(id, x, y, width, height) {
  const elements = [
    scene.ellipse(x, y, width, height, { color: PURPLE, strokeWidth: 2, dashed: true }),
    scene.placeAsset("model_validation", x + 24, y + 31, 54),
    scene.text(x + 94, y + 20, "Direct LLM: not used", {
      size: 18,
      color: PURPLE,
      width: width - 116,
      align: "center",
    }),
    scene.text(x + 94, y + 58, "dsl.llm() is not used", {
      size: 13,
      color: GRAY,
      width: width - 116,
      align: "center",
    }),
    scene.text(x + 94, y + 84, "all model work runs inside agents", {
      size: 13,
      color: GRAY,
      width: width - 116,
      align: "center",
    }),
  ];
  return { id, block: scene.group(elements) };
}

function artifactNode(id, title, iconId, bullets, x, y, width, height) {
  const panel = layout.iconPanel(scene, x, y, width, height, {
    title,
    iconId,
    bullets,
    iconSize: 48,
    bulletSize: 13,
    bulletGap: 23,
  });
  const inner = scene.rect(panel.bounds.x + 7, panel.bounds.y + 7, panel.bounds.width - 14, panel.bounds.height - 14, {
    color: GRAY,
    strokeWidth: 1,
    dashed: true,
  });
  return { id, block: scene.group([...panel.elements, inner]) };
}

const operator = operatorNode("operator", 120, 168, 300, 126);
const inputCheck = checkNode("input-check", "Workflow: input check", "non-empty string after trim?", 500, 365);
const suppliedTopic = workflowNode(
  "supplied-topic",
  "Workflow: use supplied topic",
  "prompt_template",
  ["topic = input.trim()", "owner: workflow"],
  900,
  325,
  300,
  150,
);
const defaultTopic = workflowNode(
  "default-topic",
  "Workflow: use fallback topic",
  "prompt_template",
  ['topic = "runtime smoke test"', "owner: workflow"],
  900,
  490,
  300,
  150,
);
const phaseAndLog = workflowNode(
  "phase-log",
  "Workflow: prepare smoke phase",
  "function_router",
  ['phase("smoke")', 'log("Live smoke for: …")', "ask(who) builds agent prompt"],
  1290,
  365,
  320,
  190,
);
const exploreAgent = agentNode(
  "explore-agent",
  "explore",
  [
    "label: list cwd entries",
    "permissionMode: agent-defined",
    "read/bash lists cwd",
    "returns exact one-sentence text",
  ],
  1660,
  605,
  360,
  205,
);
const sequentialAwait = workflowNode(
  "sequential-await",
  "Workflow: sequential await",
  "function_router",
  ["retain exact explore text", "only then invoke quick_task", "owner: workflow"],
  2070,
  365,
  320,
  190,
);
const quickAgent = agentNode(
  "quick-agent",
  "quick_task",
  [
    "label: list cwd entries",
    "permissionMode: agent-defined",
    "read/bash lists cwd",
    "returns exact one-sentence text",
  ],
  2440,
  605,
  360,
  205,
);
const resultCheck = workflowNode(
  "result-check",
  "Workflow: assemble result",
  "function_router",
  ["topic + ok: true", "notes contain both exact texts", "no agent-result parsing"],
  2830,
  365,
  310,
  180,
);
const noDirectLlm = directLlmNoneNode("no-direct-llm", 1320, 842, 420, 126);

const sourceFile = artifactNode(
  "source-file",
  "Artifact: live-smoke.workflow.mjs",
  "prompt_template",
  ["extensions/workflows/examples/", "meta.name = live-smoke", "default export = runWorkflow"],
  120,
  1015,
  430,
  190,
);
const journalFile = artifactNode(
  "journal-file",
  "Artifact: .locus/runtime/workflows/<runId>/journal.ndjson",
  "audit_log",
  ["append-only runtime events", "phase/log + agent_start/agent_end", "status and session evidence"],
  2050,
  1015,
  500,
  190,
);
const resultFile = artifactNode(
  "result-file",
  "Artifact: .locus/runtime/workflows/<runId>/result.json",
  "historical_database",
  ["normalized run envelope", "result: topic, ok, exact notes", "status/session stay in runtime evidence"],
  3230,
  1015,
  530,
  190,
);

const nodes = [
  operator,
  inputCheck,
  suppliedTopic,
  defaultTopic,
  phaseAndLog,
  exploreAgent,
  sequentialAwait,
  quickAgent,
  resultCheck,
  noDirectLlm,
  sourceFile,
  journalFile,
  resultFile,
];

const edges = [];
function connect(id, from, to, label, options = {}) {
  const routed = layout.connectRouted(scene, from.block, to.block, {
    direction: "left-to-right",
    path: "orthogonal",
    label,
    labelWidth: 180,
    labelSize: 11,
    labelColor: GRAY,
    obstacles: nodes.map(({ block }) => block),
    clearance: 22,
    ...options,
  });
  edges.push({
    id,
    from: from.id,
    to: to.id,
    points: routed.points,
    ...(routed.label === undefined
      ? {}
      : {
          label: {
            id: `${id}-label`,
            bounds: boundsFor([routed.label]),
          },
        }),
  });
}

connect("operator-input", operator, inputCheck, "optional input value", {
  direction: "top-down",
  from: { side: "bottom", slot: 0.5 },
  to: { side: "left", slot: 0.35 },
  labelOffset: { dx: 42, dy: -2 },
});
connect("source-input", sourceFile, inputCheck, "default export + metadata", {
  direction: "bottom-up",
  from: { side: "top", slot: 0.7 },
  to: { side: "left", slot: 0.7 },
  kind: "provenance",
  dashed: true,
  labelOffset: { dx: -10, dy: 4 },
});
connect("input-supplied", inputCheck, suppliedTopic, "non-empty string", {
  from: { side: "right", slot: 0.35 },
  to: { side: "left", slot: 0.5 },
  labelWidth: 84,
  labelOffset: { dy: -12 },
});
connect("input-default", inputCheck, defaultTopic, "otherwise", {
  from: { side: "right", slot: 0.7 },
  to: { side: "left", slot: 0.5 },
  labelWidth: 84,
  labelOffset: { dy: 12 },
});
connect("supplied-phase", suppliedTopic, phaseAndLog, "trimmed topic", {
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.35 },
  labelWidth: 78,
  labelOffset: { dy: -13 },
});
connect("default-phase", defaultTopic, phaseAndLog, "fallback topic", {
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.7 },
  labelWidth: 78,
  labelOffset: { dy: 13 },
});
connect("phase-explore", phaseAndLog, exploreAgent, "prompt + agent=explore", {
  direction: "top-down",
  from: { side: "right", slot: 0.75 },
  to: { side: "left", slot: 0.35 },
  labelOffset: { dx: -12, dy: -8 },
});
connect("explore-await", exploreAgent, sequentialAwait, "exact explore text", {
  direction: "bottom-up",
  from: { side: "right", slot: 0.35 },
  to: { side: "left", slot: 0.75 },
  labelOffset: { dx: 0, dy: -8 },
});
connect("await-quick", sequentialAwait, quickAgent, "prompt + agent=quick_task", {
  direction: "top-down",
  from: { side: "right", slot: 0.75 },
  to: { side: "left", slot: 0.35 },
  labelOffset: { dx: -4, dy: -8 },
});
connect("quick-check", quickAgent, resultCheck, "exact quick_task text", {
  direction: "bottom-up",
  from: { side: "right", slot: 0.35 },
  to: { side: "left", slot: 0.75 },
  labelOffset: { dx: -4, dy: -8 },
});
connect("explore-check", sequentialAwait, resultCheck, "retained explore result", {
  from: { side: "right", slot: 0.25 },
  to: { side: "left", slot: 0.25 },
  path: "orthogonal",
  labelOffset: { dy: -8 },
});
connect("phase-journal", phaseAndLog, journalFile, "phase + log events", {
  direction: "top-down",
  from: { side: "bottom", slot: 0.2 },
  to: { side: "left", slot: 0.2 },
  path: "outer",
  routeBounds: new Bounds(1260, 340, 1340, 880),
  outerSide: "left",
  outerGap: 20,
  kind: "provenance",
  dashed: true,
  labelWidth: 140,
  labelOffset: { dx: -12, dy: 8 },
});
connect("explore-journal", exploreAgent, journalFile, "explore agent_start / agent_end", {
  direction: "top-down",
  from: { side: "bottom", slot: 0.55 },
  to: { side: "top", slot: 0.25 },
  kind: "provenance",
  dashed: true,
  labelOffset: { dx: -30, dy: 0 },
});
connect("quick-journal", quickAgent, journalFile, "quick_task agent_start / agent_end", {
  direction: "top-down",
  from: { side: "bottom", slot: 0.45 },
  to: { side: "top", slot: 0.75 },
  kind: "provenance",
  dashed: true,
  labelOffset: { dx: 36, dy: 0 },
});
connect("check-result", resultCheck, resultFile, "topic + ok + exact notes", {
  direction: "top-down",
  from: { side: "bottom", slot: 0.7 },
  to: { side: "top", slot: 0.5 },
  path: "outer",
  routeBounds: new Bounds(2800, 340, 1000, 550),
  outerSide: "bottom",
  outerGap: 40,
  labelOffset: { dx: 20, dy: -2 },
});
connect("journal-result", journalFile, resultFile, "journal snapshot in run envelope", {
  from: { side: "right", slot: 0.6 },
  to: { side: "left", slot: 0.6 },
  kind: "provenance",
  dashed: true,
  labelOffset: { dy: -13 },
});

// Legend uses the same editable primitives as the graph.
const legendX = 3210;
const legendY = 128;
const legendWidth = 550;
const legendHeight = 760;
scene.rect(legendX, legendY, legendWidth, legendHeight, { color: GRAY, strokeWidth: 1 });
scene.text(legendX + 20, legendY + 18, "Legend — ownership and execution type", {
  size: 20,
  color: GRAY,
  width: legendWidth - 40,
  align: "center",
});

scene.ellipse(legendX + 28, legendY + 78, 92, 54, { color: GRAY, strokeWidth: 2 });
scene.text(legendX + 145, legendY + 85, "Operator", { size: 15, color: GRAY, width: 350 });
scene.text(legendX + 145, legendY + 108, "human-supplied request", { size: 12, color: GRAY, width: 350 });

scene.rect(legendX + 28, legendY + 160, 92, 54, { color: BLUE, strokeWidth: 2 });
scene.text(legendX + 145, legendY + 167, "Workflow-owned rectangle", {
  size: 15,
  color: BLUE,
  width: 350,
});
scene.text(legendX + 145, legendY + 190, "orchestration, prompt construction, or merge", {
  size: 12,
  color: GRAY,
  width: 350,
});

scene.line(
  [
    [legendX + 74, legendY + 242],
    [legendX + 120, legendY + 269],
    [legendX + 74, legendY + 296],
    [legendX + 28, legendY + 269],
    [legendX + 74, legendY + 242],
  ],
  { color: BLUE, strokeWidth: 2 },
);
scene.text(legendX + 145, legendY + 250, "Workflow-owned diamond", {
  size: 15,
  color: BLUE,
  width: 350,
});
scene.text(legendX + 145, legendY + 273, "explicit check; branch labels state outcomes", {
  size: 12,
  color: GRAY,
  width: 350,
});

scene.rect(legendX + 24, legendY + 329, 100, 62, { color: GREEN, strokeWidth: 2 });
scene.rect(legendX + 31, legendY + 336, 86, 48, { color: BLUE, strokeWidth: 1 });
scene.text(legendX + 145, legendY + 337, "Double rectangle", {
  size: 15,
  color: GREEN,
  width: 350,
});
scene.text(legendX + 145, legendY + 360, "full agent session with tools + childSessionId", {
  size: 12,
  color: GRAY,
  width: 350,
});

scene.ellipse(legendX + 28, legendY + 423, 92, 54, {
  color: PURPLE,
  strokeWidth: 2,
  dashed: true,
});
scene.text(legendX + 145, legendY + 430, "Dashed ellipse", {
  size: 15,
  color: PURPLE,
  width: 350,
});
scene.text(legendX + 145, legendY + 453, "direct LLM call; explicitly unused here", {
  size: 12,
  color: GRAY,
  width: 350,
});

scene.rect(legendX + 28, legendY + 511, 92, 60, { color: GRAY, strokeWidth: 2 });
scene.rect(legendX + 35, legendY + 518, 78, 46, { color: GRAY, strokeWidth: 1, dashed: true });
scene.text(legendX + 145, legendY + 518, "Inset rectangle", {
  size: 15,
  color: GRAY,
  width: 350,
});
scene.text(legendX + 145, legendY + 541, "source or persisted artifact", {
  size: 12,
  color: GRAY,
  width: 350,
});

scene.arrow(
  [
    [legendX + 28, legendY + 620],
    [legendX + 120, legendY + 620],
  ],
  { color: BLUE, strokeWidth: 2 },
);
scene.text(legendX + 145, legendY + 605, "Solid labeled arrow", {
  size: 15,
  color: BLUE,
  width: 350,
});
scene.text(legendX + 145, legendY + 628, "request or result handoff", {
  size: 12,
  color: GRAY,
  width: 350,
});

scene.arrow(
  [
    [legendX + 28, legendY + 692],
    [legendX + 120, legendY + 692],
  ],
  { color: GRAY, strokeWidth: 1, dashed: true },
);
scene.text(legendX + 145, legendY + 677, "Dashed labeled arrow", {
  size: 15,
  color: GRAY,
  width: 350,
});
scene.text(legendX + 145, legendY + 700, "source or persistence handoff", {
  size: 12,
  color: GRAY,
  width: 350,
});

const validation = assertDiagramHealthy({
  blocks: nodes.map(({ id, block }) => ({ id, bounds: block.bounds })),
  edges,
  gap: 6,
  renderBounds: canvas,
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
  throw new Error("Generated LIVE smoke pipeline is missing Excalidraw type, elements, or embedded files.");
}

console.log(
  JSON.stringify(
    {
      outputPath,
      elements: output.elements.length,
      files: Object.keys(output.files).length,
      validation: {
        ok: validation.ok,
        errors: validation.errors.length,
        warnings: validation.warnings.length,
      },
    },
    null,
    2,
  ),
);
