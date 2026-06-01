import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// BrainView pulls in server-action modules (which reach into the auth/DB
// stack) through its import graph. Stub them so the component can mount in
// jsdom; this test only exercises the client-side MarkdownBrainEditor.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/brain/actions", () => ({
  createBrainFile: vi.fn(),
  deleteBrainFile: vi.fn(),
  deleteBrainFolder: vi.fn(),
  renameBrainFile: vi.fn(),
  renameBrainFolder: vi.fn(),
  updateBrainFile: vi.fn(),
}));

// Spy on the Tiptap entry point so we can inspect the exact `content` option
// MarkdownBrainEditor hands to useEditor on each render. The real flicker
// (PRO-83) is a browser-only input-composition artefact that jsdom cannot
// reproduce, so we assert the *mechanism* the fix guarantees instead: the
// content option must be frozen at the value captured on mount and must not
// change when the parent re-renders with a different `content` prop.
const useEditorSpy = vi.fn();
vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    useEditor: (options: { content?: string }, deps?: unknown[]) => {
      useEditorSpy(options?.content);
      return actual.useEditor(options as never, deps as never);
    },
  };
});

const { MarkdownBrainEditor } = await import("./BrainView");

function contentOptionsSeen(): string[] {
  return useEditorSpy.mock.calls.map((call) => call[0] as string);
}

describe("MarkdownBrainEditor", () => {
  beforeEach(() => {
    useEditorSpy.mockClear();
  });

  it("renders the initial markdown content", () => {
    const { container } = render(<MarkdownBrainEditor content={"# Heading"} onChange={vi.fn()} />);
    expect(container.querySelector(".tiptap-brain")?.textContent ?? "").toContain("Heading");
  });

  it("freezes the content option passed to useEditor across re-renders (PRO-83)", () => {
    const { rerender } = render(<MarkdownBrainEditor content={"# Title"} onChange={vi.fn()} />);
    expect(contentOptionsSeen()[0]).toBe("# Title");

    // The parent stores the editor's own keystroke output back into state,
    // re-rendering MarkdownBrainEditor with a changed `content` prop on every
    // keystroke. The content option fed to useEditor must stay frozen at the
    // value captured on mount, otherwise setOptions()/updateState() fires each
    // render and the typed characters flicker away momentarily.
    rerender(<MarkdownBrainEditor content={"# Tit"} onChange={vi.fn()} />);
    rerender(<MarkdownBrainEditor content={"completely different"} onChange={vi.fn()} />);

    const seen = contentOptionsSeen();
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((value) => value === "# Title")).toBe(true);
  });
});
