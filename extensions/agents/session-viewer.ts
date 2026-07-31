import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  agentLiveStore,
  type AgentLiveExecutionHandle,
  type AgentLiveRow,
} from "../_shared/agent-runtime/agent-sdk-host.js";
import type {
  AgentLiveTranscriptSnapshot,
  AgentTranscriptBlock,
  AgentTranscriptToolBlock,
} from "../_shared/agent-runtime/agent-live-transcript.js";
import type { CustomUiComponent, CustomUiTui } from "../_shared/host/pi-api.js";
import { formatAgentDrillTitle } from "../_shared/agent-runtime/agent-live-panel.js";
import { errorMessage } from "../_shared/host/error-text.js";
import type { DrillRoundsConfig } from "./drill-overlay.js";

interface ViewerTui extends CustomUiTui {
  terminal?: { rows: number; columns: number };
}

interface NativeComponentModule {
  AssistantMessageComponent: new (
    message?: unknown,
    hideThinkingBlock?: boolean,
    markdownTheme?: unknown,
    hiddenThinkingLabel?: string,
    outputPad?: number,
  ) => Component & {
    updateContent(message: unknown): void;
  };
  ToolExecutionComponent: new (
    toolName: string,
    toolCallId: string,
    args: unknown,
    options: { showImages?: boolean },
    toolDefinition: undefined,
    ui: TUI,
    cwd: string,
  ) => Component & {
    updateArgs(args: unknown): void;
    markExecutionStarted(): void;
    setArgsComplete(): void;
    updateResult(result: unknown, isPartial?: boolean): void;
    setExpanded(expanded: boolean): void;
  };
}

type NativeToolComponent = Component & {
  updateArgs(args: unknown): void;
  markExecutionStarted(): void;
  setArgsComplete(): void;
  updateResult(result: unknown, isPartial?: boolean): void;
  setExpanded(expanded: boolean): void;
};

type NativeComponentEntry =
  | { kind: "assistant"; component: Component & { updateContent(message: unknown): void }; messageKey: string }
  | {
      kind: "tool";
      component: NativeToolComponent;
      argsKey: string;
      executionStarted: boolean;
      argsComplete: boolean;
      resultKey?: string;
      expanded: boolean;
    };

export type AgentViewerCapabilityResult =
  { ok: true; capability: AgentViewerCapability } | { ok: false; reason: string };

/** One guarded Pi-version boundary for both public native components. */
export class AgentViewerCapability {
  readonly #components = new Map<string, NativeComponentEntry>();

  constructor(private readonly module: NativeComponentModule) {}

  render(blocks: readonly AgentTranscriptBlock[], tui: ViewerTui, width: number, expanded: boolean): string[] {
    const liveIds = new Set(blocks.map((block) => block.id));
    for (const id of this.#components.keys()) if (!liveIds.has(id)) this.#components.delete(id);
    return blocks.flatMap((block) => this.#component(block, tui, expanded).render(width));
  }

  invalidate(): void {
    for (const entry of this.#components.values()) entry.component.invalidate();
  }

  #component(block: AgentTranscriptBlock, tui: ViewerTui, expanded: boolean): Component {
    const existing = this.#components.get(block.id);
    if (block.kind === "assistant") {
      const messageKey = fingerprint(block.message);
      if (existing?.kind === "assistant") {
        if (existing.messageKey !== messageKey) {
          existing.component.updateContent(block.message);
          existing.messageKey = messageKey;
        }
        return existing.component;
      }
      const component = new this.module.AssistantMessageComponent(block.message, false, undefined, "Thinking...", 1);
      this.#components.set(block.id, { kind: "assistant", component, messageKey });
      return component;
    }
    if (existing?.kind === "tool") {
      applyToolTransition(existing, block, expanded);
      return existing.component;
    }
    const component = new this.module.ToolExecutionComponent(
      block.toolName,
      block.toolCallId,
      block.args,
      { showImages: false },
      undefined,
      tui as TUI,
      block.cwd,
    );
    const entry: Extract<NativeComponentEntry, { kind: "tool" }> = {
      kind: "tool",
      component,
      argsKey: fingerprint(block.args),
      executionStarted: false,
      argsComplete: false,
      expanded: false,
    };
    applyToolTransition(entry, block, expanded);
    this.#components.set(block.id, entry);
    return component;
  }
}

export async function loadAgentViewerCapability(): Promise<AgentViewerCapabilityResult> {
  try {
    const module: unknown = await import("@earendil-works/pi-coding-agent");
    return createAgentViewerCapability(module);
  } catch (error) {
    return { ok: false, reason: `Pi viewer components could not load: ${errorMessage(error)}` };
  }
}

export function createAgentViewerCapability(module: unknown): AgentViewerCapabilityResult {
  if (!isNativeComponentModule(module)) {
    return {
      ok: false,
      reason: "Installed Pi host does not export AssistantMessageComponent and ToolExecutionComponent.",
    };
  }
  return { ok: true, capability: new AgentViewerCapability(module) };
}

export class AgentSessionViewer implements CustomUiComponent {
  #disposed = false;
  #closed = false;
  #expandedTools = false;
  #selection: number;
  readonly #title: string;
  readonly #unsubscribe: () => void;
  #storeAttached = true;
  #unregisterGlobal = () => {};

  constructor(
    private readonly execution: AgentLiveExecutionHandle,
    private readonly tui: ViewerTui,
    private readonly done: () => void,
    private readonly capability: AgentViewerCapability,
    private readonly rounds?: DrillRoundsConfig,
  ) {
    const row = agentLiveStore.rowForExecution(execution);
    this.#title = row === undefined ? "Agent execution unavailable" : formatAgentDrillTitle(row);
    this.#selection = rounds?.active ?? 1;
    const requestRender = () => {
      if (this.#disposed) return;
      if (agentLiveStore.rowForExecution(this.execution) === undefined) {
        if (this.#isHistoricalRound()) this.#detachStore();
        else this.#close();
        return;
      }
      this.tui.requestRender();
    };
    agentLiveStore.emitter.on("change", requestRender);
    this.#unsubscribe = () => agentLiveStore.emitter.off("change", requestRender);
    const dispose = () => this.dispose();
    activeSessionViewers().add(dispose);
    this.#unregisterGlobal = () => activeSessionViewers().delete(dispose);
  }

  render(width: number): string[] {
    if (this.#disposed) return [];
    const safeWidth = Math.max(1, Math.floor(width));
    const row = agentLiveStore.rowForExecution(this.execution);
    if (!this.#isHistoricalRound() && row === undefined) {
      this.#close();
      return [];
    }
    const rounds = this.roundsLabel();
    const header = dividerLine(`${this.#title}${rounds === "" ? "" : `  ${rounds}`}`, safeWidth);
    const snapshot = row?.transcript;
    const content = this.#isHistoricalRound()
      ? (this.rounds?.readBody(this.#selection) ?? [`Round ${this.#selection} is not available in the run journal.`])
      : this.#nativeLines(row, snapshot, safeWidth);
    const visible = content.map((line) => fitLine(line, safeWidth));
    const footer = dividerLine(`Esc/q close · d tools:${this.#expandedTools ? "expanded" : "compact"}`, safeWidth);
    return [header, ...visible, footer];
  }

  handleInput(data: string): void {
    if (this.#disposed) return;
    if (isClose(data)) {
      this.#close();
      return;
    }
    const selectedRound = this.#selectRound(data);
    if (selectedRound !== undefined) {
      if (selectedRound === this.rounds?.active && agentLiveStore.rowForExecution(this.execution) === undefined) {
        this.#close();
        return;
      }
      this.#selection = selectedRound;
      this.tui.requestRender();
      return;
    }
    if (data === "d") {
      this.#expandedTools = !this.#expandedTools;
      this.capability.invalidate();
      this.tui.requestRender();
      return;
    }
  }

  invalidate(): void {
    if (this.#disposed) return;
    this.capability.invalidate();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#detachStore();
    this.#unregisterGlobal();
  }

  #detachStore(): void {
    if (!this.#storeAttached) return;
    this.#storeAttached = false;
    this.#unsubscribe();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.dispose();
    this.done();
  }

  get expandedTools(): boolean {
    return this.#expandedTools;
  }

  #nativeLines(
    row: AgentLiveRow | undefined,
    snapshot: AgentLiveTranscriptSnapshot | undefined,
    width: number,
  ): string[] {
    const transcript =
      snapshot === undefined || snapshot.blocks.length === 0
        ? noTranscriptLines(row)
        : [
            ...(snapshot.omittedBlockCount > 0 ? [`… ${snapshot.omittedBlockCount} earlier block(s) omitted`] : []),
            ...this.capability.render(snapshot.blocks, this.tui, width, this.#expandedTools),
          ];
    return [
      dividerLine("Request", width),
      ...requestLines(row?.request, width),
      dividerLine("Agent history", width),
      ...transcript,
    ];
  }

  #isHistoricalRound(): boolean {
    return this.rounds !== undefined && this.#selection !== this.rounds.active;
  }

  #selectRound(data: string): number | undefined {
    if (this.rounds === undefined || this.rounds.list.length <= 1) return undefined;
    const index = this.rounds.list.indexOf(this.#selection);
    if (data === "left" || data === "\u001b[D") return this.rounds.list[Math.max(0, index - 1)];
    if (data === "right" || data === "\u001b[C")
      return this.rounds.list[Math.min(this.rounds.list.length - 1, Math.max(0, index + 1))];
    if (/^[1-9]$/u.test(data)) {
      const round = Number(data);
      return this.rounds.list.includes(round) ? round : undefined;
    }
    return undefined;
  }

  private roundsLabel(): string {
    if (this.rounds === undefined || this.rounds.list.length <= 1) return "";
    return `rounds: ${this.rounds.list.map((round) => (round === this.#selection ? `[${round}]` : String(round))).join(" ")}`;
  }
}

function noTranscriptLines(row: AgentLiveRow | undefined): string[] {
  if (row === undefined) return ["Agent row is no longer available."];
  const finalAnswer = row.finalAnswer?.trim();
  if (finalAnswer !== undefined && finalAnswer !== "") {
    const recordedText =
      row.status === "cancelled"
        ? "recorded cancellation text"
        : row.status === "error"
          ? "recorded failure text"
          : row.status === "done"
            ? "recorded terminal text"
            : "recorded row text";
    return [
      `No child transcript is available; showing ${recordedText}.`,
      ...(row.resultArtifact === undefined ? [] : [`source: ${row.resultArtifact}`]),
      "",
      ...finalAnswer.split(/\r?\n/u),
      ...row.errors.map((error) => `error: ${error}`),
    ];
  }
  if (row.errors.length > 0) {
    return ["No child transcript or readable answer is available.", ...row.errors.map((error) => `error: ${error}`)];
  }
  switch (row.status) {
    case "queued":
      return ["Agent is queued; no assistant output yet."];
    case "working":
      return ["Agent is working; waiting for assistant output…"];
    case "done":
      return ["Agent completed without assistant output."];
    case "cancelled":
      return ["Agent was cancelled before assistant output."];
    case "error":
      return ["Agent failed before assistant output."];
  }
}

const ACTIVE_SESSION_VIEWERS_KEY = Symbol.for("locus-pi.active-agent-session-viewers.v1");

function activeSessionViewers(): Set<() => void> {
  const runtimeGlobal = globalThis as unknown as Record<symbol, unknown>;
  const existing = runtimeGlobal[ACTIVE_SESSION_VIEWERS_KEY];
  if (existing instanceof Set) return existing as Set<() => void>;
  const registry = new Set<() => void>();
  Object.defineProperty(runtimeGlobal, ACTIVE_SESSION_VIEWERS_KEY, {
    value: registry,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return registry;
}

export function disposeAgentSessionViewers(): void {
  for (const dispose of [...activeSessionViewers()]) dispose();
}

/** True while the expanded viewer owns terminal input and Escape. */
export function hasActiveAgentSessionViewer(): boolean {
  return activeSessionViewers().size > 0;
}

function applyToolTransition(
  entry: Extract<NativeComponentEntry, { kind: "tool" }>,
  block: AgentTranscriptToolBlock,
  expanded: boolean,
): void {
  const argsKey = fingerprint(block.args);
  if (entry.argsKey !== argsKey) {
    entry.component.updateArgs(block.args);
    entry.argsKey = argsKey;
  }
  if (block.executionStarted && !entry.executionStarted) {
    entry.component.markExecutionStarted();
    entry.executionStarted = true;
  }
  if (block.argsComplete && !entry.argsComplete) {
    entry.component.setArgsComplete();
    entry.argsComplete = true;
  }
  const resultKey = block.result === undefined ? undefined : fingerprint([block.result, block.isPartial]);
  if (resultKey !== undefined && entry.resultKey !== resultKey) {
    entry.component.updateResult(block.result, block.isPartial);
    entry.resultKey = resultKey;
  }
  if (entry.expanded !== expanded) {
    entry.component.setExpanded(expanded);
    entry.expanded = expanded;
  }
}

function isNativeComponentModule(value: unknown): value is NativeComponentModule {
  return (
    isRecord(value) &&
    typeof value.AssistantMessageComponent === "function" &&
    typeof value.ToolExecutionComponent === "function"
  );
}

function fitLine(value: string, width: number): string {
  const line = truncateToWidth(value, width, "…");
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function isClose(data: string): boolean {
  return data === "q" || data === "escape" || data === "\u001b";
}
function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function requestLines(request: string | undefined, width: number): string[] {
  if (request === undefined) return ["Original request is unavailable for this retained row."];
  const safe = request
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "�");
  return safe.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
}

function dividerLine(label: string, width: number): string {
  if (width < 7) return "─".repeat(width);
  const left = "── ";
  const right = " ──";
  const labelWidth = width - visibleWidth(left) - visibleWidth(right);
  const fitted = truncateToWidth(label, labelWidth, "…");
  return `${left}${fitted}${"─".repeat(Math.max(0, labelWidth - visibleWidth(fitted)))}${right}`;
}
