import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { AssetRegistry, Scene, assertDiagramHealthy, layout } = require("@kroffske/excalidraw-diagrams");

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = join(outputDirectory, "review-pipeline.excalidraw");
const scene = new Scene({
  seed: 20260717,
  assetRegistry: AssetRegistry.bundled(),
  background: "#ffffff",
});

scene.text(40, 24, "Curated review workflow — agent-owned pipeline", {
  size: 30,
  width: 3460,
  align: "center",
});
scene.text(
  40,
  68,
  "The workflow routes prompts and schemas; full agents acquire and verify repository or PR evidence.",
  {
    size: 16,
    color: "#475569",
    width: 3460,
    align: "center",
  },
);

const cardWidth = 300;
const cardHeight = 152;
const smallCardHeight = 126;
const node = (id, title, iconId, bullets, x, y, height = cardHeight) => ({
  id,
  block: layout.iconPanel(scene, x, y, cardWidth, height, {
    title,
    iconId,
    bullets,
    iconSize: 48,
    bulletSize: 13,
  }),
});

const request = node(
  "request",
  "Operator request",
  "chat_message",
  ["Free-form review intent", "Local branch, working tree, or PR", "No workflow-specific target grammar"],
  40,
  300,
);
const targetAgent = node(
  "target-agent",
  "Agent 1 — resolve target",
  "signal_quality_magnifier",
  ["Prompt: resolve target with own tools", "Inspect Git, remotes, guidance, and auth", "Prove target access"],
  390,
  300,
);
const targetReady = node(
  "target-ready",
  "Target ready?",
  "function_router",
  ["ready → start independent review", "blocked → ask one precise question"],
  740,
  300,
);
const fanout = node(
  "review-fanout",
  "Parallel review fan-out",
  "multi_agent_orchestrator",
  ["Same operator request", "Same target handoff", "Each lane reacquires evidence"],
  1090,
  300,
);
const changesAgent = node(
  "changes-agent",
  "Agent 2 — introduced changes",
  "robot_agent",
  [
    "Prompt: review introduced changes",
    "Obtain diff; read changed files and consumers",
    "Report only introduced defects",
  ],
  1440,
  180,
);
const contextAgent = node(
  "context-agent",
  "Agent 3 — whole context",
  "context_window",
  ["Prompt: review whole-file context", "Obtain diff; read project standards", "Inspect config, tests, and docs"],
  1440,
  420,
);
const barrier = node(
  "parallel-barrier",
  "Parallel barrier",
  "guardrails",
  ["Both structured lanes required", "Agent or schema failure fails closed"],
  1790,
  300,
);
const adjudicator = node(
  "adjudicator",
  "Agent 4 — adjudicate",
  "model_validation",
  ["Prompt: verify both lane reports", "Reopen target; reject and dedupe findings", "Fill REPORT_TEMPLATE"],
  2140,
  300,
);
const verdict = node(
  "final-verdict",
  "Final verdict",
  "confidence_meter",
  ["pass", "needs_changes", "blocked"],
  2490,
  300,
);
const passReport = node(
  "pass-report",
  "Completed — pass",
  "audit_log",
  ["ok=true", "Structured review + Markdown report"],
  2840,
  120,
  smallCardHeight,
);
const changesReport = node(
  "changes-report",
  "Completed — needs_changes",
  "human_review",
  ["ok=true", "Actionable introduced findings"],
  2840,
  300,
  smallCardHeight,
);
const blockedReport = node(
  "blocked-report",
  "Blocked verdict",
  "kill_switch",
  ["ok=false", "Target could not be verified"],
  2840,
  480,
  smallCardHeight,
);
const targetBlocked = node(
  "target-blocked",
  "Target blocked",
  "kill_switch",
  ["ok=false", "Return exact operator question", "No review lanes start"],
  1090,
  690,
);
const groupFailure = node(
  "group-failure",
  "Lane or schema failure",
  "kill_switch",
  ["Typed WORKFLOW_GROUP_FAILURE", "Adjudicator does not run"],
  1790,
  690,
);
const adjudicatorFailure = node(
  "adjudicator-failure",
  "Adjudicator failure",
  "kill_switch",
  ["Missing or invalid structured result", "Return failed stage"],
  2140,
  690,
);

const nodes = [
  request,
  targetAgent,
  targetReady,
  fanout,
  changesAgent,
  contextAgent,
  barrier,
  adjudicator,
  verdict,
  passReport,
  changesReport,
  blockedReport,
  targetBlocked,
  groupFailure,
  adjudicatorFailure,
];

scene.text(40, 252, "1. Request", {
  size: 18,
  color: "#475569",
  width: 300,
  align: "center",
});
scene.text(390, 252, "2. Target acquisition", {
  size: 18,
  color: "#475569",
  width: 650,
  align: "center",
});
scene.text(1090, 128, "3. Independent review", {
  size: 18,
  color: "#475569",
  width: 1000,
  align: "center",
});
scene.text(2140, 252, "4. Verification and report", {
  size: 18,
  color: "#475569",
  width: 1000,
  align: "center",
});

const edges = [];
const connect = (id, from, to, options = {}) => {
  const routed = layout.connectRouted(scene, from.block, to.block, {
    direction: "left-to-right",
    path: "orthogonal",
    ...options,
  });
  edges.push({
    id,
    from: from.id,
    to: to.id,
    points: routed.points,
  });
};

connect("request-target", request, targetAgent);
connect("target-ready", targetAgent, targetReady);
connect("ready-fanout", targetReady, fanout);
connect("fanout-changes", fanout, changesAgent, {
  from: { side: "right", slot: 0.35 },
  to: { side: "left", slot: 0.5 },
});
connect("fanout-context", fanout, contextAgent, {
  from: { side: "right", slot: 0.65 },
  to: { side: "left", slot: 0.5 },
});
connect("changes-barrier", changesAgent, barrier, {
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.35 },
});
connect("context-barrier", contextAgent, barrier, {
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.65 },
});
connect("barrier-adjudicator", barrier, adjudicator);
connect("adjudicator-verdict", adjudicator, verdict);
connect("verdict-pass", verdict, passReport, {
  from: { side: "right", slot: 0.25 },
  to: { side: "left", slot: 0.5 },
});
connect("verdict-changes", verdict, changesReport, {
  from: { side: "right", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("verdict-blocked", verdict, blockedReport, {
  from: { side: "right", slot: 0.75 },
  to: { side: "left", slot: 0.5 },
});
connect("target-blocked-branch", targetReady, targetBlocked, {
  direction: "top-down",
  from: { side: "bottom", slot: 0.5 },
  to: { side: "left", slot: 0.5 },
});
connect("group-failure-branch", barrier, groupFailure, {
  direction: "top-down",
  from: { side: "bottom", slot: 0.5 },
  to: { side: "top", slot: 0.5 },
});
connect("adjudicator-failure-branch", adjudicator, adjudicatorFailure, {
  direction: "top-down",
  from: { side: "bottom", slot: 0.5 },
  to: { side: "top", slot: 0.5 },
});

const boundaryNote = node(
  "boundary-note",
  "Workflow boundary",
  "prompt_template",
  [
    "Only agent, parallel, phase, and log",
    "No direct Git, filesystem, network, or forge adapter",
    "Non-mutation prompt is not a sandbox",
  ],
  390,
  970,
);
const templatesNote = node(
  "templates-note",
  "Prompt and result templates",
  "data_catalog",
  ["TARGET_SCHEMA for Agent 1", "LANE_SCHEMA for Agents 2 and 3", "REPORT_SCHEMA + REPORT_TEMPLATE for Agent 4"],
  1090,
  970,
);

scene.arrow(
  [
    [targetAgent.block.bounds.centerX, targetAgent.block.bounds.bottom],
    [targetAgent.block.bounds.centerX, boundaryNote.block.bounds.top],
  ],
  { color: "#475569", strokeWidth: 1, dashed: true },
);
scene.arrow(
  [
    [fanout.block.bounds.centerX, fanout.block.bounds.bottom],
    [fanout.block.bounds.centerX, templatesNote.block.bounds.top],
  ],
  { color: "#475569", strokeWidth: 1, dashed: true },
);

assertDiagramHealthy({
  blocks: nodes.map(({ id, block }) => ({ id, bounds: block.bounds })),
  edges,
  gap: 20,
});

scene.write(outputPath);
const output = JSON.parse(readFileSync(outputPath, "utf8"));
if (output.type !== "excalidraw" || output.elements.length === 0 || Object.keys(output.files ?? {}).length === 0) {
  throw new Error("Generated review pipeline is missing Excalidraw elements or embedded assets.");
}

console.log(
  JSON.stringify(
    {
      outputPath,
      elements: output.elements.length,
      files: Object.keys(output.files).length,
    },
    null,
    2,
  ),
);
