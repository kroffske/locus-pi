import { readFile, stat } from "node:fs/promises";
import path from "node:path";

interface PackageJson {
  pi: { extensions: string[] };
}

interface Manifest {
  id: string;
  ownershipStatus?: string;
  review?: { source?: string };
}

const root = process.cwd();
const docs = path.join(root, "docs", "source-audit");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as PackageJson;
const localOmpRoot = path.join(root, ".local", "oh-my-pi-review");
const ompRoot = process.env.OMP_REVIEW_ROOT ?? ((await exists(localOmpRoot)) ? localOmpRoot : "/tmp/oh-my-pi-review");

const auditByExtension: Record<string, string> = {
  agents: "agents.md",
  "ask-user-question": "ask-user-question.md",
  "ast-structural-edit": "omp-tools.md",
  loop: "loop.md",
  model: "model.md",
  plan: "plan.md",
  "security-gate": "security-gate.md",
  "todo-context": "todo-write.md",
  workflows: "workflows.md",
};

const manifests = await readActiveManifests(packageJson.pi.extensions);
const required = [...new Set(Object.values(auditByExtension))].sort();

for (const file of required) {
  if (!(await exists(path.join(docs, file)))) {
    console.error(`Missing active source-audit note: ${file}`);
    process.exit(1);
  }
}

for (const manifest of manifests) {
  const copiedOrAdapted =
    manifest.ownershipStatus === "compat-wrapper" || manifest.review?.source === "copy-after-audit";
  const auditFile = auditByExtension[manifest.id];
  if (copiedOrAdapted && !auditFile) {
    console.error(`Active adapted extension lacks source-audit mapping: ${manifest.id}`);
    process.exit(1);
  }
}

for (const file of required) {
  const text = await readFile(path.join(docs, file), "utf8");
  if (!text.includes("Decision:")) {
    console.error(`Audit note lacks Decision: ${file}`);
    process.exit(1);
  }
  const hasOmpEvidence =
    text.includes("oh-my-pi:") || text.includes("OMP source evidence") || text.includes("Relevant OMP references");
  const hasLicenseNote = /License note:|License \/ attribution|MIT licensed|MIT-licensed/i.test(text);
  if (hasOmpEvidence && !hasLicenseNote) {
    console.error(`Audit note lacks OMP license/attribution note: ${file}`);
    process.exit(1);
  }
}

const refs = new Map<string, string[]>();
for (const file of required) {
  const text = await readFile(path.join(docs, file), "utf8");
  for (const match of text.matchAll(/`oh-my-pi:([^`]+)`/g)) {
    const resolved = path.resolve(ompRoot, match[1]!);
    refs.set(resolved, [...(refs.get(resolved) ?? []), file]);
  }
}

if (await exists(ompRoot)) {
  const missingRefs: Array<{ ref: string; files: string[] }> = [];
  for (const [ref, files] of refs) {
    if (!(await exists(ref))) missingRefs.push({ ref, files });
  }
  if (missingRefs.length > 0) {
    for (const missing of missingRefs) {
      console.error(`Missing OMP source evidence path: ${missing.ref} (${[...new Set(missing.files)].join(", ")})`);
    }
    process.exit(1);
  }
  console.log(`active source-audit notes present; ${refs.size} OMP source paths verified`);
} else {
  console.log(`active source-audit notes present; OMP path verification skipped because ${ompRoot} is absent`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    )
      return false;
    throw error;
  }
}

async function readActiveManifests(entrypoints: readonly string[]): Promise<Manifest[]> {
  const manifests: Manifest[] = [];
  for (const entrypoint of entrypoints) {
    const manifestPath = path.join(root, path.dirname(entrypoint), "manifest.json");
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
    if (typeof parsed.id !== "string") {
      console.error(`Active manifest lacks string id: ${path.relative(root, manifestPath)}`);
      process.exit(1);
    }
    manifests.push(parsed);
  }
  return manifests;
}
