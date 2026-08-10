import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  WorkflowArtifactPorts,
  WorkflowArtifactRef,
} from "../../../extensions/workflows/runtime/workflow-artifacts.js";
import { createWorkflowResourceLoader } from "../../../extensions/workflows/runtime/workflow-resources.js";
import {
  createWorkflowRuntime,
  WorkflowAgentExecutionError,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
} from "../../../extensions/workflows/runtime/workflow-runtime.js";

/**
 * The tracked `requirements-grill` example. It is a straight line of three named
 * agents, so what is pinned here is the cast, the handoffs between them, and the
 * absence of the script-owned repository search this file used to carry.
 */
const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/requirements-grill.workflow.mjs");

interface PublishedArtifact {
  ref: WorkflowArtifactRef;
  text: string;
  stage?: string;
}

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

function completed(request: WorkflowAgentRequest, text: string): WorkflowAgentResult {
  return {
    ok: true,
    status: "completed",
    summary: text,
    text,
    diagnostics: [],
    agent: request.agent,
    ...(request.label === undefined ? {} : { label: request.label }),
  };
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function runtimeWith(runner: (request: WorkflowAgentRequest) => Promise<WorkflowAgentResult>) {
  const runId = "requirements-grill-test";
  const runDir = mkdtempSync(path.join(tmpdir(), "locus-requirements-grill-"));
  const published: PublishedArtifact[] = [];
  const artifactPorts: WorkflowArtifactPorts = {
    recordAgentEvidence(input) {
      if (input.text === undefined) return {};
      return { answer: { runId, artifactId: `answer-${input.name}`, name: input.name, sha256: digest(input.text) } };
    },
    publishText(name, text, stage) {
      const ref = { runId, artifactId: `published-${published.length + 1}`, name, sha256: digest(text) };
      published.push({ ref, text, ...(stage === undefined ? {} : { stage }) });
      return ref;
    },
    consumeText(ref) {
      throw new Error(`unexpected workflow-local artifact consume: ${ref.name}`);
    },
  };
  return {
    ...createWorkflowRuntime({
      runId,
      agentRunner: runner,
      resourceLoader: createWorkflowResourceLoader({ workflowSourcePath: workflowPath, runDir }),
      artifactPorts,
      projectRoot: process.cwd(),
    }),
    published,
  };
}

const CONTEXT = "# Request Context\n## What already exists here\n- `src/page.ts` — paginates.";
const CHALLENGE = "# Challenge\n## Unobservable goals\n- 'faster' names no measurement.";
const HANDOFF = "# Requirements Handoff\n## Goal\nPagination advances by one page.";

const OUTPUTS: Record<string, string> = {
  scout: CONTEXT,
  challenger: CHALLENGE,
  synthesizer: HANDOFF,
};

describe("workflow example: requirements-grill.workflow.mjs", () => {
  it("lets the agents search and keeps the script out of the repository", () => {
    const source = readFileSync(workflowPath, "utf8");

    // The script used to guess search terms from an English stop-word list and
    // run `rg` itself. Its own agents hold better search tools, that guess was
    // English-only, and it made ripgrep an install requirement of the package.
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("node:fs");
    expect(source).not.toMatch(/\bspawn\(/u);
    expect(source).not.toMatch(/"rg"/u);
    // No import at all: the file stays `self-contained-static` with nothing to bind.
    expect(source).not.toMatch(/^import /mu);

    // Runtime supplies the complete tool set; source does not maintain one.
    expect(source).not.toMatch(/\breadOnly:/u);
    expect(source).not.toMatch(/\btools:/u);
    expect(source).not.toMatch(/\bpermissionMode:/u);

    expect(source).toContain("const COMMON = ");
    expect(source).not.toContain("promptFile");
    // Three named prompt builders: no prompt here is long enough to earn a file.
    expect(source.match(/^\s*return `\$\{COMMON\}$/gmu)).toHaveLength(3);

    // Nothing loops and nothing branches here, so nothing needs a declared shape
    // and nothing may read a decision out of the model's Markdown.
    expect(source).not.toMatch(/\bschema:/u);
    expect(source).not.toContain("validate:");
    expect(source).not.toContain("JSON.parse");
  });

  it("takes every agent identity and every label from the one roster", async () => {
    const source = readFileSync(workflowPath, "utf8");
    expect(source).toContain("const GRILL_AGENTS = Object.freeze({");
    expect(source).not.toMatch(/\btools:/u);
    expect(source.match(/\.\.\.GRILL_AGENTS\.\w+\.options,/gu)).toHaveLength(3);
    expect(source.match(/^\s*label: /gmu)).toHaveLength(3);
    for (const id of ["scout", "challenger", "synthesizer"]) {
      expect(source, id).toContain(`label: GRILL_AGENTS.${id}.id`);
    }

    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, OUTPUTS[request.label!]!);
    });

    await (
      await loadWorkflow()
    )(dsl, "make pagination faster");

    expect(calls.map((call) => call.label)).toEqual(["scout", "challenger", "synthesizer"]);
    expect(calls.map((call) => call.phase)).toEqual(["scout-repository", "challenge-request", "synthesize-handoff"]);
    expect(calls.every((call) => call.tools?.join(",") === "*")).toBe(true);
    expect(calls.every((call) => call.readOnly === undefined)).toBe(true);
  });

  it("hands the request and every prior agent text on verbatim, and returns the handoff", async () => {
    const calls: WorkflowAgentRequest[] = [];
    const { dsl, published } = runtimeWith(async (request) => {
      calls.push(request);
      return completed(request, OUTPUTS[request.label!]!);
    });

    const request = "  make pagination faster  ";
    const result = await (await loadWorkflow())(dsl, request);

    // The run's terminal result is the synthesizer's exact text: no envelope, no
    // workflow-composed summary standing in for what the agent actually wrote.
    expect(result).toBe(HANDOFF);
    expect(published.map((artifact) => artifact.ref.name)).toEqual(["request.md"]);
    expect(published[0]?.text).toBe(request);

    for (const call of calls) expect(call.prompt).toContain(request.trim());
    expect(calls[0]?.prompt).not.toContain(CONTEXT);
    expect(calls[1]?.prompt).toContain(CONTEXT);
    expect(calls[2]?.prompt).toContain(CONTEXT);
    expect(calls[2]?.prompt).toContain(CHALLENGE);
  });

  it("refuses an empty request before spawning a child, and bounds nothing the host already bounds", async () => {
    const { dsl } = runtimeWith(async () => {
      throw new Error("no agent should run");
    });

    await expect((await loadWorkflow())(dsl, "   ")).rejects.toThrow(/requires a non-empty request/u);

    // The host caps workflow input on both entry surfaces, so a second, stricter
    // number here could only refuse a request the operator was allowed to send.
    const source = readFileSync(workflowPath, "utf8");
    expect(source).not.toMatch(/MAX_REQUEST_CHARS|input\.length|requestText\.length/u);
  });

  it("stops at the failing stage instead of handing an empty text to the next one", async () => {
    const calls: WorkflowAgentRequest[] = [];
    const { dsl } = runtimeWith(async (request) => {
      calls.push(request);
      return {
        ok: false,
        status: "failed",
        summary: "scout unavailable",
        diagnostics: ["test failure"],
        agent: request.agent,
      };
    });

    await expect((await loadWorkflow())(dsl, "inspect current behaviour")).rejects.toBeInstanceOf(
      WorkflowAgentExecutionError,
    );
    expect(calls).toHaveLength(1);
  });
});
