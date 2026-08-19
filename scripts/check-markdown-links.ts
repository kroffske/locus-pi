import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { deadMarkdownLinks, surfaceMarkdownFiles, type PublishedSurface } from "./markdown-links.js";

/**
 * The internal-link gate over published Markdown, run by `npm run check:links`.
 *
 * Scope, and the reason for it: documentation is read from inside whatever was
 * published — an unpacked npm tarball, or the public repository — where the rest
 * of this checkout does not exist. A relative link that resolves here and not
 * there is dead for every reader who installed or cloned, and they cannot tell a
 * broken link from a document we forgot to publish. Both surfaces are checked,
 * because they publish different file sets.
 *
 * External `http(s)` links are deliberately out of scope. Reaching them needs
 * the network, so they cannot belong to an offline deterministic gate, and a URL
 * rotting on somebody else's host is not a defect a push can be blocked on.
 *
 * Read-only by construction: it opens `package.json`, the public-repository
 * manifest, its generated inventory, and the Markdown those name. Nothing is
 * written, so `npm run check` leaves the working tree untouched.
 */

interface PackageJson {
  files?: string[];
}

interface PublicRepositoryManifest {
  generatedInventory: string;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

function main(): void {
  const root = process.cwd();
  const surfaces = [packageSurface(root), publicRepositorySurface(root)];

  const failures = surfaces.flatMap((surface) => {
    const dead = deadMarkdownLinks(root, surface);
    return dead.length === 0 ? [] : [`Dead links in ${surface.name}:\n${dead.map((line) => `  ${line}`).join("\n")}`];
  });

  if (failures.length > 0) {
    console.error(failures.join("\n\n"));
    process.exitCode = 1;
    return;
  }

  const checked = surfaces.map((surface) => `${surfaceMarkdownFiles(surface).length} in ${surface.name}`).join(", ");
  console.log(`Published Markdown links verified: ${checked}`);
}

/** What `npm pack` ships: the file-granular allowlist, plus the manifest npm always adds. */
function packageSurface(root: string): PublishedSurface {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
  if (!Array.isArray(packageJson.files)) throw new Error("package.json has no files array to publish from");
  return { name: "the npm package", files: new Set([...packageJson.files, "package.json"]) };
}

/**
 * What the public repository contains, read from the inventory the materializer
 * generates. `check:repository` is what proves that inventory still equals both
 * the manifest selection and the working tree, so this gate reads it and does
 * not re-derive it.
 */
function publicRepositorySurface(root: string): PublishedSurface {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "public-repository.json"), "utf8"),
  ) as PublicRepositoryManifest;
  const inventory = readFileSync(path.join(root, manifest.generatedInventory), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { name: "the public repository", files: new Set(inventory) };
}
