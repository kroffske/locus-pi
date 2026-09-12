import { describe, expect, it } from "vitest";
import { runScheduled } from "../../../../extensions/workflows/runtime/workflow-groups.js";

/**
 * The group scheduler seen from its own owner. What `parallel()`/`pipeline()` DO with it —
 * barriers, ordered slots, partial values — is covered by `workflow-group-failure.test.ts`
 * through real scripts. What is asserted here is the one property that makes the two bounds
 * in this runtime safe to hold at once: this pool is PER CALL, so a nested call opens its own
 * and never competes for the outer one's slots.
 */
describe("the per-group scheduler", () => {
  it("bounds simultaneous thunks to the width of THIS call and keeps result order", async () => {
    let live = 0;
    let peak = 0;
    const finished: number[] = [];
    const thunks = Array.from({ length: 7 }, (_value, index) => async () => {
      live += 1;
      if (live > peak) peak = live;
      await new Promise((resolve) => setTimeout(resolve, 1));
      live -= 1;
      finished.push(index);
      return index * 10;
    });

    const out = await runScheduled(thunks, 2);

    expect(peak).toBe(2);
    expect(out).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect([...finished].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("gives a nested call its own pool instead of queueing it behind the outer one", async () => {
    // A width of 1 outside and a width of 1 inside: a single shared pool would deadlock
    // here, which is exactly why the run's leaf gate is a separate object.
    const seen: string[] = [];
    const out = await runScheduled(
      [
        async () => {
          seen.push("outer");
          const [inner] = await runScheduled([async () => "inner"], 1);
          seen.push(inner!);
          return inner;
        },
      ],
      1,
    );

    expect(out).toEqual(["inner"]);
    expect(seen).toEqual(["outer", "inner"]);
  });

  it("never starts more workers than it has thunks", async () => {
    let started = 0;
    const out = await runScheduled(
      [
        async () => {
          started += 1;
          return "only";
        },
      ],
      8,
    );
    expect(started).toBe(1);
    expect(out).toEqual(["only"]);
    expect(await runScheduled<number>([], 4)).toEqual([]);
  });
});
