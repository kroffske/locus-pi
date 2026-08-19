import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const expectedDocs = ["architecture.md", "extensions.md", "getting-started.md", "workflows.md"];
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  pi: { extensions: string[] };
};
const extensionIds = packageJson.pi.extensions.map((entry) => /^\.\/extensions\/([^/]+)\/index\.ts$/.exec(entry)?.[1]);

describe("public documentation topology", () => {
  it("keeps docs small and free of internal history surfaces", () => {
    expect(
      readdirSync(path.join(root, "docs"), { withFileTypes: true })
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(expectedDocs);
    for (const relativePath of [
      "docs/adr",
      "docs/decisions",
      "docs/prd",
      "docs/source-audit",
      "docs/internal",
      "docs/archive",
      "docs/milestones.md",
    ]) {
      expect(existsSync(path.join(root, relativePath)), relativePath).toBe(false);
    }
  });

  it("co-locates one manual with every default extension", () => {
    const index = readFileSync(path.join(root, "docs/extensions.md"), "utf8");
    for (const id of extensionIds) {
      expect(id).toBeTruthy();
      const manifestPath = path.join(root, "extensions", id!, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        docsPath: string;
        sourceAuditPath: string | null;
      };
      expect(manifest.docsPath).toBe(`extensions/${id}/README.md`);
      expect(manifest.sourceAuditPath).toBeNull();
      expect(existsSync(path.join(root, manifest.docsPath)), manifest.docsPath).toBe(true);
      expect(index).toContain(`extensions/${id}/README.md`);
    }
  });

  it("links the public entry pages", () => {
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    for (const relativePath of [
      "docs/getting-started.md",
      "docs/extensions.md",
      "docs/workflows.md",
      "docs/architecture.md",
      "CONTRIBUTING.md",
      "SUPPORT.md",
      "SECURITY.md",
    ]) {
      expect(readme).toContain(relativePath);
      expect(existsSync(path.join(root, relativePath)), relativePath).toBe(true);
    }
  });
});
