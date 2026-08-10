import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MarkdownGoatBrainEditor } from "./MarkdownGoatBrainEditor";

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

// Capture the editor instance the real component creates so the test can type
// into it like a user would.
let capturedEditor: Editor | null = null;
vi.mock("@tiptap/react", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...mod,
    useEditor: ((options: Parameters<typeof mod.useEditor>[0], deps: unknown[]) => {
      const editor = mod.useEditor(options, deps as never);
      capturedEditor = editor ?? capturedEditor;
      return editor;
    }) as typeof mod.useEditor,
  };
});

describe("wiki slash command inside MarkdownGoatBrainEditor", () => {
  it("selects the /page entry with Enter and with a click", async () => {
    const createPage = vi
      .fn()
      .mockReturnValue({ id: "page-1", slug: "untitled", path: "untitled", title: "" });
    const onPageCreated = vi.fn();
    render(
      <MarkdownGoatBrainEditor
        content=""
        onChange={vi.fn()}
        brainLinks={{}}
        pageTitles={{}}
        wikiSlashCommands={{ createPage, onPageCreated }}
        placeholder="Write, or type / for commands…"
      />,
    );

    await waitFor(() => expect(capturedEditor).not.toBeNull());
    const editor = capturedEditor as Editor;
    act(() => {
      editor.chain().focus().insertContent("/page").run();
    });
    await screen.findByText("Create a sub-page and link it here");

    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    await waitFor(() => expect(createPage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(editor.getMarkdown()).toContain("[[untitled]]"));
    expect(onPageCreated).toHaveBeenCalledTimes(1);

    act(() => {
      editor.chain().focus().insertContent("/page").run();
    });
    await screen.findByText("Create a sub-page and link it here");
    fireEvent.click(screen.getByText("Create a sub-page and link it here"));
    await waitFor(() => expect(createPage).toHaveBeenCalledTimes(2));
  });
});
