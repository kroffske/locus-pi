import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface AgentDefinition {
  id: string;
  number: number;
  name: string;
  label: string;
  profile: string;
  schema: string;
  maxToolCalls: number;
  prompt: string;
}

interface ReviewAgentManifest {
  version: string;
  workflows: {
    review: { agents: Record<string, AgentDefinition> };
    reviewFix: { agents: Record<string, AgentDefinition> };
  };
}

const reviewFamilyDirectory = path.join(process.cwd(), "extensions/workflows/examples/review-family");
const manifestPath = path.join(reviewFamilyDirectory, "agents.yaml");
const configPath = path.join(reviewFamilyDirectory, "review-config.mjs");

describe("review agent YAML manifest", () => {
  it("names and numbers every review and remediation agent explicitly", () => {
    const manifest = parse(readFileSync(manifestPath, "utf8")) as ReviewAgentManifest;
    const reviewAgents = Object.entries(manifest.workflows.review.agents);
    const fixAgents = Object.entries(manifest.workflows.reviewFix.agents);

    expect(manifest.version).toBe("locus.review-agents.v1");
    expect(reviewAgents.map(([key, agent]) => [key, agent.id, agent.number, agent.name, agent.label])).toEqual([
      ["targetResolver", "R1", 1, "target-resolver", "resolve review target"],
      ["changeReviewer", "R2", 2, "change-reviewer", "review introduced changes"],
      ["contextReviewer", "R3", 3, "context-reviewer", "review whole-file context"],
      ["adjudicator", "R4", 4, "adjudicator", "adjudicate review findings"],
      ["publisher", "R5", 5, "publisher", "publish review report"],
    ]);
    expect(fixAgents.map(([key, agent]) => [key, agent.id, agent.number, agent.name, agent.label])).toEqual([
      ["planResolver", "F1", 1, "plan-resolver", "resolve approved review plan"],
      ["implementer", "F2", 2, "implementer", "apply accepted review fixes"],
      ["verifier", "F3", 3, "verifier", "verify review fixes and publish report"],
    ]);

    const allAgents = [...reviewAgents, ...fixAgents].map(([, agent]) => agent);
    expect(new Set(allAgents.map(({ id }) => id)).size).toBe(8);
    expect(new Set(allAgents.map(({ label }) => label)).size).toBe(8);
    expect(allAgents.every(({ profile }) => profile === "oracle")).toBe(true);
    expect(allAgents.every(({ prompt }) => prompt.includes("{{RESULT_ENVELOPE}}"))).toBe(true);
  });

  it("loads, freezes, and fail-closed renders the package-owned manifest", async () => {
    const loaded = (await import(configPath)) as {
      reviewAgentManifest: ReviewAgentManifest;
      agentOptions: (workflow: string, agent: string, schemaName: string, schema: unknown) => unknown;
      renderAgentPrompt: (workflow: string, agent: string, variables: Record<string, string>) => string;
    };

    expect(Object.isFrozen(loaded.reviewAgentManifest)).toBe(true);
    expect(Object.isFrozen(loaded.reviewAgentManifest.workflows.review.agents.targetResolver)).toBe(true);
    expect(() => loaded.agentOptions("review", "targetResolver", "WRONG_SCHEMA", {})).toThrow(
      /declares schema TARGET_SCHEMA, expected WRONG_SCHEMA/u,
    );
    expect(() => loaded.renderAgentPrompt("review", "targetResolver", {})).toThrow(
      /Missing template variable ORIGINAL_REQUEST/u,
    );
    expect(
      loaded.renderAgentPrompt("review", "targetResolver", {
        ORIGINAL_REQUEST: "Review dev...feature",
        RESULT_ENVELOPE: "structured-result",
      }),
    ).toContain("Review dev...feature");
  });
});
