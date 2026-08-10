import { readFileSync } from "node:fs";
import path from "node:path";
import { staticWorkflowMeta } from "../extensions/workflows/workflow-catalog.js";
import { standardWorkflowSourceShapeErrors } from "../extensions/workflows/workflow-source-shape.js";
import { packagedWorkflowNames, packagedWorkflowPath } from "../extensions/workflows/runtime/workflow-runner.js";

interface SourceShapeTarget {
  label: string;
  path: string;
  requireStandard: boolean;
}

const requestedPaths = process.argv.slice(2);
const targets: SourceShapeTarget[] =
  requestedPaths.length > 0
    ? requestedPaths.map((requestedPath) => ({
        label: requestedPath,
        path: path.resolve(process.cwd(), requestedPath),
        requireStandard: true,
      }))
    : packagedWorkflowNames().map((name) => ({
        label: `Package workflow ${name}`,
        path: packagedWorkflowPath(name),
        requireStandard: false,
      }));

let failed = false;
let checked = 0;

for (const target of targets) {
  let source: string;
  try {
    source = readFileSync(target.path, "utf8");
  } catch (error) {
    failed = true;
    console.error(`${target.label}: unable to read source: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  const profile = staticWorkflowMeta(source).profile;
  if (profile !== "standard") {
    if (target.requireStandard) {
      failed = true;
      console.error(`${target.label}: expected literal meta.profile \"standard\", found ${profile}`);
    }
    continue;
  }

  checked += 1;
  const errors = standardWorkflowSourceShapeErrors(source);
  if (errors.length === 0) {
    console.log(`${target.label}: standard source shape passed`);
    continue;
  }

  failed = true;
  console.error(`${target.label}: standard source shape failed`);
  for (const error of errors) console.error(`  - ${error}`);
}

if (checked === 0 && !failed) {
  failed = true;
  console.error("No standard workflow source was checked.");
}

if (failed) process.exitCode = 1;
