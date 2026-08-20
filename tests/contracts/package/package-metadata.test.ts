import { describe, expect, it } from "vitest";
import { extensionIdFromEntrypoint, pkg, publicCatalogs } from "../helpers/package-contract.js";

describe("package metadata contract", () => {
  it("activates exactly the extensions the generated catalog publishes", () => {
    // The catalog is generated from this same list, so a divergence means the artifact was not
    // regenerated after an entrypoint moved. `npm run build:catalogs` is the fix.
    expect(pkg.pi.extensions.map(extensionIdFromEntrypoint)).toEqual(publicCatalogs.extensions.map(({ id }) => id));
    expect(pkg.files.some((file) => file.startsWith("extensions/beta/"))).toBe(false);
  });

  it("binds the MIT package to the clean repository identity", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository.url).toBe("git+https://github.com/kroffske/locus-pi.git");
  });
});
