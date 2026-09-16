import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { createRef, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type ComposerInputHandle, ReferenceComposerInput } from "./ReferenceComposerInput";

let captured: Editor | null = null;
vi.mock("@tiptap/react", async (original) => {
  const importedModule = await original<typeof import("@tiptap/react")>();
  return {
    ...importedModule,
    useEditor: (options: Parameters<typeof importedModule.useEditor>[0], deps: never) => {
      const editor = importedModule.useEditor(options, deps);
      captured = editor ?? captured;
      return editor;
    },
  };
});
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {
  cleanup();
  captured = null;
});

const link = "[org/repo](https://github.com/org/repo)";
function Harness({ initial = "", handle = createRef<ComposerInputHandle>() }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ReferenceComposerInput
        ref={handle}
        id="test-composer"
        value={value}
        placeholder="Write a message"
        highlights={[]}
        onChange={(event) => setValue(event.target.value)}
        onSelectionChange={() => {}}
        onBlur={() => {}}
        onKeyDown={() => {}}
        onPaste={() => {}}
      />
      <output data-testid="saved">{value}</output>
      <button onClick={() => setValue(`Review ${link} now`)}>Insert reference</button>
    </>
  );
}

describe("real reference composer", () => {
  it("renders saved references atomically and translates caret offsets to saved text", async () => {
    const handle = createRef<ComposerInputHandle>();
    render(<Harness initial={`Review ${link} now`} handle={handle} />);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(input).toHaveTextContent("Review org/repo now"));
    expect(input.querySelector('[data-context-reference="repository"]')).toHaveAttribute(
      "contenteditable",
      "false",
    );
    act(() => handle.current?.setSelectionRange(7 + link.length, 7 + link.length));
    expect(handle.current?.selectionStart).toBe(7 + link.length);
    expect(handle.current?.value).toBe(`Review ${link} now`);
  });
  it("can undo and redo a selected reference, and delete it as one unit", async () => {
    render(<Harness initial="Review @repo" />);
    await screen.findByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "Insert reference" }));
    await waitFor(() => expect(screen.getByTestId("saved")).toHaveTextContent(link));
    act(() => {
      captured!.commands.undo();
    });
    expect(screen.getByTestId("saved")).toHaveTextContent("Review @repo");
    act(() => {
      captured!.commands.redo();
      captured!.commands.setNodeSelection(7);
      captured!.commands.deleteSelection();
    });
    expect(screen.getByTestId("saved")).toHaveTextContent("Review now");
  });
  it("pastes readable Markdown as a chip and preserves newlines and ordinary text", async () => {
    render(<Harness />);
    const input = await screen.findByRole("textbox");
    fireEvent.paste(input, {
      clipboardData: { getData: () => `Review ${link}\nthen report`, items: [] },
    });
    await waitFor(() => expect(input).toHaveTextContent("org/repo"));
    expect(screen.getByTestId("saved").textContent).toBe(`Review ${link}\nthen report`);
    act(() => {
      captured!.commands.setTextSelection(captured!.state.doc.content.size);
    });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByTestId("saved").textContent).toBe(`Review ${link}\nthen report\n`);
  });
});
