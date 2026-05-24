import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

describe("brain markdown editor support", () => {
  it("loads markdown into Tiptap and serializes markdown back out", () => {
    const editor = new Editor({
      extensions: [
        StarterKit,
        Markdown.configure({
          indentation: { style: "space", size: 2 },
          markedOptions: { gfm: true, breaks: false },
        }),
      ],
      content: "# Brain notes\n\n- first item\n\nThis is **important**.",
      contentType: "markdown",
    });

    expect(editor.isActive("heading", { level: 1 })).toBe(true);
    expect(editor.getMarkdown()).toContain("# Brain notes");
    expect(editor.getMarkdown()).toContain("- first item");
    expect(editor.getMarkdown()).toContain("**important**");

    editor.destroy();
  });
});
