import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentLiveStore,
  createAgentSdkSessionExecutor,
  type SdkAgentSessionEventLike,
  type SdkAgentSessionLike,
  type SdkCreateSessionOptionsLike,
} from "../../../extensions/_shared/agent-runtime/agent-sdk-host.js";
import type { AgentExecutor } from "../../../extensions/_shared/agent-runtime/agent-runner.js";
import { createWorkflowAgentRunner } from "../../../extensions/workflows/runtime/workflow-agent-bridge.js";
import {
  applyWorkflowJournalLineToAgentLiveStore,
  createWorkflowJournalSink,
  readWorkflowRunJournalState,
  readWorkflowRunSummary,
  resetWorkflowLiveExecutions,
  workflowAgentLiveRowId,
} from "../../../extensions/workflows/runtime/workflow-journal.js";
import {
  createWorkflowRuntime,
  type WorkflowAgentResult,
  type WorkflowJournalLine,
} from "../../../extensions/workflows/runtime/workflow-runtime.js";
import {
  parseModelSelector,
  resolveWorkflowModel,
  type WorkflowModelRegistrySource,
} from "../../../extensions/_shared/workflow-model-resolve.js";
import type { ModelLike } from "../../../extensions/_shared/pi-api.js";
import { createHarness, type Harness } from "../../test-harness.js";

/**
 * Model tiers, end to end.
 *
 * The claim under test is narrow and was false before T-129: the model a stage
 * declares is the model the child session is created with, and every refusal names
 * what it refused. Everything here is deterministic — the SDK factory is injected,
 * so `createSession` is observed by value rather than believed.
 *
 * What these tests deliberately cannot prove: that a real Pi peer honours the model
 * object it was handed. That is the live run in `artifacts/live-two-tier-run.md`.
 */

const FAST: ModelLike = { provider: "test", id: "fast", name: "Test Fast" };
const STRONG: ModelLike = { provider: "test", id: "strong", name: "Test Strong" };

afterEach(() => {
  resetWorkflowLiveExecutions();
  agentLiveStore.reset();
});

/** The shape the post-child validator cases hand the runtime, so `validate` is reached at all. */
const COUNT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["count"],
  properties: { count: { type: "integer" } },
} as const;

/**
 * A project that owns every agent it names.
 *
 * Discovery is project → user → bundled, so a root without `.agents/agents/` reads
 * the developer's home catalog and these assertions would depend on their machine.
 */
function tieredProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "locus-model-tiers-"));
  const dir = path.join(root, ".agents", "agents");
  mkdirSync(dir, { recursive: true });
  const agents: Array<[string, string]> = [
    ["default", "---\nname: default\ndescription: General purpose agent\nmodel: task\n---\nDo the work.\n"],
    ["roled", "---\nname: roled\ndescription: Agent on a role tier\nmodel: smol\n---\nWork cheaply.\n"],
    ["pinned", "---\nname: pinned\ndescription: Agent pinned to one model\nmodel: test/strong\n---\nWork.\n"],
    ["bare", "---\nname: bare\ndescription: Agent with no model line\n---\nWork.\n"],
    ["stale", "---\nname: stale\ndescription: Agent on the pre-tier namespace\nmodel: pi/smol\n---\nWork.\n"],
  ];
  for (const [name, body] of agents) writeFileSync(path.join(dir, `${name}.md`), body, "utf8");
  return root;
}

interface SdkProbe {
  createExecutor: (o: { model?: unknown }) => AgentExecutor;
  /** Every `createSession` call, in order. Length 0 proves no child was ever spawned. */
  captured: SdkCreateSessionOptionsLike[];
}

/**
 * The bridge's own executor factory, with only the SDK boundary faked.
 *
 * `createAgentSdkSessionExecutor` is the real one, so a passing assertion covers the
 * whole path bridge → boundary → executor → `createSession`, not just the bridge's
 * intention.
 */
function sdkProbe(sessionModel?: unknown, answer = "tier answer"): SdkProbe {
  const captured: SdkCreateSessionOptionsLike[] = [];
  const reportsDir = mkdtempSync(path.join(tmpdir(), "locus-model-tiers-reports-"));
  const createExecutor = (o: { model?: unknown }): AgentExecutor =>
    createAgentSdkSessionExecutor({
      ...(o.model !== undefined ? { model: o.model } : {}),
      createSession: async (options) => {
        captured.push(options);
        return { session: fakeSession(sessionModel, answer) };
      },
      reportsDir,
      now: () => "fixed",
    });
  return { createExecutor, captured };
}

function fakeSession(model: unknown, answer = "tier answer"): SdkAgentSessionLike {
  const exportDir = mkdtempSync(path.join(tmpdir(), "locus-model-tiers-export-"));
  let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
  return {
    sessionId: "tier-child",
    // Absent on purpose when the caller passes nothing: an older peer or a
    // structural mock exposes no model, and that must record as `unavailable`.
    ...(model !== undefined ? { model } : {}),
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      listener?.({ type: "agent_end", willRetry: false });
    },
    getSessionStats() {
      return { sessionId: "tier-child", toolCalls: 1, toolResults: 1 };
    },
    getLastAssistantText() {
      return answer;
    },
    exportToJsonl(outputPath) {
      const target = outputPath ?? path.join(exportDir, "session.jsonl");
      writeFileSync(target, "{}\n", "utf8");
      return target;
    },
    dispose() {},
  };
}

/** Every `locus.agent.run-result.v1` body written under a project root, read off disk. */
function runResultArtifacts(projectRoot: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.startsWith("agent-run-") && entry.name.endsWith(".json")) {
        const envelope = JSON.parse(readFileSync(next, "utf8")) as { content?: string };
        if (envelope.content !== undefined) found.push(JSON.parse(envelope.content) as Record<string, unknown>);
      }
    }
  };
  try {
    walk(path.join(projectRoot, ".locus", "runtime", "artifacts"));
  } catch {
    return [];
  }
  return found;
}

async function harnessWithRoles(roles?: Record<string, string>): Promise<Harness> {
  const h = createHarness(tieredProject(), { sessionId: "tier-parent" });
  h.ctx.model = STRONG;
  if (roles !== undefined) await h.ctx.settings?.set("modelRoles", roles);
  return h;
}

// ---------------------------------------------------------------------------
// W1 — the selector grammar, which OD3 settled as "real thinking levels only"
// ---------------------------------------------------------------------------

describe("model selector grammar", () => {
  it("splits a plain provider/id selector", () => {
    expect(parseModelSelector("openai/gpt-5")).toEqual({ provider: "openai", id: "gpt-5" });
  });

  it.each(["off", "minimal", "low", "medium", "high", "xhigh"])(
    "strips the real thinking level %s and keeps it for display",
    (level) => {
      expect(parseModelSelector(`openai/gpt-5:${level}`)).toEqual({
        provider: "openai",
        id: "gpt-5",
        thinking: level,
      });
    },
  );

  it("keeps a suffix that is not a thinking level as part of the id", () => {
    // The two parsers used to disagree here: this module stripped the LITERAL
    // string ":thinking" while the roles table stripped real levels. One grammar
    // now, and the literal word is just an id suffix that will fail to resolve.
    expect(parseModelSelector("openai/gpt-5:thinking")).toEqual({ provider: "openai", id: "gpt-5:thinking" });
  });

  it.each(["smol", "slow", "default"])("treats the slash-free token %s as a role, not a selector", (token) => {
    expect(parseModelSelector(token)).toBeUndefined();
  });

  it.each(["", "/", "openai/", "/gpt-5", "openai/:high"])("refuses the malformed selector %j", (selector) => {
    expect(parseModelSelector(selector)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// W1 — resolution goes through the host registry and never returns "undefined,
// figure it out yourself"
// ---------------------------------------------------------------------------

describe("registry resolution", () => {
  it("resolves a configured model to the registry's own object", async () => {
    const h = await harnessWithRoles();
    const resolution = await resolveWorkflowModel("test/fast", h.ctx);

    expect(resolution).toMatchObject({ ok: true, selector: "test/fast", provider: "test", id: "fast" });
    expect(resolution.ok && resolution.model).toEqual(FAST);
  });

  it("strips the thinking level BEFORE the registry lookup", async () => {
    const seen: Array<[string, string]> = [];
    const source: WorkflowModelRegistrySource = {
      modelRegistry: {
        find(provider, id) {
          seen.push([provider, id]);
          return provider === "test" && id === "fast" ? FAST : undefined;
        },
      },
    } as WorkflowModelRegistrySource;

    const resolution = await resolveWorkflowModel("test/fast:low", source);

    expect(seen).toEqual([["test", "fast"]]);
    expect(resolution).toMatchObject({ ok: true, thinking: "low" });
  });

  it("names an unknown model instead of returning nothing", async () => {
    const h = await harnessWithRoles();
    const resolution = await resolveWorkflowModel("test/absent", h.ctx);

    expect(resolution.ok).toBe(false);
    expect(resolution).toMatchObject({ reason: "unknown-model" });
    expect(!resolution.ok && resolution.message).toContain('"test/absent"');
    expect(!resolution.ok && resolution.message).toContain('provider "test" has no model "absent"');
  });

  it("names an unparseable selector", async () => {
    const h = await harnessWithRoles();
    const resolution = await resolveWorkflowModel("smol", h.ctx);

    expect(resolution).toMatchObject({ ok: false, reason: "unparseable-selector" });
  });

  it("names a host with no model registry rather than guessing", async () => {
    const resolution = await resolveWorkflowModel("test/fast", {} as WorkflowModelRegistrySource);

    expect(resolution).toMatchObject({ ok: false, reason: "no-model-registry" });
  });
});

// ---------------------------------------------------------------------------
// W2 / W3 / W12 — the resolved tier reaches the child session
// ---------------------------------------------------------------------------

describe("the declared tier reaches the child session", () => {
  it("creates the child session with the model a modelRole resolves to", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "cheap work", agent: "bare", modelRole: "smol" });

    expect(result.status).toBe("completed");
    // By VALUE, not by truthiness: the parent session runs `test/strong`, so a
    // passing assertion here cannot be satisfied by inheritance.
    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]?.model).toEqual(FAST);
    expect(h.ctx.model).toEqual(STRONG);
  });

  it("resolves a tier that carries a thinking suffix as that tier, not as a role of its own", async () => {
    // The two grammars have to agree. `provider/id:high` names a model at a level;
    // `smol:high` names the SAME tier at a level. Looking the whole token up as a
    // role name finds nothing, and a role that resolves to nothing degrades to the
    // parent — so the author who spelled out the cheap tier would silently get the
    // expensive one. The level itself is display-only and never reaches the child.
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "cheap work", agent: "bare", modelRole: "smol:high" });

    expect(result.status).toBe("completed");
    // By value: the parent is `test/strong`, so inheritance cannot satisfy this.
    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]?.model).toEqual(FAST);
    // And it resolved rather than degraded — a degradation would have recorded one.
    expect(result.modelRoleFallback).toBeUndefined();
  });

  it("lets a per-call model outrank the agent's frontmatter tier", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    // `roled` declares `model: smol` (→ test/fast); the call pins test/strong.
    const result = await runner({ prompt: "pin it", agent: "roled", model: "test/strong" });

    expect(result.status).toBe("completed");
    expect(probe.captured[0]?.model).toEqual(STRONG);
  });

  it("routes an agent's own frontmatter role when the call declares nothing", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "roled" });

    expect(result.status).toBe("completed");
    expect(probe.captured[0]?.model).toEqual(FAST);
  });

  it("resolves a declared role WITHOUT the purpose fallback chain", async () => {
    // `resolveModelRoleForPurpose` walks preferred → agent → task → default. An
    // author who wrote `modelRole: "smol"` asked about `smol`; answering with the
    // `agent` tier would run a different model under the requested tier's name.
    const h = await harnessWithRoles({ agent: "test/fast", task: "test/fast", default: "test/fast" });
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "bare", modelRole: "smol" });

    expect(result.status).toBe("completed");
    // `agent`/`task`/`default` all resolve to test/fast; `smol` does not resolve at
    // all, so the child must inherit the session model rather than borrow theirs.
    expect(probe.captured[0]?.model).toEqual(STRONG);
    expect(result.modelRoleFallback).toContain('"smol"');
  });
});

// ---------------------------------------------------------------------------
// W2 — a concrete selector that does not resolve ends the call, with no child
// ---------------------------------------------------------------------------

describe("an unresolvable concrete selector fails the call", () => {
  it("refuses a per-call model and spawns nothing", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({
      prompt: "work",
      agent: "bare",
      model: "no-such-provider/no-such-model",
    });

    expect(result.status).toBe("failed");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.join("\n")).toContain('"no-such-provider/no-such-model"');
    expect(probe.captured).toHaveLength(0);
    // The SUMMARY has to carry the whole reason, not a headline. A live run showed
    // `diagnostics` never reaches `agent_end` or the result envelope, so a refusal
    // whose actionable half lives only there leaves the operator with a quoted
    // selector and no next step.
    expect(result.summary).toContain('provider "no-such-provider" has no model "no-such-model"');
  });

  it("refuses a role whose assignment names a model this host does not have", async () => {
    const h = await harnessWithRoles({ smol: "no-such-provider/no-such-model" });
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "bare", modelRole: "smol" });

    expect(result.status).toBe("failed");
    const diagnostic = result.diagnostics.join("\n");
    // Both halves, because either alone leaves the operator guessing which to edit.
    expect(diagnostic).toContain('"smol"');
    expect(diagnostic).toContain('"no-such-provider/no-such-model"');
    expect(probe.captured).toHaveLength(0);
  });

  it("refuses a MALFORMED role assignment instead of reading it as unassigned", async () => {
    // Round-2 finding 1. `parseModelSelector` drops any value without a "/", so a
    // typo'd assignment used to arrive at the bridge indistinguishable from a role
    // nobody assigned — and OD5 degrades an unassigned role. The operator therefore
    // got the parent's model under the name `smol`, plus a note claiming the role was
    // "not assigned in any model-roles layer" that their own config file contradicts.
    // A typo is OD5's fail-closed case.
    const h = await harnessWithRoles({ smol: "deepseek-v4-flash" });
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "bare", modelRole: "smol" });

    expect(result.status).toBe("failed");
    const diagnostic = result.diagnostics.join("\n");
    expect(diagnostic).toContain('"smol"');
    // The value as written and the layer that carried it — the two facts needed to fix it.
    expect(diagnostic).toContain('"deepseek-v4-flash"');
    expect(diagnostic).toContain("settings");
    // And it must NOT be described as unassigned, which is the false statement.
    expect(diagnostic).not.toContain("is not assigned in any model-roles layer");
    expect(probe.captured).toHaveLength(0);
  });

  it("refuses a malformed assignment behind an agent's frontmatter tier too", async () => {
    // The frontmatter path is the softer one by D3b, but D3b softens an UNASSIGNED
    // role so a stock install works — not a broken roles file, which only this
    // machine's own config can produce.
    const h = await harnessWithRoles({ smol: "deepseek-v4-flash" });
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    // `roled` declares `model: smol` in its frontmatter and the call declares nothing.
    const result = await runner({ prompt: "work", agent: "roled" });

    expect(result.status).toBe("failed");
    expect(result.diagnostics.join("\n")).toContain('"deepseek-v4-flash"');
    expect(probe.captured).toHaveLength(0);
  });

  it("refuses the pre-tier pi/<role> namespace and says how to migrate it", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe();
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "stale" });

    expect(result.status).toBe("failed");
    expect(result.diagnostics.join("\n")).toContain("`model: smol`");
    expect(probe.captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// W2 — an unassigned ROLE degrades to the session model and says so out loud
// ---------------------------------------------------------------------------

describe("an unassigned role degrades and records the degradation", () => {
  it("runs the child on the session model and names the role and the layers", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "roled" });

    expect(result.status).toBe("completed");
    // The child DID run — a package whose every default agent fails closed on a
    // stock install is not a shipped feature (OD5).
    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]?.model).toEqual(STRONG);
    expect(result.modelRoleFallback).toContain('"smol"');
    expect(result.modelRoleFallback).toContain("model-roles");
    expect(result.modelRoleFallback).toContain("session");
    expect(result.modelRoleFallback).toContain("inherited the parent session model");
    expect(result.diagnostics[0]).toBe(result.modelRoleFallback);
  });

  it("carries the degradation into the run-result artifact, not just the result object", async () => {
    // W7's actual claim is about `locus.agent.run-result.v1`. The result object had
    // it all along; the ARTIFACT did not, because `createAgentRunRequest` is an
    // allowlist that dropped the field on the way in. The existing artifact test
    // could not catch that: it built its request literal by hand.
    const h = await harnessWithRoles();
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "roled" });

    expect(result.status).toBe("completed");
    const bodies = runResultArtifacts(h.ctx.session!.projectRoot!);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.modelRoleFallback).toContain('"smol"');
  });

  it("records no degradation when a session was built but the child never ran", async () => {
    // Round-2 finding 2, bridge half. The degradation note is PAST TENSE ("the child
    // inherited the parent session model"). It used to be gated on a child session
    // merely EXISTING, and a session created then cancelled before kickoff has an id
    // — so a call that spent no tokens still told `agent_end` and the result envelope
    // that a child had inherited and run. Nothing ran, so nothing may say it did.
    const h = await harnessWithRoles();
    const controller = new AbortController();
    const captured: SdkCreateSessionOptionsLike[] = [];
    const reportsDir = mkdtempSync(path.join(tmpdir(), "locus-model-tiers-reports-"));
    const createExecutor = (o: { model?: unknown }): AgentExecutor =>
      createAgentSdkSessionExecutor({
        ...(o.model !== undefined ? { model: o.model } : {}),
        createSession: async (options) => {
          captured.push(options);
          // Abort while the session is being built: real session, no child turn.
          controller.abort();
          return { session: fakeSession(STRONG) };
        },
        reportsDir,
        now: () => "fixed",
      });
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: controller.signal,
      createExecutor,
    });

    // `roled` declares `model: smol`, nothing assigns `smol` — the degrade path.
    const result = await runner({ prompt: "work", agent: "roled" });

    // The session was genuinely built, which is what makes this the tricky case.
    expect(captured).toHaveLength(1);
    expect(result.status).not.toBe("completed");
    expect(result.modelRoleFallback).toBeUndefined();
    expect(result.diagnostics.join("\n")).not.toContain("inherited the parent session model");
  });

  it("records no degradation when the per-call timeout fires before the child is prompted", async () => {
    // The same rule on the OTHER exit. The bridge returns early when its per-call
    // fuse fires (`timedOut`), and that return built its own result object — so the
    // gate that keeps the past-tense note off a call that never ran had to hold
    // there too, not only on the settled path. A timeout during session setup is
    // exactly the shape that reaches it.
    const h = await harnessWithRoles();
    const captured: SdkCreateSessionOptionsLike[] = [];
    const reportsDir = mkdtempSync(path.join(tmpdir(), "locus-model-tiers-reports-"));
    const createExecutor = (o: { model?: unknown }): AgentExecutor =>
      createAgentSdkSessionExecutor({
        ...(o.model !== undefined ? { model: o.model } : {}),
        createSession: async (options) => {
          captured.push(options);
          // Ordered, not raced: the fuse timer is armed before this executor is
          // ever entered, so its 1 ms expiry always precedes this 50 ms one.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { session: fakeSession(STRONG) };
        },
        reportsDir,
        now: () => "fixed",
      });
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor,
    });

    // `roled` declares `model: smol`, nothing assigns `smol` — the degrade path.
    const result = await runner({ prompt: "work", agent: "roled", timeoutMs: 1 });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("timeout");
    expect(result.executedModel).toBeUndefined();
    expect(result.modelRoleFallback).toBeUndefined();
    expect(result.diagnostics.join("\n")).not.toContain("inherited the parent session model");
  });

  it("does not let a declared frontmatter role fall through to another assigned tier", async () => {
    // The regression this closes: `resolveAgentModelPreference` used to answer a
    // bare frontmatter role through `resolveModelRoleForPurpose`'s
    // `preferred → agent → task → default` walk. So `roled` (frontmatter
    // `model: smol`) with `smol` UNASSIGNED but `task` assigned would run the
    // `task` tier — a different model under the requested tier's name, which is the
    // silent substitution D3a exists to stop and which no evidence surface would
    // have explained.
    const h = await harnessWithRoles({ task: "test/fast", agent: "test/fast", default: "test/fast" });
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "roled" });

    expect(result.status).toBe("completed");
    // The session model, NOT `test/fast` — the assigned fallback roles are visible
    // to the chain and must not be reachable from a declared role.
    expect(probe.captured).toHaveLength(1);
    expect(probe.captured[0]?.model).toEqual(STRONG);
    expect(result.modelRoleFallback).toContain('"smol"');
  });

  it("refuses a slash-bearing modelRole instead of degrading to the session model", async () => {
    // OD1's grammar: a "/" means a concrete provider/id. `modelRole` only ever names
    // a role (D4), so a slash-bearing value is a category error, not an unassigned
    // role — and degrading it would silently run something other than the model the
    // author spelled out, which is the fail-closed case OD5 keeps loud.
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "bare", modelRole: "test/fast" });

    expect(result.status).toBe("failed");
    expect(result.failureCause).toBe("unclassified");
    expect(result.summary).toContain("test/fast");
    expect(result.summary).toContain("modelRole");
    // The actionable half: which option to use instead.
    expect(result.summary).toContain("model:");
    // Zero child sessions — the refusal lands before anything is spawned.
    expect(probe.captured).toHaveLength(0);
  });

  it("says nothing about tiers when the agent declared none", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "work", agent: "bare" });

    expect(result.status).toBe("completed");
    expect(result.modelRoleFallback).toBeUndefined();
    expect(probe.captured[0]?.model).toEqual(STRONG);
  });
});

// ---------------------------------------------------------------------------
// W5 / W6 / W12 — the executed model is READ BACK, and the journal says which
// value is which
// ---------------------------------------------------------------------------

describe("executed-model evidence", () => {
  it("records the host readback on agent_end and the request on agent_start", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "tier-journal", agentRunner: runner });

    await expect(dsl.agent("cheap work", { agent: "bare", modelRole: "smol" })).resolves.toBe("tier answer");

    const journal: readonly WorkflowJournalLine[] = getJournal();
    const start = journal.find((line) => line.kind === "agent_start");
    const end = journal.find((line) => line.kind === "agent_end");
    // agent_start is emitted before the bridge resolves anything, so it can only
    // carry intent — and it says so by name.
    expect(start?.modelRole).toBe("smol");
    expect(start?.executedModel).toBeUndefined();
    expect(end?.executedModel).toBe("test/fast");
  });

  it("round-trips requested, role, executed, and fallback model evidence through the persisted reader", async () => {
    const root = tieredProject();
    const h = createHarness(root, { sessionId: "tier-persisted-journal" });
    h.ctx.model = STRONG;
    await h.ctx.settings?.set("modelRoles", {});
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const runId = "tier-persisted-journal";
    const { dsl } = createWorkflowRuntime({
      runId,
      agentRunner: runner,
      journal: createWorkflowJournalSink(root, runId),
    });

    await expect(dsl.agent("work", { agent: "bare", modelRole: "smol" })).resolves.toBe("tier answer");
    await expect(dsl.agent("pinned work", { agent: "bare", model: "test/strong" })).resolves.toBe("tier answer");

    const persisted = readWorkflowRunJournalState(root, runId);
    expect(persisted.diagnostics).toEqual([]);
    const starts = persisted.lines.filter((line) => line.kind === "agent_start");
    const end = persisted.lines.find((line) => line.kind === "agent_end");
    expect(starts[0]?.modelRole).toBe("smol");
    expect(starts[1]?.requestedModel).toBe("test/strong");
    expect(end?.executedModel).toBe("test/strong");
    expect(end?.modelRoleFallback).toContain('"smol"');
  });

  it("carries the requested selector under a name that says requested", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "tier-requested", agentRunner: runner });

    await dsl.agent("work", { agent: "bare", model: "test/strong" });

    const start = getJournal().find((line) => line.kind === "agent_start");
    expect(start?.requestedModel).toBe("test/strong");
    expect(start?.executedModel).toBeUndefined();
  });

  it("records `unavailable` when the peer exposes no model, never the request", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(); // structural mock: no `model` on the session
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "tier-unavailable", agentRunner: runner });

    await dsl.agent("cheap work", { agent: "bare", modelRole: "smol" });

    const end = getJournal().find((line) => line.kind === "agent_end");
    expect(end?.executedModel).toBe("unavailable");
    expect(end?.executedModel).not.toBe("test/fast");
  });

  it("records the degradation on agent_end so a reader sees the quiet fallback", async () => {
    const h = await harnessWithRoles();
    const probe = sdkProbe(STRONG);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "tier-fallback", agentRunner: runner });

    await dsl.agent("work", { agent: "bare", modelRole: "smol" });

    const end = getJournal().find((line) => line.kind === "agent_end");
    expect(end?.modelRoleFallback).toContain('"smol"');
    expect(end?.executedModel).toBe("test/strong");
  });

  /**
   * The mirror of every rule above.
   *
   * Those cases stop a REQUEST being published as a result. These two stop a real
   * RESULT being thrown away: a script `validate` callback or the artifact writer can
   * fail after the child has already answered, and the runtime ends such a call with an
   * `error` line rather than an `agent_end`. If that line carries no `executedModel`,
   * every read side keyed on it — the live row here, the reader's report — concludes no
   * child ran, and the one call that provably DID execute is the one whose evidence
   * disappears. Both assert the journal line AND the row the operator actually watches,
   * because the defect needed both halves to be visible.
   */
  it("keeps the readback on the error line when a script validator throws after the child ran", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST, '{"count":3}');
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({ runId: "tier-validator-threw", agentRunner: runner });

    await expect(
      (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("cheap work", {
        agent: "bare",
        modelRole: "smol",
        schema: COUNT_SCHEMA,
        validate: () => {
          throw new Error("validator exploded after the child had already answered");
        },
      }),
    ).rejects.toThrow(/validator exploded/);

    const journal: readonly WorkflowJournalLine[] = getJournal();
    const failure = journal.find((line) => line.kind === "error");
    expect(probe.captured).toHaveLength(1); // the child really ran
    expect(failure?.source).toBe("script");
    expect(failure?.executedModel).toBe("test/fast");

    for (const line of journal) applyWorkflowJournalLineToAgentLiveStore(line);
    const start = journal.find((line) => line.kind === "agent_start")!;
    const row = agentLiveStore.rows.get(workflowAgentLiveRowId(start));
    expect(row?.status).toBe("error");
    expect(row?.model).toBe("test/fast");
  });

  it("round-trips usage on the sole error line when a validator throws after execution", async () => {
    const root = tieredProject();
    const runId = "tier-validator-usage";
    const { dsl } = createWorkflowRuntime({
      runId,
      journal: createWorkflowJournalSink(root, runId),
      agentRunner: async (request): Promise<WorkflowAgentResult> => ({
        ok: true,
        status: "completed",
        summary: "done",
        text: '{"count":3}',
        diagnostics: [],
        agent: request.agent,
        executedModel: "test/fast",
        usage: { input: 20, output: 10, totalTokens: 30, costTotal: 0 },
      }),
    });

    await expect(
      (dsl.agent as (prompt: string, opts: unknown) => Promise<unknown>)("cheap work", {
        schema: COUNT_SCHEMA,
        validate: () => {
          throw new Error("validator exploded after measured execution");
        },
      }),
    ).rejects.toThrow(/measured execution/u);

    const persisted = readWorkflowRunJournalState(root, runId);
    expect(persisted.diagnostics).toEqual([]);
    const failure = persisted.lines.find((line) => line.kind === "error");
    expect(failure?.executedModel).toBe("test/fast");
    expect(failure?.usage).toEqual({ input: 20, output: 10, totalTokens: 30, costTotal: 0 });
    expect(readWorkflowRunSummary(root, runId).usage).toEqual({
      input: 20,
      output: 10,
      totalTokens: 30,
      costTotal: 0,
    });
  });

  it("keeps the readback on the error line when the artifact writer fails after the child ran", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "tier-artifact-threw",
      agentRunner: runner,
      artifactPorts: {
        recordAgentEvidence: () => {
          throw new Error("artifact store is unwritable");
        },
        publishText: () => {
          throw new Error("unused");
        },
        consumeText: () => {
          throw new Error("unused");
        },
      },
    });

    await expect(dsl.agent("cheap work", { agent: "bare", modelRole: "smol" })).rejects.toThrow(/unwritable/);

    const failure = getJournal().find((line) => line.kind === "error");
    expect(probe.captured).toHaveLength(1);
    expect(failure?.source).toBe("runtime");
    expect(failure?.executedModel).toBe("test/fast");
  });

  /**
   * The third shape, and the quiet one: a REPLAYED call completes.
   *
   * `agent_start` publishes the requested selector by design, and a resumed run serves
   * the recorded answer without creating a child — so `agent_end` has no readback to
   * replace it with. The status is `completed`, which is the one an operator never
   * re-reads, so the request would stand as the model that ran on a call that spent
   * nothing. Driven through the real runtime rather than by feeding the reducer a
   * hand-written line, so it also proves what a replay actually emits: no child was
   * created, and no `executedModel` was invented for one.
   */
  it("leaves no model on a replayed completion, where no child ran at all", async () => {
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(FAST);
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });
    const { dsl, getJournal } = createWorkflowRuntime({
      runId: "tier-replayed",
      agentRunner: runner,
      replay: {
        beginAgentAttempt: () => ({ replayed: true as const, text: "recorded answer" }),
        recordAgentAttempt: () => {},
        resolveValue: (_kind, produce) => produce(),
        counts: () => ({ replayedCalls: 1, freshCalls: 0 }),
      },
    });

    // A CONCRETE selector, so `agent_start` really seeds the row with a model and this
    // case can fail. A bare tier would leave the row blank from the start and the
    // assertion below would pass without the rule under test existing at all.
    await expect(dsl.agent("cheap work", { agent: "bare", model: "test/fast:high" })).resolves.toBe("recorded answer");

    const journal: readonly WorkflowJournalLine[] = getJournal();
    expect(probe.captured).toHaveLength(0); // nothing was created to run it
    const end = journal.find((line) => line.kind === "agent_end");
    expect(end?.status).toBe("completed");
    expect(end?.replayed).toBe(true);
    expect(end?.executedModel).toBeUndefined();

    const start = journal.find((line) => line.kind === "agent_start")!;
    const id = workflowAgentLiveRowId(start);
    applyWorkflowJournalLineToAgentLiveStore(start);
    expect(agentLiveStore.rows.get(id)?.model).toBe("test/fast"); // the request is on the row
    expect(agentLiveStore.rows.get(id)?.thinking).toBe("high");

    for (const line of journal.filter((l) => l.kind !== "agent_start")) {
      applyWorkflowJournalLineToAgentLiveStore(line);
    }
    const row = agentLiveStore.rows.get(id);
    expect(row?.status).toBe("done");
    expect(row?.model).toBeUndefined();
    expect(row?.thinking).toBeUndefined();
  });

  it("fails the call when the readback contradicts the resolved request", async () => {
    // The whole point of a readback: a host that quietly ignored the selection is
    // the failure this evidence exists to catch. A pre-execution value echoed back
    // could never produce this test.
    const h = await harnessWithRoles({ smol: "test/fast" });
    const probe = sdkProbe(STRONG); // asked for test/fast, session says test/strong
    const runner = createWorkflowAgentRunner({
      pi: h.pi,
      ctx: h.ctx,
      signal: new AbortController().signal,
      createExecutor: probe.createExecutor,
    });

    const result = await runner({ prompt: "cheap work", agent: "bare", modelRole: "smol" });

    expect(result.status).toBe("failed");
    const diagnostic = result.diagnostics.join("\n");
    expect(diagnostic).toContain("test/strong");
    expect(diagnostic).toContain("test/fast");
    expect(diagnostic).toContain("did not honour the selected model");
    expect(result.text).toBeUndefined();
  });
});
