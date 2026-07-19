import { execFile } from "node:child_process";

export interface ReadOnlyAgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface ReadOnlyAgentCustomTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ReadOnlyAgentToolResult> | ReadOnlyAgentToolResult;
}

export interface ReadOnlyAgentSessionCapabilities {
  tools: string[];
  excludeTools: string[];
  customTools?: ReadOnlyAgentCustomTool[];
}

const SAFE_TOOLS = new Set(["read", "grep", "find", "ls", "git_read", "yield"]);
const GIT_QUERY_SUBCOMMANDS = new Set([
  "branch",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "grep",
  "log",
  "ls-files",
  "merge-base",
  "name-rev",
  "rev-parse",
  "show",
  "status",
]);
const GIT_DIFF_SUBCOMMANDS = new Set(["diff", "diff-files", "diff-index", "diff-tree", "log", "show"]);
const MAX_ARGS = 80;
const MAX_ARG_LENGTH = 4_096;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function createReadOnlyAgentSessionCapabilities(
  cwd: string,
  requestedTools: readonly string[],
): ReadOnlyAgentSessionCapabilities {
  const tools = requestedTools.includes("*")
    ? [...SAFE_TOOLS]
    : unique(requestedTools.filter((tool) => SAFE_TOOLS.has(tool)));
  const excludeTools = unique([
    "spawn_agent",
    "task",
    "workflow",
    "bash",
    "edit",
    "write",
    ...requestedTools.filter((tool) => tool !== "*" && !SAFE_TOOLS.has(tool)),
  ]);
  return {
    tools,
    excludeTools,
    ...(tools.includes("git_read") ? { customTools: [createGitReadTool(cwd)] } : {}),
  };
}

function createGitReadTool(cwd: string): ReadOnlyAgentCustomTool {
  return {
    name: "git_read",
    label: "Git Read",
    description:
      'Run one allowlisted read-only Git query in the current project. Pass argv without the leading `git`, for example {"args":["diff","--stat","BASE...HEAD"]}. Mutation commands, shell syntax, output files, external diff, and textconv are rejected.',
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["args"],
      properties: {
        args: {
          type: "array",
          minItems: 1,
          maxItems: MAX_ARGS,
          items: { type: "string", maxLength: MAX_ARG_LENGTH },
        },
      },
    },
    async execute(_toolCallId, input, signal) {
      const validation = validateGitReadInput(input);
      if (!validation.ok) return blocked(validation.reason);
      const [subcommand, ...rest] = validation.args;
      const hardenedArgs = [
        "--no-optional-locks",
        "-c",
        "core.pager=",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        subcommand!,
        ...(GIT_DIFF_SUBCOMMANDS.has(subcommand!) ? ["--no-ext-diff", "--no-textconv"] : []),
        ...rest,
      ];
      return executeGit(cwd, hardenedArgs, validation.args, signal);
    },
  };
}

type GitReadValidation = { ok: true; args: string[] } | { ok: false; reason: string };

function validateGitReadInput(input: unknown): GitReadValidation {
  if (!isRecord(input) || !Array.isArray(input.args)) {
    return { ok: false, reason: "git_read requires one `args` string array." };
  }
  if (input.args.length === 0 || input.args.length > MAX_ARGS) {
    return { ok: false, reason: `git_read accepts 1-${MAX_ARGS} arguments.` };
  }
  if (
    input.args.some(
      (arg) => typeof arg !== "string" || arg.length === 0 || arg.length > MAX_ARG_LENGTH || arg.includes("\0"),
    )
  ) {
    return {
      ok: false,
      reason: `Every git_read argument must be a non-empty string up to ${MAX_ARG_LENGTH} characters.`,
    };
  }
  const args = input.args as string[];
  const subcommand = args[0]!;
  if (!GIT_QUERY_SUBCOMMANDS.has(subcommand)) {
    return {
      ok: false,
      reason: `git_read blocks mutating or unsupported subcommand: ${subcommand}`,
    };
  }
  if (args.slice(1).some(blockedOption)) {
    return {
      ok: false,
      reason: "git_read blocks output, configuration, pager, signature, and external-process options.",
    };
  }
  if (subcommand === "branch" && !(args.length === 2 && args[1] === "--show-current")) {
    return { ok: false, reason: "git_read allows `branch` only for showing the current branch." };
  }
  return { ok: true, args: [...args] };
}

function blockedOption(arg: string): boolean {
  return (
    arg === "--ext-diff" ||
    arg === "--textconv" ||
    arg === "--show-signature" ||
    arg === "--paginate" ||
    arg === "--config-env" ||
    arg === "-c" ||
    arg === "-O" ||
    arg === "--output" ||
    arg.startsWith("--output=") ||
    arg === "--open-files-in-pager" ||
    arg.startsWith("--open-files-in-pager=") ||
    arg.includes("%G")
  );
}

function executeGit(
  cwd: string,
  hardenedArgs: string[],
  requestedArgs: string[],
  signal: AbortSignal,
): Promise<ReadOnlyAgentToolResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      hardenedArgs,
      {
        cwd,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "",
          PAGER: "",
        },
        maxBuffer: MAX_OUTPUT_BYTES,
        signal,
      },
      (error, stdout, stderr) => {
        const output = [stdout, stderr]
          .filter((value) => value !== "")
          .join(stderr !== "" && stdout !== "" ? "\n" : "");
        if (error !== null) {
          resolve({
            content: [{ type: "text", text: output || error.message }],
            details: { args: requestedArgs, exitCode: typeof error.code === "number" ? error.code : undefined },
            isError: true,
          });
          return;
        }
        resolve({
          content: [{ type: "text", text: output }],
          details: { args: requestedArgs, exitCode: 0 },
        });
      },
    );
  });
}

function blocked(reason: string): ReadOnlyAgentToolResult {
  return {
    content: [{ type: "text", text: reason }],
    details: { blocked: true },
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
