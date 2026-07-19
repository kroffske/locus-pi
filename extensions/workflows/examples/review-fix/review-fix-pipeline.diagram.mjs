import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { AssetRegistry, Bounds, Scene, assertDiagramHealthy, layout } = require("@kroffske/excalidraw-diagrams");

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = join(outputDirectory, "review-fix-pipeline.excalidraw");
const scene = new Scene({
  seed: 20260719,
  assetRegistry: AssetRegistry.bundled(),
  background: "#ffffff",
});

const COLORS = {
  operator: "#087f5b",
  workflow: "#7e22ce",
  agent: "#0b1fb3",
  directLlm: "#b45309",
  artifact: "#475569",
  risk: "#b91c1c",
  muted: "#64748b",
  operatorFill: "#ecfdf5",
  workflowFill: "#faf5ff",
  agentFill: "#eff6ff",
  artifactFill: "#f8fafc",
};

const setFill = (element, color, opacity = 100) => {
  element.backgroundColor = color;
  element.fillStyle = "solid";
  element.opacity = opacity;
};

const tint = (block, stroke, fill) => {
  for (const element of block.elements) {
    if (element.type !== "image") element.strokeColor = stroke;
    if (element.type === "rectangle" || element.type === "ellipse") setFill(element, fill);
  }
  return block;
};

const record = (id, block) => ({
  id,
  block,
  texts: block.elements.filter((element) => element.type === "text"),
});

const panel = (id, title, bullets, iconId, x, y, width, height, role) => {
  const stroke = role === "agent" ? COLORS.agent : COLORS.workflow;
  const fill = role === "agent" ? COLORS.agentFill : COLORS.workflowFill;
  return record(
    id,
    tint(
      layout.iconPanel(scene, x, y, width, height, {
        title,
        iconId,
        bullets,
        iconSize: 42,
        titleSize: 15,
        bulletSize: 11,
        bulletGap: 6,
      }),
      stroke,
      fill,
    ),
  );
};

const operator = (id, title, body, x, y, width, height) => {
  const frame = scene.ellipse(x, y, width, height, { color: COLORS.operator, strokeWidth: 2 });
  setFill(frame, COLORS.operatorFill);
  const icon = scene.placeAsset("chat_message", x + 24, y + 30, 42);
  const heading = scene.text(x + 78, y + 22, title, {
    size: 15,
    color: COLORS.operator,
    width: width - 96,
    align: "center",
  });
  const text = scene.text(x + 78, y + 52, body, {
    size: 11,
    color: COLORS.operator,
    width: width - 96,
    align: "center",
  });
  return record(id, scene.group([frame, icon, heading, text]));
};

const artifact = (id, title, lines, iconId, x, y, width, height, risk = false) => {
  const color = risk ? COLORS.risk : COLORS.artifact;
  const frame = scene.rect(x, y, width, height, { color, strokeWidth: 2, roundness: null });
  setFill(frame, risk ? "#fef2f2" : COLORS.artifactFill);
  const icon = scene.placeAsset(iconId, x + 20, y + 35, 38);
  const heading = scene.text(x + 70, y + 16, title, {
    size: 13,
    color,
    width: width - 88,
  });
  const text = scene.text(x + 70, y + 46, lines.join("\n"), {
    size: 10,
    color,
    width: width - 86,
  });
  return record(id, scene.group([frame, icon, heading, text]));
};

const lane = (title, subtitle, y, height, color, fill) => {
  const frame = scene.rect(40, y, 3920, height, { color, strokeWidth: 1, dashed: true });
  setFill(frame, fill, 42);
  frame.roughness = 0;
  scene.text(60, y + 12, title, { size: 18, color, width: 320 });
  scene.text(60, y + 42, subtitle, { size: 10, color: COLORS.muted, width: 470 });
};

scene.text(40, 18, "Curated review-fix workflow — accepted findings, isolated changes, verified report", {
  size: 28,
  width: 3920,
  align: "center",
});
scene.text(
  40,
  58,
  "Deterministic code validates approval before one runtime-owned worktree and two text-returning agents.",
  { size: 14, color: COLORS.muted, width: 3920, align: "center" },
);
scene.text(70, 96, "Legend", { size: 15, color: COLORS.artifact, width: 80 });
scene.text(
  165,
  94,
  "Operator: green ellipse · Workflow: purple card · Agent: blue card · Direct LLM: not used · Artifact: gray document · red artifact: isolated write surface",
  { size: 11, color: COLORS.artifact, width: 1650 },
);

lane(
  "OPERATOR",
  "Selects the approved task and later decides what to do with the retained worktree.",
  145,
  180,
  COLORS.operator,
  "#f0fdf4",
);
lane(
  "WORKFLOW-OWNED",
  "Validates files and hashes, allocates one opaque handle, forwards exact text, and returns.",
  345,
  250,
  COLORS.workflow,
  "#faf5ff",
);
lane(
  "FULL AGENT SESSIONS",
  "Implementer and verifier receive the same runtime-owned workspace handle.",
  615,
  235,
  COLORS.agent,
  "#eff6ff",
);
lane(
  "ARTIFACTS",
  "Human approval, isolated diff, reader report, and runtime evidence.",
  870,
  245,
  COLORS.artifact,
  "#f8fafc",
);

const request = operator(
  "operator-request",
  "Operator: fix request",
  "Task path whose fix-plan has accepted items",
  70,
  192,
  300,
  95,
);
const launchResolver = panel(
  "launch-resolver",
  "Workflow: load explicit fix-plan.md",
  ["Require one project-relative path", "Resolve files inside project root"],
  "multi_agent_orchestrator",
  430,
  405,
  285,
  115,
  "workflow",
);
const resolver = panel(
  "agent-1",
  "Workflow: deterministic approval validator",
  [
    "Recompute review + plan SHA-256",
    "Match target, snapshot, and finding ids",
    "Require at least one accepted finding",
  ],
  "signal_quality_magnifier",
  770,
  665,
  305,
  145,
  "workflow",
);
const checkApproval = panel(
  "check-approval",
  "Workflow: allocate one workspace handle",
  ["Exact reviewed head", "Opaque runtime-owned identity", "Original checkout invariant"],
  "function_router",
  1125,
  390,
  345,
  140,
  "workflow",
);
const blocked = panel(
  "blocked",
  "Workflow: stop on validation error",
  ["No worktree creation", "No write-capable agent starts"],
  "guardrails",
  3560,
  500,
  270,
  95,
  "workflow",
);
const launchImplementer = panel(
  "launch-implementer",
  "Workflow: launch Agent F1",
  ["Pass accepted findings only", "Pass opaque workspace handle"],
  "multi_agent_orchestrator",
  1550,
  385,
  270,
  110,
  "workflow",
);
const implementer = panel(
  "agent-2",
  "Agent: F1 — review-fix-01-implementer",
  ["label: apply accepted review fixes", "Edits runtime-owned worktree", "Returns exact implementation text"],
  "sandbox_executor",
  1880,
  655,
  315,
  155,
  "agent",
);
const launchVerifier = panel(
  "launch-verifier",
  "Workflow: launch Agent F2",
  ["Pass exact implementation text", "Reuse same opaque workspace handle"],
  "multi_agent_orchestrator",
  2250,
  405,
  285,
  115,
  "workflow",
);
const verifier = panel(
  "agent-3",
  "Agent: F2 — review-fix-02-verifier",
  ["label: verify review fixes and publish report", "Inspects diff + re-runs checks", "Writes fix-report.md"],
  "model_validation",
  2590,
  655,
  310,
  155,
  "agent",
);
const mapResult = panel(
  "map-result",
  "Workflow: return Agent F2 exact text",
  ["No JSON parse", "Recheck plan hashes", "Runtime keeps workspace evidence"],
  "function_router",
  2950,
  390,
  330,
  140,
  "workflow",
);
const operatorDecision = operator(
  "operator-decision",
  "Operator: inspect worktree",
  "Keep, edit, commit, or discard — outside workflow",
  3510,
  192,
  330,
  95,
);

const source = artifact(
  "source",
  "Artifact: review-fix.workflow.mjs + resources/*.md",
  ["Deterministic validator + F1/F2 Markdown"],
  "prompt_template",
  430,
  935,
  290,
  105,
);
const fixPlan = artifact(
  "fix-plan",
  "Artifact: .tasks/<task>/artifacts/fix-plan.md",
  [
    "Review publishes every finding pending",
    "Human disposition is the write gate",
    "Only accepted ids cross to Agent F1",
  ],
  "prompt_template",
  1125,
  920,
  345,
  130,
);
const worktree = artifact(
  "worktree",
  "Artifact: retained linked Git worktree",
  [
    "Exact reviewed head; separate real path",
    "Uncommitted accepted-finding diff",
    "Original checkout remains untouched",
  ],
  "sandbox_executor",
  1880,
  910,
  355,
  150,
  true,
);
const fixReport = artifact(
  "fix-report",
  "Artifact: .tasks/<task>/artifacts/fix-report.md",
  ["Applied + unresolved ids", "Changed files, checks, retained path"],
  "audit_log",
  2545,
  920,
  345,
  130,
);
const journal = artifact(
  "journal",
  "Artifact: journal.ndjson",
  ["Phase, log, and child-session evidence"],
  "audit_log",
  2990,
  940,
  285,
  105,
);
const result = artifact(
  "result",
  "Artifact: result.json",
  ["Mandatory run envelope", "Exact verifier text + runtime workspace evidence"],
  "data_catalog",
  3480,
  920,
  330,
  130,
);

const nodes = [
  request,
  launchResolver,
  resolver,
  checkApproval,
  blocked,
  launchImplementer,
  implementer,
  launchVerifier,
  verifier,
  mapResult,
  operatorDecision,
  source,
  fixPlan,
  worktree,
  fixReport,
  journal,
  result,
];

const edges = [];
const connect = (id, from, to, options = {}) => {
  const routed = layout.connectRouted(scene, from.block, to.block, {
    path: "orthogonal",
    direction: "left-to-right",
    labelSize: 10,
    labelColor: COLORS.artifact,
    labelWidth: 145,
    ...options,
  });
  edges.push({
    id,
    from: from.id,
    to: to.id,
    points: routed.points,
    ...(routed.label ? { label: { id: `${id}-label`, bounds: scene.bounds([routed.label]) } } : {}),
  });
};

connect("request-launch", request, launchResolver, { label: "input:string" });
connect("source-launch", source, launchResolver, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.artifact,
  label: "workflow definition",
  from: { side: "top", slot: 0.5 },
  to: { side: "bottom", slot: 0.5 },
});
connect("launch-resolver", launchResolver, resolver, {
  direction: "top-down",
  label: "path + file bytes",
  from: { side: "bottom", slot: 0.65 },
  to: { side: "top", slot: 0.35 },
});
connect("plan-resolver", fixPlan, resolver, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.operator,
  label: "read dispositions + hash",
  from: { side: "top", slot: 0.35 },
  to: { side: "bottom", slot: 0.65 },
});
connect("resolver-check", resolver, checkApproval, {
  direction: "bottom-up",
  label: "validated plan + reviewed head",
  from: { side: "top", slot: 0.65 },
  to: { side: "bottom", slot: 0.35 },
});
connect("approval-ready", checkApproval, launchImplementer, {
  label: "workspaceHandle",
  labelOffset: { dx: 0, dy: -100 },
});
connect("approval-blocked", checkApproval, blocked, {
  label: "validation/allocation error",
  path: "outer",
  outerSide: "top",
  outerGap: 38,
  from: { side: "right", slot: 0.7 },
  to: { side: "left", slot: 0.5 },
  labelOffset: { dx: 0, dy: -220 },
});
connect("launch-implementer", launchImplementer, implementer, {
  direction: "top-down",
  label: "accepted ids + plan text + handle",
  from: { side: "bottom", slot: 0.65 },
  to: { side: "top", slot: 0.35 },
});
connect("implementer-worktree", checkApproval, worktree, {
  direction: "top-down",
  color: COLORS.risk,
  label: "allocates exact reviewed head",
  path: "outer",
  outerSide: "right",
  outerGap: 42,
  from: { side: "bottom", slot: 0.65 },
  to: { side: "top", slot: 0.35 },
});
connect("implementer-launch-verifier", implementer, launchVerifier, {
  direction: "bottom-up",
  label: "exact implementationText",
  from: { side: "top", slot: 0.65 },
  to: { side: "bottom", slot: 0.35 },
});
connect("launch-verifier", launchVerifier, verifier, {
  direction: "top-down",
  label: "plan + text + same handle",
  from: { side: "bottom", slot: 0.65 },
  to: { side: "top", slot: 0.35 },
});
connect("worktree-verifier", worktree, verifier, {
  direction: "bottom-up",
  dashed: true,
  color: COLORS.risk,
  label: "re-open diff + run checks",
  from: { side: "top", slot: 0.65 },
  to: { side: "bottom", slot: 0.35 },
});
connect("verifier-report", verifier, fixReport, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "writes + re-reads",
  from: { side: "bottom", slot: 0.7 },
  to: { side: "top", slot: 0.35 },
});
connect("verifier-map", verifier, mapResult, {
  direction: "bottom-up",
  label: "exact verificationText",
  from: { side: "top", slot: 0.65 },
  to: { side: "bottom", slot: 0.35 },
});
connect("map-result", mapResult, result, {
  direction: "top-down",
  label: "serialized return",
  from: { side: "bottom", slot: 0.65 },
  to: { side: "top", slot: 0.35 },
});
connect("map-operator-decision", mapResult, operatorDecision, {
  color: COLORS.operator,
  label: "report + retained path",
  from: { side: "right", slot: 0.35 },
  to: { side: "left", slot: 0.65 },
  labelOffset: { dx: 0, dy: -45 },
});
connect("verifier-journal", verifier, journal, {
  direction: "top-down",
  dashed: true,
  color: COLORS.artifact,
  label: "phase + agent events",
  from: { side: "bottom", slot: 0.85 },
  to: { side: "top", slot: 0.35 },
});

const health = assertDiagramHealthy({
  blocks: nodes.map(({ id, block, texts }) => ({ id, bounds: block.bounds, texts, padding: 0 })),
  edges,
  gap: 8,
  renderBounds: new Bounds(0, 0, 4000, 1170),
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
      validation: { ok: health.ok, errors: health.errors.length, warnings: health.warnings.length },
      elements: output.elements.length,
      files: Object.keys(output.files).length,
    },
    null,
    2,
  ),
);
