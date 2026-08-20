import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateEvidence } from "../../../extensions/_shared/agent-runtime/agent-evidence-evaluator.js";
import {
  BUNDLED_AGENTS_DIR,
  loadAgentsFromDir,
  type AgentDefinition,
} from "../../../extensions/_shared/agent-runtime/agents.js";
import {
  buildModelRolesState,
  DEFAULT_MODEL_ROLES,
  loadModelRolesState,
  resolveAgentModelPreference,
  type ModelRolesState,
} from "../../../extensions/_shared/model/model-settings.js";
import { createHarness } from "../../test-harness.js";
import { loadExtensionAgentCatalog, refreshAgents, resolveAgentSelection } from "../../../extensions/agents/catalog.js";

function loadBundledAgent(name: string): AgentDefinition {
  const loaded = loadAgentsFromDir(BUNDLED_AGENTS_DIR, "bundled");
  expect(loaded.diagnostics).toEqual([]);
  const definition = loaded.definitions.find((agent) => agent.name === name);
  expect(definition).toBeDefined();
  return definition!;
}

describe("bundled extension-agent catalog", () => {
  it("covers every default extension and resolves its manifest description", () => {
    const entries = loadExtensionAgentCatalog();
    expect(entries).toHaveLength(10);
    expect(new Set(entries.map((entry) => entry.extensionId)).size).toBe(entries.length);
    expect(new Set(entries.map((entry) => entry.agentName)).size).toBe(entries.length);

    refreshAgents(process.cwd());
    for (const entry of entries) {
      expect(resolveAgentSelection(entry.agentName)?.agent.description).toBe(entry.description);
      expect(entry.profilePath).toMatch(/^\.agents\/agents\/extension-[^/]+\.md$/);
    }
  });

  it("rejects an unknown or duplicate assignment in a package fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-extension-agent-catalog-"));
    try {
      await mkdir(join(root, "extensions", "one"), { recursive: true });
      await mkdir(join(root, ".agents", "agents"), { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ pi: { extensions: ["./extensions/one/index.ts"] } }),
      );
      await writeFile(
        join(root, "extensions", "one", "manifest.json"),
        JSON.stringify({ id: "one", agent: { name: "missing", description: "x" } }),
      );
      expect(() => loadExtensionAgentCatalog({ packageRoot: root })).toThrow("unknown bundled agent profile");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects drift between manifest and profile descriptions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-extension-agent-description-"));
    try {
      await mkdir(join(root, "extensions", "one"), { recursive: true });
      await mkdir(join(root, ".agents", "agents"), { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ pi: { extensions: ["./extensions/one/index.ts"] } }),
      );
      await writeFile(
        join(root, "extensions", "one", "manifest.json"),
        JSON.stringify({ id: "one", agent: { name: "extension-one", description: "Manifest description." } }),
      );
      await writeFile(
        join(root, ".agents", "agents", "extension-one.md"),
        "---\nname: extension-one\ndescription: Profile description.\nmodel: task\n---\nOne.\n",
      );
      expect(() => loadExtensionAgentCatalog({ packageRoot: root })).toThrow("description drift");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bundled agent profiles", () => {
  it("gives workflow-author the Pi-native source checker", () => {
    const definition = loadBundledAgent("workflow-author");

    expect(definition.allowedTools).toContain("workflow_check_source");
  });

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

/**
 * The tier namespace the ten shipped agents use, and what the package promises a
 * stranger about it.
 *
 * OD1: a slash means a real provider, a slash-free token is a role. OD5: the package
 * ships NO assignments, so a role means whatever the operator's own config says and
 * nothing until then. Both are product decisions that source alone cannot re-derive,
 * so they are asserted here rather than left to be rediscovered from a failing run.
 */
describe("bundled agent tiers", () => {
  const bundled = () => {
    const loaded = loadAgentsFromDir(BUNDLED_AGENTS_DIR, "bundled");
    expect(loaded.diagnostics).toEqual([]);
    return loaded.definitions;
  };

  it("gives every bundled agent exactly one tier, written as a bare role", () => {
    const definitions = bundled();
    expect(definitions.length).toBeGreaterThan(0);

    for (const definition of definitions) {
      expect(definition.model, `${definition.name} declares no model`).toBeDefined();
      // One entry, because `resolveAgentModelPreference` reads only `model[0]`; a
      // second entry would be inert text that reads like a fallback and is not one.
      expect(definition.model, `${definition.name} declares more than one tier`).toHaveLength(1);
      const tier = definition.model![0]!;
      expect(tier, `${definition.name} still uses a slash-bearing tier`).not.toContain("/");
      expect(DEFAULT_MODEL_ROLES, `${definition.name} names a role the table does not ship`).toContain(tier);
    }
  });

  it("resolves each bundled tier through the roles table, not as a provider selector", () => {
    const state = emptyRolesState();

    for (const definition of bundled()) {
      const tier = definition.model![0]!;
      const resolution = resolveAgentModelPreference(state, definition.model!);
      // `source: "agent"` is what `resolveAgentModelPreference` returns for a DIRECT
      // provider/id selector. Anything else means the value went through the table.
      expect(resolution.source, `${definition.name} short-circuited the roles table`).not.toBe("agent");
      expect(resolution.requestedRoles[0]).toBe(tier);
    }
  });

  it("ships no concrete model assignment for any role", async () => {
    // OD5, provider-neutral: the package must not decide which vendor a stranger
    // pays. Every role is a name until an operator layer assigns it, and an
    // unassigned role degrades to the session model with the degradation recorded.
    // If a package default is ever added, this test fails and the decision has to be
    // re-made on purpose instead of drifting in.
    //
    // This goes through the SHIPPED loader rather than four hand-built empty layers:
    // hand-building the layers proves only that empty input yields empty output, and
    // a default injected anywhere inside `loadModelRolesState` would sail past it.
    // The operator layers are pointed at empty temp directories so the machine
    // running the suite cannot lend the package its own assignments.
    const previousHome = process.env.PI_MODEL_ROLES_HOME;
    const root = await mkdtemp(join(tmpdir(), "pi-provider-neutral-"));
    try {
      process.env.PI_MODEL_ROLES_HOME = join(root, "home");
      const harness = createHarness(join(root, "project"));
      const state = await loadModelRolesState(harness.ctx);

      for (const role of DEFAULT_MODEL_ROLES) {
        expect(state.effective.get(role)).toMatchObject({ role, source: "unset" });
        expect(state.effective.get(role)?.assignment).toBeUndefined();
      }
    } finally {
      if (previousHome === undefined) delete process.env.PI_MODEL_ROLES_HOME;
      else process.env.PI_MODEL_ROLES_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});

function emptyRolesState(): ModelRolesState {
  return buildModelRolesState({ user: "/nowhere/user.json", project: "/nowhere/project.json" }, {}, {}, {}, {});
}
