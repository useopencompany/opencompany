import { describe, expect, it } from "vitest";
import { compileGoogleDocsMarkdown } from "./google-docs-markdown";

describe("Google Docs Markdown compiler", () => {
  it("turns the daily-task Markdown shape into native Docs formatting requests", () => {
    const compiled = compileGoogleDocsMarkdown(
      [
        "# Sat, September 5th",
        "",
        "## Tasks",
        "",
        "- [ ] open source **repo**",
        "- [ ] bring wiki ingestion back and improve it",
        "- [x] ship ~~old plugin~~",
      ].join("\n"),
      "t.0",
    );

    expect(compiled.text).toBe(
      [
        "Sat, September 5th",
        "Tasks",
        "open source repo",
        "bring wiki ingestion back and improve it",
        "ship old plugin",
      ].join("\n"),
    );
    expect(compiled.text).not.toMatch(/(^|\n)#{1,6} |\[[ xX]\]|\*\*|~~/u);
    expect(compiled.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          updateParagraphStyle: expect.objectContaining({
            paragraphStyle: { namedStyleType: "TITLE" },
          }),
        }),
        expect.objectContaining({
          updateParagraphStyle: expect.objectContaining({
            paragraphStyle: { namedStyleType: "HEADING_1" },
          }),
        }),
        expect.objectContaining({
          updateTextStyle: expect.objectContaining({ textStyle: { bold: true } }),
        }),
        expect.objectContaining({
          updateTextStyle: expect.objectContaining({ textStyle: { strikethrough: true } }),
        }),
      ]),
    );
    const checkboxRequests = compiled.requests.filter(
      (request) =>
        (request.createParagraphBullets as { bulletPreset?: string } | undefined)?.bulletPreset ===
        "BULLET_CHECKBOX",
    );
    expect(checkboxRequests).toHaveLength(1);
  });

  it("applies nested bullets last and from the bottom so removed indentation cannot shift ranges", () => {
    const compiled = compileGoogleDocsMarkdown(
      ["- parent", "  - nested", "", "1. first", "2. second"].join("\n"),
      "t.child",
    );
    const bullets = compiled.requests.flatMap((request) =>
      request.createParagraphBullets
        ? [
            request.createParagraphBullets as {
              range: { startIndex: number; endIndex: number; tabId: string };
              bulletPreset: string;
            },
          ]
        : [],
    );

    expect(compiled.text).toBe("parent\n\tnested\nfirst\nsecond");
    expect(bullets.map((request) => request.range.startIndex)).toEqual(
      [...bullets.map((request) => request.range.startIndex)].sort((left, right) => right - left),
    );
    expect(bullets.every((request) => request.range.tabId === "t.child")).toBe(true);
    expect(
      compiled.requests.slice(-bullets.length).every((request) => request.createParagraphBullets),
    ).toBe(true);
  });

  it("uses UTF-16 indexes and ignores unsafe Markdown link protocols", () => {
    const compiled = compileGoogleDocsMarkdown(
      "# 🚀 Launch\n[unsafe](javascript:alert(1)) and [safe](https://example.com)",
      "t.0",
    );
    const links = compiled.requests.flatMap((request) => {
      const update = request.updateTextStyle as
        | { range: { startIndex: number; endIndex: number }; textStyle: { link?: { url: string } } }
        | undefined;
      return update?.textStyle.link ? [update] : [];
    });

    expect(links).toHaveLength(1);
    expect(links[0]?.textStyle.link?.url).toBe("https://example.com");
    expect(links[0]?.range).toEqual({ startIndex: 22, endIndex: 26, tabId: "t.0" });
  });
});
