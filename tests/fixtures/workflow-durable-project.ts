/** Shared temporary-project setup for the workflow durable-execution test family. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A throwaway project root that already carries the saved-workflow directory. */
export function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-durable-"));
  mkdirSync(path.join(root, ".locus-pi", "workflows"), { recursive: true });
  return root;
}

/** Save one single-file workflow into a project created by `project()`. */
export function writeWorkflow(root: string, name: string, source: string): void {
  writeFileSync(path.join(root, ".locus-pi", "workflows", `${name}.workflow.mjs`), source, "utf8");
}
