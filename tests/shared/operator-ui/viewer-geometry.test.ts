import { afterEach, describe, expect, it } from "vitest";
import {
  clearViewerExternalRows,
  setViewerExternalRows,
  viewerExternalRows,
} from "../../../extensions/_shared/operator/viewer-geometry.js";

afterEach(() => {
  clearViewerExternalRows("test-a");
  clearViewerExternalRows("test-b");
});

describe("focused viewer external-row reservations", () => {
  it("shares and sums current host rows without retaining cleared owners", () => {
    setViewerExternalRows("test-a", 3);
    setViewerExternalRows("test-b", 2.9);
    expect(viewerExternalRows()).toBe(5);

    setViewerExternalRows("test-a", 1);
    clearViewerExternalRows("test-b");
    expect(viewerExternalRows()).toBe(1);

    setViewerExternalRows("test-a", 0);
    expect(viewerExternalRows()).toBe(0);
  });
});
