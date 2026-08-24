import { describe, expect, it } from "vitest";
import { resolveRenderProfile } from "../../../extensions/_shared/host/render-profile.js";

describe("resolveRenderProfile", () => {
  it("defaults calm off in a plain Linux environment", () => {
    expect(resolveRenderProfile({ env: {}, procVersion: "Linux version 6.8.0-generic" })).toEqual({ calm: false });
    expect(resolveRenderProfile({ env: {} })).toEqual({ calm: false });
  });

  it("defaults calm on under WSL environment markers", () => {
    expect(resolveRenderProfile({ env: { WSL_DISTRO_NAME: "Ubuntu" } })).toEqual({ calm: true });
    expect(resolveRenderProfile({ env: { WSL_INTEROP: "/run/WSL/1_interop" } })).toEqual({ calm: true });
  });

  it("defaults calm on when the kernel identifies as Microsoft", () => {
    expect(
      resolveRenderProfile({
        env: {},
        procVersion: "Linux version 5.15.167.4-microsoft-standard-WSL2 (root@...)",
      }),
    ).toEqual({ calm: true });
    expect(resolveRenderProfile({ env: {}, procVersion: "Linux version 4.4.0-Microsoft" })).toEqual({ calm: true });
  });

  it("honours the explicit override in both directions", () => {
    // Force ON on a fast terminal…
    expect(resolveRenderProfile({ env: { LOCUS_PS_CALM: "1" } })).toEqual({ calm: true });
    // …and force OFF under WSL (e.g. Windows Terminal, which repaints cleanly).
    expect(resolveRenderProfile({ env: { LOCUS_PS_CALM: "0", WSL_DISTRO_NAME: "Ubuntu" } })).toEqual({ calm: false });
  });

  it("ignores unrecognized override values and falls back to detection", () => {
    expect(resolveRenderProfile({ env: { LOCUS_PS_CALM: "yes", WSL_DISTRO_NAME: "Ubuntu" } })).toEqual({ calm: true });
    expect(resolveRenderProfile({ env: { LOCUS_PS_CALM: "" } })).toEqual({ calm: false });
  });
});
