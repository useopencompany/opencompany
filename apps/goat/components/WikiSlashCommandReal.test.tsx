import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MarkdownGoatBrainEditor } from "./MarkdownGoatBrainEditor";

// jsdom has no layout; ProseMirror's post-dispatch scrollIntoView asks ranges
// for client rects. Stub them so editor dispatches don't throw.
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
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
    const createPage = vi.fn().mockReturnValue({ slug: "untitled", title: "Untitled" });
    render(
      <MarkdownGoatBrainEditor
        content=""
        onChange={vi.fn()}
        brainLinks={{}}
        pageTitles={{}}
        wikiSlashCommands={{ createPage }}
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
    expect(createPage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(editor.getMarkdown()).toContain("[[untitled]]"));

    act(() => {
      editor.chain().focus().insertContent("/page").run();
    });
    await screen.findByText("Create a sub-page and link it here");
    fireEvent.mouseDown(screen.getByText("Create a sub-page and link it here"));
    expect(createPage).toHaveBeenCalledTimes(2);
  });
});
