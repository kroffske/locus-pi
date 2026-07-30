import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  auditEvent,
  classifyToolCall,
  clearAuditEvents,
  getAuditEvents,
} from "../../../extensions/security-gate/permissions.js";
import { redactSecrets } from "../../../extensions/_shared/host/redaction.js";
import { truncateOutput } from "../../../extensions/_shared/host/safe-output.js";
import securityGate from "../../../extensions/security-gate/index.js";
import { createHarness, emit } from "../../test-harness.js";

async function createDisposableDeleteFixture(): Promise<{
  root: string;
  target: string;
  command: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "locus-pi-security-"));
  const target = path.join(root, "delete-me");
  const siblingCanary = path.join(root, "sibling-canary.txt");
  const targetCanary = path.join(target, "target-canary.txt");
  await mkdir(target);
  await writeFile(targetCanary, "target canary", { flag: "wx" });
  await writeFile(siblingCanary, "sibling canary", { flag: "wx" });

  assertDisposableTarget(root, target);
  return {
    root,
    target,
    command: buildScopedDeleteCommand(target),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function assertDisposableTarget(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!resolvedRoot.startsWith(tmpdir()) || !path.basename(resolvedRoot).startsWith("locus-pi-security-")) {
    throw new Error("security-gate fixture must live in the test temp directory");
  }
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("security-gate target must be strictly inside the disposable fixture");
  }
}

function buildScopedDeleteCommand(target: string): string {
  const removeProgram = ["r", "m"].join("");
  const scopedRecursiveFlag = `-${["r", "f"].join("")}`;
  return `${removeProgram} ${scopedRecursiveFlag} ${target}`;
}

async function expectCanary(pathname: string): Promise<void> {
  await expect(access(pathname)).resolves.toBeUndefined();
}

describe("security gate", () => {
  it("classifies AST preview lifecycle calls separately from generic mutation tools", async () => {
    clearAuditEvents();
    const h = createHarness();
    securityGate(h.pi);

    const previewResults = (
      await emit(h, "tool_call", {
        toolName: "ast_edit",
        toolArgs: { ops: [{ pat: "greet($A)", out: "hello($A)" }], paths: ["sample.ts"] },
      })
    ).filter((entry) => entry !== undefined);
    const discardResults = (
      await emit(h, "tool_call", {
        toolName: "resolve",
        toolArgs: { action: "discard", reason: "not needed", extra: { previewId: "preview-1" } },
      })
    ).filter((entry) => entry !== undefined);
    const applyResults = (
      await emit(h, "tool_call", {
        toolName: "resolve",
        toolArgs: { action: "apply", reason: "approved by resolve", extra: { previewId: "preview-1" } },
      })
    ).filter((entry) => entry !== undefined);
    const legacyApplyResults = (
      await emit(h, "tool_call", {
        toolName: "ast_apply",
        toolArgs: { action: "apply", previewId: "preview-1", reason: "legacy caller" },
      })
    ).filter((entry) => entry !== undefined);
    const genericEditResults = (
      await emit(h, "tool_call", { toolName: "edit", toolArgs: { path: "sample.ts" } })
    ).filter((entry) => entry !== undefined);
    const genericWriteResults = (
      await emit(h, "tool_call", { toolName: "write", toolArgs: { path: "sample.ts" } })
    ).filter((entry) => entry !== undefined);

    expect(previewResults).toEqual([]);
    expect(discardResults).toEqual([]);
    expect(applyResults).toEqual([]);
    expect(legacyApplyResults).toEqual([]);
    expect(genericEditResults).toEqual([]);
    expect(genericWriteResults).toEqual([]);
    expect(getAuditEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extensionId: "security-gate",
          decision: "allow",
          actionType: "preview",
          toolOrCommand: "ast_edit",
          target: "sample.ts",
        }),
        expect.objectContaining({
          extensionId: "security-gate",
          decision: "allow",
          actionType: "preview",
          toolOrCommand: "resolve",
          target: "preview-1",
        }),
        expect.objectContaining({
          extensionId: "security-gate",
          decision: "allow",
          actionType: "filesystem-write",
          toolOrCommand: "resolve",
          target: "preview-1",
        }),
        expect.objectContaining({
          extensionId: "security-gate",
          decision: "allow",
          actionType: "filesystem-write",
          toolOrCommand: "ast_apply",
          target: "preview-1",
        }),
        expect.objectContaining({
          extensionId: "security-gate",
          decision: "allow",
          userDecision: "delegated-to-pi",
          enforcement: "pi-original",
          actionType: "filesystem-write",
          toolOrCommand: "edit",
          target: "sample.ts",
        }),
        expect.objectContaining({
          extensionId: "security-gate",
          decision: "allow",
          userDecision: "delegated-to-pi",
          enforcement: "pi-original",
          actionType: "filesystem-write",
          toolOrCommand: "write",
          target: "sample.ts",
        }),
      ]),
    );
  });

  it("audits dangerous tool calls, allows Pi to decide, and renders /security-audit output", async () => {
    clearAuditEvents();
    const h = createHarness();
    securityGate(h.pi);
    const fixture = await createDisposableDeleteFixture();
    try {
      const safeResults = (await emit(h, "tool_call", { toolName: "read", toolArgs: { path: "README.md" } })).filter(
        (entry) => entry !== undefined,
      );
      expect(safeResults).toEqual([]);

      const classification = classifyToolCall("bash", { command: fixture.command });
      const dangerousResults = (
        await emit(h, "tool_call", { toolName: "bash", toolArgs: { command: fixture.command } })
      ).filter((entry) => entry !== undefined);
      expect(dangerousResults).toEqual([]);

      await h.commands.get("security-audit")!.handler("", h.ctx);
      const widget = h.widgets.get("security-audit") ?? "";

      expect(getAuditEvents()).toHaveLength(2);
      expect(getAuditEvents()[0]).toMatchObject({
        timestamp: expect.any(String),
        extensionId: "security-gate",
        actionType: "filesystem-read",
        toolOrCommand: "read",
        target: "README.md",
        decision: "allow",
      });
      expect(getAuditEvents()[1]).toMatchObject({
        timestamp: expect.any(String),
        extensionId: "security-gate",
        actionType: "subprocess",
        toolOrCommand: "bash",
        target: fixture.command,
        decision: "allow",
        userDecision: "delegated-to-pi",
        enforcement: "pi-original",
        args: JSON.stringify({ reason: classification.reason }),
      });
      expect(widget).toContain("[VIEW]");
      expect(widget).toContain("Security audit");
      expect(widget).toContain("[audit-only]");
      expect(widget).toContain("Showing 2 newest of 2 local observation(s).");
      expect(widget).toContain("Pi owns approval, prompt, and deny decisions");
      expect(widget).toContain("INFO | allow | filesystem-read | read | README.md");
      expect(widget).toContain("WARN | allow/delegated-to-pi | subprocess | bash");
      expect(widget).toContain("rm -rf");
      expect(widget).not.toContain("[ERROR]");
      expect(widget).not.toContain("decision=deny");
      expect(widget).not.toContain("Locus enforced");
      await expectCanary(path.join(fixture.target, "target-canary.txt"));
      await expectCanary(path.join(fixture.root, "sibling-canary.txt"));
    } finally {
      await fixture.cleanup();
    }
  });

  it("renders an explicit empty audit-only view", async () => {
    clearAuditEvents();
    const h = createHarness();
    securityGate(h.pi);

    await h.commands.get("security-audit")!.handler("", h.ctx);

    const widget = h.widgets.get("security-audit") ?? "";
    expect(widget).toContain("[VIEW]");
    expect(widget).toContain("No historical local security audit events.");
    expect(widget).toContain("Evidence boundary: in-memory process-local audit ring");
  });

  it("shows newest bounded observations, hidden count, and a redacted target", async () => {
    clearAuditEvents();
    const secret = `sk-${"a".repeat(40)}`;
    for (let index = 0; index < 6; index += 1) {
      auditEvent({
        timestamp: `2026-07-10T00:00:0${index}.000Z`,
        extensionId: "security-gate",
        actionType: "subprocess",
        toolOrCommand: "bash",
        target: index === 5 ? `run --token=${secret} ${"x".repeat(100)}` : `command-${index}`,
        decision: "allow",
        ...(index === 5 ? { userDecision: "delegated-to-pi", enforcement: "pi-original" } : {}),
      });
    }
    const h = createHarness();
    securityGate(h.pi);

    await h.commands.get("security-audit")!.handler("3", h.ctx);

    const widget = h.widgets.get("security-audit") ?? "";
    expect(widget).toContain("Showing 3 newest of 6 local observation(s).");
    expect(widget).toContain("+3 hidden");
    expect(widget.indexOf("00:00:05")).toBeLessThan(widget.indexOf("00:00:04"));
    expect(widget).toContain("WARN | allow/delegated-to-pi");
    expect(widget).toContain("[REDACTED:cli-secret]");
    expect(widget).not.toContain(secret);
    expect(widget.split(/\r?\n/u).every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("keeps audit-only ownership and recovery inside the RPC string-array budget", async () => {
    clearAuditEvents();
    for (let index = 0; index < 6; index += 1) {
      auditEvent({
        timestamp: `2026-07-10T00:00:0${index}.000Z`,
        extensionId: "security-gate",
        actionType: "subprocess",
        toolOrCommand: "bash",
        target: `command-${index}`,
        decision: "allow",
        ...(index === 5 ? { userDecision: "delegated-to-pi", enforcement: "pi-original" } : {}),
      });
    }
    const h = createHarness(process.cwd(), { mode: "rpc" });
    h.ctx.hasUI = true;
    securityGate(h.pi);

    await h.commands.get("security-audit")!.handler("6", h.ctx);

    expect(Array.isArray(h.widgetPayloads.get("security-audit"))).toBe(true);
    const widget = h.widgets.get("security-audit") ?? "";
    expect(widget).toContain("Mode: audit-only; Pi owns enforcement.");
    expect(widget).toContain("WARN | allow/delegated-to-pi");
    expect(widget).toContain("+3 hidden");
    expect(widget).toContain("Limit: /security-audit <1-50>");
    expect(widget).not.toContain("widget truncated");
    expect(widget.split(/\r?\n/u).length).toBeLessThanOrEqual(10);
  });
});

describe("redaction and truncation", () => {
  it("preserves legacy redaction and truncation coverage", () => {
    expect(redactSecrets("token=abcdefghijklmnopqrstuvwxyz1234567890SECRET").text).toContain("[REDACTED:api-key]");
    const truncated = truncateOutput("x".repeat(100), 20, 20);
    expect(truncated.truncated).toBe(true);
  });
});
