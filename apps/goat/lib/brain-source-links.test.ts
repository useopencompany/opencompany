import { describe, expect, it } from "vitest";
import { isExternalHref, sourceHrefForRef } from "@/lib/brain-source-links";

describe("sourceHrefForRef", () => {
  it("derives GitHub URLs from activity source refs", () => {
    expect(sourceHrefForRef("github:acme/api")).toBe("https://github.com/acme/api");
    expect(sourceHrefForRef("github:acme/api:pull:123")).toBe(
      "https://github.com/acme/api/pull/123",
    );
    expect(sourceHrefForRef("github:acme/api:issue:45")).toBe(
      "https://github.com/acme/api/issues/45",
    );
    expect(sourceHrefForRef("github:acme/api:issue:45:comment:987654321")).toBe(
      "https://github.com/acme/api/issues/45#issuecomment-987654321",
    );
    expect(sourceHrefForRef("github:acme/api:pull:45:comment:987654321")).toBe(
      "https://github.com/acme/api/pull/45#issuecomment-987654321",
    );
  });

  it("supports direct http source ids and upload assets", () => {
    expect(sourceHrefForRef("web:https://example.com/docs/a?b=1")).toBe(
      "https://example.com/docs/a?b=1",
    );
    expect(sourceHrefForRef("upload:goat_brain_doc_abc")).toBe(
      "/api/brain-assets/goat_brain_doc_abc",
    );
  });

  it("does not create links for unsafe or under-specified refs", () => {
    expect(sourceHrefForRef("web:javascript:alert(1)")).toBeNull();
    expect(sourceHrefForRef("linear:issue:ENG-42")).toBeNull();
    expect(sourceHrefForRef("github:acme/api:pull:nope")).toBeNull();
    expect(sourceHrefForRef("github:bad/../../repo:issue:1")).toBeNull();
    expect(sourceHrefForRef("not-a-source-ref")).toBeNull();
  });
});

describe("isExternalHref", () => {
  it("distinguishes external http URLs from app paths", () => {
    expect(isExternalHref("https://github.com/acme/api")).toBe(true);
    expect(isExternalHref("http://example.com")).toBe(true);
    expect(isExternalHref("/api/brain-assets/doc_1")).toBe(false);
  });
});
