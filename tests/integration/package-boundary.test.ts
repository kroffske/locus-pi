import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { CURATED_PACKAGE_WORKFLOW_NAMES } from "../../extensions/_shared/workflow-runner.js";

interface PackageJson {
  files: string[];
  bin: Record<string, string>;
  pi: { extensions: string[] };
}

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
}

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
const EXPECTED_CURATED_PACKAGE_WORKFLOW_NAMES = [
  "live-smoke",
  "llm-smoke",
  "requirements-grill",
  "review",
  "review-fix",
] as const;
const CURATED_PACKAGE_WORKFLOW_PATHS = {
  "live-smoke": "extensions/workflows/examples/live-smoke.workflow.mjs",
  "llm-smoke": "extensions/workflows/examples/llm-smoke.workflow.mjs",
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

  it("ships exactly the five curated Package workflows and no forbidden paths", () => {
    const packedPaths = dryRun.files.map((file) => file.path);
    const packedWorkflowNames = packedPaths
      .filter((file) => file.startsWith("extensions/workflows/examples/") && file.endsWith(".workflow.mjs"))
      .map((file) => path.basename(file, ".workflow.mjs"))
      .sort();

    expect([...CURATED_PACKAGE_WORKFLOW_NAMES].sort()).toEqual([...EXPECTED_CURATED_PACKAGE_WORKFLOW_NAMES].sort());
    expect(packedWorkflowNames).toEqual([...EXPECTED_CURATED_PACKAGE_WORKFLOW_NAMES].sort());
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
      const workflowUrls = EXPECTED_CURATED_PACKAGE_WORKFLOW_NAMES.map((name) => ({
        name,
        url: pathToFileURL(path.join(packageRoot, CURATED_PACKAGE_WORKFLOW_PATHS[name])).href,
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
