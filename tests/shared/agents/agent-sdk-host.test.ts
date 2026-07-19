import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_SDK_UNAVAILABLE_DIAGNOSTIC,
  AgentSdkUnavailableError,
  agentLiveStore,
  createAgentSdkSessionExecutor,
  type CreateAgentSessionFactory,
  type SdkAgentSessionEventLike,
  type SdkAgentSessionLike,
  type SdkCreateSessionOptionsLike,
} from "../../../extensions/_shared/agent-sdk-host.js";
import { elapsedSinceStart, formatDuration } from "../../../extensions/_shared/agent-live-panel.js";
import { buildAgentSystemPrompt } from "../../../extensions/_shared/agent-system-prompt.js";
import type { AgentRunRequest } from "../../../extensions/_shared/agent-runner.js";
import type { AgentDefinition } from "../../../extensions/_shared/types.js";

/**
 * INSURANCE, NOT PROOF.
 *
 * These tests inject a FAKE createAgentSession factory and only prove the wiring:
 * boundary contract -> SDK executor -> exact text result + graceful
 * degradation. They deliberately do NOT spawn a real child agent.
 * Real proof must come from a live `task`-tool run on a working host, captured via
 * the exported .locus/runtime/reports JSONL — that is out of scope here.
 */

const reviewer: AgentDefinition = {
  name: "reviewer",
  description: "Review code",
  allowedTools: ["read", "search", "yield"],
  tools: ["read", "search", "yield"],
  risk: "medium",
  readOnly: true,
  source: "project",
  filePath: "/repo/.agents/agents/reviewer.md",
};

function request(): AgentRunRequest {
  return {
    agent: reviewer,
    task: "Review this change",
    parentSessionId: "parent-session",
    projectRoot: "/repo",
    workingDirectory: "/repo",
    maxTurns: 5,
    depth: 0,
    maxDepth: 1,
    allowedTools: ["read", "search", "yield"],
    approvalTier: "allow",
  };
}

function requestWithSystemPrompt(): AgentRunRequest {
  return {
    ...request(),
    agent: {
      ...reviewer,
      systemPrompt: "Run this task autonomously and report succinctly.",
    },
  };
}

function inMemoryFileSystem(entries: Map<string, string>) {
  return {
    exists: (filePath: string) => entries.has(filePath),
    readFile: (filePath: string) => {
      const value = entries.get(filePath);
      if (value === undefined) throw new Error(`No file: ${filePath}`);
      return value;
    },
  };
}

interface FakeSessionConfig {
  toolCalls: number;
  toolResults: number;
  lastAssistantText: string | undefined;
  sessionId?: string;
  /**
   * When set, prompt() resolves but the terminal `agent_end` event is NEVER
   * emitted, so the only way out of the turn is the timeout (or an abort). Used
   * to prove the executor cannot hang waiting for a completion that never comes.
   */
  neverEnds?: boolean;
  /** When set, prompt() rejects with this message (simulates a transport failure). */
  promptError?: string;
  messages?: readonly unknown[];
  events?: SdkAgentSessionEventLike[];
}

interface FakeSession {
  session: SdkAgentSessionLike;
  disposeSpy: ReturnType<typeof vi.fn>;
  abortSpy: ReturnType<typeof vi.fn>;
}

function fakeSession(config: FakeSessionConfig): FakeSession {
  const exportDir = mkdtempSync(path.join(tmpdir(), "locus-sdk-host-export-"));
  const disposeSpy = vi.fn();
  const abortSpy = vi.fn(async () => {});
  let listener: ((event: SdkAgentSessionEventLike) => void) | undefined;
  const session: SdkAgentSessionLike = {
    sessionId: config.sessionId ?? "sdk-child",
    ...(config.messages !== undefined ? { messages: config.messages } : {}),
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      if (config.promptError !== undefined) throw new Error(config.promptError);
      for (const event of config.events ?? []) listener?.(event);
      // Drive the terminal event synchronously so `await ended` resolves, unless
      // the fake is configured to never complete its turn.
      if (config.neverEnds !== true) listener?.({ type: "agent_end", willRetry: false });
    },
    getSessionStats() {
      return {
        sessionId: config.sessionId ?? "sdk-child",
        toolCalls: config.toolCalls,
        toolResults: config.toolResults,
      };
    },
    getLastAssistantText() {
      return config.lastAssistantText;
    },
    exportToJsonl(outputPath) {
      const target = outputPath ?? path.join(exportDir, "session.jsonl");
      writeFileSync(target, "{}\n", "utf8");
      return target;
    },
    dispose: disposeSpy,
    abort: abortSpy,
  };
  return { session, disposeSpy, abortSpy };
}

function tmpReportsDir(): string {
  return mkdtempSync(path.join(tmpdir(), "locus-sdk-host-reports-"));
}

describe("agent SDK session executor (insurance, not proof)", () => {
  it("omits context extras when the opt-in flag is unset", () => {
    const prompt = buildAgentSystemPrompt(requestWithSystemPrompt(), {
      env: {
        LOCUS_AGENT_CONTEXT_EXTRAS: "0",
        LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
      },
      readFile: () => {
        throw new Error("memory reads must not run when extras are disabled");
      },
      exists: () => false,
    });

    expect(prompt).not.toContain("# Context extras");
    expect(prompt).not.toContain("## Memory");
    expect(prompt).not.toContain("## Skill: reviewer");
  });

  it("falls back to <projectRoot>/MEMORY.md when memory env is unset", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-memory-default-"));
    const memoryPath = path.join(root, "MEMORY.md");
    const filesystem = inMemoryFileSystem(new Map([[memoryPath, "DEFAULT_MEMORY\nline-2"]]));

    const prompt = buildAgentSystemPrompt(
      {
        ...requestWithSystemPrompt(),
        projectRoot: root,
        workingDirectory: root,
      },
      {
        env: {
          LOCUS_AGENT_CONTEXT_EXTRAS: "1",
        },
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      },
    );

    expect(prompt).toContain("## Memory");
    expect(prompt).toContain(`Requested: ${memoryPath}`);
    expect(prompt).toContain("DEFAULT_MEMORY");
  });

  it("preserves live parentRowId through session events, stats, and terminal status", async () => {
    agentLiveStore.reset();
    try {
      const session = fakeSession({ toolCalls: 1, toolResults: 1, lastAssistantText: "done" });
      const createSession: CreateAgentSessionFactory = async () => ({ session: session.session });
      const executor = createAgentSdkSessionExecutor({
        createSession,
        reportsDir: tmpReportsDir(),
        now: () => "fixed",
        live: {
          parentRowId: "workflow:run:reviewer:review-step:smoke",
          label: "SDK child session",
          model: "test/strong",
          thinking: "high",
          isolated: true,
          noMcp: true,
        },
      });

      await executor.run(request(), new AbortController().signal);
      const row = [...agentLiveStore.rows.values()].find(
        (candidate) => candidate.parentRowId === "workflow:run:reviewer:review-step:smoke",
      );

      expect(row).toBeDefined();
      expect(row).toMatchObject({
        parentRowId: "workflow:run:reviewer:review-step:smoke",
        label: "SDK child session",
        status: "done",
        activityState: "completed",
        model: "test/strong",
        thinking: "high",
        currentPath: "/repo",
        childSessionId: "sdk-child",
        finalAnswer: "done",
        isolated: true,
        noMcp: true,
      });
      expect(row?.stepCount).toBeGreaterThanOrEqual(2);
    } finally {
      agentLiveStore.reset();
    }
  });

  it("records source-backed live metadata without fabricating unsupported fields", () => {
    agentLiveStore.reset();
    try {
      const row = agentLiveStore.begin({
        id: "metadata-row",
        agentName: "reviewer",
        label: "Review",
        isolated: false,
        noMcp: false,
      });

      agentLiveStore.feedSessionEvent(row.id, { type: "turn_start", cwd: "/repo/worktree" }, 1000);
      agentLiveStore.feedSessionEvent(
        row.id,
        {
          type: "tool_call",
          toolName: "read",
          toolCall: { args: { file: "README.md", range: [1, 4] } },
        },
        1100,
      );

      const updated = agentLiveStore.rows.get(row.id);
      expect(updated).toMatchObject({
        status: "working",
        activityState: "active",
        currentPath: "/repo/worktree",
        currentTools: ["read"],
        turnCount: 1,
        lastActivityAt: 1100,
      });
      expect(updated?.currentToolArgs).toContain("README.md");
      expect(updated?.tokenCount).toBeUndefined();
      expect(updated?.model).toBeUndefined();
      expect(updated?.thinking).toBeUndefined();
    } finally {
      agentLiveStore.reset();
    }
  });

  it("adds token usage after each completed child turn without double-counting message_end", () => {
    agentLiveStore.reset();
    try {
      const row = agentLiveStore.begin({ id: "live-tokens", agentName: "reviewer", label: "Review" });
      const message = {
        role: "assistant",
        usage: { input: 120, output: 30, total: 150, cacheRead: 0, cacheWrite: 0 },
      };

      agentLiveStore.feedSessionEvent(row.id, { type: "message_end", message }, 1_000);
      expect(agentLiveStore.rows.get(row.id)?.tokenCount).toBeUndefined();

      agentLiveStore.feedSessionEvent(row.id, { type: "turn_end", message }, 1_100);
      agentLiveStore.feedSessionEvent(
        row.id,
        {
          type: "turn_end",
          message: { role: "assistant", usage: { input: 80, output: 20 } },
        },
        1_200,
      );

      expect(agentLiveStore.rows.get(row.id)?.tokenCount).toEqual({ input: 200, output: 50 });
    } finally {
      agentLiveStore.reset();
    }
  });

  it("stamps currentToolStartMs when a tool starts and clears it on tool end / change (T-196 W2)", () => {
    agentLiveStore.reset();
    try {
      const row = agentLiveStore.begin({
        id: "tool-clock",
        agentName: "reviewer",
        label: "Review",
        isolated: false,
        noMcp: false,
      });

      // Tool starts → anchor stamped at the event's `now`.
      const started = agentLiveStore.feedSessionEvent(
        row.id,
        { type: "tool_call", toolName: "bash", args: { command: "npm test -- sums.spec" } },
        10_000,
      );
      expect(started?.currentTools).toEqual(["bash"]);
      expect(started?.currentToolStartMs).toBe(10_000);

      // A *different* tool starts → anchor re-stamped (tool change resets the clock).
      const changed = agentLiveStore.feedSessionEvent(
        row.id,
        { type: "tool_call", toolName: "read", args: { path: "src/app.ts" } },
        12_000,
      );
      expect(changed?.currentToolStartMs).toBe(12_000);

      // Tool ends → anchor cleared.
      const ended = agentLiveStore.feedSessionEvent(row.id, { type: "tool_result", toolName: "read" }, 15_000);
      expect(ended?.currentToolStartMs).toBeUndefined();

      // agent_end also clears the anchor (defensive; tools already gone).
      agentLiveStore.feedSessionEvent(row.id, { type: "tool_call", toolName: "bash", args: { command: "ls" } }, 16_000);
      const finished = agentLiveStore.feedSessionEvent(row.id, { type: "agent_end" }, 17_000);
      expect(finished?.currentToolStartMs).toBeUndefined();
    } finally {
      agentLiveStore.reset();
    }
  });

  it("injects enabled memory extras with 200-line clipping", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-memory-"));
    const memoryLines = Array.from({ length: 205 }, (_, index) =>
      index === 0 ? "MEMORY_SENTINEL" : `line-${index + 1}`,
    );
    const memoryPath = path.join(root, "MEMORY.md");
    const filesystem = inMemoryFileSystem(new Map([[memoryPath, memoryLines.join("\n")]]));

    const prompt = buildAgentSystemPrompt(
      {
        ...requestWithSystemPrompt(),
        projectRoot: root,
        workingDirectory: root,
      },
      {
        env: {
          LOCUS_AGENT_CONTEXT_EXTRAS: "1",
        },
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      },
    );

    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("MEMORY_SENTINEL");
    expect(prompt).toContain("First 200 lines kept.");
    expect(prompt).not.toContain("line-201");
  });

  it("injects enabled skill extras from simple names with canonical source path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-skill-"));
    const skillPath = path.join(root, ".agents", "skills", "reviewer", "SKILL.md");
    const filesystem = inMemoryFileSystem(new Map([[skillPath, "SKILL_SENTINEL\n"]]));

    const prompt = buildAgentSystemPrompt(
      {
        ...requestWithSystemPrompt(),
        projectRoot: root,
        workingDirectory: root,
      },
      {
        env: {
          LOCUS_AGENT_CONTEXT_EXTRAS: "1",
          LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
        },
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      },
    );

    expect(prompt).toContain("## Skill: reviewer");
    expect(prompt).toContain(`Source: ${skillPath}`);
    expect(prompt).toContain("Requested: reviewer");
    expect(prompt).toContain("SKILL_SENTINEL");
  });

  it("resolves simple skill names via .pi/skills fallback when .agents/skills is absent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-skill-pi-"));
    const skillPath = path.join(root, ".pi", "skills", "reviewer", "SKILL.md");
    const memoryPath = path.join(root, "MEMORY.md");
    const filesystem = inMemoryFileSystem(
      new Map([
        [memoryPath, "DEFAULT_MEMORY\n"],
        [skillPath, "PI_SKILL_SENTINEL\n"],
      ]),
    );

    const prompt = buildAgentSystemPrompt(
      {
        ...requestWithSystemPrompt(),
        projectRoot: root,
        workingDirectory: root,
      },
      {
        env: {
          LOCUS_AGENT_CONTEXT_EXTRAS: "1",
          LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
        },
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      },
    );

    expect(prompt).toContain(`Source: ${skillPath}`);
    expect(prompt).toContain("PI_SKILL_SENTINEL");
  });

  it("returns diagnostics instead of throwing when requested memory/skill assets are missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-missing-"));
    const missingSkillPath = path.join(root, ".agents", "skills", "missing", "SKILL.md");
    const missingMemoryPath = path.join(root, "missing-memory.md");

    const prompt = buildAgentSystemPrompt(
      {
        ...requestWithSystemPrompt(),
        projectRoot: root,
        workingDirectory: root,
      },
      {
        env: {
          LOCUS_AGENT_CONTEXT_EXTRAS: "1",
          LOCUS_AGENT_MEMORY_FILE: missingMemoryPath,
          LOCUS_AGENT_PRELOAD_SKILLS: "missing",
        },
        readFile() {
          throw new Error("must not read missing files");
        },
        exists: () => false,
      },
    );

    expect(prompt).toContain("- Missing memory file: ");
    expect(prompt).toContain(missingMemoryPath);
    expect(prompt).toContain(`- Requested: missing`);
    expect(prompt).toContain(missingSkillPath);
    expect(prompt).toContain("Skill source missing. Tried");
    expect(prompt).toContain("(skill content unavailable)");
  });

  it("produces byte-identical prompts for identical inputs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-stable-"));
    const memoryPath = path.join(root, "MEMORY.md");
    const skillPath = path.join(root, ".agents", "skills", "reviewer", "SKILL.md");
    const filesystem = inMemoryFileSystem(
      new Map([
        [memoryPath, "MEMORY_SENTINEL\nline-2"],
        [skillPath, "SKILL_SENTINEL\n"],
      ]),
    );

    const requestWithExtras = {
      ...requestWithSystemPrompt(),
      projectRoot: root,
      workingDirectory: root,
    };
    const env = {
      LOCUS_AGENT_CONTEXT_EXTRAS: "1",
      LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
    };
    const promptA =
      buildAgentSystemPrompt(requestWithExtras, {
        env,
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      }) ?? "";
    const promptB =
      buildAgentSystemPrompt(requestWithExtras, {
        env,
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      }) ?? "";

    expect(Buffer.byteLength(promptA, "utf8")).toBe(Buffer.byteLength(promptB, "utf8"));
    expect(promptA).toBe(promptB);
  });

  it("appends opt-in memory and skill extras to the SDK child system prompt", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-sdk-host-extras-"));
    const memoryPath = path.join(root, "MEMORY.md");
    const memoryLines = ["MEMORY_SENTINEL", ...Array.from({ length: 204 }, (_, index) => `memory-line-${index + 2}`)];
    writeFileSync(memoryPath, memoryLines.join("\n"), "utf8");
    const skillPath = path.join(root, ".agents", "skills", "reviewer", "SKILL.md");
    mkdirSync(path.dirname(skillPath), { recursive: true });
    const skillLines = ["SKILL_SENTINEL", ...Array.from({ length: 204 }, (_, index) => `skill-line-${index + 2}`)];
    writeFileSync(skillPath, skillLines.join("\n"), "utf8");
    const env = {
      LOCUS_AGENT_CONTEXT_EXTRAS: "1",
      LOCUS_AGENT_MEMORY_FILE: memoryPath,
      LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
    } as NodeJS.ProcessEnv;

    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "SDK extras result.",
    });
    let capturedOptions: SdkCreateSessionOptionsLike | undefined;
    const executor = createAgentSdkSessionExecutor({
      createSession: async (options) => {
        capturedOptions = options;
        return { session };
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      promptEnv: env,
    });

    const result = await executor.run(
      { ...requestWithSystemPrompt(), projectRoot: root, workingDirectory: root },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    const prompt = String(capturedOptions?.appendSystemPrompt ?? "");
    expect(prompt).toContain("# Context extras");
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("MEMORY_SENTINEL");
    expect(prompt).toContain("First 200 lines kept.");
    expect(prompt).toContain("## Skill: reviewer");
    expect(prompt).toContain(`Source: ${skillPath}`);
    expect(prompt).toContain("Requested: reviewer");
    expect(prompt).toContain("SKILL_SENTINEL");
    expect(prompt).not.toContain("memory-line-201");
    expect(prompt).not.toContain("skill-line-201");
  });

  it("appends extras when the agent has no systemPrompt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-context-extras-no-system-prompt-"));
    const memoryPath = path.join(root, "MEMORY.md");
    const skillPath = path.join(root, ".pi", "skills", "reviewer", "SKILL.md");
    const filesystem = inMemoryFileSystem(
      new Map([
        [memoryPath, "MEMORY_SENTINEL\n"],
        [skillPath, "PI_SKILL_SENTINEL\n"],
      ]),
    );

    const prompt = buildAgentSystemPrompt(
      {
        ...request(),
        projectRoot: root,
        workingDirectory: root,
      },
      {
        env: {
          LOCUS_AGENT_CONTEXT_EXTRAS: "1",
          LOCUS_AGENT_MEMORY_FILE: memoryPath,
          LOCUS_AGENT_PRELOAD_SKILLS: "reviewer",
        },
        readFile: filesystem.readFile,
        exists: filesystem.exists,
      },
    );

    expect(prompt).toBeDefined();
    const promptText = prompt ?? "";
    expect(promptText).toContain('<active_agent name="reviewer"/>');
    expect(promptText).toContain("You are a pi coding agent sub-agent.");
    expect(promptText).toContain("# Context extras");
    expect(promptText).toContain("## Memory");
    expect(promptText).toContain("MEMORY_SENTINEL");
    expect(promptText).toContain("## Skill: reviewer");
    expect(promptText).toContain(`Source: ${skillPath}`);
    expect(promptText).toContain("PI_SKILL_SENTINEL");
    expect(promptText).not.toContain("<agent_instructions>");
    expect(promptText.indexOf("# Context extras")).toBeGreaterThan(
      promptText.indexOf("You have been invoked to handle a specific task autonomously."),
    );
  });

  it("surfaces missing context-extra diagnostics without failing the SDK run", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-sdk-host-extras-missing-"));
    const missingMemoryPath = path.join(root, "missing-memory.md");
    const missingSkillPath = path.join(root, ".agents", "skills", "missing", "SKILL.md");
    const env = {
      LOCUS_AGENT_CONTEXT_EXTRAS: "1",
      LOCUS_AGENT_MEMORY_FILE: missingMemoryPath,
      LOCUS_AGENT_PRELOAD_SKILLS: "missing",
    } as NodeJS.ProcessEnv;

    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "SDK missing diagnostics result.",
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      promptEnv: env,
    });

    const result = await executor.run(
      { ...requestWithSystemPrompt(), projectRoot: root, workingDirectory: root },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Missing memory file"),
        expect.stringContaining(missingMemoryPath),
        expect.stringContaining("Requested: missing"),
        expect.stringContaining("Skill source missing. Tried"),
        expect.stringContaining(missingSkillPath),
        expect.stringContaining("(skill content unavailable)"),
      ]),
    );
  });

  it("updates AgentLiveStore rows from mocked session events and stats", () => {
    agentLiveStore.reset();
    const row = agentLiveStore.begin({ id: "live-1", agentName: "reviewer", label: "reviewer" });

    agentLiveStore.feedSessionEvent(row.id, { type: "tool_call", toolName: "read" }, 1000);
    const rebegun = agentLiveStore.begin({ id: row.id, agentName: "critic", label: "reviewer" });
    expect(rebegun.agentName).toBe("reviewer");
    expect(rebegun.eventLines).toEqual(["event type=tool_call tool=read"]);

    agentLiveStore.patch(row.id, { status: "working" });
    expect(agentLiveStore.rows.get(row.id)?.eventLines).toEqual(["event type=tool_call tool=read"]);
    agentLiveStore.feedSessionEvent(row.id, { type: "tool_result", toolName: "read" }, 1100);
    agentLiveStore.feedSessionEvent(row.id, { type: "willRetry", message: "retrying transport" }, 1200);
    expect(() => agentLiveStore.feedSessionEvent(row.id, { unexpected: "shape" }, 1250)).not.toThrow();
    agentLiveStore.feedSessionEvent(row.id, { type: "agent_end", willRetry: false }, 1300);
    agentLiveStore.applySessionStats(row.id, { sessionId: "sdk-child", toolCalls: 3, toolResults: 2 });

    expect(agentLiveStore.rows.get(row.id)).toMatchObject({
      id: "live-1",
      agentName: "reviewer",
      label: "reviewer",
      status: "done",
      currentTools: [],
      stepCount: 5,
      errors: ["retrying transport"],
      eventLines: [
        "event type=tool_call tool=read",
        "event type=tool_result tool=read",
        "event type=willRetry message=retrying transport",
        "event type=unknown",
        "event type=agent_end",
        "stats sessionId=sdk-child toolCalls=3 toolResults=2",
      ],
    });
  });

  it("trims AgentLiveStore event lines to the last 200 entries", () => {
    agentLiveStore.reset();
    const row = agentLiveStore.begin({ id: "live-trim", agentName: "reviewer", label: "reviewer" });

    for (let index = 0; index < 205; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, { type: `event_${index}` });
    }

    const eventLines = agentLiveStore.rows.get(row.id)?.eventLines;
    expect(eventLines).toHaveLength(200);
    expect(eventLines?.[0]).toBe("event type=event_5");
    expect(eventLines?.[199]).toBe("event type=event_204");
  });

  it("projects streaming and completed Pi messages into one readable chronological transcript", () => {
    agentLiveStore.reset();
    const row = agentLiveStore.begin({ id: "transcript-live", agentName: "reviewer", label: "reviewer" });
    const partial = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspecting" },
        { type: "text", text: "I will read" },
      ],
    };

    agentLiveStore.feedSessionEvent(row.id, { type: "message_update", message: partial });
    expect(agentLiveStore.rows.get(row.id)?.transcript?.blocks).toHaveLength(1);
    expect(agentLiveStore.rows.get(row.id)?.latestMessage).toBe("I will read");

    agentLiveStore.feedSessionEvent(row.id, { type: "message_end", message: partial });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "file body" }] },
      isError: false,
    });
    agentLiveStore.feedSessionEvent(row.id, {
      type: "agent_end",
      willRetry: false,
      messages: [
        {
          role: "assistant",
          content: [
            ...partial.content,
            { type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "file body" }],
          isError: false,
        },
        { role: "assistant", content: [{ type: "text", text: "Final answer" }], stopReason: "stop" },
      ],
    });

    expect(agentLiveStore.rows.get(row.id)?.transcript?.blocks.map((block) => block.id)).toEqual([
      "assistant:1",
      "tool:read-1",
      "assistant:2",
    ]);
    expect(agentLiveStore.rows.get(row.id)?.transcript?.blocks[1]).toMatchObject({
      kind: "tool",
      args: { path: "README.md" },
      result: { content: [{ type: "text", text: "file body" }] },
    });
    expect(agentLiveStore.rows.get(row.id)?.latestMessage).toBe("Final answer");
  });

  it("bounds transcript retention and reports how many earlier lines were omitted", () => {
    agentLiveStore.reset();
    const row = agentLiveStore.begin({ id: "transcript-trim", agentName: "reviewer", label: "reviewer" });
    for (let index = 0; index < 125; index += 1) {
      agentLiveStore.feedSessionEvent(row.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `line ${index}` }], stopReason: "stop" },
      });
    }

    const retained = agentLiveStore.rows.get(row.id);
    expect(retained?.transcript?.blocks).toHaveLength(120);
    expect(retained?.transcript?.blocks[0]?.id).toBe("assistant:6");
    expect(retained?.transcript?.omittedBlockCount).toBe(5);
    expect(retained?.latestMessage).toBe("line 124");
  });

  it("removes retired rows and their transcript/cancel state with one change event", () => {
    agentLiveStore.reset();
    const row = agentLiveStore.begin({ id: "retired-row", agentName: "reviewer", label: "retired" });
    const cancel = vi.fn();
    agentLiveStore.registerCancel(row.id, cancel);
    agentLiveStore.feedSessionEvent(row.id, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "old answer" }], stopReason: "stop" },
    });
    const changed = vi.fn();
    agentLiveStore.emitter.on("change", changed);
    try {
      expect(agentLiveStore.removeRows([row.id, "missing-row"])).toBe(1);
      expect(changed).toHaveBeenCalledOnce();
      expect(agentLiveStore.cancel(row.id)).toBe(false);

      const replacement = agentLiveStore.begin({ id: row.id, agentName: "reviewer", label: "replacement" });
      agentLiveStore.feedSessionEvent(replacement.id, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "new answer" }], stopReason: "stop" },
      });
      expect(agentLiveStore.rows.get(row.id)?.transcript?.blocks).toHaveLength(1);
      expect(agentLiveStore.rows.get(row.id)?.latestMessage).toBe("new answer");
    } finally {
      agentLiveStore.emitter.off("change", changed);
    }
  });

  it("runs a child session through the SDK host and returns exact text", async () => {
    const { session, disposeSpy } = fakeSession({
      toolCalls: 2,
      toolResults: 1,
      lastAssistantText: "  Reviewed via SDK\n",
    });
    const reportsDir = tmpReportsDir();
    const createSession: CreateAgentSessionFactory = async () => ({ session });
    const executor = createAgentSdkSessionExecutor({ createSession, reportsDir, now: () => "fixed" });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result).toMatchObject({
      status: "completed",
      reason: "  Reviewed via SDK\n",
      text: "  Reviewed via SDK\n",
      childSession: { id: "sdk-child" },
      childOutputStats: {
        assistantToolCallCount: 2,
        toolResultCount: 1,
        hasWorkloadProof: true,
      },
    });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(reportsDir, "agent-sdk-reviewer-fixed.jsonl"))).toBe(true);
  });

  it("accepts a non-empty text completion with no child workload proof", async () => {
    const { session, disposeSpy } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "Reviewed via SDK",
    });
    const createSession: CreateAgentSessionFactory = async () => ({ session });
    const executor = createAgentSdkSessionExecutor({ createSession, reportsDir: tmpReportsDir(), now: () => "fixed" });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.reason).toBe("Reviewed via SDK");
    expect(result.childOutputStats).toMatchObject({ hasWorkloadProof: false });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("treats JSON-looking SDK output as ordinary text", async () => {
    const { session, disposeSpy } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: '{"status":"failed","summary":"Reasoning-only final answer."}',
    });
    const createSession: CreateAgentSessionFactory = async () => ({ session });
    const executor = createAgentSdkSessionExecutor({ createSession, reportsDir: tmpReportsDir(), now: () => "fixed" });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.text).toBe('{"status":"failed","summary":"Reasoning-only final answer."}');
    expect(result).not.toHaveProperty("structuredResult");
    expect(result.childOutputStats).toMatchObject({ hasWorkloadProof: false });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces the provider error from assistant messages before the empty-result fallback", async () => {
    const providerError = "OAuth token refresh failed for provider";
    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: undefined,
      messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: providerError }],
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toBe(providerError);
    expect(result.reason).not.toBe("Agent result text is empty.");
    expect([...agentLiveStore.rows.values()].at(-1)).toMatchObject({
      status: "error",
      errors: [providerError],
      transcript: {
        blocks: [{ kind: "assistant", message: { stopReason: "error", errorMessage: providerError } }],
      },
    });
  });

  it("preserves the empty-result failure when no assistant/provider diagnostic exists", async () => {
    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: undefined,
      messages: [{ role: "assistant", content: [], stopReason: "stop" }],
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("Agent result text is empty.");
  });

  it("does not let a recovered earlier provider error override the terminal assistant success", async () => {
    const answer = "Recovered final answer.";
    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: answer,
      messages: [
        { role: "assistant", content: [], stopReason: "error", errorMessage: "temporary provider failure" },
        { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" },
      ],
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.reason).toBe(answer);
  });

  it("passes the selected agent persona as appended child system prompt instructions", async () => {
    const { session } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: "Persona-aware SDK answer.",
    });
    let capturedOptions: unknown;
    const createSession: CreateAgentSessionFactory = async (options) => {
      capturedOptions = options;
      return { session };
    };
    const executor = createAgentSdkSessionExecutor({ createSession, reportsDir: tmpReportsDir(), now: () => "fixed" });

    const result = await executor.run(
      {
        ...request(),
        agent: { ...reviewer, readOnly: false, systemPrompt: "Review for correctness first." },
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(capturedOptions).toMatchObject({
      cwd: "/repo",
      excludeTools: ["spawn_agent", "task"],
      appendSystemPrompt: expect.stringContaining("Review for correctness first."),
    });
    expect((capturedOptions as { appendSystemPrompt?: string }).appendSystemPrompt).toContain(
      '<active_agent name="reviewer"/>',
    );
    expect((capturedOptions as { appendSystemPrompt?: string }).appendSystemPrompt).toContain(
      "Do not call `spawn_agent` or `task` directly",
    );
    expect((capturedOptions as { appendSystemPrompt?: string }).appendSystemPrompt).toContain("`workflow`");
  });

  it("blocks direct nested agent tools even when the child profile allows every tool", async () => {
    const { session } = fakeSession({ toolCalls: 0, toolResults: 0, lastAssistantText: "Wildcard child answer." });
    let capturedOptions: SdkCreateSessionOptionsLike | undefined;
    const executor = createAgentSdkSessionExecutor({
      createSession: async (options) => {
        capturedOptions = options;
        return { session };
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(
      {
        ...requestWithSystemPrompt(),
        agent: { ...reviewer, readOnly: false, allowedTools: ["*"], tools: ["*"] },
        allowedTools: ["*"],
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(capturedOptions?.tools).toBeUndefined();
    expect(capturedOptions?.excludeTools).toEqual(["spawn_agent", "task"]);
    expect(capturedOptions?.excludeTools).not.toContain("workflow");
  });

  it("enforces read-only child capabilities and rejects Git mutations without a shell", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "locus-read-only-agent-"));
    execFileSync("git", ["init", "--quiet", root]);
    writeFileSync(path.join(root, "tracked.txt"), "candidate\n", "utf8");
    const { session } = fakeSession({ toolCalls: 0, toolResults: 0, lastAssistantText: "Read-only answer." });
    let capturedOptions: SdkCreateSessionOptionsLike | undefined;
    const executor = createAgentSdkSessionExecutor({
      createSession: async (options) => {
        capturedOptions = options;
        return { session };
      },
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(
      {
        ...request(),
        projectRoot: root,
        workingDirectory: root,
        allowedTools: ["read", "git_read", "grep", "find", "bash", "write", "edit", "workflow", "unknown"],
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(capturedOptions?.tools).toEqual(["read", "git_read", "grep", "find"]);
    expect(capturedOptions?.excludeTools).toEqual(
      expect.arrayContaining(["spawn_agent", "task", "workflow", "bash", "edit", "write", "unknown"]),
    );
    expect(capturedOptions?.tools).not.toEqual(expect.arrayContaining(["bash", "write", "edit", "workflow"]));

    const gitRead = capturedOptions?.customTools?.find((tool) => tool.name === "git_read");
    expect(gitRead).toBeDefined();
    const readResult = await gitRead!.execute(
      "read-status",
      { args: ["status", "--short"] },
      new AbortController().signal,
    );
    expect(readResult.isError).not.toBe(true);
    expect(readResult.content[0]?.text).toContain("tracked.txt");

    const mutationResult = await gitRead!.execute(
      "blocked-checkout",
      { args: ["checkout", "-b", "forbidden"] },
      new AbortController().signal,
    );
    expect(mutationResult).toMatchObject({ isError: true, details: { blocked: true } });
    expect(mutationResult.content[0]?.text).toContain("blocks mutating or unsupported subcommand: checkout");
    const externalProcessResult = await gitRead!.execute(
      "blocked-pager",
      { args: ["grep", "--open-files-in-pager", "candidate"] },
      new AbortController().signal,
    );
    expect(externalProcessResult).toMatchObject({ isError: true, details: { blocked: true } });
    expect(externalProcessResult.content[0]?.text).toContain("external-process options");
    expect(execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim()).not.toBe(
      "forbidden",
    );
  });

  it("returns a blocked result with the unavailable diagnostic when the host is too old", async () => {
    const createSession: CreateAgentSessionFactory = async () => {
      throw new AgentSdkUnavailableError("Installed Pi host does not export createAgentSession (host too old).");
    };
    const executor = createAgentSdkSessionExecutor({ createSession, reportsDir: tmpReportsDir(), now: () => "fixed" });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("blocked");
    expect(result.diagnostics).toContain(AGENT_SDK_UNAVAILABLE_DIAGNOSTIC);
    expect(result.reason).toContain("host too old");
  });

  it("fails honestly when child session creation throws a non-substrate error", async () => {
    const createSession: CreateAgentSessionFactory = async () => {
      throw new Error("boom");
    };
    const executor = createAgentSdkSessionExecutor({ createSession, reportsDir: tmpReportsDir(), now: () => "fixed" });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("boom");
    // The stale M11 replacement-session text must never appear on this path.
    expect(JSON.stringify(result)).not.toContain("replacement-session");
    // No child was ever created, so no child evidence is attached and the dispose
    // path (guarded by disposeQuietly) is never reached — the throw is the result.
    expect(result.childSession).toBeUndefined();
    expect(result.childOutputStats).toBeUndefined();
  });

  it("cancels before creating a child session when the signal is already aborted", async () => {
    const createSession = vi.fn<CreateAgentSessionFactory>();
    const executor = createAgentSdkSessionExecutor({
      createSession: createSession as unknown as CreateAgentSessionFactory,
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.run(request(), controller.signal);

    expect(result.status).toBe("cancelled");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("cancels without prompting when the signal aborts during session creation", async () => {
    // The abort lands while createSession() is in flight: the child must be
    // disposed and the run cancelled WITHOUT ever prompting a turn.
    const { session, disposeSpy } = fakeSession({ toolCalls: 9, toolResults: 9, lastAssistantText: undefined });
    const promptSpy = vi.spyOn(session, "prompt");
    const controller = new AbortController();
    const createSession: CreateAgentSessionFactory = async () => {
      controller.abort(); // signal flips between creation and prompting
      return { session };
    };
    const executor = createAgentSdkSessionExecutor({ createSession, reportsDir: tmpReportsDir(), now: () => "fixed" });

    const result = await executor.run(request(), controller.signal);

    expect(result.status).toBe("cancelled");
    expect(result.reason).toContain("before child session kickoff");
    expect(promptSpy).not.toHaveBeenCalled();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the child turn exceeds its timeout instead of hanging", async () => {
    // prompt() resolves but agent_end never fires: only the timeout can end the turn.
    const { session, disposeSpy, abortSpy } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: undefined,
      neverEnds: true,
    });
    const createSession: CreateAgentSessionFactory = async () => ({ session });
    const executor = createAgentSdkSessionExecutor({
      createSession,
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      turnTimeoutMs: 5, // times out fast; budget = 5ms * maxTurns
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("budget and was aborted");
    expect(abortSpy).toHaveBeenCalledTimes(1); // child was force-stopped
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the child starts a tool call beyond its configured budget", async () => {
    const { session, disposeSpy, abortSpy } = fakeSession({
      toolCalls: 4,
      toolResults: 3,
      lastAssistantText: undefined,
      neverEnds: true,
      events: [
        { type: "tool_execution_start", toolName: "bash" },
        { type: "tool_execution_start", toolName: "bash" },
        { type: "tool_execution_start", toolName: "bash" },
        { type: "tool_execution_start", toolName: "bash" },
      ],
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      turnTimeoutMs: 60_000,
      maxToolCalls: 3,
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("exceeded the 3 tool-call budget");
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight child turn when the signal fires mid-run", async () => {
    // The turn is in flight (prompt() entered, no agent_end yet) when the caller
    // aborts. The abort is fired from inside prompt() so it lands AFTER the
    // pre-kickoff guard and is handled by the abort branch of the turn race.
    const controller = new AbortController();
    const { session, disposeSpy, abortSpy } = fakeSession({
      toolCalls: 1,
      toolResults: 1,
      lastAssistantText: undefined,
      neverEnds: true,
    });
    vi.spyOn(session, "prompt").mockImplementation(async () => {
      controller.abort();
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
      turnTimeoutMs: 60_000, // long enough that the abort, not the timeout, wins
    });

    const result = await executor.run(request(), controller.signal);

    expect(result.status).toBe("cancelled");
    expect(result.reason).toBe("Agent run was cancelled.");
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("routes a selected live-row stop through the child AbortController", async () => {
    agentLiveStore.reset();
    let wallNow = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
    try {
      const { session, disposeSpy, abortSpy } = fakeSession({
        toolCalls: 1,
        toolResults: 1,
        lastAssistantText: undefined,
        neverEnds: true,
      });
      const executor = createAgentSdkSessionExecutor({
        createSession: async () => ({ session }),
        reportsDir: tmpReportsDir(),
        now: () => "fixed",
        turnTimeoutMs: 60_000,
        live: { rowId: "fleet-cancel-row", label: "cancel me" },
      });

      const running = executor.run(request(), new AbortController().signal);
      await vi.waitFor(() => {
        expect(agentLiveStore.rows.get("fleet-cancel-row")?.status).toBe("working");
      });
      agentLiveStore.patch("fleet-cancel-row", {
        startedAt: 1_000,
        currentTools: ["bash"],
        currentToolArgs: '{"command":"sleep 60"}',
        currentToolStartMs: 1_000,
      });

      wallNow = 10_000;
      expect(agentLiveStore.cancel("fleet-cancel-row")).toBe(true);
      const result = await running;

      expect(result.status).toBe("cancelled");
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      expect(agentLiveStore.rows.get("fleet-cancel-row")).toMatchObject({
        status: "cancelled",
        currentTools: [],
        finalAnswer: "Agent run was cancelled.",
        elapsedMs: 9_000,
      });
      const terminalRow = agentLiveStore.rows.get("fleet-cancel-row")!;
      expect("currentToolArgs" in terminalRow).toBe(false);
      expect("currentToolStartMs" in terminalRow).toBe(false);
      wallNow = 70_000;
      expect(formatDuration(terminalRow.elapsedMs ?? elapsedSinceStart(terminalRow))).toBe("9s");
      expect(agentLiveStore.cancel("fleet-cancel-row")).toBe(false);
    } finally {
      clock.mockRestore();
      agentLiveStore.reset();
    }
  });

  it("fails honestly when prompt() rejects (e.g. transport/credential failure)", async () => {
    // Mirrors the live-host reality: createAgentSession spawns, but prompt() rejects
    // with "No API key found ..." — that is a genuine run failure, never fake success.
    const { session, disposeSpy } = fakeSession({
      toolCalls: 0,
      toolResults: 0,
      lastAssistantText: undefined,
      promptError: "No API key found for deepseek.",
    });
    const executor = createAgentSdkSessionExecutor({
      createSession: async () => ({ session }),
      reportsDir: tmpReportsDir(),
      now: () => "fixed",
    });

    const result = await executor.run(request(), new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("No API key found");
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
