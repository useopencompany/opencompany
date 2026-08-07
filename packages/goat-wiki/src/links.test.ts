import { describe, expect, it } from "vitest";
import {
  formatWikiPageLink,
  formatWikiSourceLink,
  parseWikiInlineLinks,
  wikiPageLinkTargets,
  wikiSourceRefTargets,
} from "./links";

describe("parseWikiInlineLinks", () => {
  it("parses bare page links, labeled links, and source refs", () => {
    const links = parseWikiInlineLinks(
      "See [[website-redesign]] and [[ada-lovelace|Ada]], tracked in [[source:linear:issue:ENG-123]].",
    );
    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({ kind: "page", target: "website-redesign", valid: true });
    expect(links[1]).toMatchObject({ kind: "page", target: "ada-lovelace", label: "Ada" });
    expect(links[2]).toMatchObject({
      kind: "source",
      target: "linear:issue:ENG-123",
      valid: true,
    });
  });

  it("accepts the explicit page: prefix", () => {
    expect(parseWikiInlineLinks("[[page:some-slug]]")[0]).toMatchObject({
      kind: "page",
      target: "some-slug",
      valid: true,
    });
  });

  it("marks invalid targets without dropping them", () => {
    expect(parseWikiInlineLinks("[[Not A Slug]]")[0]).toMatchObject({
      kind: "page",
      valid: false,
    });
  });

  it("ignores links inside code fences and inline code", () => {
    const text = [
      "Link syntax is `[[example]]` inline.",
      "```",
      "[[fenced]]",
      "```",
      "But [[real-link]] counts.",
    ].join("\n");
    expect(wikiPageLinkTargets(text)).toEqual(["real-link"]);
  });

  it("ignores escaped brackets", () => {
    expect(parseWikiInlineLinks("\\[[not-a-link]]")).toHaveLength(0);
  });

  it("dedupes targets in first-appearance order", () => {
    expect(wikiPageLinkTargets("[[b]] then [[a]] then [[b]]")).toEqual(["b", "a"]);
    expect(
      wikiSourceRefTargets("[[source:gmail:thread:x]] and again [[source:gmail:thread:x]]"),
    ).toEqual(["gmail:thread:x"]);
  });
});

describe("format helpers", () => {
  it("emits bare page links and prefixed source links", () => {
    expect(formatWikiPageLink("some-slug")).toBe("[[some-slug]]");
    expect(formatWikiPageLink("some-slug", "Label")).toBe("[[some-slug|Label]]");
    expect(formatWikiSourceLink("linear:issue:ENG-1", "ENG-1")).toBe(
      "[[source:linear:issue:ENG-1|ENG-1]]",
    );
  });

  it("rejects invalid targets and labels", () => {
    expect(() => formatWikiPageLink("Not A Slug")).toThrow();
    expect(() => formatWikiSourceLink("nope")).toThrow();
    expect(() => formatWikiPageLink("ok", "bad]label")).toThrow();
  });
});
