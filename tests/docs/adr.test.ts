import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "../..");

describe("ADR documentation", () => {
  it("ADR file exists", () => {
    expect(
      existsSync(path.join(repoRoot, "docs/adr/agent-execution-trust-model.md")),
    ).toBe(true);
  });

  it("docs/README.md links to the ADR", () => {
    const readme = readFileSync(path.join(repoRoot, "docs/README.md"), "utf8");

    expect(readme).toContain("agent-execution-trust-model.md");
  });

  it("ADR contains the four explicit Q&A answers", () => {
    const adr = readFileSync(
      path.join(repoRoot, "docs/adr/agent-execution-trust-model.md"),
      "utf8",
    );

    expect(adr).toMatch(/tool calls[\s\S]{0,160}No|No[\s\S]{0,160}tool calls/);
    expect(adr).toMatch(/parent[\s\S]{0,160}Yes|Yes[\s\S]{0,160}parent/);
    expect(adr).toContain("not supported");
    expect(adr).toContain("Pi original");
  });
});
