import { describe, expect, it, vi } from "vitest";
import type { CustomUiComponent, CustomUiFactory } from "../../../extensions/_shared/pi-api.js";
import {
  requestInlineOperatorInteraction,
  StaleInlineOperatorInteractionError,
} from "../../../extensions/_shared/operator-interaction.js";
import { createHarness } from "../../test-harness.js";

describe("inline operator interaction ownership", () => {
  it("serializes Locus custom components within one session generation", async () => {
    const harness = createHarness();
    const mounted: string[] = [];
    const completions: Array<(value: string) => void> = [];
    harness.ctx.ui.custom = vi.fn(async <T>(factory: CustomUiFactory<T>) => {
      return await new Promise<T>(async (resolve) => {
        const component = await factory({ requestRender() {} }, {}, {}, (value) => resolve(value));
        mounted.push(component.render(80)[0] ?? "");
        completions.push(resolve as (value: string) => void);
      });
    }) as NonNullable<typeof harness.ctx.ui.custom>;

    const first = requestInlineOperatorInteraction(harness.ctx, () => component("first"));
    const second = requestInlineOperatorInteraction(harness.ctx, () => component("second"));

    await vi.waitFor(() => expect(mounted).toEqual(["first"]));
    completions[0]!("first-result");
    await expect(first).resolves.toBe("first-result");
    await vi.waitFor(() => expect(mounted).toEqual(["first", "second"]));
    completions[1]!("second-result");
    await expect(second).resolves.toBe("second-result");
  });

  it("drops a queued interaction when its caller lease becomes stale", async () => {
    const harness = createHarness();
    const completions: Array<(value: string) => void> = [];
    harness.ctx.ui.custom = vi.fn(async <T>(factory: CustomUiFactory<T>) => {
      return await new Promise<T>(async (resolve) => {
        await factory({ requestRender() {} }, {}, {}, (value) => resolve(value));
        completions.push(resolve as (value: string) => void);
      });
    }) as NonNullable<typeof harness.ctx.ui.custom>;
    let current = true;

    const active = requestInlineOperatorInteraction(harness.ctx, () => component("active"));
    const stale = requestInlineOperatorInteraction(harness.ctx, () => component("must-not-mount"), {
      isCurrent: () => current,
    });

    await vi.waitFor(() => expect(completions).toHaveLength(1));
    current = false;
    completions[0]!("done");
    await expect(active).resolves.toBe("done");
    await expect(stale).rejects.toBeInstanceOf(StaleInlineOperatorInteractionError);
    expect(harness.ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("does not make a fresh session generation wait for the old generation", async () => {
    const harness = createHarness();
    let sessionId = "one";
    harness.ctx.sessionManager!.getSessionId = () => sessionId;
    const mounted: string[] = [];
    const completions: Array<(value: string) => void> = [];
    harness.ctx.ui.custom = vi.fn(async <T>(factory: CustomUiFactory<T>) => {
      return await new Promise<T>(async (resolve) => {
        const child = await factory({ requestRender() {} }, {}, {}, (value) => resolve(value));
        mounted.push(child.render(80)[0] ?? "");
        completions.push(resolve as (value: string) => void);
      });
    }) as NonNullable<typeof harness.ctx.ui.custom>;

    const oldGeneration = requestInlineOperatorInteraction(harness.ctx, () => component("old"));
    await vi.waitFor(() => expect(mounted).toEqual(["old"]));
    sessionId = "two";
    const freshGeneration = requestInlineOperatorInteraction(harness.ctx, () => component("fresh"));
    await vi.waitFor(() => expect(mounted).toEqual(["old", "fresh"]));

    completions[1]!("fresh-result");
    await expect(freshGeneration).resolves.toBe("fresh-result");
    completions[0]!("old-result");
    await expect(oldGeneration).resolves.toBe("old-result");
  });

  it("releases the queue when Pi disposes a component whose custom promise remains unsettled", async () => {
    const harness = createHarness();
    const mounted: CustomUiComponent[] = [];
    const completions: Array<(value: string) => void> = [];
    harness.ctx.ui.custom = vi.fn(async <T>(factory: CustomUiFactory<T>) => {
      return await new Promise<T>(async (resolve) => {
        const child = await factory({ requestRender() {} }, {}, {}, (value) => resolve(value));
        mounted.push(child);
        completions.push(resolve as (value: string) => void);
      });
    }) as NonNullable<typeof harness.ctx.ui.custom>;

    const retired = requestInlineOperatorInteraction(harness.ctx, () => component("retired"));
    const next = requestInlineOperatorInteraction(harness.ctx, () => component("next"));
    await vi.waitFor(() => expect(mounted).toHaveLength(1));

    mounted[0]!.dispose?.();
    await vi.waitFor(() => expect(mounted).toHaveLength(2));
    completions[1]!("next-result");
    await expect(next).resolves.toBe("next-result");

    // The first host promise is still pending when the next component mounts.
    completions[0]!("retired-result");
    await expect(retired).resolves.toBe("retired-result");
  });
});

function component(label: string): CustomUiComponent {
  return {
    render: () => [label],
    invalidate() {},
  };
}
