/**
 * extensions/workflows/command-completions.ts — Argument completions for
 * `/workflows` and its flat `/workflow-*` aliases.
 *
 * The `/workflows` grammar is the source of truth: the flat aliases delegate
 * here and strip their own verb back off, so a token can never be completed
 * one way on one command and another way on the other.
 */

import type { CommandArgumentCompletion } from "../_shared/pi-api.js";
import { listWorkflowRunIds } from "./runtime/workflow-journal.js";
import type { FlatWorkflowCommand } from "./command-router.js";
import { listExampleNames } from "./operator-ui.js";
import { buildWorkflowCatalogModel } from "./workflow-catalog.js";

export function workflowArgumentCompletions(
  rawPrefix: string,
  projectRoot: string,
  workingDirectory = projectRoot,
): CommandArgumentCompletion[] | null {
  const prefix = rawPrefix.replace(/^\s+/u, "");
  const rootCommands: CommandArgumentCompletion[] = [
    { value: "dashboard", label: "dashboard", description: "Open persisted run dashboard" },
    { value: "list ", label: "list", description: "Browse workflow catalog" },
    { value: "info ", label: "info", description: "Show one workflow" },
    { value: "status ", label: "status", description: "Inspect persisted run status" },
    { value: "run ", label: "run", description: "Start a workflow" },
    { value: "stop ", label: "stop", description: "Stop a workflow explicitly" },
  ];
  if (!prefix.includes(" ")) return matchingCompletions(rootCommands, prefix);
  if (prefix.startsWith("list ")) return null;

  const runIds = (): string[] => listWorkflowRunIds(projectRoot).slice(0, 20);
  const workflowNames = (): string[] => {
    try {
      return buildWorkflowCatalogModel(projectRoot, workingDirectory).current.map((row) => row.name);
    } catch {
      return listExampleNames();
    }
  };
  if (prefix.startsWith("info ")) {
    return matchingCompletions(
      workflowNames().map((name) => ({ value: `info ${name}`, label: name })),
      prefix,
    );
  }
  if (prefix.startsWith("status ")) {
    return matchingCompletions(
      runIds().map((runId) => ({ value: `status ${runId}`, label: runId })),
      prefix,
    );
  }
  if (prefix.startsWith("stop ")) {
    return matchingCompletions(
      [
        { value: "stop last", label: "last", description: "Most recently started run" },
        ...runIds().map((runId) => ({ value: `stop ${runId}`, label: runId })),
      ],
      prefix,
    );
  }
  if (!prefix.startsWith("run ")) return null;

  const runTail = prefix.slice("run ".length);
  const firstSpace = runTail.search(/\s/u);
  const targetPrefix = firstSpace < 0 ? runTail : runTail.slice(0, firstSpace);
  if (targetPrefix.includes("/") || targetPrefix.startsWith(".")) return null;
  if (firstSpace < 0) {
    return matchingCompletions(
      workflowNames().map((name) => ({ value: `run ${name}`, label: name })),
      prefix,
    );
  }

  const afterTarget = runTail.slice(firstSpace);
  if (" --resume ".startsWith(afterTarget)) {
    return [{ value: `run ${targetPrefix} --resume `, label: "--resume", description: "Resume from a prior run" }];
  }
  if (!afterTarget.startsWith(" --resume ")) return null;
  const resumePrefix = `run ${targetPrefix} --resume `;
  const requestedRunId = afterTarget.slice(" --resume ".length);
  if (/\s/u.test(requestedRunId)) return null;
  return matchingCompletions(
    runIds().map((runId) => ({ value: `${resumePrefix}${runId}`, label: runId })),
    `${resumePrefix}${requestedRunId}`,
  );
}

export function workflowFlatCommandCompletions(
  command: FlatWorkflowCommand,
  rawPrefix: string,
  projectRoot: string,
  workingDirectory = projectRoot,
  actionableRunIds?: readonly string[],
): CommandArgumentCompletion[] | null {
  if (command === "list") return null;
  if (command === "continue") {
    return workflowContinueArgumentCompletions(rawPrefix, actionableRunIds ?? listWorkflowRunIds(projectRoot));
  }

  const prefix = rawPrefix.replace(/^\s+/u, "");
  const delegated = workflowArgumentCompletions(
    prefix === "" ? `${command} ` : `${command} ${prefix}`,
    projectRoot,
    workingDirectory,
  );
  if (delegated === null) return null;
  const verbPrefix = `${command} `;
  return delegated.map((completion) => ({
    ...completion,
    value: completion.value.startsWith(verbPrefix) ? completion.value.slice(verbPrefix.length) : completion.value,
  }));
}

function workflowContinueArgumentCompletions(
  rawPrefix: string,
  actionableRunIds: readonly string[],
): CommandArgumentCompletion[] | null {
  const prefix = rawPrefix.replace(/^\s+/u, "");
  const firstSpace = prefix.search(/\s/u);
  const runIdPrefix = firstSpace < 0 ? prefix : prefix.slice(0, firstSpace);
  const runIds = actionableRunIds.slice(0, 20);
  if (firstSpace < 0) {
    return matchingCompletions(
      runIds.map((runId) => ({ value: runId, label: runId })),
      runIdPrefix,
    );
  }
  if (!runIds.includes(runIdPrefix)) return [];
  const tail = prefix.slice(firstSpace);
  if (" --answer ".startsWith(tail)) {
    return [
      {
        value: `${runIdPrefix} --answer `,
        label: "--answer",
        description: "Supply one explicit noninteractive answer",
      },
    ];
  }
  return null;
}

function matchingCompletions(completions: CommandArgumentCompletion[], prefix: string): CommandArgumentCompletion[] {
  const normalizedPrefix = prefix.toLowerCase();
  return completions.filter((item) => item.value.toLowerCase().startsWith(normalizedPrefix));
}
