import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CustomUiComponent, CustomUiTui } from "../_shared/pi-api.js";

const CONTENT_LINE_COUNT = 18;
const LARGE_SCROLL_STEP = 9;

/** Static catalog/inspect text overlay. Live agent viewing belongs to AgentSessionViewer. */
export class ScrollableTextOverlay implements CustomUiComponent {
  #scroll = 0;

  constructor(
    private readonly title: string | (() => string),
    private readonly bodyLines: () => string[],
    protected readonly tui: CustomUiTui,
    private readonly done: () => void,
  ) {}

  render(width: number): string[] {
    const budget = Math.max(0, Math.floor(width));
    if (budget === 0) return [""];
    const body = this.bodyLines();
    const maxScroll = Math.max(0, body.length - CONTENT_LINE_COUNT);
    this.#scroll = clamp(this.#scroll, 0, maxScroll);
    const visibleBody = body.slice(this.#scroll, this.#scroll + CONTENT_LINE_COUNT);
    const footer = `q/esc close • ↑/k ↓/j scroll • ${this.#scroll + 1}-${Math.min(body.length, this.#scroll + visibleBody.length)}/${body.length}`;
    const title = typeof this.title === "function" ? this.title() : this.title;
    return frameLines(title, visibleBody, footer, budget);
  }

  handleInput(data: string): void {
    const key = normalizeKey(data);
    if (key === "close") {
      this.done();
      return;
    }
    const maxScroll = Math.max(0, this.bodyLines().length - CONTENT_LINE_COUNT);
    if (key === "up") this.#scroll -= 1;
    else if (key === "down") this.#scroll += 1;
    else if (key === "pageUp") this.#scroll -= LARGE_SCROLL_STEP;
    else if (key === "pageDown") this.#scroll += LARGE_SCROLL_STEP;
    else if (key === "home") this.#scroll = 0;
    else if (key === "end") this.#scroll = maxScroll;
    else return;
    this.#scroll = clamp(this.#scroll, 0, maxScroll);
    this.tui.requestRender();
  }

  invalidate(): void {}
}

/** Historical workflow rounds stay a journal-backed text fallback in the native viewer. */
export interface DrillRoundsConfig {
  active: number;
  list: number[];
  readBody: (round: number) => string[] | undefined;
}

function normalizeKey(data: string): "close" | "up" | "down" | "pageUp" | "pageDown" | "home" | "end" | "unknown" {
  if (data === "q" || data === "escape" || data === "\u001b") return "close";
  if (data === "up" || data === "k" || data === "\u001b[A") return "up";
  if (data === "down" || data === "j" || data === "\u001b[B") return "down";
  if (data === "pageUp" || data === "pageup" || data === "shift+up" || data === "\u001b[5~" || data === "\u001b[1;2A") return "pageUp";
  if (data === "pageDown" || data === "pagedown" || data === "shift+down" || data === "\u001b[6~" || data === "\u001b[1;2B") return "pageDown";
  if (data === "home" || data === "\u001b[H" || data === "\u001b[1~") return "home";
  if (data === "end" || data === "\u001b[F" || data === "\u001b[4~") return "end";
  return "unknown";
}

function frameLines(title: string, body: string[], footer: string, width: number): string[] {
  if (width === 1) return ["┌", ...body.map(() => "│"), "└"];
  if (width === 2) return ["┌┐", ...body.map(() => "││"), "└┘"];
  const innerWidth = width - 2;
  const horizontal = "─".repeat(innerWidth);
  const framed = (line: string) => `│${fitLine(line, innerWidth)}│`;
  return [
    `┌${horizontal}┐`,
    framed(title),
    `├${horizontal}┤`,
    ...body.map(framed),
    `├${horizontal}┤`,
    framed(footer),
    `└${horizontal}┘`,
  ];
}

function fitLine(line: string, width: number): string {
  const fitted = truncateToWidth(line, width, "…");
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
