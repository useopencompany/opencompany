import { describe, expect, it } from "vitest";
import {
  normalizeConnectorOrganizationSlug,
  slugifyConnectorOrganizationName,
  validateConnectorOrganizationInput,
} from "./slug";

describe("connector organization slug helpers", () => {
  it("slugifies organization names into URL-safe slugs", () => {
    expect(slugifyConnectorOrganizationName(" Acme, Inc. ")).toBe("acme-inc");
    expect(slugifyConnectorOrganizationName("Already---Slugged")).toBe("already-slugged");
    expect(slugifyConnectorOrganizationName("!!!")).toBe("team");
  });

  it("normalizes typed slugs", () => {
    expect(normalizeConnectorOrganizationSlug("  Foo BAR__Baz ")).toBe("foo-bar-baz");
  });

  it("validates name and slug input", () => {
    expect(validateConnectorOrganizationInput({ name: "Acme", slug: "acme" })).toEqual({
      ok: true,
      name: "Acme",
      slug: "acme",
    });
    expect(validateConnectorOrganizationInput({ name: "A", slug: "acme" })).toEqual({
      ok: false,
      error: "Organization name must be at least 2 characters.",
    });
    expect(validateConnectorOrganizationInput({ name: "Acme", slug: "a" })).toEqual({
      ok: false,
      error: "Slug must be at least 2 characters.",
    });
  });
});
