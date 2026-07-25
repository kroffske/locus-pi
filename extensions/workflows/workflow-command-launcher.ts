import type { ExtensionAPI, ExtensionContext } from "../_shared/pi-api.js";
import { getProjectRoot, getSessionId } from "../_shared/pi-api.js";
import type { WorkflowContinuation } from "../_shared/workflow-artifacts.js";
import type { WorkflowHandoffClaimLease } from "../_shared/workflow-handoff.js";
import type { WorkflowJournalLine } from "../_shared/workflow-runtime.js";
import {
  runWorkflowScript,
  type ResolvedWorkflowTarget,
  type RunWorkflowScriptOptions,
  type RunWorkflowScriptResult,
} from "../_shared/workflow-runner.js";
import {
  workflowBackgroundRunRegistry,
  type WorkflowBackgroundLaunchResult,
  type WorkflowBackgroundRunContext,
  type WorkflowBackgroundRunRegistry,
  type WorkflowBackgroundStopResult,
  type WorkflowSessionLease,
} from "./background-run-registry.js";
import { readWorkflowMeta, type WorkflowMetaPhase } from "./workflow-catalog.js";

export interface WorkflowCommandLaunchRequest {
  ctx: ExtensionContext;
  scriptRef: string;
  target?: ResolvedWorkflowTarget;
  input?: string;
  resumeFromRunId?: string;
  continuation?: WorkflowContinuation;
  operatorHandoffClaim?: WorkflowHandoffClaimLease;
  waitForIdle?: () => Promise<void>;
}

export type WorkflowCommandLaunchResult =
  { status: "started" } | { status: "busy"; owner: string } | { status: "stale" };

export interface WorkflowCommandLaunchPreparation {
  /** Stage titles plus their planned detail, read statically from `meta.phases`. */
  declaredStages: WorkflowMetaPhase[];
  hasUI: boolean;
}

export interface WorkflowCommandLaunchObserver {
  onRunStart(runId: string): void;
  onEvent(line: WorkflowJournalLine): void;
  onResult(result: RunWorkflowScriptResult, isCurrent: () => boolean): void | Promise<void>;
  onError(error: unknown): void;
  onFinally(): void;
  onRejected(): void;
}

export interface WorkflowCommandLauncherOptions {
  pi: ExtensionAPI;
  createObserver(
    request: WorkflowCommandLaunchRequest,
    preparation: WorkflowCommandLaunchPreparation,
  ): WorkflowCommandLaunchObserver;
  onTerminal(request: WorkflowCommandLaunchRequest, isCurrent: () => boolean): void;
  backgroundRuns?: WorkflowBackgroundRunRegistry;
  runScript?: (options: RunWorkflowScriptOptions) => Promise<RunWorkflowScriptResult>;
}

export interface WorkflowCommandLauncher {
  startSession(ctx: ExtensionContext): WorkflowSessionLease;
  currentLease(ctx: ExtensionContext): WorkflowSessionLease | undefined;
  isCurrent(lease: WorkflowSessionLease): boolean;
  hasActiveCommandRun(): boolean;
  launch(request: WorkflowCommandLaunchRequest): WorkflowCommandLaunchResult;
  attach<T>(
    ctx: ExtensionContext,
    hostSignal: AbortSignal,
    execute: (background: WorkflowBackgroundRunContext) => Promise<T>,
  ): WorkflowBackgroundLaunchResult<T>;
  stop(lease: WorkflowSessionLease, selector?: string): WorkflowBackgroundStopResult;
  shutdown(): void;
}

export function createWorkflowCommandLauncher(options: WorkflowCommandLauncherOptions): WorkflowCommandLauncher {
  const backgroundRuns = options.backgroundRuns ?? workflowBackgroundRunRegistry();
  let sessionLease: WorkflowSessionLease | undefined;
  let sessionRevoked = false;

  const startSession = (ctx: ExtensionContext): WorkflowSessionLease => {
    sessionRevoked = false;
    sessionLease = backgroundRuns.startSession(getProjectRoot(ctx), workflowSessionId(ctx));
    return sessionLease;
  };
  const currentLease = (ctx: ExtensionContext): WorkflowSessionLease | undefined => {
    if (sessionRevoked) return undefined;
    if (sessionLease === undefined || !backgroundRuns.isCurrent(sessionLease)) return startSession(ctx);
    return sessionLease;
  };

  return {
    startSession,
    currentLease,
    isCurrent: (lease) => backgroundRuns.isCurrent(lease),
    hasActiveCommandRun: () =>
      sessionLease !== undefined &&
      backgroundRuns.isCurrent(sessionLease) &&
      backgroundRuns.active(sessionLease) !== undefined,
    launch(request) {
      const lease = currentLease(request.ctx);
      if (lease === undefined) return { status: "stale" };
      const active = backgroundRuns.active(lease);
      if (active !== undefined) return { status: "busy", owner: active.runId ?? active.launchId };

      const observer = options.createObserver(request, {
        hasUI: request.ctx.hasUI === true,
        declaredStages: request.target === undefined ? [] : readWorkflowMeta(request.target.path).phases,
      });
      const launched = backgroundRuns.launch<RunWorkflowScriptResult>(lease, async (background) => {
        const isCurrent = (): boolean => background.isCurrent();
        try {
          const result = await (options.runScript ?? runWorkflowScript)({
            pi: options.pi,
            ctx: request.ctx,
            signal: background.signal,
            script: request.scriptRef,
            ...(request.input === undefined ? {} : { input: request.input }),
            ...(request.resumeFromRunId === undefined ? {} : { resumeFromRunId: request.resumeFromRunId }),
            ...(request.continuation === undefined ? {} : { continuation: request.continuation }),
            ...(request.operatorHandoffClaim === undefined
              ? {}
              : { operatorHandoffClaim: request.operatorHandoffClaim }),
            onRunStart: ({ runId }) => {
              background.setRunId(runId);
              if (isCurrent()) observer.onRunStart(runId);
            },
            onEvent: (line) => {
              if (isCurrent()) observer.onEvent(line);
            },
          });
          if (isCurrent()) await observer.onResult(result, isCurrent);
          return result;
        } catch (error) {
          if (isCurrent()) observer.onError(error);
          throw error;
        } finally {
          if (isCurrent()) observer.onFinally();
        }
      });
      if (!launched.ok) {
        observer.onRejected();
        return launched.reason === "stale-lease"
          ? { status: "stale" }
          : { status: "busy", owner: launched.active?.runId ?? launched.active?.launchId ?? "current run" };
      }
      void launched.run.terminal.then(() => {
        options.onTerminal(request, () => backgroundRuns.isCurrent(lease));
      });
      return { status: "started" };
    },
    attach<T>(
      ctx: ExtensionContext,
      hostSignal: AbortSignal,
      execute: (background: WorkflowBackgroundRunContext) => Promise<T>,
    ) {
      const lease = currentLease(ctx);
      return lease === undefined
        ? ({ ok: false, reason: "stale-lease" } as const)
        : backgroundRuns.attach(lease, hostSignal, execute);
    },
    stop: (lease, selector) => backgroundRuns.stop(lease, selector),
    shutdown() {
      sessionRevoked = true;
      if (sessionLease !== undefined) backgroundRuns.shutdown(sessionLease);
    },
  };
}

function workflowSessionId(ctx: ExtensionContext): string {
  const sessionId = getSessionId(ctx);
  return sessionId.trim() === "" ? "unknown-session" : sessionId;
}
