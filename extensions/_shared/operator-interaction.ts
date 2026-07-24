import type { CustomUiFactory, ExtensionContext } from "./pi-api.js";

interface InlineInteractionQueue {
  tail: Promise<void>;
  pending: number;
}

interface SessionGeneration {
  owner: object;
  id: string;
}

export interface InlineOperatorInteractionRequest {
  /**
   * Optional caller-owned lease check. It runs after this request reaches the
   * front of the queue and immediately before Pi mounts the component.
   */
  isCurrent?: () => boolean;
}

export class StaleInlineOperatorInteractionError extends Error {
  constructor() {
    super("Inline operator interaction was dropped because its session lease is stale.");
    this.name = "StaleInlineOperatorInteractionError";
  }
}

const queuesByOwner = new WeakMap<object, Map<string, InlineInteractionQueue>>();

/**
 * Canonical blocking interaction surface for locus-pi.
 *
 * Pi's non-overlay custom UI replaces the editor container, so the interaction
 * stays anchored at the command line and disappears when `done()` resolves.
 * Raw overlay mode is deliberately centralized away from feature callers:
 * overlays cover scrollback and can leave the triggering key on a competing
 * global route while the focused component is closing.
 */
export const INLINE_OPERATOR_INTERACTION_OPTIONS = Object.freeze({
  overlay: false as const,
});

export async function requestInlineOperatorInteraction<T>(
  ctx: ExtensionContext,
  factory: CustomUiFactory<T>,
  request: InlineOperatorInteractionRequest = {},
): Promise<T> {
  const generation = captureSessionGeneration(ctx);
  const queues = queueMap(generation.owner);
  const queue = queues.get(generation.id) ?? { tail: Promise.resolve(), pending: 0 };
  queues.set(generation.id, queue);

  const available = queue.tail;
  let resolveSlot!: () => void;
  queue.tail = new Promise<void>((resolve) => {
    resolveSlot = resolve;
  });
  let slotReleased = false;
  const releaseSlot = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    resolveSlot();
  };
  queue.pending += 1;

  await available;
  try {
    if (!sessionLeaseIsCurrent(ctx, generation, request.isCurrent)) {
      throw new StaleInlineOperatorInteractionError();
    }

    const custom = ctx.ui.custom;
    if (custom === undefined) {
      throw new Error("Inline operator interaction is unavailable because this Pi host does not expose custom UI.");
    }
    return await (custom.call(
      ctx.ui,
      wrapFactoryDisposal(factory, releaseSlot),
      INLINE_OPERATOR_INTERACTION_OPTIONS,
    ) as Promise<T>);
  } finally {
    releaseSlot();
    queue.pending -= 1;
    if (queue.pending === 0 && queues.get(generation.id) === queue) {
      queues.delete(generation.id);
    }
  }
}

export function isStaleInlineOperatorInteractionError(error: unknown): error is StaleInlineOperatorInteractionError {
  return error instanceof StaleInlineOperatorInteractionError;
}

function captureSessionGeneration(ctx: ExtensionContext): SessionGeneration {
  return {
    owner: currentGenerationOwner(ctx),
    id: currentSessionId(ctx) ?? "session-unknown",
  };
}

function queueMap(owner: object): Map<string, InlineInteractionQueue> {
  const existing = queuesByOwner.get(owner);
  if (existing !== undefined) return existing;
  const created = new Map<string, InlineInteractionQueue>();
  queuesByOwner.set(owner, created);
  return created;
}

function sessionLeaseIsCurrent(
  ctx: ExtensionContext,
  captured: SessionGeneration,
  callerGuard: (() => boolean) | undefined,
): boolean {
  try {
    const currentOwner = currentGenerationOwner(ctx);
    if (currentOwner !== captured.owner) return false;
    if ((currentSessionId(ctx) ?? "session-unknown") !== captured.id) return false;
    return callerGuard?.() ?? true;
  } catch {
    // Pi invalidates captured contexts after session replacement/reload.
    return false;
  }
}

function currentGenerationOwner(ctx: ExtensionContext): object {
  if (isObject(ctx.sessionManager)) return ctx.sessionManager;
  return ctx.ui;
}

function wrapFactoryDisposal<T>(factory: CustomUiFactory<T>, releaseSlot: () => void): CustomUiFactory<T> {
  return async (tui, theme, keybindings, done) => {
    const component = await factory(tui, theme, keybindings, done);
    const dispose = component.dispose?.bind(component);
    let disposed = false;
    component.dispose = () => {
      if (disposed) return;
      disposed = true;
      try {
        dispose?.();
      } finally {
        // Pi can dispose a replaced session component without resolving the
        // old custom() promise. Once disposed, it no longer owns editor focus.
        releaseSlot();
      }
    };
    return component;
  };
}

function currentSessionId(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager?.getSessionId?.() ?? ctx.session?.id;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
