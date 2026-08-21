import { readFile } from "node:fs/promises";
import path from "node:path";

interface PackageJson {
  pi: { extensions: string[] };
}
interface Manifest {
  id: string;
  ownershipStatus?: string;
  sourceAuditPath?: string | null;
  review?: { status?: string; source?: string; reviewedBy?: string | null; reviewedAt?: string | null };
}

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as PackageJson;
const notices = await readFile(path.join(root, "docs/third-party-notices.md"), "utf8");
const manifests = await readActiveManifests(packageJson.pi.extensions);

// The one review.source in schemas/extension-manifest.schema.json that describes adapted third-party
// code; write-from-scratch is the other, and it carries no attribution obligation.
const ADAPTED_REVIEW_SOURCE = "copy-after-audit";

for (const manifest of manifests) {
  const adapted = manifest.ownershipStatus === "compat-wrapper" || manifest.review?.source === ADAPTED_REVIEW_SOURCE;
  if (!adapted) continue;
  if (manifest.review?.status !== "reviewed" || !manifest.review.reviewedBy || !manifest.review.reviewedAt) {
    throw new Error(`Adapted extension lacks completed review metadata: ${manifest.id}`);
  }
}

for (const required of [
  "## Pi",
  "## Oh My Pi",
  "https://github.com/earendil-works/pi",
  "https://github.com/can1357/oh-my-pi",
  "MIT",
]) {
  if (!notices.includes(required)) {
    throw new Error(`docs/third-party-notices.md lacks required attribution: ${required}`);
  }
}

for (const manifest of manifests) {
  if (manifest.sourceAuditPath !== null)
    throw new Error(`Public manifest must not link internal source-audit notes: ${manifest.id}`);
}

console.log(`Source ownership metadata and third-party notices verified for ${manifests.length} extensions`);

async function readActiveManifests(entrypoints: readonly string[]): Promise<Manifest[]> {
  const manifests: Manifest[] = [];
  for (const entrypoint of entrypoints) {
    const manifestPath = path.join(root, path.dirname(entrypoint), "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
    if (typeof manifest.id !== "string")
      throw new Error(`Active manifest lacks string id: ${path.relative(root, manifestPath)}`);
    manifests.push(manifest);
  }
  return manifests;
}
