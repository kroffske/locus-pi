import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { AssetRegistry, Bounds, Scene, assertDiagramHealthy, layout } = require("@kroffske/excalidraw-diagrams");

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = join(outputDirectory, "plan-pipeline.excalidraw");
const scene = new Scene({
  seed: 20260727,
  assetRegistry: AssetRegistry.bundled(),
  background: "#ffffff",
});

// One left-to-right column per stage, exactly like the sibling `review` and
// `review-fix` diagrams. Lane titles own the left margin, so the first node of
// every lane starts right of LANE_LABEL_WIDTH.
//
// The pipeline is authored as one long strip and then WRAPPED into two bands.
// Unwrapped it renders about 4700x1400 — a ~3.4:1 sliver whose text is
// illegible at fit-to-window — so every node whose authored x is at or past
// BAND_BREAK drops into a second band below, and the four swim lanes are drawn
// once per band. Authored coordinates never change; only bandX/bandY move them.
// The break sits just before the drafting loop, so the loop and its
// verdict-driven back edge stay inside one band and read as a cycle.
const BAND_BREAK = 2140;
const BAND_DX = -1580;
const BAND_DY = 1360;
const inBand2 = (x) => x >= BAND_BREAK;
const bandX = (x) => (inBand2(x) ? x + BAND_DX : x);
const bandY = (x, y) => (inBand2(x) ? y + BAND_DY : y);

const LANE_X = 40;
const LANE_WIDTH = 3120;
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
  const color = COLORS.artifact;
  const frame = scene.rect(x, y, width, height, {
    color,
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
  "Curated plan workflow — one paused operator round, then a drafter and a critic that loop until acceptance",
  {
    size: 29,
    width: LANE_WIDTH,
    align: "center",
  },
);
scene.text(
  LANE_X,
  61,
  "One semantic string enters the workflow. A read-only clarifier either continues immediately or pauses with task.md + clarification-questions.md for a host-verified continuation. A drafter then writes the complete plan and a read-only critic returns a shaped accept/revise verdict; only an accepted draft leaves the loop, and the round cap fails the run instead of shipping one nobody accepted.",
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
  "Owns the task, any clarification answers, and the accepted plan; nothing else decides when planning is done.",
  170,
  190,
  COLORS.operator,
  "#f0fdf4",
);
lane(
  "WORKFLOW-OWNED",
  "Host continuation binding, schema and cross-field checks, loop control, phase names, and capability policy.",
  390,
  330,
  COLORS.workflow,
  "#faf5ff",
);
lane(
  "FULL AGENT SESSIONS",
  "One shaped clarifier on fresh input, then recon, and a drafter/critic pair that repeats; every agent is read-only.",
  750,
  340,
  COLORS.agent,
  "#eff6ff",
);
lane(
  "ARTIFACTS",
  "Workflow source, runtime-owned Markdown and JSON below the run root, and the run's own journal.",
  1120,
  270,
  COLORS.artifact,
  "#f8fafc",
);

const request = operatorNode(
  "operator-request",
  "Operator: task",
  "Semantic input string + optional\nhost continuation metadata",
  "chat_message",
  85,
  240,
  430,
  110,
);

const answerClarification = operatorNode(
  "operator-answer-clarification",
  "Operator: answer clarification",
  "Later run: text answers + exact\ntask/questions continuation refs",
  "human_review",
  1060,
  240,
  440,
  110,
);

const launchClarifier = workflowNode(
  "launch-clarifier",
  "Workflow: bind task / launch clarifier",
  [
    "Fresh: phase clarify-task",
    "Continued: consume exactly two verified refs",
    "Source must be this workflow's clarify-task run",
  ],
  "multi_agent_orchestrator",
  560,
  470,
  410,
  145,
);

const clarifierAgent = agentNode(
  "agent-clarifier",
  "Agent: P0 — clarification decider",
  [
    "catalog default · label: decide clarification",
    "Host-enforced read-only; no tools",
    "CLARIFIER_SCHEMA {decision, questions[]}",
    "continue requires []; needs_operator requires 1–6",
  ],
  "model_validation",
  650,
  815,
  440,
  195,
);

const clarifierGate = workflowCheck(
  "clarifier-gate",
  "Workflow: check clarifier output.decision",
  "CLARIFIER_SCHEMA + cross-field rules\nneeds_operator publishes id + full prompt and stops\ncontinue or verified continuation starts recon",
  1080,
  450,
  400,
  230,
);

const launchContext = workflowNode(
  "launch-context",
  "Workflow: launch Agent P1",
  ["phase map-context", "Inline task under COMMON + AST_INDEX_NOTE", "readOnly + ast_index, grep/find fallback"],
  "multi_agent_orchestrator",
  1600,
  470,
  410,
  145,
);

const contextAgent = agentNode(
  "agent-context",
  "Agent: P1 — task-context mapper",
  [
    "catalog default · label: map task context",
    "Describes what exists; proposes nothing",
    "Cited paths only; unknowns stay unknowns",
    "Returns exact contextText",
  ],
  "aggregation_puzzle",
  1590,
  815,
  440,
  195,
);

const launchDraft = workflowNode(
  "launch-draft",
  "Workflow: launch Agent P2 round n",
  [
    "phase draft-plan · at most MAX_PLAN_ROUNDS",
    "Forwards the previous draft and exact defects",
    "readOnly + ast_index, grep/find fallback",
  ],
  "multi_agent_orchestrator",
  2160,
  470,
  410,
  145,
);

const draftAgent = agentNode(
  "agent-draft",
  "Agent: P2 — plan drafter",
  [
    "catalog default · label: draft plan round <n>",
    "Writes the COMPLETE plan every round",
    "Stable S<n> ids, Files/Change/Verify/Depends on",
    "Runtime persists each round as plan.md",
  ],
  "prompt_template",
  2150,
  815,
  440,
  215,
);

const launchCritique = workflowNode(
  "launch-critique",
  "Workflow: launch Agent P3 round n",
  ["phase critique-plan", "Same round number as the draft it judges", "readOnly + ast_index, grep/find fallback"],
  "multi_agent_orchestrator",
  2720,
  470,
  410,
  145,
);

const criticAgent = agentNode(
  "agent-critic",
  "Agent: P3 — plan critic",
  [
    "catalog default · label: critique plan round <n>",
    "PLAN_VERDICT_SCHEMA {verdict, defects[]}",
    "Reopens the files the plan names; rewrites nothing",
    "accept requires []; revise requires 1–12",
  ],
  "model_validation",
  2710,
  815,
  440,
  215,
);

const verdictGate = workflowCheck(
  "verdict-gate",
  "Workflow: check critic output.verdict",
  "accept ends the loop with this exact draft\nrevise numbers the defects into the next round\nround cap without accept fails the run",
  3280,
  450,
  400,
  230,
);

const mapFinalResult = workflowNode(
  "map-final-result",
  "Workflow: return the accepted plan",
  [
    "No JSON/status parse of the plan text",
    "plan.md contains the same exact bytes",
    "Round cap instead returns ok:false + unresolvedRows",
  ],
  "function_router",
  3760,
  470,
  410,
  145,
);

const operatorInspect = operatorNode(
  "operator-inspect-plan",
  "Operator: inspect plan.md",
  "Use the run viewer, then pass its\ncomplete reference to plan-implement",
  "human_review",
  4200,
  240,
  460,
  110,
);

const sourceFile = artifactNode(
  "source-file",
  "Artifact: plan.workflow.mjs\n(inline COMMON + 4 stage tasks)",
  [
    "String + continuation routing in the entry",
    "No prompt resources; no local agent files",
    "phase() and log() name every stage and round",
  ],
  "prompt_template",
  85,
  1200,
  430,
  175,
);

const journalFile = artifactNode(
  "journal-file",
  "Artifact: journal.ndjson",
  [
    "Runtime execution journal",
    "phase, log, and child-session evidence",
    "Records which round the loop stopped on and why",
  ],
  "audit_log",
  1080,
  1200,
  400,
  175,
);

const supportingFiles = artifactNode(
  "supporting-files",
  "Artifact: runtime-owned named stage answers",
  [
    "task.md, clarifier-decision.json,",
    "clarification-questions.md + answers, context.md,",
    "one plan-critique.json per drafting round",
    "Indexed with digest and provenance",
  ],
  "aggregation_puzzle",
  2140,
  1200,
  440,
  175,
);

const resultFile = artifactNode(
  "result-file",
  "Artifact: result.json",
  [
    "Mandatory machine-readable run envelope",
    "result is the accepted plan text",
    "Unaccepted run: ok:false + unresolvedRows",
  ],
  "data_catalog",
  3740,
  1200,
  400,
  175,
);

const planFile = artifactNode(
  "plan-file",
  "Artifact: <runId>/artifacts/.../plan.md",
  [
    "Primary reader-facing runtime artifact",
    "One record per round; the last one is the plan",
    "Exact Agent P2 text; digest stored in the index",
  ],
  "news_document",
  4200,
  1200,
  460,
  175,
);

const nodes = [
  request,
  answerClarification,
  launchClarifier,
  clarifierAgent,
  clarifierGate,
  launchContext,
  contextAgent,
  launchDraft,
  draftAgent,
  launchCritique,
  criticAgent,
  verdictGate,
  mapFinalResult,
  operatorInspect,
  sourceFile,
  journalFile,
  supportingFiles,
  resultFile,
  planFile,
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

connect("operator-to-launch", request, launchClarifier, {
  label: "input:string + optional continuation",
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("source-to-workflow", sourceFile, launchClarifier, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.artifact,
  label: "workflow definition",
  from: { side: "top", slot: 0.5 },
  to: { side: "bottom", slot: 0.15 },
  labelOffset: { dx: -80, dy: 0 },
});

launchEdge("launch-to-agent-p0", launchClarifier, clarifierAgent, "fresh: agent(clarifier, CLARIFIER_SCHEMA)");
connect("agent-p0-to-gate", clarifierAgent, clarifierGate, {
  direction: "bottom-up",
  label: "{ decision, questions[] }",
  labelWidth: 130,
  from: { side: "top", slot: 0.9 },
  to: { side: "left", slot: 0.5 },
});
connect("continued-to-gate", launchClarifier, clarifierGate, {
  label: "continued task + questions + answers",
  dashed: true,
  labelWidth: 165,
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("gate-to-operator-answers", clarifierGate, answerClarification, {
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
connect("gate-to-launch-p1", clarifierGate, launchContext, {
  label: "continue or verified continuation",
  labelWidth: 130,
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("gate-to-journal", clarifierGate, journalFile, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "phase + log events",
  from: { side: "bottom", slot: 0.5 },
  to: { side: "top", slot: 0.5 },
  labelOffset: { dx: 96, dy: 0 },
});

launchEdge("launch-to-agent-p1", launchContext, contextAgent, "exact task + clarification");
// The wrap edge: band 1 ends after recon and band 2 carries the whole loop.
connect("agent-p1-to-launch-p2", contextAgent, launchDraft, {
  direction: "top-down",
  label: "exact contextText — continues in the band below",
  labelWidth: 230,
  from: { side: "right", slot: 0.5 },
  to: { side: "top", slot: 0.35 },
  path: "outer",
  routeBounds: new Bounds(40, 800, 2560, 590),
  outerSide: "bottom",
  outerGap: 26,
  labelOffset: { dx: 0, dy: 30 },
});

launchEdge("launch-to-agent-p2", launchDraft, draftAgent, "task + context + previous draft + defects");
handoffEdge("agent-p2-to-launch-p3", draftAgent, launchCritique, "exact planText\nof round n");
launchEdge("launch-to-agent-p3", launchCritique, criticAgent, "plan under review");
connect("agent-p3-to-verdict", criticAgent, verdictGate, {
  direction: "bottom-up",
  label: "{ verdict, defects[] }",
  labelWidth: 130,
  from: { side: "top", slot: 0.9 },
  to: { side: "left", slot: 0.5 },
});
connect("verdict-to-launch-p2", verdictGate, launchDraft, {
  direction: "right-to-left",
  label: "revise: exact defects[] start round n+1",
  labelWidth: 200,
  from: { side: "top", slot: 0.5 },
  to: { side: "top", slot: 0.75 },
  path: "outer",
  outerSide: "top",
  outerGap: 24,
});
connect("verdict-to-map", verdictGate, mapFinalResult, {
  label: "accept: exact planText",
  labelWidth: 140,
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});

connect("agent-p2-to-plan-file", draftAgent, planFile, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "runtime persists exact plan.md",
  labelWidth: 165,
  from: { side: "bottom", slot: 0.85 },
  to: { side: "top", slot: 0.3 },
});
connect("agent-p3-to-supporting", criticAgent, supportingFiles, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "runtime indexes every named answer",
  labelWidth: 160,
  from: { side: "bottom", slot: 0.15 },
  to: { side: "top", slot: 0.5 },
});
connect("plan-to-operator", planFile, operatorInspect, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.operator,
  label: "human reads the plan",
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
  renderBounds: new Bounds(0, 0, 3220, 2810),
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
  throw new Error("Generated plan pipeline is missing Excalidraw elements or embedded assets.");
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
