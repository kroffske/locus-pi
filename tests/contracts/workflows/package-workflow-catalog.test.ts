import { describe, expect, it } from "vitest";
import { packagedWorkflowNames } from "../../../extensions/workflows/runtime/workflow-runner.js";
import { documentedWorkflowNames, workflowDocs } from "../helpers/package-contract.js";

const expectedWorkflowNames = [
  "implement",
  "live-smoke",
  "post-code-review",
  "post-code-review/boundaries",
  "post-code-review/contracts",
  "post-code-review/necessity",
  "post-code-review/scope",
  "post-code-review/simplicity",
  "post-code-review/style",
  "post-code-review/synthesis",
  "task/implement",
  "task/plan",
  "task-via-script",
  "workflow-creator",
  "workflow-creator/build",
  "workflow-creator/design",
  "workflow-creator/svg",
];

describe("Package workflow catalog contract", () => {
  it("resolves exactly the workflows the packaged examples directory holds", () => {
    expect(packagedWorkflowNames()).toEqual(expectedWorkflowNames);
  });

  it("keeps all seventeen Package workflows in the public workflow guide", () => {
    expect(documentedWorkflowNames(workflowDocs).sort()).toEqual([...packagedWorkflowNames()].sort());
    expect(workflowDocs).toContain("`task` is a group-only namespace");
  });
});
