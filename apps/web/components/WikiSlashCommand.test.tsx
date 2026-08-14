import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Extension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { WikiLink } from "./WikiLinkNode";
import {
  createWikiSlashCommandPlugin,
  filterWikiSlashItems,
  type WikiSlashCommandHandlers,
} from "./WikiSlashCommand";

// jsdom has no layout; ProseMirror's post-dispatch scrollIntoView asks ranges
// for client rects, and cmdk needs ResizeObserver + element scrollIntoView.
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

describe("filterWikiSlashItems", () => {
  it("matches commands by id, label, and keywords", () => {
    // Text, Heading 1-3, Bulleted list, Numbered list, Page.
    expect(filterWikiSlashItems("")).toHaveLength(7);
    expect(filterWikiSlashItems("pag")).toHaveLength(1);
    expect(filterWikiSlashItems("head")).toHaveLength(3);
    expect(filterWikiSlashItems("list")).toHaveLength(2);
    expect(filterWikiSlashItems("nope")).toHaveLength(0);
  });
});

// Mirrors how MarkdownBrainEditor registers the plugin, with the editor
// instance exposed so the test can type and press keys like a user would.
function Harness({
  handlers,
  onReady,
}: {
  handlers: WikiSlashCommandHandlers;
  onReady: (editor: NonNullable<ReturnType<typeof useEditor>>) => void;
}) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
      WikiLink,
      Extension.create({
        name: "wikiSlashCommand",
        addProseMirrorPlugins() {
          return [createWikiSlashCommandPlugin(this.editor, handlers)];
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

async function mountWithSlashMenuOpen(handlers: WikiSlashCommandHandlers) {
  let editor: NonNullable<ReturnType<typeof useEditor>> | null = null;
  render(
    <Harness
      handlers={handlers}
      onReady={(instance) => {
        editor = instance;
      }}
    />,
  );
  await waitFor(() => expect(editor).not.toBeNull());
  act(() => {
    editor?.chain().focus().insertContent("/page").run();
  });
  await screen.findByText("Create a sub-page and link it here");
  if (!editor) throw new Error("editor missing");
  return editor as NonNullable<ReturnType<typeof useEditor>>;
}

const CREATED_PAGE = { id: "page-1", slug: "untitled", path: "parent/untitled", title: "" };

describe("wiki slash command menu", () => {
  it("creates the page, inserts a bare [[slug]] link, and opens it on Enter", async () => {
    const createPage = vi.fn().mockReturnValue(CREATED_PAGE);
    const onPageCreated = vi.fn();
    const editor = await mountWithSlashMenuOpen({ createPage, onPageCreated });

    fireEvent.keyDown(editor.view.dom, { key: "Enter" });

    await waitFor(() => expect(createPage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(editor.getMarkdown()).toContain("[[untitled]]"));
    expect(editor.getMarkdown()).not.toContain("/page");
    expect(onPageCreated).toHaveBeenCalledWith(CREATED_PAGE);
  });

  it("navigates the cmdk selection with arrow keys without leaking into the editor", async () => {
    const createPage = vi.fn().mockReturnValue(CREATED_PAGE);
    const editor = await mountWithSlashMenuOpen({ createPage });

    fireEvent.keyDown(editor.view.dom, { key: "ArrowDown" });
    fireEvent.keyDown(editor.view.dom, { key: "ArrowUp" });
    expect(editor.getMarkdown()).toContain("/page");

    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    await waitFor(() => expect(createPage).toHaveBeenCalledTimes(1));
  });

  it("creates the page and inserts the link on click", async () => {
    const createPage = vi.fn().mockReturnValue(CREATED_PAGE);
    const onPageCreated = vi.fn();
    const editor = await mountWithSlashMenuOpen({ createPage, onPageCreated });

    fireEvent.click(screen.getByText("Create a sub-page and link it here"));

    await waitFor(() => expect(createPage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(editor.getMarkdown()).toContain("[[untitled]]"));
    expect(onPageCreated).toHaveBeenCalledWith(CREATED_PAGE);
  });

  it("keeps the /page text when creation is refused", async () => {
    const createPage = vi.fn().mockReturnValue(null);
    const onPageCreated = vi.fn();
    const editor = await mountWithSlashMenuOpen({ createPage, onPageCreated });

    fireEvent.keyDown(editor.view.dom, { key: "Enter" });

    await waitFor(() => expect(createPage).toHaveBeenCalledTimes(1));
    expect(editor.getMarkdown()).toContain("/page");
    expect(onPageCreated).not.toHaveBeenCalled();
  });
});
