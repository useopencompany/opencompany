import { describe, expect, it } from "vitest";
import {
  describeWikiSourceRef,
  isKnownWikiSourceProvider,
  WIKI_SOURCE_PROVIDERS,
  WIKI_SOURCE_REF_GUIDE,
  wikiSourceHref,
} from "./sources";

describe("describeWikiSourceRef", () => {
  it("resolves every provider's documented ref shape", () => {
    expect(describeWikiSourceRef("linear:issue:ENG-42")).toEqual({
      label: "ENG-42",
      href: "https://linear.app/issue/ENG-42",
      icon: "link",
    });
    expect(describeWikiSourceRef("github:acme/api:pull:123")).toEqual({
      label: "#123",
      href: "https://github.com/acme/api/pull/123",
      icon: "github",
    });
    expect(describeWikiSourceRef("github:acme/api")).toEqual({
      label: "acme/api",
      href: "https://github.com/acme/api",
      icon: "github",
    });
    expect(describeWikiSourceRef("github:acme/api:issue:45:comment:987654321")?.href).toBe(
      "https://github.com/acme/api/issues/45#issuecomment-987654321",
    );
    expect(describeWikiSourceRef("gmail:thread:18c2a4b9d0e1f234")).toEqual({
      label: "Gmail thread",
      href: "https://mail.google.com/mail/u/0/#all/18c2a4b9d0e1f234",
      icon: "link",
    });
    expect(
      describeWikiSourceRef("slack:conversation:T0AB12CD3:C0XY98ZW7:1754500000.000100"),
    ).toEqual({
      label: "Slack conversation",
      href: "https://app.slack.com/client/T0AB12CD3/C0XY98ZW7",
      icon: "link",
    });
    expect(describeWikiSourceRef("google-drive:file:1AbC_dEf-234567890xyz")).toEqual({
      label: "Google Drive file",
      href: "https://drive.google.com/open?id=1AbC_dEf-234567890xyz",
      icon: "link",
    });
    expect(describeWikiSourceRef("hubspot:12345678:deal:9876543")).toEqual({
      label: "HubSpot deal",
      href: "https://app.hubspot.com/contacts/12345678/record/0-3/9876543",
      icon: "link",
    });
    expect(describeWikiSourceRef("granola:note:note_1")).toEqual({
      label: "Granola note",
      href: "https://app.granola.ai/notes/note_1",
      icon: "link",
    });
    expect(describeWikiSourceRef("fathom:recording:8842197")).toEqual({
      label: "Fathom recording",
      href: "https://fathom.video/calls/8842197",
      icon: "link",
    });
    expect(describeWikiSourceRef("web:https://example.com/docs/a?b=1")).toEqual({
      label: "example.com",
      href: "https://example.com/docs/a?b=1",
      icon: "link",
    });
  });

  it("labels pointer-only providers that have no per-artifact URL", () => {
    expect(describeWikiSourceRef("jamie:meeting:calendar_event_123")).toEqual({
      label: "Jamie meeting",
      href: null,
      icon: "link",
    });
    expect(describeWikiSourceRef("attio:ws_1:deal:rec_9876")).toEqual({
      label: "Attio deal",
      href: null,
      icon: "link",
    });
    expect(describeWikiSourceRef("attio:ws_1:widget:rec_9876")?.label).toBe("Attio record");
  });

  it("prefers a canonical URL carried directly in the id", () => {
    expect(describeWikiSourceRef("notion:https://notion.so/page-1")).toEqual({
      label: "notion.so",
      href: "https://notion.so/page-1",
      icon: "link",
    });
  });

  it("returns null rather than guessing at a malformed or unknown ref", () => {
    expect(describeWikiSourceRef("linear:ENG-123")).toBeNull();
    expect(describeWikiSourceRef("linear:issue:not an id")).toBeNull();
    expect(describeWikiSourceRef("gmail:thread:x")).toBeNull();
    expect(describeWikiSourceRef("gmail:message:18c2a4b9d0e1f234")).toBeNull();
    expect(describeWikiSourceRef("slack:conversation:evil:C0XY98ZW7:1")).toBeNull();
    expect(describeWikiSourceRef("google-drive:file:short")).toBeNull();
    expect(describeWikiSourceRef("hubspot:12345678:ticket:1")).toBeNull();
    expect(describeWikiSourceRef("github:acme/api:pull:nope")).toBeNull();
    expect(describeWikiSourceRef("github:bad/../../repo:issue:1")).toBeNull();
    expect(describeWikiSourceRef("notion:page-1")).toBeNull();
    expect(describeWikiSourceRef("not-a-source-ref")).toBeNull();
  });

  it("treats inherited Object keys as unknown object types", () => {
    // The object type comes straight out of a page body, so `__proto__` and
    // `constructor` must not resolve to an inherited value.
    expect(describeWikiSourceRef("hubspot:12345678:__proto__:9876543")).toBeNull();
    expect(describeWikiSourceRef("hubspot:12345678:constructor:9876543")).toBeNull();
    expect(describeWikiSourceRef("attio:ws_1:__proto__:rec_1")?.label).toBe("Attio record");
    expect(describeWikiSourceRef("attio:ws_1:constructor:rec_1")?.label).toBe("Attio record");
  });

  it("never builds a link from a non-http scheme", () => {
    expect(wikiSourceHref("web:javascript:alert(1)")).toBeNull();
    expect(wikiSourceHref("notion:javascript:alert(1)")).toBeNull();
  });
});

describe("the registry itself", () => {
  it("exposes each provider exactly once and advertises it to agents", () => {
    const providers = WIKI_SOURCE_PROVIDERS.map((entry) => entry.provider);
    expect(new Set(providers).size).toBe(providers.length);
    for (const provider of providers) {
      expect(isKnownWikiSourceProvider(provider)).toBe(true);
      expect(WIKI_SOURCE_REF_GUIDE).toContain(`${provider}:`);
    }
    expect(isKnownWikiSourceProvider("nope")).toBe(false);
  });

  it("documents ref shapes that its own resolver accepts", () => {
    // Each refShape starts with the provider slug, so the guide and the
    // resolver can never advertise different providers.
    for (const entry of WIKI_SOURCE_PROVIDERS) {
      expect(entry.refShape.startsWith(`${entry.provider}:`)).toBe(true);
    }
  });
});
