import { describe, expect, it } from "vitest";

import { isVideoSrc, parseChangelog, renderInline } from "./changelog";

describe("renderInline", () => {
  it("tokenizes image syntax as an image token, not a link", () => {
    const tokens = renderInline(
      "Session activity dot. ![Blue dot demo](https://example.blob.vercel-storage.com/changelog/0.11.0/blue-dot.mp4)",
    );
    expect(tokens).toEqual([
      { kind: "text", text: "Session activity dot. " },
      {
        kind: "image",
        alt: "Blue dot demo",
        src: "https://example.blob.vercel-storage.com/changelog/0.11.0/blue-dot.mp4",
      },
    ]);
  });

  it("supports empty alt text", () => {
    const tokens = renderInline("![](https://example.com/demo.webm)");
    expect(tokens).toEqual([{ kind: "image", alt: "", src: "https://example.com/demo.webm" }]);
  });

  it("still tokenizes plain links as links", () => {
    const tokens = renderInline("See [docs](https://example.com/docs).");
    expect(tokens).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "docs", href: "https://example.com/docs" },
      { kind: "text", text: "." },
    ]);
  });
});

describe("isVideoSrc", () => {
  it("matches video extensions, including with query/hash suffixes", () => {
    expect(isVideoSrc("https://example.com/a.mp4")).toBe(true);
    expect(isVideoSrc("https://example.com/a.webm?download=0")).toBe(true);
    expect(isVideoSrc("https://example.com/a.MOV#t=2")).toBe(true);
    expect(isVideoSrc("https://example.com/a.png")).toBe(false);
    expect(isVideoSrc("https://example.com/mp4-guide")).toBe(false);
  });
});

describe("parseChangelog", () => {
  it("keeps indented media continuation lines attached to their bullet", () => {
    const changelog = parseChangelog(
      [
        "# Changelog",
        "",
        "## [0.11.0] - 2026-06-10",
        "",
        "### Added",
        "",
        "- Unseen-activity blue dot for sessions.",
        "  ![Blue dot demo](https://example.com/blue-dot.mp4)",
        "- Another entry.",
      ].join("\n"),
    );

    const items = changelog.releases[0]?.sections[0]?.items;
    expect(items).toHaveLength(2);
    expect(items?.[0]).toContain("Unseen-activity blue dot");
    expect(items?.[0]).toContain("![Blue dot demo](https://example.com/blue-dot.mp4)");
  });
});
