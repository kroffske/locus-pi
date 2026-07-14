import { copyFile, lstat, mkdir, readdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

interface PackageJson {
  files: string[];
}

interface PublicRepositoryManifest {
  packageFiles: "package.json#files";
  repositoryFiles: string[];
  excludeFiles: string[];
  generatedInventory: string;
}

const sourceRoot = process.cwd();
const destinationArg = process.argv[2];
if (!destinationArg) {
  throw new Error("Usage: tsx scripts/materialize-public-repository.ts <empty-destination>");
}

const destinationRoot = path.resolve(destinationArg);
if (destinationRoot === sourceRoot || destinationRoot.startsWith(`${sourceRoot}${path.sep}`)) {
  throw new Error("Destination must be outside the source repository");
}

const existing = await readdir(destinationRoot).catch((error: unknown) => {
  if (hasCode(error, "ENOENT")) return [];
  throw error;
});
if (existing.length > 0) throw new Error(`Destination is not empty: ${destinationRoot}`);

const packageJson = JSON.parse(
  await readFile(path.join(sourceRoot, "package.json"), "utf8"),
) as PackageJson;
const manifest = JSON.parse(
  await readFile(path.join(sourceRoot, "public-repository.json"), "utf8"),
) as PublicRepositoryManifest;

const selected = new Set<string>([...packageJson.files, "package.json"]);
for (const entry of manifest.repositoryFiles) {
  await collectEntry(entry, selected);
}
for (const excluded of manifest.excludeFiles) selected.delete(normalizeRelative(excluded));
selected.add(normalizeRelative(manifest.generatedInventory));

await mkdir(destinationRoot, { recursive: true });
for (const relativePath of [...selected].sort()) {
  if (relativePath === manifest.generatedInventory) continue;
  const source = path.join(sourceRoot, relativePath);
  const destination = path.join(destinationRoot, relativePath);
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`Allowlisted path must be a regular file: ${relativePath}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, sourceStat.mode & 0o777);
}

const inventory = [...selected].sort().join("\n") + "\n";
await writeFile(path.join(destinationRoot, manifest.generatedInventory), inventory, "utf8");
console.log(`Materialized ${selected.size} files at ${destinationRoot}`);

async function collectEntry(entry: string, selected: Set<string>): Promise<void> {
  const relativeEntry = normalizeRelative(entry);
  const absoluteEntry = path.join(sourceRoot, relativeEntry);
  const entryStat = await lstat(absoluteEntry);
  if (entryStat.isSymbolicLink()) throw new Error(`Symlink allowlist entry rejected: ${relativeEntry}`);
  if (entryStat.isFile()) {
    selected.add(relativeEntry);
    return;
  }
  if (!entryStat.isDirectory()) throw new Error(`Unsupported allowlist entry: ${relativeEntry}`);
  for (const child of await readdir(absoluteEntry, { withFileTypes: true })) {
    await collectEntry(path.posix.join(relativeEntry, child.name), selected);
  }
}

function normalizeRelative(value: string): string {
  const normalized = value.split(path.sep).join("/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid relative allowlist path: ${value}`);
  }
  return normalized;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: string }).code === code;
}
