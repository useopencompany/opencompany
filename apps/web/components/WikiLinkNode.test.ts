// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveWikiLink, WikiLink, type WikiLinkState } from "./WikiLinkNode";

// jsdom has no layout; ProseMirror asks ranges for client rects on dispatch.
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
});

describe("WikiLink path resolution", () => {
  const state = (paths: string[]): WikiLinkState => ({
    brainLinks: Object.fromEntries(paths.map((path) => [path, `/wiki/${path}`])),
    pageTitles: Object.fromEntries(paths.map((path) => [path, `Title for ${path}`])),
    editingEnabled: true,
    onNavigateInternal: undefined,
  });

  it("resolves exact paths", () => {
    expect(resolveWikiLink("[[company/goals]]", state(["company/goals"]))).toMatchObject({
      href: "/wiki/company/goals",
      label: "Title for company/goals",
    });
  });

  it("falls back to a unique basename", () => {
    expect(resolveWikiLink("[[goals]]", state(["company/goals"]))).toMatchObject({
      href: "/wiki/company/goals",
    });
  });

  it("leaves ambiguous and missing basenames unresolved", () => {
    expect(resolveWikiLink("[[goals]]", state(["company/goals", "personal/goals"])).href).toBe("");
    expect(resolveWikiLink("[[missing]]", state(["company/goals"])).href).toBe("");
  });
});

function makeEditor(markdown: string): Editor {
  return new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
      WikiLink,
    ],
    content: markdown,
    contentType: "markdown",
  });
}

function roundTrip(markdown: string): string {
  const editor = makeEditor(markdown);
  const out = editor.getMarkdown().trim();
  editor.destroy();
  return out;
}

function wikiLinkRaws(markdown: string): string[] {
  const editor = makeEditor(markdown);
  const raws: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "wikiLink") raws.push(node.attrs.raw as string);
  });
  editor.destroy();
  return raws;
}

describe("WikiLink markdown round-trip", () => {
  const cases = [
    "See [[acme]].",
    "See [[page:acme|Acme Corp]].",
    "See [[source:linear:issue:ENG-1|ENG-1]].",
    "See [[source:web:https://www.opencompany.cloud/about|About]].",
    "See [[evidence:ev_abc123]].",
    "Legacy [^ev:ev_abc123] citation.",
    "Both [[page:acme|Acme]] and [[source:web:https://x.com|X]] here.",
  ];

  for (const input of cases) {
    it(`is lossless for: ${input}`, () => {
      expect(roundTrip(input)).toBe(input);
    });
  }

  it("parses the bracket link into a single atomic wikiLink node", () => {
    expect(wikiLinkRaws("See [[page:acme|Acme]].")).toEqual(["[[page:acme|Acme]]"]);
  });

  it("captures two links in one paragraph as two nodes", () => {
    expect(wikiLinkRaws("A [[page:a|A]] and [[page:b|B]].")).toEqual([
      "[[page:a|A]]",
      "[[page:b|B]]",
    ]);
  });

  it("leaves wiki syntax literal inside inline code (no node)", () => {
    expect(wikiLinkRaws("Literal `[[page:acme|x]]` here.")).toEqual([]);
    expect(roundTrip("Literal `[[page:acme|x]]` here.")).toBe("Literal `[[page:acme|x]]` here.");
  });

  it("leaves wiki syntax literal inside a fenced code block (no node)", () => {
    const input = ["```text", "[[page:acme|x]]", "```"].join("\n");
    expect(wikiLinkRaws(input)).toEqual([]);
  });
});
