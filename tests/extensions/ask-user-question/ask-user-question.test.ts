import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import askUserQuestion from "../../../extensions/ask-user-question/index.js";
import { sessionJsonlPath } from "../../../extensions/_shared/files.js";
import { JsonlSessionStore } from "../../../extensions/_shared/session-core.js";
import { createHarness, runTool } from "../../test-harness.js";

describe("ask-user-question decision journal", () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    delete process.env.LOCUS_PI_SESSION_STORE;
  });

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
    delete process.env.LOCUS_PI_SESSION_STORE;
  });

  function tempRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "locus-pi-ask-"));
    tempRoots.push(root);
    return root;
  }

  it("records primary ask answers as decision entries", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push("\r");

    const result = await runTool(h, "ask", {
      questions: [{
        id: "deploy",
        question: "Deploy?",
        options: [{ label: "ship" }, { label: "hold" }],
      }],
    });

    expect(result.details?.decision).toMatchObject({
      backend: "memory",
      decisionId: "ask-deploy",
    });
    expect(h.customComponents).toHaveLength(1);
    expect(h.customOptions[0]).toMatchObject({ overlay: true });
    for (const width of [146, 80, 48]) {
      const frame = h.customComponents[0]!.render(width);
      expect(frame.join("\n")).toContain("[SELECT]");
      expect(frame.join("\n")).toContain("Ask");
      expect(frame.join("\n")).toContain("Deploy?");
      expect(frame.join("\n")).toContain("> ship");
      expect(frame.every((line) => Array.from(line).length <= width)).toBe(true);
    }
    expect(h.entries[0]).toMatchObject({
      type: "decision",
      data: {
        decisionId: "ask-deploy",
        question: "Deploy?",
        answer: { selectedOptions: ["ship"] },
        status: "answered",
        metadata: { source: "ask", multi: false },
      },
    });
  });

  it("records checkbox-style multi-select toggles and explicit finish through the custom UI", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push(" ", "\x1b[B", " ", "\x1b[B", "\x1b[B", "\r");

    const result = await runTool(h, "ask", {
      questions: [{
        id: "multi",
        question: "Pick many",
        options: [{ label: "one" }, { label: "two" }, { label: "three" }],
        multi: true,
      }],
    });

    expect(result.content[0]).toMatchObject({ type: "text", text: "User selected: one, two" });
    expect(result.details?.selectedOptions).toEqual(["one", "two"]);
    expect(h.customRenderFrames.some((frame) => frame.join("\n").includes("[x] one"))).toBe(true);
    expect(h.customRenderFrames.some((frame) => frame.join("\n").includes("[x] two"))).toBe(true);
    expect(h.customRenderFrames.some((frame) => frame.join("\n").includes("Done selecting"))).toBe(true);
  });

  it("supports previous and next navigation across multi-question prompts", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push("\x1b[C", "\x1b[D", "\r", "\x1b[B", "\r");

    const result = await runTool(h, "ask", {
      questions: [
        { id: "first", question: "First?", options: [{ label: "one" }, { label: "two" }] },
        { id: "second", question: "Second?", options: [{ label: "red" }, { label: "blue" }] },
      ],
    });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "User answers:\nfirst: one\nsecond: blue",
    });
    expect(result.details?.results).toMatchObject([
      { id: "first", selectedOptions: ["one"] },
      { id: "second", selectedOptions: ["blue"] },
    ]);
    expect(h.customComponents.length).toBe(4);
  });

  it("persists ask decisions through the JSONL session store", async () => {
    process.env.LOCUS_PI_SESSION_STORE = "jsonl";
    const root = tempRoot();
    const h = createHarness(root, { sessionId: "ask-jsonl-session" });
    askUserQuestion(h.pi);
    h.customInputQueue.push("\r");

    await runTool(h, "ask", {
      questions: [{
        id: "confirm",
        question: "Proceed?",
        options: [{ label: "yes" }, { label: "no" }],
      }],
    });

    const store = new JsonlSessionStore({ filePath: sessionJsonlPath(root) });
    expect(store.latestEntry("ask-jsonl-session", "decision")).toMatchObject({
      type: "decision",
      payload: {
        decisionId: "ask-confirm",
        question: "Proceed?",
        answer: { selectedOptions: ["yes"] },
        status: "answered",
      },
    });
  });

  it("strips the recommended suffix from selected ask options", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push("\r");

    const result = await runTool(h, "ask", {
      questions: [{
        id: "deploy",
        question: "Deploy?",
        options: [{ label: "ship" }, { label: "hold" }],
        recommended: 0,
      }],
    });

    expect(result.isError).not.toBe(true);
    expect(result.details?.selectedOptions).toEqual(["ship"]);
    expect(h.entries[0]).toMatchObject({
      type: "decision",
      data: {
        decisionId: "ask-deploy",
        answer: { selectedOptions: ["ship"] },
        status: "answered",
      },
    });
  });

  it("records custom ask input through the automatic Other option", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push("\x1b[B", "\x1b[B", "\r");
    const editor = vi.fn(async () => "Use the release checklist.");
    h.ctx.ui.editor = editor as never;

    const result = await runTool(h, "ask", {
      questions: [{
        id: "deploy-note",
        question: "Any extra deploy note?",
        options: [{ label: "No note" }, { label: "Hold release" }],
      }],
    });

    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({
      selectedOptions: [],
      customInput: "Use the release checklist.",
    });
    expect(editor).toHaveBeenCalledWith("[INPUT] Ask custom response", "");
    expect(h.entries[0]).toMatchObject({
      type: "decision",
      data: {
        decisionId: "ask-deploy-note",
        answer: { selectedOptions: [], customInput: "Use the release checklist." },
        status: "answered",
      },
    });
  });

  it("records cancellation as a durable ask decision", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push("\x1b");

    const result = await runTool(h, "ask", {
      questions: [{
        id: "deploy",
        question: "Deploy?",
        options: [{ label: "ship" }, { label: "hold" }],
      }],
    });

    expect(result.isError).toBe(true);
    expect(result.details?.decision).toMatchObject({
      backend: "memory",
      decisionId: "ask-deploy",
    });
    expect(h.entries[0]).toMatchObject({
      type: "decision",
      data: {
        decisionId: "ask-deploy",
        question: "Deploy?",
        status: "cancelled",
        metadata: { source: "ask" },
      },
    });
  });

  it("falls back to select prompts when custom UI is unavailable", async () => {
    const h = createHarness(process.cwd(), { mode: "rpc" });
    h.ctx.hasUI = true;
    const custom = vi.fn(async () => undefined);
    h.ctx.ui.custom = custom as NonNullable<typeof h.ctx.ui.custom>;
    askUserQuestion(h.pi);
    h.selectQueue.push("ship");

    const result = await runTool(h, "ask", {
      questions: [{
        id: "deploy",
        question: "Deploy?",
        options: [{ label: "ship" }, { label: "hold" }],
      }],
    });

    expect(result.isError).not.toBe(true);
    expect(result.details?.selectedOptions).toEqual(["ship"]);
    expect(h.selectCalls[0]?.title).toBe("[SELECT] Ask — Deploy?");
    expect(h.customComponents).toHaveLength(0);
    expect(custom).not.toHaveBeenCalled();
  });

  it("keeps fallback cancellation semantically equal to custom cancellation", async () => {
    const h = createHarness(process.cwd(), { mode: "rpc" });
    h.ctx.hasUI = true;
    askUserQuestion(h.pi);
    h.selectQueue.push("not-an-option");

    const result = await runTool(h, "ask", {
      questions: [{
        id: "deploy",
        question: "Deploy?",
        options: [{ label: "ship" }, { label: "hold" }],
      }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: "Ask tool was cancelled by the user" });
    expect(h.entries[0]).toMatchObject({
      type: "decision",
      data: { decisionId: "ask-deploy", status: "cancelled" },
    });
  });

  it("fails honestly without UI and does not record a fake user cancellation", async () => {
    const h = createHarness(process.cwd(), { mode: "print" });
    h.ctx.hasUI = false;
    askUserQuestion(h.pi);

    const result = await runTool(h, "ask", {
      questions: [{ id: "deploy", question: "Deploy?", options: [{ label: "ship" }] }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("host mode cannot prompt") });
    expect(result.details).toMatchObject({ status: "unavailable", reason: "no-ui" });
    expect(h.entries).toEqual([]);
    expect(h.selectCalls).toEqual([]);
    expect(h.customComponents).toEqual([]);
  });

  it("redraws an answered single question with the question text and a chosen-option marker", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push("\r");

    const result = await runTool(h, "ask", {
      questions: [{
        id: "deploy",
        question: "Ship now?",
        options: [{ label: "ship" }, { label: "wait" }],
      }],
    });

    const tool = h.tools.get("ask");
    expect(tool?.renderResult).toBeTypeOf("function");
    const rendered = tool!.renderResult!(result, h.ctx);
    const text = Array.isArray(rendered) ? rendered.join("\n") : rendered.render(80).join("\n");

    // Not just a one-line verb phrase: the question text and every option survive.
    expect(text).toContain("[RESULT] Ask");
    expect(text).toContain("Ship now?");
    expect(text).toContain("(o) ship");
    expect(text).toContain("( ) wait");
    expect(text).toContain("answered");
    // The chosen option carries the filled marker; the unchosen one does not.
    expect(text).not.toContain("( ) ship");
  });

  it("redraws each answered question in a multi-question prompt with its chosen marker", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push("\r", "\x1b[B", "\r");

    const result = await runTool(h, "ask", {
      questions: [
        { id: "first", question: "First?", options: [{ label: "one" }, { label: "two" }] },
        { id: "second", question: "Second?", options: [{ label: "red" }, { label: "blue" }] },
      ],
    });

    const rendered = h.tools.get("ask")!.renderResult!(result, h.ctx);
    const text = (Array.isArray(rendered) ? rendered : rendered.render(80)).join("\n");

    expect(text).toContain("First?");
    expect(text).toContain("(o) one");
    expect(text).toContain("( ) two");
    expect(text).toContain("Second?");
    expect(text).toContain("(o) blue");
    expect(text).toContain("( ) red");
  });

  it("marks a cancelled answer in the redrawn card", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);
    h.customInputQueue.push("\x1b");

    const result = await runTool(h, "ask", {
      questions: [{
        id: "deploy",
        question: "Ship now?",
        options: [{ label: "ship" }, { label: "wait" }],
      }],
    });

    const rendered = h.tools.get("ask")!.renderResult!(result, h.ctx);
    const text = (Array.isArray(rendered) ? rendered : rendered.render(80)).join("\n");
    // Cancelled OMP results carry no option set, so the card falls back to the
    // plain status string rather than fabricating an empty question.
    expect(text).toContain("[ERROR] Ask");
    expect(text).toContain("cancelled");
  });

  it("normalizes the official string result for legacy text input", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    const input = vi.fn(async () => "official answer");
    h.ctx.ui.input = input as never;
    askUserQuestion(h.pi);

    const result = await runTool(h, "askUserQuestion", {
      question: "Answer?",
      kind: "text",
      sensitivity: "public",
    });

    expect(result.isError).not.toBe(true);
    expect(result.details?.value).toBe("official answer");
    expect(input).toHaveBeenCalledWith("[INPUT] Ask — Answer?", "Type a response");
  });

  it("fails explicitly when a legacy text dialog returns an unsupported result", async () => {
    const h = createHarness();
    h.ctx.hasUI = true;
    h.ctx.ui.input = async () => ({ label: "not-a-dialog-result" }) as never;
    askUserQuestion(h.pi);

    const result = await runTool(h, "askUserQuestion", {
      question: "What should happen?",
      kind: "text",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Ask UI failed");
    expect(result.details).toMatchObject({ status: "error", source: "askUserQuestion" });
    expect(h.entries).toEqual([]);
  });

  it("records legacy askUserQuestion answers without exposing secret values", async () => {
    const h = createHarness();
    askUserQuestion(h.pi);

    const result = await runTool(h, "askUserQuestion", {
      question: "Secret?",
      kind: "text",
      default: "token-value",
      sensitivity: "secret",
    });

    expect(result.details?.visibleValue).toBe("[REDACTED:secret-answer]");
    expect(result.details?.value).toBeUndefined();
    expect(h.entries[0]).toMatchObject({
      type: "decision",
      data: {
        decisionId: "askuserquestion-q-b4826f0a",
        question: "Secret?",
        answer: "[REDACTED:secret-answer]",
        status: "answered",
        metadata: { source: "askUserQuestion", kind: "text", sensitivity: "secret" },
      },
    });
  });
});
