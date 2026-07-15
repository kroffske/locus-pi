import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = process.cwd();
const inventoryPath = path.join(root, "public-repository-files.txt");
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
  process.exit(1);
}

const forbiddenPaths = [
  /^\.(locus|tasks|planning|pi)\//,
  /^\.agents\/(skills|workflows)\//,
  /^(artifacts|benchmarks|eval|evaluation|evaluations|output|reports)\//,
  /^docs\/(archive|extension-gallery|reports|system-design)\//,
  /^extensions\/beta\//,
];
const rejected = actual.filter((file) => forbiddenPaths.some((pattern) => pattern.test(file)));
if (rejected.length > 0) {
  console.error(`Forbidden public-repository paths:\n${rejected.join("\n")}`);
  process.exit(1);
}

for (const relativePath of actual) {
  const absolutePath = path.join(root, relativePath);
  const entryStat = await lstat(absolutePath);
  if (entryStat.isSymbolicLink()) {
    console.error(`Symlink rejected from public repository: ${relativePath}`);
    process.exit(1);
  }
  if (!entryStat.isFile()) {
    console.error(`Non-file rejected from public repository: ${relativePath}`);
    process.exit(1);
  }
  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  if (/\/Users\/[A-Za-z0-9._-]+\//.test(text)) {
    console.error(`Absolute workstation path found: ${relativePath}`);
    process.exit(1);
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    console.error(`Private key material found: ${relativePath}`);
    process.exit(1);
  }
  if (/registry\.npmjs\.org\/.*:_authToken\s*=/.test(text)) {
    console.error(`npm auth configuration found: ${relativePath}`);
    process.exit(1);
  }
}

console.log(`Public repository inventory verified: ${actual.length} files`);

async function candidateFiles(directory: string): Promise<string[]> {
  try {
    const { stdout: topLevel } = await execFileAsync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (path.resolve(topLevel.trim()) !== path.resolve(directory)) return walk(directory);
    const { stdout } = await execFileAsync(
      "git",
      ["-C", directory, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return walk(directory);
  }
}

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === root && (entry.name === ".git" || entry.name === "node_modules")) continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
    const entryStat = await lstat(absolutePath);
    if (entryStat.isSymbolicLink()) {
      console.error(`Symlink rejected from public repository: ${relativePath}`);
      process.exit(1);
    }
    if (entryStat.isDirectory()) files.push(...(await walk(absolutePath)));
    else if (entryStat.isFile()) files.push(relativePath);
  }
  return files;
}
