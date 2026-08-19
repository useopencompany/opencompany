import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type Editor, Extension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { WikiLink } from "./WikiLinkNode";
import { createWikiPageSuggestionPlugin, filterWikiPageSuggestions } from "./WikiPageSuggestion";

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

function Harness({
  onReady,
}: {
  onReady: (editor: NonNullable<ReturnType<typeof useEditor>>) => void;
}) {
  const titles = { "company/goals": "Company Goals", "personal/goals": "Personal Goals" };
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
      WikiLink,
      Extension.create({
        name: "wikiPageSuggestion",
        addProseMirrorPlugins() {
          return [createWikiPageSuggestionPlugin(this.editor, () => titles)];
        },
      }),
    ],
    content: "",
    contentType: "markdown",
  });
  useEffect(() => {
    if (editor) onReady(editor);
  }, [editor, onReady]);
  return <EditorContent editor={editor} />;
}

describe("Wiki page suggestions", () => {
  it("filters by title or full path", () => {
    const titles = { "company/goals": "Company Goals", "personal/notes": "Notes" };
    expect(filterWikiPageSuggestions(titles, "company").map((item) => item.path)).toEqual([
      "company/goals",
    ]);
    expect(filterWikiPageSuggestions(titles, "notes").map((item) => item.path)).toEqual([
      "personal/notes",
    ]);
  });

  it("inserts the selected page's full path", async () => {
    const editorRef: { current: Editor | null } = { current: null };
    render(
      <Harness
        onReady={(instance) => {
          editorRef.current = instance;
        }}
      />,
    );
    await waitFor(() => expect(editorRef.current).not.toBeNull());
    const editor = () => {
      if (!editorRef.current) throw new Error("Editor did not initialize.");
      return editorRef.current;
    };
    act(() => {
      editor().chain().focus().insertContent("[[company").run();
    });
    await screen.findByText("Company Goals");
    fireEvent.keyDown(editor().view.dom, { key: "Enter" });
    await waitFor(() => expect(editor().getMarkdown()).toContain("[[company/goals]]"));
  });
});
