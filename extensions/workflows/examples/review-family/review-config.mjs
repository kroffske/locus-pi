import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const MANIFEST_PATH = fileURLToPath(new URL("./agents.yaml", import.meta.url));
const EXPECTED_AGENTS = {
  review: ["targetResolver", "changeReviewer", "contextReviewer", "adjudicator", "publisher"],
  reviewFix: ["planResolver", "implementer", "verifier"],
};
const SHARED_FIELDS = [
  "resultEnvelopeInstruction",
  "evidenceBudget",
  "reportTemplate",
  "fixPlanTemplate",
  "fixReportTemplate",
];
const TEMPLATE_TOKEN = /\{\{([A-Z][A-Z0-9_]*)\}\}/gu;

export const reviewAgentManifest = loadManifest();

export function agentOptions(workflowName, agentName, schemaName, schema) {
  const definition = agentDefinition(workflowName, agentName);
  if (definition.schema !== schemaName) {
    throw new Error(
      `Review agent ${workflowName}.${agentName} declares schema ${definition.schema}, expected ${schemaName}.`,
    );
  }
  return {
    agent: definition.profile,
    label: definition.label,
    permissionMode: definition.permissionMode,
    workspaceMode: definition.workspaceMode,
    maxToolCalls: definition.maxToolCalls,
    schema,
  };
}

export function renderAgentPrompt(workflowName, agentName, variables = {}) {
  const definition = agentDefinition(workflowName, agentName);
  return renderTemplate(`${workflowName}.${agentName}.prompt`, definition.prompt, {
    EVIDENCE_BUDGET: reviewAgentManifest.shared.evidenceBudget,
    REPORT_TEMPLATE: reviewAgentManifest.shared.reportTemplate,
    FIX_PLAN_TEMPLATE: reviewAgentManifest.shared.fixPlanTemplate,
    FIX_REPORT_TEMPLATE: reviewAgentManifest.shared.fixReportTemplate,
    ...variables,
  });
}

export function resultEnvelope(output) {
  const envelope = JSON.stringify({
    version: "locus.agent.result.v1",
    status: "completed",
    summary: "<one-line stage result>",
    output,
  });
  return renderTemplate("shared.resultEnvelopeInstruction", reviewAgentManifest.shared.resultEnvelopeInstruction, {
    RESULT_ENVELOPE_JSON: envelope,
  });
}

function agentDefinition(workflowName, agentName) {
  const workflow = reviewAgentManifest.workflows[workflowName];
  if (!workflow) throw new Error(`Unknown review workflow configuration: ${workflowName}.`);
  const definition = workflow.agents[agentName];
  if (!definition) throw new Error(`Unknown review agent configuration: ${workflowName}.${agentName}.`);
  return definition;
}

function renderTemplate(subject, template, variables) {
  const rendered = template.replace(TEMPLATE_TOKEN, (_match, key) => {
    if (!Object.hasOwn(variables, key)) {
      throw new Error(`Missing template variable ${key} for ${subject}.`);
    }
    const value = variables[key];
    if (typeof value !== "string") {
      throw new Error(`Template variable ${key} for ${subject} must be a string.`);
    }
    return value;
  });
  const unresolved = [...rendered.matchAll(TEMPLATE_TOKEN)].map((match) => match[1]);
  if (unresolved.length > 0) {
    throw new Error(`Unresolved template variables for ${subject}: ${unresolved.join(", ")}.`);
  }
  return rendered;
}

function loadManifest() {
  const source = readFileSync(MANIFEST_PATH, "utf8");
  const parsed = parse(source, {
    maxAliasCount: 0,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  validateManifest(parsed);
  return deepFreeze(parsed);
}

function validateManifest(manifest) {
  if (!isRecord(manifest) || manifest.version !== "locus.review-agents.v1") {
    throw new Error("agents.yaml must declare version locus.review-agents.v1.");
  }
  if (!isRecord(manifest.shared)) throw new Error("agents.yaml shared must be an object.");
  for (const field of SHARED_FIELDS) {
    if (typeof manifest.shared[field] !== "string" || manifest.shared[field].trim() === "") {
      throw new Error(`agents.yaml shared.${field} must be a non-empty string.`);
    }
  }
  if (!isRecord(manifest.workflows)) throw new Error("agents.yaml workflows must be an object.");

  const ids = new Set();
  const labels = new Set();
  for (const [workflowName, expectedNames] of Object.entries(EXPECTED_AGENTS)) {
    const workflow = manifest.workflows[workflowName];
    if (!isRecord(workflow) || !isRecord(workflow.agents)) {
      throw new Error(`agents.yaml workflows.${workflowName}.agents must be an object.`);
    }
    const actualNames = Object.keys(workflow.agents);
    if (
      actualNames.length !== expectedNames.length ||
      expectedNames.some((name, index) => actualNames[index] !== name)
    ) {
      throw new Error(`agents.yaml workflows.${workflowName}.agents must be ordered as ${expectedNames.join(", ")}.`);
    }
    expectedNames.forEach((agentName, index) => {
      const definition = workflow.agents[agentName];
      validateAgentDefinition(workflowName, agentName, definition, index + 1, ids, labels);
    });
  }
}

function validateAgentDefinition(workflowName, agentName, definition, expectedNumber, ids, labels) {
  const subject = `agents.yaml workflows.${workflowName}.agents.${agentName}`;
  if (!isRecord(definition)) throw new Error(`${subject} must be an object.`);
  for (const field of ["id", "name", "label", "profile", "schema", "permissionMode", "workspaceMode", "prompt"]) {
    if (typeof definition[field] !== "string" || definition[field].trim() === "") {
      throw new Error(`${subject}.${field} must be a non-empty string.`);
    }
  }
  if (definition.number !== expectedNumber) {
    throw new Error(`${subject}.number must be ${expectedNumber}.`);
  }
  const expectedId = `${workflowName === "review" ? "R" : "F"}${expectedNumber}`;
  if (definition.id !== expectedId) throw new Error(`${subject}.id must be ${expectedId}.`);
  if (!Number.isInteger(definition.maxToolCalls) || definition.maxToolCalls <= 0) {
    throw new Error(`${subject}.maxToolCalls must be a positive integer.`);
  }
  if (definition.profile !== "oracle") throw new Error(`${subject}.profile must be oracle.`);
  if (definition.permissionMode !== "agent-defined") {
    throw new Error(`${subject}.permissionMode must be agent-defined.`);
  }
  if (definition.workspaceMode !== "project") {
    throw new Error(`${subject}.workspaceMode must be project.`);
  }
  if (ids.has(definition.id)) throw new Error(`${subject}.id duplicates ${definition.id}.`);
  if (labels.has(definition.label)) throw new Error(`${subject}.label duplicates ${definition.label}.`);
  ids.add(definition.id);
  labels.add(definition.label);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
