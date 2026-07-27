import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { packagedWorkflowNames } from "../../extensions/_shared/workflow-runner.js";

interface PackageJson {
  files: string[];
  bin: Record<string, string>;
  pi: { extensions: string[] };
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
}

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
/**
 * The Package registry is the examples directory itself, so this list is not the
 * registry — it is the reviewed snapshot of what that directory currently holds.
 * A file added or removed there fails here on purpose: adding a Package workflow
 * is cheap, but it is still a public-surface change somebody has to look at.
 */
const EXPECTED_PACKAGE_WORKFLOW_NAMES = [
  "live-smoke",
  "plan",
  "plan-implement",
  "requirements-grill",
  "review",
  "review-fix",
] as const;
const PI_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;
const PACKAGE_WORKFLOW_PATHS = {
  "live-smoke": "extensions/workflows/examples/live-smoke.workflow.mjs",
  plan: "extensions/workflows/examples/plan/plan.workflow.mjs",
  "plan-implement": "extensions/workflows/examples/plan-implement/plan-implement.workflow.mjs",
  "requirements-grill": "extensions/workflows/examples/requirements-grill.workflow.mjs",
  review: "extensions/workflows/examples/review/review.workflow.mjs",
  "review-fix": "extensions/workflows/examples/review-fix/review-fix.workflow.mjs",
} as const;
const forbiddenPackedPaths = [
  /^\.agents\/(skills|workflows)\//,
  /^\.(locus|tasks|planning|pi)\//,
  /^(artifacts|benchmarks|catalog|eval|evaluation|evaluations|output|scripts|tests)\//,
  /^docs\/(archive|extension-gallery|reports|system-design)\//,
  /^docs\/source-audit\//,
  /^extensions\/beta\//,
  /^bin\/pi-live-terminal$/,
  /^STATUS\.md$/,
];

let dryRun: PackResult;

beforeAll(() => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  });
  const [result] = JSON.parse(output) as PackResult[];
  if (!result) throw new Error("npm pack --dry-run returned no package result");
  dryRun = result;
});

describe("npm public package boundary", () => {
  it("requires Pi 0.82.0 in both the published peer contract and exact development baseline", () => {
    for (const packageName of PI_PACKAGES) {
      expect(pkg.peerDependencies[packageName], `${packageName} peer floor`).toBe("^0.82.0");
      expect(pkg.devDependencies[packageName], `${packageName} development pin`).toBe("0.82.0");
      expect(supportsPiVersion(pkg.peerDependencies[packageName]!, "0.82.0")).toBe(true);
      expect(supportsPiVersion(pkg.peerDependencies[packageName]!, "0.80.3")).toBe(false);
    }
  });

  it("matches the file-granular package.json allowlist exactly", () => {
    expect(new Set(pkg.files).size).toBe(pkg.files.length);
    for (const relativePath of pkg.files) {
      const absolutePath = path.join(root, relativePath);
      expect(existsSync(absolutePath), `allowlisted file must exist: ${relativePath}`).toBe(true);
      expect(statSync(absolutePath).isFile(), `allowlist entry must name a file: ${relativePath}`).toBe(true);
    }

    const expected = [...pkg.files, "package.json"].sort();
    const actual = dryRun.files.map((file) => file.path).sort();
    expect(actual).toEqual(expected);
  });

  it("ships every prompt resource a curated workflow renders", () => {
    const packedPaths = new Set(dryRun.files.map((file) => file.path));

    for (const [name, workflowPath] of Object.entries(PACKAGE_WORKFLOW_PATHS)) {
      const source = readFileSync(path.join(root, workflowPath), "utf8");
      const directory = path.posix.dirname(workflowPath);
      for (const match of source.matchAll(/promptFile\(\s*"(\.\/[^"]+\.prompt\.md)"/gu)) {
        const resource = path.posix.normalize(path.posix.join(directory, match[1]!));
        expect(existsSync(path.join(root, resource)), `${name} renders a missing prompt: ${resource}`).toBe(true);
        expect(packedPaths.has(resource), `${name} renders an unpacked prompt: ${resource}`).toBe(true);
      }
    }
  });

  it("ships ten active entrypoints, their manifests, and complete local imports", () => {
    const packedPaths = new Set(dryRun.files.map((file) => file.path));
    expect(pkg.pi.extensions).toHaveLength(10);

    for (const entrypoint of pkg.pi.extensions) {
      const normalizedEntrypoint = entrypoint.replace(/^\.\//, "");
      const manifest = path.posix.join(path.posix.dirname(normalizedEntrypoint), "manifest.json");
      expect(packedPaths.has(normalizedEntrypoint), `missing active entrypoint: ${normalizedEntrypoint}`).toBe(true);
      expect(packedPaths.has(manifest), `missing active manifest: ${manifest}`).toBe(true);
    }

    for (const localImport of localImportClosure(pkg.pi.extensions)) {
      expect(packedPaths.has(localImport), `missing transitive local import: ${localImport}`).toBe(true);
    }
  });

  it("packs exactly the workflows the examples directory resolves, and no forbidden paths", () => {
    const packedPaths = dryRun.files.map((file) => file.path);
    const packedWorkflowNames = packedPaths
      .filter((file) => file.startsWith("extensions/workflows/examples/") && file.endsWith(".workflow.mjs"))
      .map((file) => path.basename(file, ".workflow.mjs"))
      .sort();

    // The load-bearing assertion of the scanned registry: what a checkout
    // resolves by name and what an install ships must be the same set. A
    // workflow present here and missing from `package.json#files` would work in
    // this repository and be gone after `npm i`, which is the one way "the
    // folder is the registry" could lie to an operator.
    expect(packedWorkflowNames).toEqual(packagedWorkflowNames().sort());
    expect(packagedWorkflowNames().sort()).toEqual([...EXPECTED_PACKAGE_WORKFLOW_NAMES].sort());
    expect(packedPaths.filter((file) => forbiddenPackedPaths.some((pattern) => pattern.test(file)))).toEqual([]);
    expect(pkg.bin).toEqual({ "locus-pi": "bin/locus-pi" });
  });

  it("loads every declared entrypoint from an unpacked real tarball", () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "locus-pi-pack-boundary-"));
    try {
      const packOutput = execFileSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot],
        { cwd: root, encoding: "utf8" },
      );
      const [packed] = JSON.parse(packOutput) as PackResult[];
      if (!packed) throw new Error("npm pack returned no package result");
      const unpackRoot = path.join(temporaryRoot, "unpacked");
      mkdirSync(unpackRoot);
      execFileSync("tar", ["-xzf", path.join(temporaryRoot, packed.filename), "-C", unpackRoot]);

      const packageRoot = path.join(unpackRoot, "package");
      symlinkSync(path.join(root, "node_modules"), path.join(packageRoot, "node_modules"), "dir");
      const entrypointUrls = pkg.pi.extensions.map(
        (entrypoint) => pathToFileURL(path.join(packageRoot, entrypoint)).href,
      );
      const workflowUrls = EXPECTED_PACKAGE_WORKFLOW_NAMES.map((name) => ({
        name,
        url: pathToFileURL(path.join(packageRoot, PACKAGE_WORKFLOW_PATHS[name])).href,
      }));
      const loadScript = `for (const url of ${JSON.stringify(entrypointUrls)}) {
        const loaded = await import(url);
        if (typeof loaded.default !== "function") throw new Error(\`Missing default extension export: \${url}\`);
      }
      for (const workflow of ${JSON.stringify(workflowUrls)}) {
        const loaded = await import(workflow.url);
        if (typeof loaded.default !== "function") throw new Error(\`Missing workflow export: \${workflow.url}\`);
        if (loaded.meta?.name !== workflow.name) throw new Error(\`Wrong workflow name: \${workflow.url}\`);
      }`;

      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", loadScript], {
        cwd: packageRoot,
        encoding: "utf8",
      });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

function supportsPiVersion(range: string, version: string): boolean {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/u.exec(range);
  if (match === null) return false;
  const floor = match.slice(1).map((part) => Number(part));
  const candidate = version.split(".").map((part) => Number(part));
  if (floor.length !== 3 || candidate.length !== 3 || candidate.some((part) => !Number.isSafeInteger(part)))
    return false;
  if (candidate[0] !== floor[0]) return false;
  if (floor[0] === 0 && candidate[1] !== floor[1]) return false;
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index]! > floor[index]!) return true;
    if (candidate[index]! < floor[index]!) return false;
  }
  return true;
}

function localImportClosure(entrypoints: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = entrypoints.map((entrypoint) => path.resolve(root, entrypoint));

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, "utf8");
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      if (!imported.fileName.startsWith(".")) continue;
      const resolved = resolveLocalImport(file, imported.fileName);
      if (!resolved) throw new Error(`Unresolved local import from ${path.relative(root, file)}: ${imported.fileName}`);
      if (!seen.has(resolved)) pending.push(resolved);
    }
  }

  return [...seen].map((file) => path.relative(root, file).split(path.sep).join("/")).sort();
}

function resolveLocalImport(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.mjs$/, ".mts"),
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
