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
const LANE_X = 40;
const LANE_WIDTH = 5920;
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

const artifactNode = (id, title, lines, iconId, x, y, width, height, write = false) => {
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

scene.text(LANE_X, 20, "Curated review-fix workflow — one deterministic gate, then five sequential agent stages", {
  size: 29,
  width: LANE_WIDTH,
  align: "center",
});
scene.text(
  LANE_X,
  61,
  "Deterministic code confines the review path and refuses an empty finding list before any agent exists. Then F1 → F2 → F3 → F4 → F5 forward each exact text inside the operator's own launch checkout.",
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
  "Edits review.md first, then reads the uncommitted diff this workflow leaves behind.",
  170,
  190,
  COLORS.operator,
  "#f0fdf4",
);
lane(
  "WORKFLOW-OWNED",
  "Path confinement, the findings gate, prompt rendering, and capability policy; no fix judgment.",
  390,
  330,
  COLORS.workflow,
  "#faf5ff",
);
lane(
  "FULL AGENT SESSIONS",
  "One linear chain: every stage runs directly in the operator's own launch checkout.",
  750,
  340,
  COLORS.agent,
  "#eff6ff",
);
lane(
  "ARTIFACTS",
  "Human-edited review input, published fix package, mutated source, runtime evidence.",
  1120,
  270,
  COLORS.artifact,
  "#f8fafc",
);

const request = operatorNode(
  "operator-request",
  "Operator: fix request",
  'Free-form intent naming one review.md\n"apply only the P1 items in …/artifacts/review.md"',
  "chat_message",
  85,
  240,
  430,
  110,
);

const resolveReview = workflowNode(
  "resolve-review",
  "Workflow: resolve-review",
  [
    "phase resolve-review · deterministic, no agent yet",
    "Extracts the one review.md token from free text",
    "Confines it inside a project artifacts directory",
    "Rejects absolute paths and symlink escapes",
  ],
  "guardrails",
  560,
  460,
  430,
  165,
);

const findingsGate = workflowCheck(
  "findings-gate",
  "Workflow: require a non-empty finding list",
  '"## Findings" must still list one "### <id>"\nZero findings, a missing section, a duplicate id,\nor two review.md paths throw before any agent\nOnly heading ids are parsed — nothing else',
  1080,
  450,
  400,
  230,
);

const launchScope = workflowNode(
  "launch-agent-f1",
  "Workflow: launch Agent F1",
  ["phase resolve-fix-scope", "Renders resources/scope-resolver.prompt.md", "readOnly: read, git_read, grep, find"],
  "multi_agent_orchestrator",
  1600,
  470,
  410,
  145,
);

const scopeAgent = agentNode(
  "agent-f1",
  "Agent: F1 — fix-scope resolver",
  [
    "catalog default · label: resolve fix scope",
    "Host-enforced read-only; no shell, write, or edit",
    "Reads the kept findings and working-tree state",
    "Returns exact scopeText — a # Fix Scope block",
  ],
  "signal_quality_magnifier",
  1590,
  815,
  440,
  195,
);

const forwardCheck = workflowCheck(
  "forward-exact-text",
  "Workflow: forward each stage's exact text",
  "No JSON parse · no verdict or status branch\nAn empty or failed child throws\nEach text becomes the next prompt input",
  2160,
  450,
  360,
  230,
);

const launchUnits = workflowNode(
  "launch-agent-f2",
  "Workflow: launch Agent F2",
  ["phase plan-fix-units", "Renders resources/unit-planner.prompt.md", "readOnly + ast_index, grep/find fallback"],
  "multi_agent_orchestrator",
  2720,
  470,
  410,
  145,
);

const unitsAgent = agentNode(
  "agent-f2",
  "Agent: F2 — fix-unit planner",
  [
    "catalog default · label: plan fix units",
    "Host-enforced read-only; ast_index for symbols",
    "Revalidates every finding against live source",
    "Returns exact unitsText — # Fix Units + stale",
  ],
  "agent_planner",
  2710,
  815,
  440,
  195,
);

const launchImplement = workflowNode(
  "launch-agent-f3",
  "Workflow: launch Agent F3",
  [
    "phase apply-fix-units",
    "Renders resources/implementer.prompt.md",
    "Write-capable: read, write, edit, bash, grep, find",
  ],
  "multi_agent_orchestrator",
  3280,
  470,
  410,
  145,
);

const implementAgent = agentNode(
  "agent-f3",
  "Agent: F3 — implementer",
  [
    "catalog default · label: apply fix units",
    "Edits the operator's launch checkout in place",
    "Skips stale units; never commits, pushes, or stashes",
    "Returns exact implementationText",
  ],
  "sandbox_executor",
  3270,
  815,
  440,
  195,
);

const launchVerify = workflowNode(
  "launch-agent-f4",
  "Workflow: launch Agent F4",
  ["phase verify-fixes", "Renders resources/verifier.prompt.md", "Shell exception: read, ast_index, bash, grep, find"],
  "multi_agent_orchestrator",
  3840,
  470,
  410,
  145,
);

const verifyAgent = agentNode(
  "agent-f4",
  "Agent: F4 — verifier and report author",
  [
    "catalog default · label: verify fixes and write report",
    "Not host-enforced read-only: checks need a shell",
    "Reopens the working-tree diff and reruns checks",
    "Returns exact reportText — a # Fix Report",
  ],
  "model_validation",
  3830,
  815,
  440,
  195,
);

const launchPublish = workflowNode(
  "launch-agent-f5",
  "Workflow: launch Agent F5",
  ["phase publish-fix-report", "Renders resources/publisher.prompt.md", "Write-capable: read, write, bash, grep, find"],
  "multi_agent_orchestrator",
  4400,
  470,
  410,
  145,
);

const publishAgent = agentNode(
  "agent-f5",
  "Agent: F5 — publisher and presenter",
  [
    "catalog default · label: publish fix package",
    "The only stage that writes task artifacts",
    "Writes fix-report.md plus supporting Markdown",
    "Returns the executive summary as final text",
  ],
  "prompt_template",
  4390,
  815,
  440,
  195,
);

const mapFinalResult = workflowNode(
  "map-final-result",
  "Workflow: return Agent F5 exact text",
  ["No JSON parse", "The executive summary is the result", "No report file is returned as the result"],
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
  "Artifact: review-fix.workflow.mjs\n+ review-fix-input.mjs\n+ resources/*.prompt.md",
  ["Deterministic gate in review-fix-input.mjs", "F1–F5 complete stage prompts", "phase() and log() name every stage"],
  "prompt_template",
  85,
  1200,
  430,
  175,
);

const reviewInput = artifactNode(
  "review-input",
  "Artifact: human-edited review.md",
  [
    ".tasks/<task>/artifacts/review.md",
    "Input only; this workflow never rewrites it",
    "A deleted finding is a rejected finding",
    "A note under a finding steers the fix",
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
  ["Runtime execution journal", "phase, log, and child-session evidence", "Six phases: one deterministic, five agents"],
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
    "is the whole workspace; nothing is isolated",
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
  "Artifact: supporting fix Markdown",
  [
    "fix-scope.md and fix-units.md",
    "Written under .tasks/<task>/artifacts/",
    "Beside the review that produced them",
    "Optional: skipped when empty or duplicated",
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
  [
    "Mandatory machine-readable run envelope",
    "result is the Agent F5 executive summary",
    "Child metadata stays separate",
  ],
  "data_catalog",
  4880,
  1200,
  400,
  175,
);

const fixReportFile = artifactNode(
  "fix-report-file",
  "Artifact: fix-report.md",
  [
    ".tasks/<task>/artifacts/fix-report.md",
    "Mandatory. Primary reader-facing report",
    "Applied units, not applied, changed files, checks",
    "Live working tree; no snapshot and no hash",
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
  label: "free-form request",
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
  label: "kept findings",
  labelWidth: 120,
  from: { side: "top", slot: 0.5 },
  to: { side: "bottom", slot: 0.8 },
});
connect("resolve-to-gate", resolveReview, findingsGate, {
  label: "confined review path",
  labelWidth: 130,
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("gate-to-launch-f1", findingsGate, launchScope, {
  label: "at least one\nremaining finding",
  labelWidth: 130,
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});

launchEdge("launch-to-agent-f1", launchScope, scopeAgent, "agent(scopePrompt)");
connect("agent-f1-to-forward", scopeAgent, forwardCheck, {
  direction: "bottom-up",
  label: "exact scopeText",
  labelWidth: 130,
  from: { side: "top", slot: 0.9 },
  to: { side: "left", slot: 0.5 },
});
connect("forward-to-launch-f2", forwardCheck, launchUnits, {
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

launchEdge("launch-to-agent-f2", launchUnits, unitsAgent, "scopeText + reviewText");
handoffEdge("agent-f2-to-launch-f3", unitsAgent, launchImplement, "exact unitsText");

launchEdge("launch-to-agent-f3", launchImplement, implementAgent, "scopeText + unitsText\n+ reviewText");
handoffEdge("agent-f3-to-launch-f4", implementAgent, launchVerify, "exact implementationText");

launchEdge("launch-to-agent-f4", launchVerify, verifyAgent, "scopeText + unitsText\n+ implementationText");
handoffEdge("agent-f4-to-launch-f5", verifyAgent, launchPublish, "exact reportText");

launchEdge("launch-to-agent-f5", launchPublish, publishAgent, "scope + units + report verbatim");
handoffEdge("agent-f5-to-map", publishAgent, mapFinalResult, "exact executive summary text");

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
  label: "re-reads the diff,\nreruns the checks",
  labelWidth: 140,
  from: { side: "top", slot: 0.72 },
  to: { side: "bottom", slot: 0.25 },
});
connect("agent-f5-to-supporting", publishAgent, supportingFiles, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "writes supporting Markdown",
  labelWidth: 160,
  from: { side: "bottom", slot: 0.15 },
  to: { side: "top", slot: 0.5 },
});
connect("agent-f5-to-report", publishAgent, fixReportFile, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "writes + re-reads fix-report.md",
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
  renderBounds: new Bounds(0, 0, 6040, 1450),
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
