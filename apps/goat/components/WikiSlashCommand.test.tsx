import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Extension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createWikiSlashCommandPlugin,
  filterWikiSlashItems,
  type WikiSlashCommandHandlers,
} from "./WikiSlashCommand";

// jsdom has no layout; ProseMirror's post-dispatch scrollIntoView asks ranges
// for client rects. Stub them so editor dispatches don't throw.
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
});

describe("filterWikiSlashItems", () => {
  it("matches the page command by id and label", () => {
    expect(filterWikiSlashItems("")).toHaveLength(1);
    expect(filterWikiSlashItems("pag")).toHaveLength(1);
    expect(filterWikiSlashItems("nope")).toHaveLength(0);
  });
});

// Mirrors how MarkdownGoatBrainEditor registers the plugin, with the editor
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

describe("wiki slash command menu", () => {
  it("creates the page and inserts a bare [[slug]] link on Enter", async () => {
    const createPage = vi.fn().mockReturnValue({ slug: "untitled", title: "Untitled" });
    const editor = await mountWithSlashMenuOpen({ createPage });

    fireEvent.keyDown(editor.view.dom, { key: "Enter" });

    expect(createPage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(editor.getMarkdown()).toContain("[[untitled]]"));
    expect(editor.getMarkdown()).not.toContain("/page");
  });

  it("creates the page and inserts the link on click", async () => {
    const createPage = vi.fn().mockReturnValue({ slug: "untitled", title: "Untitled" });
    const editor = await mountWithSlashMenuOpen({ createPage });

    fireEvent.mouseDown(screen.getByText("Create a sub-page and link it here"));

    expect(createPage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(editor.getMarkdown()).toContain("[[untitled]]"));
  });

  it("keeps the /page text when creation is refused", async () => {
    const createPage = vi.fn().mockReturnValue(null);
    const editor = await mountWithSlashMenuOpen({ createPage });

    fireEvent.keyDown(editor.view.dom, { key: "Enter" });

    expect(createPage).toHaveBeenCalledTimes(1);
    expect(editor.getMarkdown()).toContain("/page");
  });
});
