import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(process.cwd(), "extensions/workflows/examples/live-smoke.workflow.mjs");

interface AgentCall {
  prompt: string;
  options: {
    agent: string;
    label: string;
    permissionMode: string;
    workspaceMode: string;
    readOnly: boolean;
    tools: string[];
  };
}

async function loadWorkflow(): Promise<(dsl: unknown, input?: unknown) => Promise<unknown>> {
  const module = (await import(workflowPath)) as {
    default?: (dsl: unknown, input?: unknown) => Promise<unknown>;
  };
  expect(typeof module.default).toBe("function");
  return module.default!;
}

describe("workflow example: live-smoke.workflow.mjs", () => {
  it("narrows both child agents to one read-only project tool", async () => {
    const calls: AgentCall[] = [];
    const runWorkflow = await loadWorkflow();

    const result = await runWorkflow(
      {
        phase: () => undefined,
        log: () => undefined,
        async agent(prompt: string, options: AgentCall["options"]) {
          calls.push({ prompt, options });
          return `${options.agent} inspected the directory`;
        },
      },
      "external install",
    );

    expect(calls.map((call) => call.options.agent)).toEqual(["explore", "quick_task"]);
    for (const call of calls) {
      expect(call.options).toMatchObject({
        label: "list cwd entries",
        permissionMode: "agent-defined",
        workspaceMode: "project",
        readOnly: true,
        tools: ["find"],
      });
      expect(call.prompt).toContain("Use your find tool");
      expect(call.prompt).not.toContain("bash");
    }
    expect(result).toEqual({
      topic: "external install",
      ok: true,
      notes: {
        explore: "explore inspected the directory",
        quick_task: "quick_task inspected the directory",
      },
    });
  });
});
