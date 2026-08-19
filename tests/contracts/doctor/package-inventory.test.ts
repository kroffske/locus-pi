/**
 * The doctor inventory contract.
 *
 * `extensions/devext-doctor/package-inventory.mjs` replaced a hand-maintained table that had drifted
 * away from the package it described. These tests are what stops the drift returning: the reader is
 * checked against `package.json#pi.extensions` itself, so adding or removing an entrypoint without
 * touching the doctor still leaves both doctors correct, and removing an entrypoint while leaving a
 * transcribed copy behind has nowhere to hide.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  countBy,
  defaultPackageRoot,
  ENTRYPOINT_PATTERN,
  readPackageInventory,
} from "../../../extensions/devext-doctor/package-inventory.mjs";
import { EXTENSION_ENTRYPOINT_PATTERN } from "../../../scripts/extension-manifest-sources.js";

const repositoryRoot = process.cwd();
const declaredEntrypoints = (
  JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as { pi: { extensions: string[] } }
).pi.extensions;

const temporaryRoots: string[] = [];

/**
 * A package root holding only what the reader looks at: `package.json`, the declared entrypoint files
 * and their manifests. `mutate` breaks exactly one thing so a single fault can be asserted alone.
 */
function fixtureRoot(mutate: (root: string) => void = () => {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "doctor-inventory-"));
  temporaryRoots.push(root);
  const entrypoints = ["./extensions/alpha/index.ts", "./extensions/beta/index.ts"];
  for (const [index, entrypoint] of entrypoints.entries()) {
    const directory = entrypoint.replace("./extensions/", "").replace("/index.ts", "");
    mkdirSync(path.join(root, "extensions", directory), { recursive: true });
    writeFileSync(path.join(root, "extensions", directory, "index.ts"), "export default () => {};\n");
    writeFileSync(
      path.join(root, "extensions", directory, "manifest.json"),
      `${JSON.stringify({ id: directory, risk: index === 0 ? "low" : "high", ownershipStatus: "locus-specific" })}\n`,
    );
  }
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "1.2.3", pi: { extensions: entrypoints } })}\n`,
  );
  mutate(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("doctor package inventory", () => {
  it("reports exactly the entrypoints package.json declares, in declaration order", () => {
    const inventory = readPackageInventory(repositoryRoot);

    expect(inventory.rows.map((row) => row.entrypoint)).toEqual(declaredEntrypoints);
    expect(inventory.problems).toEqual([]);
    expect(inventory.rows.every((row) => row.state === "ok")).toBe(true);
  });

  it("derives every id from the manifest rather than a transcribed list", () => {
    const inventory = readPackageInventory(repositoryRoot);

    const directories = declaredEntrypoints.map((entrypoint) => ENTRYPOINT_PATTERN.exec(entrypoint)?.[1]);
    expect(inventory.rows.map((row) => row.id)).toEqual(directories);
    // status-line was the entry the superseded hand-maintained table never listed.
    expect(inventory.rows.map((row) => row.id)).toContain("status-line");
  });

  it("carries the risk and ownership each manifest declares", () => {
    const inventory = readPackageInventory(repositoryRoot);

    for (const row of inventory.rows) {
      const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, row.manifestPath), "utf8")) as {
        risk: string;
        ownershipStatus: string;
      };
      expect(row.risk).toBe(manifest.risk);
      expect(row.ownership).toBe(manifest.ownershipStatus);
    }
  });

  it("resolves the installed root from its own location when no root is given", () => {
    expect(defaultPackageRoot()).toBe(repositoryRoot);
    expect(readPackageInventory().rows).toHaveLength(declaredEntrypoints.length);
  });

  it("spells the entrypoint rule the same way the repository gates do", () => {
    expect(ENTRYPOINT_PATTERN.source).toBe(EXTENSION_ENTRYPOINT_PATTERN.source);
    expect(ENTRYPOINT_PATTERN.flags).toBe(EXTENSION_ENTRYPOINT_PATTERN.flags);
  });

  it("counts declared fields without re-deriving the ordering at each call site", () => {
    const inventory = readPackageInventory(fixtureRoot());

    expect(countBy(inventory.rows, "risk")).toEqual(["high=1", "low=1"]);
    expect(countBy(inventory.rows, "ownership")).toEqual(["locus-specific=2"]);
  });

  it("reports a missing entrypoint instead of assuming it is installed", () => {
    const inventory = readPackageInventory(fixtureRoot((root) => rmSync(path.join(root, "extensions/beta/index.ts"))));

    expect(inventory.rows[1]?.state).toBe("missing-entrypoint");
    expect(inventory.problems).toEqual(["./extensions/beta/index.ts: declared entrypoint is missing"]);
    expect(inventory.rows).toHaveLength(2);
  });

  it("reports a missing manifest and still counts the row", () => {
    const inventory = readPackageInventory(
      fixtureRoot((root) => rmSync(path.join(root, "extensions/alpha/manifest.json"))),
    );

    expect(inventory.rows[0]?.state).toBe("missing-manifest");
    expect(inventory.rows[0]?.id).toBe("alpha");
    expect(inventory.problems).toEqual(["extensions/alpha/manifest.json: manifest is missing"]);
  });

  it("fails closed on an unreadable manifest with a diagnostic, not a stack trace", () => {
    const inventory = readPackageInventory(
      fixtureRoot((root) => writeFileSync(path.join(root, "extensions/alpha/manifest.json"), "{ not json")),
    );

    expect(inventory.rows[0]?.state).toBe("unreadable-manifest");
    expect(inventory.problems[0]).toContain("extensions/alpha/manifest.json: is not valid JSON");
    expect(inventory.rows[0]?.risk).toBe("unknown");
  });

  it("rejects an entrypoint that is not the accepted spelling", () => {
    const inventory = readPackageInventory(
      fixtureRoot((root) => {
        const file = path.join(root, "package.json");
        const packageJson = JSON.parse(readFileSync(file, "utf8")) as { pi: { extensions: string[] } };
        packageJson.pi.extensions.push("./extensions/gamma/entry.ts");
        writeFileSync(file, `${JSON.stringify(packageJson)}\n`);
      }),
    );

    expect(inventory.rows[2]?.state).toBe("invalid-entrypoint");
    expect(inventory.problems).toEqual(["./extensions/gamma/entry.ts: not an ./extensions/<id>/index.ts entrypoint"]);
  });

  it("reports an undeclared or unreadable package instead of throwing", () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), "doctor-inventory-empty-"));
    temporaryRoots.push(emptyRoot);
    const missing = readPackageInventory(emptyRoot);
    expect(missing.rows).toEqual([]);
    expect(missing.problems[0]).toContain("package.json: unreadable");

    const undeclared = readPackageInventory(
      fixtureRoot((root) => writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "x" })}\n`)),
    );
    expect(undeclared.rows).toEqual([]);
    expect(undeclared.problems).toEqual(["package.json: pi.extensions must be an array of extension entrypoints"]);
  });
});
