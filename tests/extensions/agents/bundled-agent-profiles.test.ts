import { describe, expect, it } from "vitest";
import { evaluateEvidence } from "../../../extensions/_shared/agent-evidence-evaluator.js";
import { BUNDLED_AGENTS_DIR, loadAgentsFromDir } from "../../../extensions/_shared/agents.js";
import type { AgentDefinition } from "../../../extensions/_shared/types.js";

function loadBundledAgent(name: string): AgentDefinition {
  const loaded = loadAgentsFromDir(BUNDLED_AGENTS_DIR, "bundled");
  expect(loaded.diagnostics).toEqual([]);
  const definition = loaded.definitions.find((agent) => agent.name === name);
  expect(definition).toBeDefined();
  return definition!;
}

describe("bundled agent profiles", () => {
  it("loads real default.md with reasoning-only evidence policy", () => {
    const definition = loadBundledAgent("default");
    const outcome = evaluateEvidence({
      agentName: definition.name,
      policy: definition.evidence!,
      toolCallCount: 0,
      toolResultCount: 0,
      observedToolNames: [],
      outputText: "This answer only uses reasoning.",
      status: "completed",
    });

    expect(outcome.evidence).toBe("reasoning_only");
    expect(outcome.warnings).toEqual([]);
  });

  it("loads real explore.md with expected tool-call evidence warning", () => {
    const definition = loadBundledAgent("explore");
    const outcome = evaluateEvidence({
      agentName: definition.name,
      policy: definition.evidence!,
      toolCallCount: 0,
      toolResultCount: 0,
      observedToolNames: [],
      outputText: "This answer only uses reasoning.",
      status: "completed",
    });

    expect(outcome.evidence).toBe("missing_expected_evidence");
    expect(outcome.warnings.length).toBeGreaterThan(0);
  });
});
