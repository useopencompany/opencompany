import { describe, expect, it } from "vitest";
import {
  evidenceLinkTargets,
  formatBrainEvidenceLink,
  formatBrainPageLink,
  formatBrainSourceLink,
  pageLinkTargets,
  parseBrainInlineLinks,
  sourceLinkTargets,
} from "./inline-links";

describe("goat brain inline links", () => {
  it("parses canonical page, evidence, and source links", () => {
    expect(
      parseBrainInlineLinks(
        "See [[page:acme|Acme]], [[evidence:ev-acme-email|email]], and [[source:gmail:thread_1|thread]].",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "page",
        target: "acme",
        label: "Acme",
        valid: true,
        legacy: false,
      }),
      expect.objectContaining({
        kind: "evidence",
        target: "ev-acme-email",
        label: "email",
        valid: true,
        legacy: false,
      }),
      expect.objectContaining({
        kind: "source",
        target: "gmail:thread_1",
        label: "thread",
        valid: true,
        legacy: false,
      }),
    ]);
  });

  it("keeps legacy bare page links and evidence citations readable", () => {
    expect(parseBrainInlineLinks("[[acme|Acme]] cites [^ev:ev-seed].")).toEqual([
      expect.objectContaining({
        kind: "page",
        target: "acme",
        label: "Acme",
        valid: true,
        legacy: true,
      }),
      expect.objectContaining({
        kind: "evidence",
        target: "ev-seed",
        label: "ev-seed",
        valid: true,
        legacy: true,
      }),
    ]);
  });

  it("reports invalid targets without dropping the link", () => {
    expect(parseBrainInlineLinks("[[page:Bad Id]] [[evidence:not-ev]] [[source:bad]ref]]")).toEqual(
      [
        expect.objectContaining({ kind: "page", target: "Bad Id", valid: false }),
        expect.objectContaining({ kind: "evidence", target: "not-ev", valid: false }),
      ],
    );
  });

  it("ignores escaped links and links inside Markdown code", () => {
    const text = [
      String.raw`\[[page:escaped|Escaped]]`,
      "`[[page:inline-code|Inline code]]`",
      "```text",
      "[[page:fenced-code|Fenced code]]",
      "```",
      "    [[page:indented-code|Indented code]]",
      "- ~~~",
      "  [[page:list-fenced-code|List fenced code]]",
      "  ~~~",
      "> ~~~",
      "> [[page:quoted-fenced-code|Quoted fenced code]]",
      "> ~~~",
      ">     [[page:quoted-indented-code|Quoted indented code]]",
      String.raw`\[^ev:ev-escaped]`,
      "`[^ev:ev-inline-code]`",
      "[[page:visible|Visible]]",
    ].join("\n");

    expect(parseBrainInlineLinks(text)).toEqual([
      expect.objectContaining({ kind: "page", target: "visible", label: "Visible" }),
    ]);
    expect(parseBrainInlineLinks(String.raw`\\[[page:visible|Visible]]`)).toEqual([
      expect.objectContaining({ kind: "page", target: "visible", label: "Visible" }),
    ]);
    expect(
      parseBrainInlineLinks(
        "```text\r\n[[page:fenced-code|Fenced code]]\r\n```\r\n[[page:visible|Visible]]",
      ),
    ).toEqual([expect.objectContaining({ kind: "page", target: "visible", label: "Visible" })]);
  });

  it("keeps scanning indented paragraph and list content", () => {
    const text = [
      "Paragraph",
      "    [[page:continuation|Continuation]]",
      "- Parent",
      "    - [[page:nested|Nested]]",
      "",
      "    [[page:list-paragraph|List paragraph]]",
      "",
      "      [[page:list-code|List code]]",
    ].join("\n");

    expect(parseBrainInlineLinks(text).map((link) => link.target)).toEqual([
      "continuation",
      "nested",
      "list-paragraph",
    ]);
  });

  it("ends unclosed fences when their Markdown container ends", () => {
    const text = [
      "> ~~~",
      "> [[page:quoted-code|Quoted code]]",
      "[[page:after-quote|After quote]]",
      "> > ~~~",
      "> > [[page:nested-quoted-code|Nested quoted code]]",
      "> [[page:outer-quote|Outer quote]]",
      "- ~~~",
      "  [[page:list-code|List code]]",
      "outside [[page:lazy-list-code|Lazy list code]]",
      "",
      "[[page:after-list|After list]]",
      "- ~~~",
      "  [[page:second-list-code|Second list code]]",
      "- [[page:sibling-list-item|Sibling list item]]",
      "- ~~~",
      "  [[page:third-list-code|Third list code]]",
      "> [[page:blockquote-after-list|Blockquote after list]]",
      "- ~~~",
      "  [[page:fourth-list-code|Fourth list code]]",
      "# [[page:heading-after-list|Heading after list]]",
      "- ~~~",
      "  [[page:fifth-list-code|Fifth list code]]",
      "---",
      "[[page:after-rule|After rule]]",
      "- ~~~",
      "  [[page:sixth-list-code|Sixth list code]]",
      "<3 [[page:lazy-angle-code|Lazy angle code]]",
      "",
      "[[page:after-lazy-angle|After lazy angle]]",
      "- ~~~",
      "  [[page:seventh-list-code|Seventh list code]]",
      "<span>[[page:html-after-list|HTML after list]]</span>",
    ].join("\n");

    expect(parseBrainInlineLinks(text).map((link) => link.target)).toEqual([
      "after-quote",
      "outer-quote",
      "after-list",
      "sibling-list-item",
      "blockquote-after-list",
      "heading-after-list",
      "after-rule",
      "after-lazy-angle",
      "html-after-list",
    ]);
  });

  it("requires source targets to be provider:id shaped", () => {
    expect(
      parseBrainInlineLinks(
        "[[source:jamie:meeting:calendar_event_123]] [[source:noid]] [[source:Bad:ref]] [[source:gmail:thread 1]]",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "source",
        target: "jamie:meeting:calendar_event_123",
        valid: true,
      }),
      expect.objectContaining({ kind: "source", target: "noid", valid: false }),
      expect.objectContaining({ kind: "source", target: "Bad:ref", valid: false }),
      expect.objectContaining({ kind: "source", target: "gmail:thread 1", valid: false }),
    ]);
  });

  it("extracts valid targets by kind and dedupes by first occurrence", () => {
    const text =
      "[[page:acme]] [[page:acme|Acme]] [[evidence:ev-seed]] [^ev:ev-seed] [[source:gmail:1]]";

    expect(pageLinkTargets(text)).toEqual(["acme"]);
    expect(evidenceLinkTargets(text)).toEqual(["ev-seed"]);
    expect(sourceLinkTargets(text)).toEqual(["gmail:1"]);
  });

  it("formats canonical typed links", () => {
    expect(formatBrainPageLink("acme", "Acme")).toBe("[[page:acme|Acme]]");
    expect(formatBrainEvidenceLink("ev-seed")).toBe("[[evidence:ev-seed]]");
    expect(formatBrainSourceLink("gmail:thread_1", "Thread")).toBe(
      "[[source:gmail:thread_1|Thread]]",
    );
  });

  it("rejects invalid formatted targets and labels", () => {
    expect(() => formatBrainPageLink("Bad Id")).toThrow("Invalid Brain page link target.");
    expect(() => formatBrainEvidenceLink("seed")).toThrow(
      "Invalid Brain evidence link target.",
    );
    expect(() => formatBrainSourceLink("gmail:1", "bad]label")).toThrow(
      "Invalid Brain link label.",
    );
    expect(() => formatBrainPageLink("acme", "bad[label")).toThrow(
      "Invalid Brain link label.",
    );
  });
});
