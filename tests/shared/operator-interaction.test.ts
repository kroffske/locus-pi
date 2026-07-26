import { describe, expect, it } from "vitest";
import {
  isStaleInlineOperatorInteractionError,
  requestInlineOperatorInteraction,
  StaleInlineOperatorInteractionError,
  SupersededInlineOperatorInteractionError,
} from "../../extensions/_shared/operator-interaction.js";
import type { CustomUiComponent, CustomUiFactory, ExtensionContext } from "../../extensions/_shared/pi-api.js";

/**
 * Models Pi's interactive host faithfully in the one respect that matters here:
 * it owns a single editor slot, and mounting a component runs
 * `editorContainer.clear(); addChild(component)` — the component already there
 * is detached without `dispose()` and without its `custom()` promise ever
 * settling (`@earendil-works/pi-coding-agent`, interactive mode).
 */
function hostWithSingleEditorSlot() {
  const mounted: CustomUiComponent[] = [];
  const ui = {
    notify() {},
    async custom<T>(factory: CustomUiFactory<T>): Promise<T> {
      return await new Promise<T>((resolve) => {
        void Promise.resolve(
          factory({ requestRender() {} } as never, {} as never, {} as never, (value: T) => resolve(value)),
        ).then((component) => {
          mounted.length = 0;
          mounted.push(component);
        });
      });
    },
  };
  return { ui, mounted };
}

function component(): CustomUiComponent {
  return { render: () => [], invalidate: () => {} };
}

async function flush(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await Promise.resolve();
}

function contextFor(ui: unknown, id = "session-1"): ExtensionContext {
  return { ui, session: { id } } as unknown as ExtensionContext;
}

describe("inline operator interaction slot", () => {
  it("lets a later interaction open after the host silently replaced an earlier one", async () => {
    const { ui, mounted } = hostWithSingleEditorSlot();
    const ctx = contextFor(ui);

    // The fleet selector opens. The host will replace it without disposing it,
    // so its promise never settles on its own.
    let fleetError: unknown;
    const fleet = requestInlineOperatorInteraction(ctx, async () => component()).catch((error: unknown) => {
      fleetError = error;
    });
    await flush(() => mounted.length === 1);

    // A workflow clarification arrives and takes the slot.
    let questionMounted = false;
    const question = requestInlineOperatorInteraction(ctx, async (_tui, _theme, _keys, done) => {
      questionMounted = true;
      queueMicrotask(() => done("answered"));
      return component();
    });
    await flush(() => questionMounted);
    expect(questionMounted).toBe(true);
    expect(await question).toBe("answered");

    // The superseded caller is told, so it can drop its own UI state instead of
    // waiting on a component that is no longer on screen.
    await fleet;
    expect(fleetError).toBeInstanceOf(SupersededInlineOperatorInteractionError);
    expect(isStaleInlineOperatorInteractionError(fleetError)).toBe(true);

    // Reopening the fleet works — the deadlock this test exists for.
    let reopened = false;
    const again = requestInlineOperatorInteraction(ctx, async (_tui, _theme, _keys, done) => {
      reopened = true;
      queueMicrotask(() => done("closed"));
      return component();
    });
    await flush(() => reopened);
    expect(await again).toBe("closed");
  });

  it("leaves the live component alone when the newcomer cannot mount", async () => {
    const { ui, mounted } = hostWithSingleEditorSlot();
    const ctx = contextFor(ui, "session-2");

    let holderDone: ((value: string) => void) | undefined;
    const holder = requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      holderDone = done;
      return component();
    });
    await flush(() => mounted.length === 1);
    expect(holderDone).toBeDefined();

    // A caller whose lease is gone must not take a question off the screen.
    let refusedMounted = false;
    let refusedError: unknown;
    const refused = requestInlineOperatorInteraction(
      ctx,
      async () => {
        refusedMounted = true;
        return component();
      },
      { isCurrent: () => false },
    ).catch((error: unknown) => {
      refusedError = error;
    });

    await flush(() => false);
    expect(refusedMounted).toBe(false);

    holderDone?.("holder");
    expect(await holder).toBe("holder");
    await refused;
    expect(refusedError).toBeInstanceOf(StaleInlineOperatorInteractionError);
    expect(refusedError).not.toBeInstanceOf(SupersededInlineOperatorInteractionError);
  });

  it("keeps ordinary sequential interactions unchanged", async () => {
    const { ui } = hostWithSingleEditorSlot();
    const ctx = contextFor(ui, "session-3");

    const first = await requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      queueMicrotask(() => done("first"));
      return component();
    });
    const second = await requestInlineOperatorInteraction<string>(ctx, async (_tui, _theme, _keys, done) => {
      queueMicrotask(() => done("second"));
      return component();
    });

    expect([first, second]).toEqual(["first", "second"]);
  });
});
