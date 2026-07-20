import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  AssetRegistry,
  BLUE,
  GRAY,
  PURPLE,
  RED,
  Scene,
  assertDiagramHealthy,
  layout,
  nodeCard,
} = require("@kroffske/excalidraw-diagrams");

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = join(outputDirectory, "requirements-grill-pipeline.excalidraw");
const scene = new Scene({
  seed: 20260717,
  assetRegistry: AssetRegistry.bundled(),
  background: "#ffffff",
});

const canvasWidth = 5040;

scene.text(40, 24, "Requirements grill — explicit evidence handoff", {
  size: 30,
  width: canvasWidth - 80,
  align: "center",
});
scene.text(
  40,
  68,
  "The trusted workflow validates input, runs bounded rg directly, and gates three sequential full agent sessions. No direct llm() call is used.",
  {
    size: 16,
    color: GRAY,
    width: canvasWidth - 80,
    align: "center",
  },
);

const lane = (title, y) => {
  scene.text(40, y, title, {
    size: 18,
    color: GRAY,
    width: 520,
  });
  scene.line(
    [
      [40, y + 34],
      [canvasWidth - 40, y + 34],
    ],
    { color: "#cbd5e1", strokeWidth: 1 },
  );
};

lane("Operator", 150);
lane("Workflow-owned execution and checks", 370);
lane("Full agent sessions, absent direct LLM type, and fail-closed exits", 680);
lane("Artifacts and exact text handoffs", 1010);
lane("Legend", 1340);

const cards = [];
const card = ({
  id,
  title,
  iconId,
  bullets,
  x,
  y,
  width = 340,
  color = "default",
  bulletSize = 13,
  titleSize = 17,
}) => {
  const placed = nodeCard(scene, {
    id,
    title,
    iconId,
    bullets,
    x,
    y,
    width,
    color,
    strict: true,
    bulletSize,
    titleSize,
    iconSize: 46,
    padding: 18,
  });
  cards.push(placed);
  return placed;
};

const request = card({
  id: "operator-request",
  title: "Operator: request",
  iconId: "chat_message",
  bullets: ["Free-form requirements request", "Trimmed into originalRequest", "No hidden parent-session context"],
  x: 40,
  y: 215,
  width: 320,
});

const validateInput = card({
  id: "validate-input",
  title: "Workflow: check 1 — input bounds",
  iconId: "model_validation",
  bullets: [
    "Owner: requirements-grill.workflow.mjs",
    "Require non-empty originalRequest",
    "Require length ≤ 12,000 characters",
  ],
  x: 410,
  y: 430,
  width: 340,
});

const collectContext = card({
  id: "collect-context",
  title: "Workflow: step — direct rg collection",
  iconId: "signal_quality_magnifier",
  bullets: [
    "Owner: requirements-grill.workflow.mjs",
    'spawn("rg", fixed bounded arguments)',
    "10 s, 200 lines, 40,000 characters",
    "This is not an agent session",
  ],
  x: 810,
  y: 430,
  width: 360,
});

const contextCheck = card({
  id: "context-check",
  title: "Workflow: check 2 — context ready",
  iconId: "model_validation",
  bullets: [
    "Owner: requirements-grill.workflow.mjs",
    "Require repositoryContext.ok",
    "Failure stops at collect-context",
  ],
  x: 1230,
  y: 430,
  width: 340,
});

const recon = card({
  id: "recon-agent",
  title: "Agent: 1 — repository recon",
  iconId: "robot_agent",
  bullets: [
    "Full agent() child session",
    "Receives originalRequest + repositoryContext",
    "tools: []; maxToolCalls: 0; project workspace",
    "Returns exact non-empty readable text",
  ],
  x: 1630,
  y: 730,
  width: 360,
  color: "changed",
});

const reconCheck = card({
  id: "recon-check",
  title: "Workflow: receive recon text",
  iconId: "model_validation",
  bullets: [
    "Runtime rejects failed or empty child result",
    "No JSON or schema validation",
    "Exact reconText enters Agent 2 prompt",
  ],
  x: 2050,
  y: 430,
  width: 340,
});

const challenge = card({
  id: "challenge-agent",
  title: "Agent: 2 — requirements challenge",
  iconId: "robot_agent",
  bullets: [
    "Full agent() child session",
    "Receives originalRequest + reconText",
    "tools: []; maxToolCalls: 0; project workspace",
    "Returns exact non-empty readable text",
  ],
  x: 2450,
  y: 730,
  width: 360,
  color: "changed",
});

const challengeCheck = card({
  id: "challenge-check",
  title: "Workflow: receive challenge text",
  iconId: "model_validation",
  bullets: [
    "Runtime rejects failed or empty child result",
    "No JSON or schema validation",
    "Exact challengeText enters Agent 3 prompt",
  ],
  x: 2870,
  y: 430,
  width: 340,
});

const synthesis = card({
  id: "synthesis-agent",
  title: "Agent: 3 — handoff synthesis",
  iconId: "robot_agent",
  bullets: [
    "Full agent() child session",
    "Receives originalRequest + both prior texts",
    "tools: []; maxToolCalls: 0; project workspace",
    "Returns exact non-empty readable text",
  ],
  x: 3270,
  y: 730,
  width: 360,
  color: "changed",
});

const synthesisCheck = card({
  id: "synthesis-check",
  title: "Workflow: receive synthesis text",
  iconId: "model_validation",
  bullets: [
    "Runtime rejects failed or empty child result",
    "No JSON or schema validation",
    "Exact synthesisText becomes workflow result",
  ],
  x: 3690,
  y: 430,
  width: 340,
});

const success = card({
  id: "success-result",
  title: "Workflow: result — success",
  iconId: "confidence_meter",
  bullets: ["Exact synthesisText", "No agent result envelope", "Runtime evidence retained"],
  x: 4090,
  y: 430,
  width: 340,
});

const runtime = card({
  id: "workflow-runtime",
  title: "Workflow: runtime persistence",
  iconId: "audit_log",
  bullets: [
    "Owner: runtime outside the script",
    "Journals phase, log, and agent lifecycle",
    "Persists terminal result and script identity",
  ],
  x: 4490,
  y: 430,
  width: 360,
  color: "external",
});

const directLlmNone = card({
  id: "direct-llm-none",
  title: "Direct LLM: not used",
  iconId: "function_router",
  bullets: [
    "No model-only completion in this workflow",
    "All model work uses full agent() children",
    "Shown to distinguish the unused DSL type",
  ],
  x: 40,
  y: 730,
  width: 340,
  color: "external",
});

const inputFailure = card({
  id: "input-failure",
  title: "Workflow: fail closed — validate-input",
  iconId: "kill_switch",
  bullets: ["Owner: workflow script", "failedResult; ok: false", "handoff: null"],
  x: 410,
  y: 730,
  width: 340,
  color: "removed",
});

const contextFailure = card({
  id: "context-failure",
  title: "Workflow: fail closed — collect-context",
  iconId: "kill_switch",
  bullets: ["Owner: workflow script", "rg error or timeout", "stoppedStage: collect-context"],
  x: 1230,
  y: 730,
  width: 340,
  color: "removed",
});

const reconFailure = card({
  id: "recon-failure",
  title: "Workflow: fail closed — recon",
  iconId: "kill_switch",
  bullets: ["Owner: agent runtime", "Child failed or returned empty text", "Later agents do not start"],
  x: 2050,
  y: 730,
  width: 340,
  color: "removed",
});

const challengeFailure = card({
  id: "challenge-failure",
  title: "Workflow: fail closed — challenge",
  iconId: "kill_switch",
  bullets: ["Owner: agent runtime", "Child failed or returned empty text", "Synthesis does not start"],
  x: 2870,
  y: 730,
  width: 340,
  color: "removed",
});

const synthesisFailure = card({
  id: "synthesis-failure",
  title: "Workflow: fail closed — synthesis",
  iconId: "kill_switch",
  bullets: ["Owner: agent runtime", "Child failed or returned empty text", "No handoff is returned"],
  x: 3690,
  y: 730,
  width: 340,
  color: "removed",
});

const sourceFile = card({
  id: "source-file",
  title: "Artifact: source file",
  iconId: "prompt_template",
  bullets: [
    "extensions/workflows/examples/",
    "requirements-grill.workflow.mjs",
    "Trusted executable workflow definition",
  ],
  x: 40,
  y: 1060,
  width: 360,
  color: "note",
});

const repositoryContext = card({
  id: "repository-context",
  title: "Artifact: repositoryContext",
  iconId: "data_catalog",
  bullets: [
    "pattern, summary, bounded match lines",
    "lineCount, characterCount, truncated",
    "Explicit evidence for Recon",
  ],
  x: 810,
  y: 1060,
  width: 360,
  color: "note",
});

const reconArtifact = card({
  id: "recon-artifact",
  title: "Artifact: in-memory reconText",
  iconId: "data_catalog",
  bullets: ["Exact Agent 1 text", "Passed verbatim to Agent 2", "No JSON parsing"],
  x: 1630,
  y: 1060,
  width: 360,
  color: "note",
});

const challengeArtifact = card({
  id: "challenge-artifact",
  title: "Artifact: in-memory challengeText",
  iconId: "data_catalog",
  bullets: ["Exact Agent 2 text", "Passed verbatim to Agent 3", "No JSON parsing"],
  x: 2450,
  y: 1060,
  width: 360,
  color: "note",
});

const handoffArtifact = card({
  id: "handoff-artifact",
  title: "Artifact: in-memory synthesisText",
  iconId: "data_catalog",
  bullets: ["Exact Agent 3 text", "Returned as workflow result", "Readable Markdown requested"],
  x: 3270,
  y: 1060,
  width: 360,
  color: "note",
});

const resultJson = card({
  id: "result-json",
  title: "Artifact: result.json",
  iconId: "historical_database",
  bullets: [".locus/runtime/workflows/<runId>/", "Technical workflow result", "Exact synthesisText in result value"],
  x: 4090,
  y: 1060,
  width: 360,
  color: "note",
});

const journalNdjson = card({
  id: "journal-ndjson",
  title: "Artifact: journal.ndjson",
  iconId: "audit_log",
  bullets: [
    ".locus/runtime/workflows/<runId>/",
    "Phase, log, agent start/end evidence",
    "Runtime-owned append-only journal",
  ],
  x: 4490,
  y: 1060,
  width: 360,
  color: "note",
});

const edges = [];
const connect = (id, from, to, options) => {
  const routed = layout.connectRouted(scene, from.block, to.block, {
    path: "orthogonal",
    labelWidth: 140,
    labelSize: 12,
    ...options,
  });
  edges.push({
    id,
    from: from.id,
    to: to.id,
    points: routed.points,
  });
};

connect("request-to-input", request, validateInput, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  path: "straight",
  label: "originalRequest",
});
connect("input-pass", validateInput, collectContext, {
  direction: "left-to-right",
  label: "pass: valid request",
  labelOffset: { dy: -64 },
});
connect("input-fail", validateInput, inputFailure, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  path: "straight",
  label: "fail → empty or >12,000",
  color: RED,
});
connect("collect-to-context-check", collectContext, contextCheck, {
  direction: "left-to-right",
  label: "repositoryContext",
  labelOffset: { dy: -64 },
});
connect("context-pass", contextCheck, recon, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  path: "straight",
  label: "pass: request + rg",
  labelOffset: { dx: 100, dy: 20 },
});
connect("context-fail", contextCheck, contextFailure, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  path: "straight",
  label: "fail: rg not ready",
  labelOffset: { dx: -100, dy: 22 },
  color: RED,
});
connect("recon-to-check", recon, reconCheck, {
  direction: "bottom-up",
  from: "top",
  to: "bottom",
  path: "straight",
  label: "exact reconText",
  labelOffset: { dx: -80, dy: 20 },
});
connect("recon-pass", reconCheck, challenge, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  path: "straight",
  label: "request + reconText",
  labelOffset: { dx: 100, dy: 20 },
});
connect("recon-fail", reconCheck, reconFailure, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  path: "straight",
  label: "child failure",
  labelOffset: { dx: 80, dy: 22 },
  color: RED,
});
connect("challenge-to-check", challenge, challengeCheck, {
  direction: "bottom-up",
  from: "top",
  to: "bottom",
  path: "straight",
  label: "exact challengeText",
  labelOffset: { dx: -80, dy: 20 },
});
connect("challenge-pass", challengeCheck, synthesis, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  path: "straight",
  label: "request + both texts",
  labelOffset: { dx: 100, dy: 20 },
});
connect("challenge-fail", challengeCheck, challengeFailure, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  path: "straight",
  label: "child failure",
  labelOffset: { dx: 80, dy: 22 },
  color: RED,
});
connect("synthesis-to-check", synthesis, synthesisCheck, {
  direction: "bottom-up",
  from: "top",
  to: "bottom",
  path: "straight",
  label: "exact synthesisText",
  labelOffset: { dx: -80, dy: 20 },
});
connect("synthesis-pass", synthesisCheck, success, {
  direction: "left-to-right",
  label: "exact text result",
  labelOffset: { dy: -64 },
});
connect("synthesis-fail", synthesisCheck, synthesisFailure, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  path: "straight",
  label: "child failure",
  labelOffset: { dx: 80, dy: 22 },
  color: RED,
});
connect("success-to-runtime", success, runtime, {
  direction: "left-to-right",
  label: "terminal JS result",
  labelOffset: { dy: -64 },
});

connect("rg-to-artifact", collectContext, repositoryContext, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  label: "bounded lines + metadata",
  color: GRAY,
  dashed: true,
});
connect("recon-to-artifact", recon, reconArtifact, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  label: "exact text",
  color: GRAY,
  dashed: true,
});
connect("challenge-to-artifact", challenge, challengeArtifact, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  label: "exact text",
  color: GRAY,
  dashed: true,
});
connect("synthesis-to-artifact", synthesis, handoffArtifact, {
  direction: "top-down",
  from: "bottom",
  to: "top",
  label: "exact text",
  color: GRAY,
  dashed: true,
});
connect("runtime-to-result", runtime, resultJson, {
  direction: "top-down",
  from: { side: "bottom", slot: 0.35 },
  to: "top",
  label: "persist runtime result",
  labelOffset: { dx: -96 },
  color: GRAY,
  dashed: true,
});
connect("runtime-to-journal", runtime, journalNdjson, {
  direction: "top-down",
  from: { side: "bottom", slot: 0.7 },
  to: "top",
  label: "append lifecycle evidence",
  labelOffset: { dx: 96 },
  color: GRAY,
  dashed: true,
});

scene.ellipse(60, 1405, 64, 42, { color: BLUE, strokeWidth: 2 });
scene.text(140, 1408, "Operator input", { size: 15, width: 420 });

scene.rect(650, 1405, 64, 42, {
  color: BLUE,
  strokeWidth: 2,
  roundness: { type: 3 },
});
scene.text(730, 1408, "Workflow-owned code or check", { size: 15, width: 560 });

scene.rect(1380, 1405, 64, 42, {
  color: PURPLE,
  strokeWidth: 2,
  roundness: { type: 3 },
});
scene.text(1460, 1408, "Full agent() child session", { size: 15, width: 520 });

scene.rect(2070, 1405, 64, 42, {
  color: GRAY,
  strokeWidth: 2,
  dashed: true,
});
scene.text(2150, 1408, "Direct llm() call type; absent here", { size: 15, width: 620 });

scene.rect(2900, 1405, 64, 42, {
  color: GRAY,
  strokeWidth: 2,
  roundness: { type: 3 },
});
scene.text(2980, 1408, "Artifact, file, or exact text handoff", { size: 15, width: 660 });

scene.rect(3790, 1405, 64, 42, {
  color: RED,
  strokeWidth: 2,
  roundness: { type: 3 },
});
scene.text(3870, 1408, "Fail-closed terminal branch", { size: 15, width: 520 });

scene.arrow(
  [
    [60, 1485],
    [210, 1485],
  ],
  { color: BLUE, strokeWidth: 2 },
);
scene.text(230, 1474, "Required handoff", { size: 15, width: 330 });

scene.arrow(
  [
    [650, 1485],
    [800, 1485],
  ],
  { color: GRAY, strokeWidth: 2, dashed: true },
);
scene.text(820, 1474, "Provenance or persistence", { size: 15, width: 460 });

scene.arrow(
  [
    [1380, 1485],
    [1530, 1485],
  ],
  { color: RED, strokeWidth: 2 },
);
scene.text(1550, 1474, "Failed check", { size: 15, width: 300 });

assertDiagramHealthy({
  cards,
  edges,
  gap: 18,
  overflowSeverity: "error",
});

scene.write(outputPath);
const output = JSON.parse(readFileSync(outputPath, "utf8"));
if (
  output.type !== "excalidraw" ||
  output.elements.length === 0 ||
  typeof output.files !== "object" ||
  Object.keys(output.files).length === 0
) {
  throw new Error("Generated requirements-grill pipeline is missing Excalidraw elements or embedded assets.");
}

console.log(
  JSON.stringify(
    {
      outputPath,
      type: output.type,
      elements: output.elements.length,
      files: Object.keys(output.files).length,
    },
    null,
    2,
  ),
);
