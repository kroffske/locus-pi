import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  agentLiveStore,
  type AgentLiveExecutionHandle,
  type AgentLiveRow,
} from "../../_shared/agent-runtime/agent-sdk-host.js";
import type {
  AgentLiveTranscriptSnapshot,
  AgentTranscriptBlock,
  AgentTranscriptToolBlock,
} from "../../_shared/agent-runtime/agent-live-transcript.js";
import type { CustomUiComponent, CustomUiTui } from "../../_shared/host/pi-api.js";
import { RenderScheduler } from "../../_shared/host/render-scheduler.js";
import { agentLiveDisplayName, agentLiveTitle } from "../../_shared/agent-runtime/agent-live-panel.js";
import { errorMessage } from "../../_shared/host/error-text.js";
import { viewerExternalRows } from "../../_shared/operator/viewer-geometry.js";
import { acquireFleetViewedRow } from "../../_shared/agent-runtime/fleet-menu.js";
import type { DrillRoundsConfig } from "./drill-overlay.js";

type ViewerTui = CustomUiTui & { terminal?: { rows: number; columns: number; write?(data: string): void } };

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
  ExtensionEditorComponent?: new (
    tui: TUI,
    keybindings: unknown,
    title: string,
    prefill: string | undefined,
    onSubmit: (value: string) => void,
    onCancel: () => void,
    options?: { autocompleteMaxVisible?: number },
  ) => NativeInputComponent;
}

interface NativeInputComponent extends Component {
  children?: Component[];
  focused: boolean;
  handleInput(data: string): void;
  dispose?(): void;
}

type ViewerKeybindings = { matches(data: string, keybinding: string): boolean };

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

// Pi renders the default-loaded Locus footer beneath custom views.
const PI_HOST_FOOTER_ROWS = 1;
const MOUSE_SCROLL_LINES = 3;
const ENABLE_MOUSE_SCROLL = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE_SCROLL = "\u001b[?1000l\u001b[?1006l";

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

  createInput(
    tui: ViewerTui,
    keybindings: ViewerKeybindings | undefined,
    onSubmit: (value: string) => void,
    onCancel: () => void,
    theme: unknown,
  ): NativeInputComponent | undefined {
    const Input = this.module.ExtensionEditorComponent;
    if (typeof Input !== "function" || keybindings === undefined) return undefined;
    const input = new Input(tui as TUI, keybindings, "", undefined, onSubmit, onCancel, { autocompleteMaxVisible: 4 });
    const chrome = input.children;
    if (chrome?.length === 9) {
      chrome[6]!.render = (width) => [fitLine(themeText(theme, "muted", "↵ send · ⇧↵ newline"), width)];
      input.children = [chrome[0]!, chrome[4]!, chrome[6]!, chrome[8]!];
    }
    input.focused = true;
    return input;
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
  #historyOffset = 0;
  #lastHistoryLineCount = 0;
  #lastBodyHeight = 1;
  #input: NativeInputComponent | undefined;
  #inputSuppressedAtRows: number | undefined;
  #submitting = false;
  #inputNotice: string | undefined;
  readonly #title: string;
  readonly #unsubscribe: () => void;
  readonly #scheduler = new RenderScheduler(() => this.tui.requestRender());
  #storeAttached = true;
  #releaseMouseScroll = () => {};
  #releaseFleetViewedRow = () => {};
  #unregisterGlobal = () => {};

  constructor(
    private readonly execution: AgentLiveExecutionHandle,
    private readonly tui: ViewerTui,
    private readonly done: () => void,
    private readonly capability: AgentViewerCapability,
    private readonly rounds?: DrillRoundsConfig,
    private readonly keybindings?: ViewerKeybindings,
    private readonly theme?: unknown,
  ) {
    const row = agentLiveStore.rowForExecution(execution);
    this.#title = row === undefined ? "Agent execution unavailable" : formatAgentSessionStart(row);
    if (row !== undefined) this.#releaseFleetViewedRow = acquireFleetViewedRow(row.id);
    this.#selection = rounds?.active ?? 1;
    this.#releaseMouseScroll = acquireTerminalMouseScroll(this.tui);
    // Row-lifecycle handling stays synchronous and unthrottled — a vanished row
    // must close or detach the overlay at once. Only the repaint is coalesced.
    const requestRender = () => {
      if (this.#disposed) return;
      if (agentLiveStore.rowForExecution(this.execution) === undefined) {
        if (this.#isHistoricalRound()) this.#detachStore();
        else this.#close();
        return;
      }
      this.#scheduler.request();
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
    const header = this.#dividerLine(`${this.#title}${rounds === "" ? "" : `  ${rounds}`}`, safeWidth, "top");
    const snapshot = row?.transcript;
    const content = this.#isHistoricalRound()
      ? (this.rounds?.readBody(this.#selection) ?? [`Round ${this.#selection} is not available in the run journal.`])
      : this.#nativeLines(row, snapshot, safeWidth);
    const hostRows = finiteTerminalRows(this.tui.terminal?.rows);
    const terminalRows =
      hostRows === undefined ? undefined : Math.max(1, hostRows - PI_HOST_FOOTER_ROWS - viewerExternalRows());
    let input = this.#syncInput(terminalRows);
    let inputLines = input?.render(safeWidth).map((line) => fitLine(line, safeWidth)) ?? [];
    if (terminalRows !== undefined && inputLines.length > Math.max(0, terminalRows - 4)) {
      this.#suppressInputForRows(terminalRows);
      input = undefined;
      inputLines = [];
    }
    const footer = this.#dividerLine(this.#footerLabel(row, input !== undefined), safeWidth, "bottom");
    if (terminalRows === undefined) {
      return [header, ...content.map((line) => fitLine(line, safeWidth)), ...inputLines, footer];
    }
    if (terminalRows === 1) return [header];
    const bodyHeight = Math.max(0, terminalRows - inputLines.length - 2);
    if (this.#historyOffset > 0 && this.#lastHistoryLineCount > 0) {
      this.#historyOffset +=
        content.length - this.#lastHistoryLineCount + (this.#lastBodyHeight - Math.max(1, bodyHeight));
    }
    this.#historyOffset = Math.min(Math.max(0, content.length - bodyHeight), Math.max(0, this.#historyOffset));
    this.#lastHistoryLineCount = content.length;
    this.#lastBodyHeight = Math.max(1, bodyHeight);
    const visible = historyWindow(content, bodyHeight, this.#historyOffset).map((line) => fitLine(line, safeWidth));
    return [header, ...visible, ...inputLines, footer];
  }

  handleInput(data: string): void {
    if (this.#disposed) return;
    if (isClose(data) || (data === "q" && this.#input === undefined)) {
      this.#close();
      return;
    }
    const mouse = mouseEvent(data);
    if (mouse !== undefined) {
      if (mouse === "wheel-up") this.#scrollHistory(MOUSE_SCROLL_LINES);
      if (mouse === "wheel-down") this.#scrollHistory(-MOUSE_SCROLL_LINES);
      return;
    }
    if (this.#matches(data, "app.tools.expand", ["ctrl+o"])) {
      this.#expandedTools = !this.#expandedTools;
      this.capability.invalidate();
      this.tui.requestRender();
      return;
    }
    if (this.#matches(data, "tui.select.pageUp", ["pageup", "pageUp", "\u001b[5~"])) {
      this.#scrollHistory(Math.max(1, this.#lastBodyHeight - 1));
      return;
    }
    if (this.#matches(data, "tui.select.pageDown", ["pagedown", "pageDown", "\u001b[6~"])) {
      this.#scrollHistory(-Math.max(1, this.#lastBodyHeight - 1));
      return;
    }
    if (this.#input === undefined && (data === "home" || data === "\u001b[H")) {
      this.#historyOffset = Math.max(0, this.#lastHistoryLineCount - this.#lastBodyHeight);
      this.tui.requestRender();
      return;
    }
    if (this.#input === undefined && (data === "end" || data === "\u001b[F")) {
      this.#historyOffset = 0;
      this.tui.requestRender();
      return;
    }
    const selectedRound = this.#selectRound(data, this.#input === undefined);
    if (selectedRound !== undefined) {
      if (selectedRound === this.rounds?.active && agentLiveStore.rowForExecution(this.execution) === undefined) {
        this.#close();
        return;
      }
      this.#selection = selectedRound;
      this.#historyOffset = 0;
      this.tui.requestRender();
      return;
    }
    if (this.#input === undefined && data === "d") {
      this.#expandedTools = !this.#expandedTools;
      this.capability.invalidate();
      this.tui.requestRender();
      return;
    }
    if (this.#input !== undefined && !this.#submitting) this.#input.handleInput(data);
  }

  invalidate(): void {
    if (this.#disposed) return;
    this.capability.invalidate();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#releaseMouseScroll();
    this.#releaseMouseScroll = () => {};
    this.#releaseFleetViewedRow();
    this.#releaseFleetViewedRow = () => {};
    this.#input?.dispose?.();
    this.#input = undefined;
    this.#detachStore();
    this.#unregisterGlobal();
  }

  #detachStore(): void {
    if (!this.#storeAttached) return;
    this.#storeAttached = false;
    this.#unsubscribe();
    // Drop any coalesced repaint queued before the row went away.
    this.#scheduler.cancel();
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
      this.#dividerLine("REQUEST", width),
      ...requestLines(row?.request, width),
      this.#dividerLine("RUNTIME", width),
      ...transcript,
    ];
  }

  #dividerLine(label: string, width: number, style: DividerStyle = "section"): string {
    return themeText(this.theme, "borderMuted", dividerLine(label, width, style));
  }

  #isHistoricalRound(): boolean {
    return this.rounds !== undefined && this.#selection !== this.rounds.active;
  }

  #selectRound(data: string, allowPlainArrows: boolean): number | undefined {
    if (this.rounds === undefined || this.rounds.list.length <= 1) return undefined;
    const index = this.rounds.list.indexOf(this.#selection);
    if (data === "alt+left" || (allowPlainArrows && (data === "left" || data === "\u001b[D")))
      return this.rounds.list[Math.max(0, index - 1)];
    if (data === "alt+right" || (allowPlainArrows && (data === "right" || data === "\u001b[C")))
      return this.rounds.list[Math.min(this.rounds.list.length - 1, Math.max(0, index + 1))];
    if (allowPlainArrows && /^[1-9]$/u.test(data)) {
      const round = Number(data);
      return this.rounds.list.includes(round) ? round : undefined;
    }
    return undefined;
  }

  private roundsLabel(): string {
    if (this.rounds === undefined || this.rounds.list.length <= 1) return "";
    return `rounds: ${this.rounds.list.map((round) => (round === this.#selection ? `[${round}]` : String(round))).join(" ")}`;
  }

  #syncInput(terminalRows: number | undefined): NativeInputComponent | undefined {
    const available =
      !this.#isHistoricalRound() && agentLiveStore.canSendInputForExecution(this.execution) && !this.#disposed;
    if (!available) {
      this.#input?.dispose?.();
      this.#input = undefined;
      this.#inputSuppressedAtRows = undefined;
      return undefined;
    }
    if (this.#inputSuppressedAtRows !== undefined) {
      if (terminalRows === this.#inputSuppressedAtRows) return undefined;
      this.#inputSuppressedAtRows = undefined;
    }
    this.#input ??= this.capability.createInput(
      this.tui,
      this.keybindings,
      (value) => this.#submitInput(value),
      () => this.#close(),
      this.theme,
    );
    return this.#input;
  }

  #suppressInputForRows(terminalRows: number): void {
    this.#input?.dispose?.();
    this.#input = undefined;
    this.#inputSuppressedAtRows = terminalRows;
  }

  #submitInput(value: string): void {
    if (this.#submitting) return;
    this.#submitting = true;
    this.#inputNotice = "sending…";
    this.tui.requestRender();
    void agentLiveStore.sendInputForExecution(this.execution, value).then((result) => {
      if (this.#disposed) return;
      this.#submitting = false;
      this.#inputNotice = result.ok ? "message queued" : result.reason;
      if (result.ok) {
        this.#input?.dispose?.();
        this.#input = undefined;
        this.#historyOffset = 0;
      }
      this.tui.requestRender();
    });
  }

  #scrollHistory(delta: number): void {
    const maxOffset = Math.max(0, this.#lastHistoryLineCount - this.#lastBodyHeight);
    this.#historyOffset = Math.min(maxOffset, Math.max(0, this.#historyOffset + delta));
    this.tui.requestRender();
  }

  #matches(data: string, keybinding: string, fallbacks: readonly string[]): boolean {
    try {
      if (this.keybindings?.matches(data, keybinding) === true) return true;
    } catch {
      // A partial host keybinding object degrades to the stable raw-key fallback.
    }
    return fallbacks.includes(data);
  }

  #footerLabel(row: AgentLiveRow | undefined, hasInput: boolean): string {
    const notice = this.#inputNotice === undefined ? "" : `${this.#inputNotice} · `;
    const controls = hasInput
      ? "wheel/PgUp/PgDn history · Enter send"
      : this.#inputSuppressedAtRows === undefined
        ? "PgUp/PgDn history"
        : "resize terminal for input";
    const status = this.#isHistoricalRound() ? "history" : (row?.status ?? "unavailable");
    return `STATUS: ${status} · ${notice}Esc close · ${controls} · Ctrl+O tools:${this.#expandedTools ? "expanded" : "compact"}`;
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
const MOUSE_SCROLL_LEASES_PROPERTY = "__locusPiMouseScrollLeases";

type MouseScrollLease = { owners: number };

interface ActiveSessionViewerRegistry extends Set<() => void> {
  [MOUSE_SCROLL_LEASES_PROPERTY]?: Map<object, MouseScrollLease>;
}

function activeSessionViewers(): ActiveSessionViewerRegistry {
  const runtimeGlobal = globalThis as unknown as Record<symbol, unknown>;
  const existing = runtimeGlobal[ACTIVE_SESSION_VIEWERS_KEY];
  if (existing instanceof Set) return existing as ActiveSessionViewerRegistry;
  const registry: ActiveSessionViewerRegistry = new Set<() => void>();
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
  return data === "escape" || data === "\u001b";
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

type DividerStyle = "top" | "section" | "strong" | "bottom";

function dividerLine(label: string, width: number, style: DividerStyle = "section"): string {
  const strong = style === "strong" || style === "bottom";
  const fill = strong ? "═" : "─";
  const left = style === "top" ? "┌─ " : style === "strong" ? "╞═ " : style === "bottom" ? "╘═ " : "├─ ";
  if (width <= visibleWidth(left)) return fill.repeat(width);
  const labelWidth = width - visibleWidth(left) - 1;
  const fitted = truncateToWidth(label, labelWidth, "…");
  return `${left}${fitted} ${fill.repeat(Math.max(0, labelWidth - visibleWidth(fitted)))}`;
}

function themeText(theme: unknown, tone: "borderMuted" | "muted", text: string): string {
  if (!isRecord(theme) || typeof theme.fg !== "function") return text;
  return String(theme.fg.call(theme, tone, text));
}

function formatAgentSessionStart(row: AgentLiveRow): string {
  const start = `[agent ${agentLiveDisplayName(row)}] started work`;
  const title = agentLiveTitle(row);
  return title === "" ? start : `${start} · ${title}`;
}

function finiteTerminalRows(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(1, Math.floor(value));
}

function writeTerminalControl(tui: ViewerTui, sequence: string): boolean {
  const terminal = tui.terminal;
  if (terminal?.write === undefined) return false;
  try {
    terminal.write(sequence);
    return true;
  } catch {
    return false;
  }
}

function acquireTerminalMouseScroll(tui: ViewerTui): () => void {
  const terminal = tui.terminal;
  if (terminal?.write === undefined) return () => {};
  const registry = activeSessionViewers();
  const leases = terminalMouseScrollLeases(registry);
  const existing = leases.get(terminal);
  if (existing === undefined) {
    if (!writeTerminalControl(tui, ENABLE_MOUSE_SCROLL)) return () => {};
    leases.set(terminal, { owners: 1 });
  } else {
    existing.owners += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const lease = leases.get(terminal);
    if (lease === undefined) return;
    lease.owners -= 1;
    if (lease.owners > 0) return;
    leases.delete(terminal);
    writeTerminalControl(tui, DISABLE_MOUSE_SCROLL);
  };
}

function terminalMouseScrollLeases(registry: ActiveSessionViewerRegistry): Map<object, MouseScrollLease> {
  const existing = registry[MOUSE_SCROLL_LEASES_PROPERTY];
  if (existing !== undefined) return existing;
  const leases = new Map<object, MouseScrollLease>();
  Object.defineProperty(registry, MOUSE_SCROLL_LEASES_PROPERTY, {
    value: leases,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return leases;
}

function mouseEvent(data: string): "wheel-up" | "wheel-down" | "other" | undefined {
  const match = /^\u001b\[<(\d+);\d+;\d+[Mm]$/u.exec(data);
  if (match === null) return undefined;
  const button = Number(match[1]) & ~28;
  if (button === 64) return "wheel-up";
  if (button === 65) return "wheel-down";
  return "other";
}

function historyWindow(lines: readonly string[], height: number, offset: number): string[] {
  if (height <= 0) return [];
  const end = Math.max(0, lines.length - Math.max(0, offset));
  const start = Math.max(0, end - height);
  const visible = lines.slice(start, end);
  return [...Array.from({ length: height - visible.length }, () => ""), ...visible];
}
