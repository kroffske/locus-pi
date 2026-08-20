/** Pi-native boundary for the standard workflow source-shape validator. */

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "../_shared/host/pi-api.js";
import { errorResult, getProjectRoot, textResult } from "../_shared/host/pi-api.js";
import { errorMessage } from "../_shared/host/error-text.js";
import { safeToolText } from "../_shared/host/safe-output.js";
import { validateParams } from "../_shared/host/validation.js";
import { standardWorkflowSourceShapeErrors } from "./workflow-source-shape.js";

const WorkflowSourceCheckParams = Type.Object(
  {
    path: Type.String({
      description: "Project-relative path of one .workflow.mjs source file to validate without executing it.",
      minLength: 1,
      maxLength: 4096,
    }),
  },
  { additionalProperties: false },
);
const MAX_WORKFLOW_SOURCE_BYTES = 512 * 1024;

export function registerWorkflowSourceCheckTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workflow_check_source",
    label: "workflow source check",
    description:
      "Validate one project workflow source up to 512 KiB against the machine-enforced standard authoring grammar without importing or executing it. The path must stay inside the current project.",
    parameters: WorkflowSourceCheckParams,
    approval: "read",
    formatApprovalDetails: (args) => {
      const value = args !== null && typeof args === "object" ? String((args as { path?: unknown }).path ?? "") : "";
      return [`Workflow source: ${value}`, "Action: static validation only; the workflow is not imported or run"];
    },
    execute(_toolCallId, params, _signal, _update, ctx) {
      const valid = validateParams(WorkflowSourceCheckParams, params);
      if (!valid.ok) return valid.result;
      try {
        const projectRoot = getProjectRoot(ctx);
        const sourcePath = confinedProjectFile(projectRoot, valid.value.path);
        const displayPath = path.relative(projectRoot, sourcePath).split(path.sep).join("/");
        const errors = standardWorkflowSourceShapeErrors(readFileSync(sourcePath, "utf8"));
        const details = { owner: "workflows", path: displayPath, errorCount: errors.length };
        if (errors.length > 0) {
          const output = safeToolText(
            `${displayPath}: standard workflow source shape failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
          );
          return errorResult(output.text, {
            ...details,
            outputTruncated: output.truncated,
            outputRedacted: output.redacted,
          });
        }
        return textResult(`${displayPath}: standard workflow source shape passed`, details);
      } catch (error) {
        return errorResult(`workflow_check_source: ${errorMessage(error)}`, { owner: "workflows" });
      }
    },
  });
}

function confinedProjectFile(projectRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("path must be project-relative");
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalFile = path.resolve(lexicalRoot, relativePath);
  assertWithin(lexicalRoot, lexicalFile, "path escapes the project root");
  const physicalRoot = realpathSync(lexicalRoot);
  const physicalFile = realpathSync(lexicalFile);
  assertWithin(physicalRoot, physicalFile, "path escapes the project root through a symlink");
  const sourceStat = statSync(physicalFile);
  if (!sourceStat.isFile()) throw new Error("path is not a regular file");
  if (sourceStat.size > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new Error(`source exceeds the ${MAX_WORKFLOW_SOURCE_BYTES}-byte validation limit`);
  }
  return lexicalFile;
}

function assertWithin(root: string, candidate: string, message: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(message);
}
