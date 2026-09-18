import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ContextReferenceText } from "./ContextReference";
import { Markdown } from "./Markdown";
import { MarkdownEditor } from "./MarkdownEditor";

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
vi.mock("@/lib/context-reference-catalog", async (original) => ({
  ...(await original<typeof import("@/lib/context-reference-catalog")>()),
  fetchContextReferenceCatalog: async () => ({
    items: [
      {
        kind: "plugin",
        label: "Slack",
        plugin: "slack",
        href: "/plugins/slack",
        description: "Plugin",
      },
    ],
    error: null,
  }),
}));
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
afterEach(() => {
  cleanup();
  captured = null;
});

describe("workflow and message references", () => {
  it("selects a plugin alongside existing skills and saves ordinary Markdown", async () => {
    const changed = vi.fn();
    render(<MarkdownEditor content="" onChange={changed} skillMentions={[]} contextMentions />);
    await waitFor(() => expect(captured).not.toBeNull());
    act(() => {
      captured!.commands.insertContent("Use @sla");
    });
    await screen.findByRole("option", { name: /Slack/ });
    fireEvent.keyDown(captured!.view.dom, { key: "Tab" });
    expect(captured!.getMarkdown()).toBe("Use [Slack](/plugins/slack) ");
    await waitFor(() =>
      expect(
        captured!.view.dom.querySelector('[data-context-reference="plugin"]'),
      ).toHaveTextContent("Slack"),
    );
    const saved = captured!.getMarkdown();
    cleanup();
    captured = null;
    render(
      <MarkdownEditor content={saved} onChange={() => {}} skillMentions={[]} contextMentions />,
    );
    await waitFor(() =>
      expect(
        captured?.view.dom.querySelector('[data-context-reference="plugin"]'),
      ).toHaveTextContent("Slack"),
    );
    expect(captured!.getMarkdown()).toBe(saved);
  });
  it("renders the same reference in sent text and read-only Markdown without losing surrounding text", () => {
    const text = "Ask [Slack](/plugins/slack)\nabout [org/repo](https://github.com/org/repo)";
    render(
      <>
        <ContextReferenceText text={text} />
        <Markdown content={text} />
      </>,
    );
    expect(screen.getAllByRole("link", { name: "Slack" })).toHaveLength(2);
    for (const link of screen.getAllByRole("link", { name: "org/repo" })) {
      expect(link).toHaveAttribute("href", "https://github.com/org/repo");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });
  it("lets references without an inline brand color inherit their surface foreground", () => {
    render(
      <div className="bg-ink text-canvas">
        <ContextReferenceText text="Ask [org/repo](https://github.com/org/repo)" />
      </div>,
    );
    const link = screen.getByRole("link", { name: "org/repo" });
    expect(link).toHaveClass("context-reference");
    expect(link).not.toHaveClass("text-ink");
    expect(link.querySelector("svg")).not.toHaveClass("text-ink");
  });
});
