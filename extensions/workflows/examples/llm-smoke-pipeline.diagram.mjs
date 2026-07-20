import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  AssetRegistry,
  Scene,
  assertDiagramHealthy,
  boundsFor,
  layout,
  nodeCard,
} = require("@kroffske/excalidraw-diagrams");

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = join(outputDirectory, "llm-smoke-pipeline.excalidraw");
const scene = new Scene({
  seed: 20260717,
  assetRegistry: AssetRegistry.bundled(),
  background: "#ffffff",
});

scene.text(40, 24, "llm-smoke — four direct model calls, no child agents", {
  size: 30,
  width: 4320,
  align: "center",
});
scene.text(40, 68, "Source truth: extensions/workflows/examples/llm-smoke.workflow.mjs", {
  size: 16,
  color: "#475569",
  width: 4320,
  align: "center",
});
scene.text(1460, 136, "4 × direct dsl.llm() calls · 0 × full Agent sessions", {
  size: 23,
  color: "#7c3aed",
  width: 1440,
  align: "center",
});

const cards = [];
const makeCard = ({ id, title, iconId, bullets, x, y, width = 340, color = "default", dashed = false }) => {
  const card = nodeCard(scene, {
    id,
    title,
    iconId,
    bullets,
    x,
    y,
    width,
    color,
    strict: true,
    titleSize: 18,
    titleMinSize: 14,
    titleMaxLines: 2,
    bulletSize: 13,
    bulletMaxLines: 3,
    bulletGap: 7,
    iconSize: 44,
  });
  if (dashed) {
    card.frame.strokeStyle = "dashed";
  }
  cards.push(card);
  return card;
};

const legend = makeCard({
  id: "legend",
  title: "Legend · node type / shape",
  iconId: "data_catalog",
  bullets: [
    "Operator: · chat card",
    "Workflow: · blue rounded card",
    "Direct LLM: · violet rounded card",
    "Agent: · red dashed robot",
    "Artifact: · gray database",
  ],
  x: 40,
  y: 112,
  width: 420,
  color: "external",
});

const readingGuide = makeCard({
  id: "reading-guide",
  title: "How to read the handoffs",
  iconId: "function_router",
  bullets: [
    "Solid arrow · awaited control or data",
    "Dashed arrow · runtime persistence",
    "Every edge label names its handoff",
  ],
  x: 500,
  y: 112,
  width: 400,
  color: "external",
});

const noAgent = makeCard({
  id: "no-agent-session",
  title: "Agent: not used",
  iconId: "robot_agent",
  bullets: [
    "Full Agent sessions: 0",
    "Owner would be the agent runtime",
    "No dsl.agent() call",
    "No child session is created",
  ],
  x: 3940,
  y: 112,
  width: 420,
  color: "removed",
  dashed: true,
});

const operator = makeCard({
  id: "operator",
  title: "Operator: request",
  iconId: "chat_message",
  bullets: ["Selects Package workflow: llm-smoke", "May provide a topic string"],
  x: 40,
  y: 440,
  color: "external",
});

const source = makeCard({
  id: "workflow-source",
  title: "Artifact: llm-smoke.workflow.mjs",
  iconId: "prompt_template",
  bullets: ["Owner: workflow source", "Exports meta + runWorkflow(dsl, input)", "Uses llm, phase, and log"],
  x: 600,
  y: 440,
});

const topicCheck = makeCard({
  id: "topic-check",
  title: "Workflow: input branch",
  iconId: "function_router",
  bullets: ["Owner: runWorkflow", "Non-empty string → input.trim()", "Otherwise → fixed default topic"],
  x: 1150,
  y: 440,
});

const direct = makeCard({
  id: "direct-call",
  title: "Direct LLM: call 1 — plain",
  iconId: "llm_chat",
  bullets: [
    'dsl.llm() · label: "direct"',
    "Prompt asks for one short sentence",
    "Captures text, stopReason, model, usage",
  ],
  x: 1200,
  y: 780,
  color: "changed",
});

const system = makeCard({
  id: "system-call",
  title: "Direct LLM: call 2 — system",
  iconId: "llm_chat",
  bullets: ['dsl.llm() · label: "system"', "Adds terse under-8-word system prompt", "Captures constrained.text"],
  x: 1740,
  y: 780,
  color: "changed",
});

const streamed = makeCard({
  id: "streamed-call",
  title: "Direct LLM: call 3 — streamed",
  iconId: "llm_chat",
  bullets: ['dsl.llm() · label: "streamed"', "stream: true forwards text chunks", "Captures text + stopReason"],
  x: 2280,
  y: 780,
  color: "changed",
});

const schema = makeCard({
  id: "schema-call",
  title: "Direct LLM: call 4 — schema",
  iconId: "model_validation",
  bullets: [
    'dsl.llm() · label: "schema"',
    "Validates positive / negative / neutral",
    "Parsed JSON → classified.output",
  ],
  x: 2820,
  y: 780,
  color: "changed",
});

const aggregate = makeCard({
  id: "aggregate-check",
  title: "Workflow: aggregate check",
  iconId: "guardrails",
  bullets: ["Owner: runWorkflow", "Check: all four result .ok values", "Boolean result → ok"],
  x: 3380,
  y: 440,
});

const returned = makeCard({
  id: "returned-result",
  title: "Workflow: return object",
  iconId: "data_catalog",
  bullets: ["Owner: runWorkflow", "Returns topic + four result slices", "Includes classified.output"],
  x: 3900,
  y: 440,
});

const journalArtifact = makeCard({
  id: "journal-artifact",
  title: "Artifact: journal.ndjson",
  iconId: "audit_log",
  bullets: [
    ".locus/runtime/workflows/<runId>/",
    "llm_start + llm_end for all four calls",
    "llm_delta for the streamed call",
  ],
  x: 1980,
  y: 1170,
  width: 420,
  color: "external",
});

const resultArtifact = makeCard({
  id: "result-artifact",
  title: "Artifact: result.json",
  iconId: "historical_database",
  bullets: [".locus/runtime/workflows/<runId>/", "Persists returned text and metadata", "Persists classified.output"],
  x: 3900,
  y: 1170,
  width: 420,
  color: "external",
});

const workflowSection = layout.section(scene, {
  title: "Workflow-owned orchestration and checks",
  x: 560,
  y: 370,
  padding: 24,
  titleHeight: 42,
  headerGap: 8,
  children: [source.block, topicCheck.block, aggregate.block, returned.block],
});

const directLlmSection = layout.section(scene, {
  title: "Direct LLM calls · awaited sequentially · no child Agent session",
  x: 1160,
  y: 710,
  padding: 24,
  titleHeight: 42,
  headerGap: 8,
  children: [direct.block, system.block, streamed.block, schema.block],
});

layout.section(scene, {
  title: "Durable runtime artifacts",
  x: 1940,
  y: 1100,
  padding: 24,
  titleHeight: 42,
  headerGap: 8,
  children: [journalArtifact.block, resultArtifact.block],
});

const edges = [];
const connect = (id, from, to, options) => {
  const routed = layout.connectRouted(scene, from.block, to.block, {
    direction: "left-to-right",
    path: "orthogonal",
    labelSize: 13,
    labelWidth: 138,
    labelOffset: { dy: -24 },
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
            bounds: boundsFor([routed.label]),
          },
        }
      : {}),
  });
};

connect("operator-to-source", operator, source, {
  label: "select workflow + optional topic",
});
connect("source-to-topic", source, topicCheck, {
  label: "runWorkflow(dsl, input)",
});
connect("topic-to-direct", topicCheck, direct, {
  direction: "top-down",
  from: { side: "bottom", slot: 0.65 },
  to: { side: "left", slot: 0.5 },
  label: "resolved topic → prompt 1",
  labelOffset: { dx: -36, dy: 12 },
});
connect("direct-to-system", direct, system, {
  label: "reply returned → await call 2",
});
connect("system-to-streamed", system, streamed, {
  label: "constrained returned → await call 3",
});
connect("streamed-to-schema", streamed, schema, {
  label: "streamed returned → await call 4",
});
connect("schema-to-aggregate", schema, aggregate, {
  direction: "bottom-up",
  from: { side: "right", slot: 0.5 },
  to: { side: "bottom", slot: 0.35 },
  label: "classified returned → evaluate ok",
  labelOffset: { dx: 42, dy: 12 },
});
connect("aggregate-to-return", aggregate, returned, {
  label: "ok + captured result fields",
});
connect("return-to-result", returned, resultArtifact, {
  direction: "top-down",
  from: { side: "bottom", slot: 0.7 },
  to: { side: "top", slot: 0.7 },
  label: "runtime persists returned value",
  dashed: true,
  color: "#475569",
  labelColor: "#475569",
  labelOffset: { dx: 150, dy: 0 },
});

const connectFromBlock = (id, fromId, fromBlock, to, options) => {
  const routed = layout.connectRouted(scene, fromBlock, to.block, {
    direction: "top-down",
    path: "orthogonal",
    dashed: true,
    color: "#475569",
    labelColor: "#475569",
    labelSize: 13,
    labelWidth: 180,
    ...options,
  });
  edges.push({
    id,
    from: fromId,
    to: to.id,
    points: routed.points,
    ...(routed.label
      ? {
          label: {
            id: `${id}-label`,
            bounds: boundsFor([routed.label]),
          },
        }
      : {}),
  });
};

connectFromBlock("calls-to-journal", "direct-llm-section", directLlmSection, journalArtifact, {
  from: { side: "bottom", slot: 0.35 },
  to: { side: "top", slot: 0.35 },
  label: "each call → llm_start / llm_end",
  labelOffset: { dx: -170, dy: 0 },
});
connect("stream-to-journal", streamed, journalArtifact, {
  direction: "top-down",
  from: { side: "bottom", slot: 0.7 },
  to: { side: "top", slot: 0.78 },
  label: "text chunks → llm_delta",
  dashed: true,
  color: "#475569",
  labelColor: "#475569",
  labelOffset: { dx: 170, dy: 0 },
});

const health = assertDiagramHealthy({
  cards,
  edges,
  gap: 18,
});

scene.write(outputPath);
const output = JSON.parse(readFileSync(outputPath, "utf8"));
if (output.type !== "excalidraw") {
  throw new Error(`Expected Excalidraw type, received: ${String(output.type)}`);
}
if (!Array.isArray(output.elements) || output.elements.length === 0) {
  throw new Error("Generated llm-smoke pipeline has no Excalidraw elements.");
}
if (typeof output.files !== "object" || Object.keys(output.files).length === 0) {
  throw new Error("Generated llm-smoke pipeline has no embedded asset files.");
}

console.log(
  JSON.stringify(
    {
      outputPath,
      elements: output.elements.length,
      files: Object.keys(output.files).length,
      health: {
        ok: health.ok,
        errors: health.errors.length,
        warnings: health.warnings.length,
      },
      sections: {
        workflow: workflowSection.bounds,
        directLlm: directLlmSection.bounds,
      },
    },
    null,
    2,
  ),
);
