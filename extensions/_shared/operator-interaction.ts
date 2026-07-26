import type { CustomUiFactory, ExtensionContext } from "./pi-api.js";

interface InlineInteractionQueue {
  tail: Promise<void>;
  pending: number;
  /**
   * Releases whoever currently owns the single editor slot. A newer request
   * calls it instead of waiting behind a holder Pi may already have replaced.
   */
  releaseCurrent?: (() => void) | undefined;
  /** Fails the current holder's returned promise once it has been superseded. */
  supersedeCurrent?: (() => void) | undefined;
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
  constructor(message = "Inline operator interaction was dropped because its session lease is stale.") {
    super(message);
    this.name = "StaleInlineOperatorInteractionError";
  }
}

/**
 * A newer interaction took the host's single editor slot. It extends the stale
 * error because every caller already abandons that one quietly, and the correct
 * response is identical: this interaction is no longer on screen.
 */
export class SupersededInlineOperatorInteractionError extends StaleInlineOperatorInteractionError {
  constructor() {
    super("Inline operator interaction was superseded by a newer one.");
    this.name = "SupersededInlineOperatorInteractionError";
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
    queue.pending -= 1;
    if (queue.releaseCurrent === releaseSlot) {
      queue.releaseCurrent = undefined;
      queue.supersedeCurrent = undefined;
    }
    resolveSlot();
    if (queue.pending === 0 && queues.get(generation.id) === queue) {
      queues.delete(generation.id);
    }
  };
  let supersede!: () => void;
  const superseded = new Promise<never>((_resolve, reject) => {
    supersede = () => reject(new SupersededInlineOperatorInteractionError());
  });
  // Nothing observes this until the race below, and an unobserved rejection
  // would surface as an unhandled promise.
  superseded.catch(() => {});
  queue.pending += 1;

  // Waiting for the slot stays bounded by the previous holder's own lifetime,
  // except that the holder may already be gone: Pi owns one editor slot, and
  // mounting a component runs `editorContainer.clear()` — a component replaced
  // that way is never disposed and its promise never settles. Waiting on it
  // would block every later interaction for the rest of the session. So a
  // request that is genuinely ready to mount takes the slot instead of waiting.
  // Sole request: nothing to take the slot from, and the wait stays exactly as
  // cheap as it was. Contended: race, so a holder Pi already replaced cannot
  // strand the slot.
  if (queue.pending === 1) await available;
  else await Promise.race([available, whenReadyToMount(ctx, generation, request)]);
  try {
    if (!sessionLeaseIsCurrent(ctx, generation, request.isCurrent)) {
      throw new StaleInlineOperatorInteractionError();
    }

    const custom = ctx.ui.custom;
    if (custom === undefined) {
      throw new Error("Inline operator interaction is unavailable because this Pi host does not expose custom UI.");
    }

    // Only now, with this request certain to mount, is the previous holder
    // retired — a request that declined to mount must never take a live
    // component off the operator's screen.
    const releasePrevious = queue.releaseCurrent;
    const supersedePrevious = queue.supersedeCurrent;
    queue.releaseCurrent = releaseSlot;
    queue.supersedeCurrent = supersede;
    if (releasePrevious !== releaseSlot) {
      releasePrevious?.();
      supersedePrevious?.();
    }

    // The host's promise for a replaced component never settles, and its own
    // close path would restore the editor over whatever replaced it. So the
    // superseded caller is failed here instead, and the stale host promise is
    // left pending.
    return await Promise.race([
      custom.call(ctx.ui, wrapFactoryDisposal(factory, releaseSlot), INLINE_OPERATOR_INTERACTION_OPTIONS) as Promise<T>,
      superseded,
    ]);
  } finally {
    releaseSlot();
  }
}

/**
 * Resolves once this request is both allowed and able to mount, and never
 * resolves otherwise. Raced against the queue, it decides which of two rules
 * applies: a request that can mount takes the slot from the current holder —
 * the newest component is what the host shows anyway — while a request that
 * cannot (stale lease, no custom UI) waits its turn and leaves whatever is on
 * screen alone.
 */
async function whenReadyToMount(
  ctx: ExtensionContext,
  generation: SessionGeneration,
  request: InlineOperatorInteractionRequest,
): Promise<void> {
  // One turn of the microtask queue: enough for a holder that is settling right
  // now to release, and short enough that a replaced holder does not strand the
  // slot. Everything here is synchronous host state, so nothing is polled.
  await Promise.resolve();
  if (!sessionLeaseIsCurrent(ctx, generation, request.isCurrent)) return await new Promise<void>(() => {});
  if (ctx.ui.custom === undefined) return await new Promise<void>(() => {});
}

export function isSupersededInlineOperatorInteractionError(
  error: unknown,
): error is SupersededInlineOperatorInteractionError {
  return error instanceof SupersededInlineOperatorInteractionError;
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
