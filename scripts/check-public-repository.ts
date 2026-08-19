import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MANIFEST_FILE = "public-repository.json";
const PACKAGE_FILES_POINTER = "package.json#files";
const MATERIALIZE_COMMAND = "tsx scripts/materialize-public-repository.ts <empty-destination>";

/**
 * One rejected manifest reference. `field` is the JSON path inside
 * public-repository.json, so every finding names a single edit to make.
 */
export interface ManifestProblem {
  field: string;
  value: string;
  reason: string;
  remedy: string;
}

interface PublicRepositoryManifest {
  packageFiles: string;
  repositoryFiles: string[];
  excludeFiles: string[];
  generatedInventory: string;
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  await checkPublicRepository(process.cwd());
}

async function checkPublicRepository(root: string): Promise<void> {
  const manifestProblems = await publicRepositoryManifestProblems(root);
  if (manifestProblems.length > 0) {
    console.error(formatManifestProblems(manifestProblems));
    process.exitCode = 1;
    return;
  }

  // The manifest passed validation above, so its declared destination is the
  // one inventory both this checker and the materializer answer to.
  const inventoryPath = path.join(root, await declaredInventory(root));
  const expected = (await readFile(inventoryPath, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const actual = (await candidateFiles(root)).sort();

  const missing = expected.filter((file) => !actual.includes(file));
  const extra = actual.filter((file) => !expected.includes(file));
  if (missing.length > 0 || extra.length > 0) {
    if (missing.length > 0) console.error(`Missing public-repository files:\n${missing.join("\n")}`);
    if (extra.length > 0) console.error(`Unexpected public-repository files:\n${extra.join("\n")}`);
    process.exitCode = 1;
    return;
  }

  const forbiddenPaths = [
    /^\.(locus|tasks|planning|pi|publication)\//,
    /^\.agents\/(skills|workflows)\//,
    /^(artifacts|benchmarks|eval|evaluation|evaluations|output|reports|transcripts)\//,
    /^docs\/(adr|decisions|prd|source-audit|internal|archive|_archive|drafts|notes|research|proposals|specs|system-design|extension-gallery|reports|runtime|extensions)\//,
    /^docs\/(?:milestones|roadmap).*\.md$/i,
    /^(?:EXPORT_MANIFEST\.(?:md|json)|PUBLICATION_PLAN\.md|PUBLICATION_REMOVALS\.txt|VALIDATION_REPORT\.md)$/,
    /^extensions\/beta\//,
  ];
  const rejected = actual.filter((file) => forbiddenPaths.some((pattern) => pattern.test(file)));
  if (rejected.length > 0) {
    console.error(`Forbidden public-repository paths:\n${rejected.join("\n")}`);
    process.exitCode = 1;
    return;
  }

  for (const relativePath of actual) {
    const absolutePath = path.join(root, relativePath);
    const entryStat = await lstat(absolutePath);
    if (entryStat.isSymbolicLink()) {
      console.error(`Symlink rejected from public repository: ${relativePath}`);
      process.exitCode = 1;
      return;
    }
    if (!entryStat.isFile()) {
      console.error(`Non-file rejected from public repository: ${relativePath}`);
      process.exitCode = 1;
      return;
    }
    const bytes = await readFile(absolutePath);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (/\/Users\/[A-Za-z0-9._-]+\//.test(text)) {
      console.error(`Absolute workstation path found: ${relativePath}`);
      process.exitCode = 1;
      return;
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
      console.error(`Private key material found: ${relativePath}`);
      process.exitCode = 1;
      return;
    }
    if (/registry\.npmjs\.org\/.*:_authToken\s*=/.test(text)) {
      console.error(`npm auth configuration found: ${relativePath}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`Public repository inventory verified: ${actual.length} files`);
}

/**
 * Validates public-repository.json against the working tree it materializes.
 * Reads only the manifest, package.json and the generated inventory, so a
 * clean checkout with no local git state is enough to run it.
 */
export async function publicRepositoryManifestProblems(root: string): Promise<ManifestProblem[]> {
  const raw = JSON.parse(await readFile(path.join(root, MANIFEST_FILE), "utf8")) as Record<string, unknown>;
  const shape = shapeProblems(raw);
  if (shape.length > 0) return shape;
  // shapeProblems accepted every declared field, so the manifest shape is known.
  const manifest = raw as unknown as PublicRepositoryManifest;

  const listedReferences = [
    ...manifest.repositoryFiles.map((value, index) => ({ field: `repositoryFiles[${index}]`, value })),
    ...manifest.excludeFiles.map((value, index) => ({ field: `excludeFiles[${index}]`, value })),
  ];
  const inventoryReference = { field: "generatedInventory", value: manifest.generatedInventory };

  // A path that is not canonical cannot be resolved, compared or de-duplicated,
  // so spelling gates the rest instead of contributing one finding among many.
  const spelling = [...listedReferences, inventoryReference].flatMap(
    ({ field, value }) => spellingProblem(field, value) ?? [],
  );
  if (spelling.length > 0) return spelling;

  const problems = [
    ...duplicateProblems("repositoryFiles", manifest.repositoryFiles),
    ...duplicateProblems("excludeFiles", manifest.excludeFiles),
  ];
  for (const { field, value } of listedReferences) {
    const problem = await entryProblem(root, field, value);
    if (problem) problems.push(problem);
  }
  const unreadableInventory = await entryProblem(root, inventoryReference.field, inventoryReference.value);
  if (unreadableInventory) problems.push(unreadableInventory);

  const packageFiles = await packageFileList(root);
  if (!packageFiles) {
    problems.push({
      field: "packageFiles",
      value: PACKAGE_FILES_POINTER,
      reason: "package.json has no files array to select from",
      remedy: 'restore the "files" array in package.json',
    });
    return problems;
  }

  // Reproduce the materialization selection exactly: package files first, then
  // the repository allowlist, then the declared removals.
  const selected = new Set([...packageFiles, "package.json", ...manifest.repositoryFiles]);
  manifest.excludeFiles.forEach((value, index) => {
    if (selected.delete(value)) return;
    problems.push({
      field: `excludeFiles[${index}]`,
      value,
      reason: `removes nothing, because ${value} is not selected by ${PACKAGE_FILES_POINTER} or "repositoryFiles"`,
      remedy: `drop ${JSON.stringify(value)} from "excludeFiles" in ${MANIFEST_FILE}`,
    });
  });
  selected.add(manifest.generatedInventory);

  if (!unreadableInventory) problems.push(...(await inventoryProblems(root, manifest.generatedInventory, selected)));
  return problems;
}

function shapeProblems(raw: Record<string, unknown>): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  if (raw.packageFiles !== PACKAGE_FILES_POINTER) {
    problems.push({
      field: "packageFiles",
      value: renderValue(raw.packageFiles),
      reason: `the only supported package pointer is ${PACKAGE_FILES_POINTER}`,
      remedy: `set "packageFiles" to ${JSON.stringify(PACKAGE_FILES_POINTER)} in ${MANIFEST_FILE}`,
    });
  }
  for (const field of ["repositoryFiles", "excludeFiles"] as const) {
    const value = raw[field];
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) continue;
    problems.push({
      field,
      value: renderValue(value),
      reason: "must be an array of relative file paths",
      remedy: `write "${field}" as a JSON array of strings in ${MANIFEST_FILE}`,
    });
  }
  if (typeof raw.generatedInventory !== "string" || raw.generatedInventory.length === 0) {
    problems.push({
      field: "generatedInventory",
      value: renderValue(raw.generatedInventory),
      reason: "must name the inventory file the materializer writes",
      remedy: `set "generatedInventory" to the inventory path in ${MANIFEST_FILE}`,
    });
  }
  return problems;
}

function spellingProblem(field: string, value: string): ManifestProblem | undefined {
  const alias = (reason: string): ManifestProblem => ({
    field,
    value,
    reason,
    remedy: `write the entry as ${JSON.stringify(path.posix.normalize(value.split("\\").join("/")))} in ${MANIFEST_FILE}`,
  });
  if (value.includes("\\"))
    return alias("uses a backslash separator, which aliases the same file under another spelling");
  if (path.isAbsolute(value) || value.startsWith("/")) {
    return {
      field,
      value,
      reason: "is absolute, so it does not name a path inside the repository",
      remedy: `write the entry relative to the repository root in ${MANIFEST_FILE}`,
    };
  }
  const segments = value.split("/");
  if (segments.includes("..")) {
    return {
      field,
      value,
      reason: "traverses outside the repository with a .. segment",
      remedy: `remove ${JSON.stringify(value)} from ${MANIFEST_FILE}; the public surface is materialized from repository paths only`,
    };
  }
  if (segments.includes(""))
    return alias("contains an empty path segment, which aliases the same file under another spelling");
  if (segments.includes(".")) return alias("contains a . segment, which aliases the same file under another spelling");
  return undefined;
}

function duplicateProblems(field: string, values: string[]): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const firstIndex = new Map<string, number>();
  values.forEach((value, index) => {
    const seen = firstIndex.get(value.toLowerCase());
    if (seen === undefined) {
      firstIndex.set(value.toLowerCase(), index);
      return;
    }
    const original = values[seen] ?? "";
    problems.push({
      field: `${field}[${index}]`,
      value,
      reason:
        value === original
          ? `repeats ${field}[${seen}]`
          : `collides with ${field}[${seen}] (${original}) on a case-insensitive filesystem`,
      remedy: `keep one spelling and drop the other from "${field}" in ${MANIFEST_FILE}`,
    });
  });
  return problems;
}

async function entryProblem(root: string, field: string, value: string): Promise<ManifestProblem | undefined> {
  const segments = value.split("/");
  let absolutePath = root;
  for (const [index, segment] of segments.entries()) {
    absolutePath = path.join(absolutePath, segment);
    const traversed = segments.slice(0, index + 1).join("/");
    const entry = await lstat(absolutePath).catch(() => undefined);
    if (!entry) {
      return {
        field,
        value,
        reason: `names ${traversed}, which does not exist in the working tree`,
        remedy: `add the file, or remove ${JSON.stringify(value)} from ${MANIFEST_FILE}`,
      };
    }
    if (entry.isSymbolicLink()) {
      return {
        field,
        value,
        reason: `resolves through the symlink ${traversed}`,
        remedy: `allowlist the real file instead of a symlink in ${MANIFEST_FILE}`,
      };
    }
    if (index === segments.length - 1 && !entry.isFile()) {
      return {
        field,
        value,
        reason: "is not a regular file",
        remedy: `list each file exactly in ${MANIFEST_FILE}; directories are never expanded`,
      };
    }
  }
  return undefined;
}

async function inventoryProblems(root: string, inventory: string, selected: Set<string>): Promise<ManifestProblem[]> {
  const listed = new Set(
    (await readFile(path.join(root, inventory), "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const problems: ManifestProblem[] = [];
  for (const file of [...selected].sort().filter((file) => !listed.has(file))) {
    problems.push({
      field: "generatedInventory",
      value: file,
      reason: `is selected by ${MANIFEST_FILE} but absent from ${inventory}`,
      remedy: `regenerate ${inventory} with: ${MATERIALIZE_COMMAND}`,
    });
  }
  for (const file of [...listed].sort().filter((file) => !selected.has(file))) {
    problems.push({
      field: "generatedInventory",
      value: file,
      reason: `is listed in ${inventory} but not selected by ${MANIFEST_FILE}`,
      remedy: `add ${JSON.stringify(file)} to "repositoryFiles" in ${MANIFEST_FILE}, or regenerate ${inventory} with: ${MATERIALIZE_COMMAND}`,
    });
  }
  return problems;
}

async function declaredInventory(root: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST_FILE), "utf8")) as PublicRepositoryManifest;
  return manifest.generatedInventory;
}

async function packageFileList(root: string): Promise<string[] | undefined> {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { files?: unknown };
  if (!Array.isArray(packageJson.files) || packageJson.files.some((entry) => typeof entry !== "string"))
    return undefined;
  return packageJson.files as string[];
}

function renderValue(value: unknown): string {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

function formatManifestProblems(problems: ManifestProblem[]): string {
  const lines = problems.map(
    (problem) => `  ${problem.field}: ${problem.value}\n    problem: ${problem.reason}\n    fix:     ${problem.remedy}`,
  );
  return `${MANIFEST_FILE} does not describe a materializable public surface:\n${lines.join("\n")}`;
}

export async function candidateFiles(directory: string): Promise<string[]> {
  try {
    const { stdout: topLevel } = await execFileAsync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (path.resolve(topLevel.trim()) !== path.resolve(directory)) return walk(directory, directory);
    const [{ stdout }, { stdout: deletedStdout }] = await Promise.all([
      execFileAsync("git", ["-C", directory, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }),
      execFileAsync("git", ["-C", directory, "ls-files", "--deleted", "-z"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }),
    ]);
    const deleted = new Set(deletedStdout.split("\0").filter(Boolean));
    return stdout.split("\0").filter((file) => file.length > 0 && !deleted.has(file));
  } catch {
    return walk(directory, directory);
  }
}

async function walk(directory: string, root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === root && (entry.name === ".git" || entry.name === "node_modules")) continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
    const entryStat = await lstat(absolutePath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Symlink rejected from public repository: ${relativePath}`);
    }
    if (entryStat.isDirectory()) files.push(...(await walk(absolutePath, root)));
    else if (entryStat.isFile()) files.push(relativePath);
  }
  return files;
}
