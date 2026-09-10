import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownBrainEditor } from "./MarkdownBrainEditor";

const SKILL = {
  scope: "company" as const,
  id: "skill_installation_0123456789abcdef",
  name: "feature-blog-post",
  description: "Draft a feature announcement",
};

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

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

beforeEach(() => {
  capturedEditor = null;
});
afterEach(cleanup);

describe("workflow skill mentions in the real markdown editor", () => {
  it.each(["click", "Tab"])(
    "selects a skill with %s and can delete the whole mention",
    async (method) => {
      render(<MarkdownBrainEditor content="" onChange={vi.fn()} skillMentions={[SKILL]} />);
      await waitFor(() => expect(capturedEditor).not.toBeNull());
      const editor = capturedEditor as Editor;
      act(() => {
        editor.chain().focus().insertContent("@feature").run();
      });
      const option = await screen.findByRole("option", { name: /feature-blog-post/ });
      if (method === "click") fireEvent.click(option);
      else fireEvent.keyDown(editor.view.dom, { key: "Tab" });
      await waitFor(() => expect(editor.view.dom.textContent?.trim()).toBe(`@${SKILL.name}`));
      act(() => {
        editor.commands.setNodeSelection(1);
      });
      fireEvent.keyDown(editor.view.dom, { key: "Backspace" });
      expect(editor.getMarkdown().trim()).toBe("");
    },
  );

  it("shows the empty result without creating a reference", async () => {
    render(<MarkdownBrainEditor content="" onChange={vi.fn()} skillMentions={[]} />);
    await waitFor(() => expect(capturedEditor).not.toBeNull());
    const editor = capturedEditor as Editor;
    act(() => {
      editor.chain().focus().insertContent("@missing").run();
    });
    await screen.findByText("No matching skills");
    expect(editor.view.dom.querySelector("[data-skill-mention]")).toBeNull();
    expect(editor.getMarkdown()).toBe("@missing");
  });

  it("displays saved mentions in read-only workflows without emitting an edit", async () => {
    const onChange = vi.fn();
    render(
      <MarkdownBrainEditor
        content={`@skill/${SKILL.id}`}
        onChange={onChange}
        skillMentions={[SKILL]}
        readOnly
      />,
    );
    await screen.findByText(`@${SKILL.name}`);
    expect(capturedEditor?.isEditable).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the selected skill name visible after Enter while saving its stable ID", async () => {
    const onChange = vi.fn();
    render(<MarkdownBrainEditor content="" onChange={onChange} skillMentions={[SKILL]} />);
    await waitFor(() => expect(capturedEditor).not.toBeNull());
    const editor = capturedEditor as Editor;
    act(() => {
      editor.chain().focus().insertContent("@feature").run();
    });
    await screen.findByRole("option", { name: /feature-blog-post/ });
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    await waitFor(() => expect(editor.getMarkdown().trim()).toBe(`@skill/${SKILL.id}`));
    expect(editor.view.dom.textContent?.trim()).toBe(`@${SKILL.name}`);
    expect(onChange).toHaveBeenLastCalledWith(editor.getMarkdown());
  });
});
