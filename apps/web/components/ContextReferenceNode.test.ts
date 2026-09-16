import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { ContextReferenceNode } from "./ContextReferenceNode";

describe("reference Markdown storage", () => {
  it("round trips plugin and repository references without loading a catalog", () => {
    const text = "Review [org/repo](https://github.com/org/repo) for [Slack](/plugins/slack).";
    const editor = new Editor({
      element: null,
      extensions: [StarterKit, Markdown, ContextReferenceNode],
      content: text,
      contentType: "markdown",
    });
    expect(
      editor.getJSON().content?.[0]?.content?.filter((node) => node.type === "contextReference"),
    ).toHaveLength(2);
    expect(editor.getMarkdown()).toBe(text);
    editor.destroy();
  });
  it("keeps code examples and ordinary links unchanged", () => {
    const text = "`[Slack](/plugins/slack)` and [website](https://example.com)";
    const editor = new Editor({
      element: null,
      extensions: [StarterKit, Markdown, ContextReferenceNode],
      content: text,
      contentType: "markdown",
    });
    expect(
      editor.getJSON().content?.[0]?.content?.some((node) => node.type === "contextReference"),
    ).toBe(false);
    expect(editor.getMarkdown()).toBe(text);
    editor.destroy();
  });
});
