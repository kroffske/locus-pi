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

// The pipeline is authored as one long left-to-right strip and then wrapped.
// Unwrapped it renders about 3800x1240 — a ~3:1 sliver that is unreadable at
// fit-to-window — so every node whose authored x is at or past BAND_BREAK drops
// into a second band below, and the four swim lanes are drawn once per band.
// Authored coordinates stay untouched; only `bandX`/`bandY` move them.
const BAND_BREAK = 2040;
const BAND_DX = -1570;
const BAND_DY = 995;
const inBand2 = (x) => x >= BAND_BREAK;
const bandX = (x) => (inBand2(x) ? x + BAND_DX : x);
const bandY = (x, y) => (inBand2(x) ? y + BAND_DY : y);

const canvas = new Bounds(0, 0, 2720, 2280);
const BLUE = "#0b1fb3";
const GREEN = "#087f3f";
const GRAY = "#475569";

const HEADER_WIDTH = 2640;

scene.text(40, 24, "LIVE smoke workflow — two sequential full agent sessions", {
  size: 30,
  width: HEADER_WIDTH,
  align: "center",
});
scene.text(
  40,
  68,
  "Source: extensions/workflows/examples/live-smoke.workflow.mjs · sequential agent proof · runtime-owned persistence · read top band, then bottom band",
  {
    size: 16,
    color: GRAY,
    width: HEADER_WIDTH,
    align: "center",
  },
);

const lanes = [
  { label: "OPERATOR", top: 130, bottom: 315 },
  { label: "WORKFLOW-OWNED ORCHESTRATION / CHECKS", top: 315, bottom: 590 },
  { label: "FULL AGENT SESSIONS", top: 590, bottom: 820 },
  { label: "ARTIFACTS", top: 985, bottom: 1240 },
];

// Band 1 stops short of the legend panel; band 2 runs the full content width and
// omits the OPERATOR lane, which holds nothing after the wrap point.
for (const [band, right, laneSubset] of [
  [0, 2060, lanes],
  [1, 2260, lanes.slice(1)],
]) {
  const dy = band * BAND_DY;
  for (const lane of laneSubset) {
    scene.text(20, lane.top + dy + 12, lane.label, {
      size: 14,
      color: GRAY,
      width: 280,
      align: "left",
    });
    scene.line(
      [
        [300, lane.top + dy],
        [right, lane.top + dy],
      ],
      { color: "#cbd5e1", strokeWidth: 1, dashed: true },
    );
  }
  scene.line(
    [
      [300, laneSubset.at(-1).bottom + dy],
      [right, laneSubset.at(-1).bottom + dy],
    ],
    { color: "#cbd5e1", strokeWidth: 1, dashed: true },
  );
}

function operatorNode(id, authoredX, authoredY, width, height) {
  const x = bandX(authoredX);
  const y = bandY(authoredX, authoredY);
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

function workflowNode(id, title, iconId, bullets, authoredX, authoredY, width = 310, height = 180) {
  return {
    id,
    block: layout.iconPanel(scene, bandX(authoredX), bandY(authoredX, authoredY), width, height, {
      title,
      iconId,
      bullets,
      iconSize: 48,
      bulletSize: 13,
      bulletGap: 23,
    }),
  };
}

function checkNode(id, title, detail, authoredX, authoredY, width = 300, height = 170) {
  const x = bandX(authoredX);
  const y = bandY(authoredX, authoredY);
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

function agentNode(id, agentName, bullets, authoredX, authoredY, width = 360, height = 205) {
  const panel = layout.iconPanel(scene, bandX(authoredX), bandY(authoredX, authoredY), width, height, {
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

function artifactNode(id, title, iconId, bullets, authoredX, authoredY, width, height) {
  const panel = layout.iconPanel(scene, bandX(authoredX), bandY(authoredX, authoredY), width, height, {
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

const sourceFile = artifactNode(
  "source-file",
  "Artifact: live-smoke.workflow.mjs",
  "prompt_template",
  ["extensions/workflows/examples/", "meta.name = live-smoke", "default export = runWorkflow"],
  700,
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
// The wrap edge: band 1 ends here and band 2 continues below-left.
connect("explore-await", exploreAgent, sequentialAwait, "exact explore text — continues in the band below", {
  direction: "top-down",
  from: { side: "bottom", slot: 0.8 },
  to: { side: "left", slot: 0.35 },
  labelWidth: 210,
  labelOffset: { dx: -70, dy: 0 },
});
connect("await-quick", sequentialAwait, quickAgent, "prompt + agent=quick_task", {
  direction: "top-down",
  from: { side: "right", slot: 0.75 },
  to: { side: "left", slot: 0.35 },
  labelOffset: { dx: 32, dy: -8 },
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
  routeBounds: new Bounds(1260, 340, 900, 880),
  outerSide: "left",
  outerGap: 20,
  kind: "provenance",
  dashed: true,
  labelWidth: 140,
  labelOffset: { dx: -12, dy: 8 },
});
connect("explore-journal", exploreAgent, journalFile, "explore agent_start / agent_end", {
  direction: "top-down",
  from: { side: "left", slot: 0.85 },
  to: { side: "left", slot: 0.3 },
  path: "outer",
  routeBounds: new Bounds(320, 820, 1780, 1440),
  outerSide: "left",
  outerGap: 24,
  kind: "provenance",
  dashed: true,
  labelWidth: 150,
  labelOffset: { dx: 96, dy: -14 },
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
  routeBounds: new Bounds(bandX(2800), bandY(2800, 340), 1000, 550),
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
const legendX = 2110;
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
