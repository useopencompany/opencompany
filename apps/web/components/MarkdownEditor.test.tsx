import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

describe("MarkdownEditor", () => {
  it("renders web source refs as source chips when the URL is auto-linked", async () => {
    render(
      <MarkdownEditor
        content="opencompany ([[source:web:https://www.opencompany.cloud/about|About]])."
        onChange={vi.fn()}
        readOnly
      />,
    );

    const sourceLink = await screen.findByRole("link", { name: "About" });
    expect(sourceLink.getAttribute("href")).toBe("https://www.opencompany.cloud/about");
    expect(sourceLink.tagName).toBe("A");
    expect(sourceLink.getAttribute("target")).toBe("_blank");
    expect(sourceLink.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders page chips with the live page title, following renames", async () => {
    const { rerender } = render(
      <MarkdownEditor
        content="See [[acme|Frozen label]]."
        onChange={vi.fn()}
        pageLinks={{ acme: "/wiki/acme" }}
        pageTitles={{ acme: "Acme Corp" }}
        readOnly
      />,
    );

    expect((await screen.findByRole("link", { name: "Acme Corp" })).getAttribute("href")).toBe(
      "/wiki/acme",
    );

    rerender(
      <MarkdownEditor
        content="See [[acme|Frozen label]]."
        onChange={vi.fn()}
        pageLinks={{ acme: "/wiki/acme" }}
        pageTitles={{ acme: "Acme Inc" }}
        readOnly
      />,
    );

    expect((await screen.findByRole("link", { name: "Acme Inc" })).getAttribute("href")).toBe(
      "/wiki/acme",
    );
  });

  it("keeps a long page title available when the visible chip is truncated", async () => {
    const title = "Go-to-market — first customers: sell how we build with opencompany";
    render(
      <MarkdownEditor
        content="Related: [[go-to-market]]."
        onChange={vi.fn()}
        pageLinks={{ "go-to-market": "/wiki/go-to-market" }}
        pageTitles={{ "go-to-market": title }}
        readOnly
      />,
    );

    const link = await screen.findByRole("link", { name: title });
    expect(link.getAttribute("title")).toBe(`${title} — Open link`);
    expect(link.querySelector(".wiki-source-chip-label")?.textContent).toBe(title);
  });

  it("keeps a leading link collapsed in read-only documents", async () => {
    const { container } = render(
      <MarkdownEditor
        content="[[page:acme|Acme]] is a customer."
        onChange={vi.fn()}
        pageLinks={{ "page:acme": "/wiki/company/companies/acme" }}
        readOnly
      />,
    );

    expect((await screen.findByRole("link", { name: "Acme" })).getAttribute("href")).toBe(
      "/wiki/company/companies/acme",
    );
    expect(container.querySelector(".wiki-doc-syntax")).toBeNull();
  });

  it("preserves document positions after hard breaks", async () => {
    render(
      <MarkdownEditor
        content={"Before  \n[[page:acme|Acme]]"}
        onChange={vi.fn()}
        pageLinks={{ "page:acme": "/wiki/company/companies/acme" }}
        readOnly
      />,
    );

    expect((await screen.findByRole("link", { name: "Acme" })).getAttribute("href")).toBe(
      "/wiki/company/companies/acme",
    );
  });

  it("leaves wiki syntax literal inside inline and fenced code", async () => {
    render(
      <MarkdownEditor
        content={[
          "Literal `[[page:acme|Inline]]`.",
          "",
          "```text",
          "[[page:acme|Fenced]]",
          "```",
        ].join("\n")}
        onChange={vi.fn()}
        pageLinks={{ "page:acme": "/wiki/company/companies/acme" }}
        readOnly
      />,
    );

    await screen.findByText("[[page:acme|Inline]]");
    expect(screen.queryByRole("link", { name: "Inline" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Fenced" })).toBeNull();
  });

  it("refreshes link targets and editability when props change", async () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <MarkdownEditor content="See [[page:acme|Acme]]." onChange={onChange} readOnly={false} />,
    );

    expect(screen.queryByRole("link", { name: "Acme" })).toBeNull();
    rerender(
      <MarkdownEditor
        content="See [[page:acme|Acme]]."
        onChange={onChange}
        pageLinks={{ "page:acme": "/wiki/company/companies/acme" }}
        readOnly
      />,
    );

    expect((await screen.findByRole("link", { name: "Acme" })).getAttribute("href")).toBe(
      "/wiki/company/companies/acme",
    );
    await waitFor(() =>
      expect(container.querySelector("[contenteditable]")?.getAttribute("contenteditable")).toBe(
        "false",
      ),
    );
  });

  it("intercepts plain internal link clicks", async () => {
    const onNavigateInternal = vi.fn(() => true);
    render(
      <MarkdownEditor
        content="See [[page:acme|Acme]]."
        onChange={vi.fn()}
        pageLinks={{ "page:acme": "/wiki/company/companies/acme" }}
        readOnly
        onNavigateInternal={onNavigateInternal}
      />,
    );

    const link = await screen.findByRole("link", { name: "Acme" });
    expect(fireEvent.click(link)).toBe(false);
    expect(onNavigateInternal).toHaveBeenCalledOnce();
  });

  it("navigates regular markdown links to wiki pages in the same tab", async () => {
    const onNavigateInternal = vi.fn(() => true);
    render(
      <MarkdownEditor
        content="See [Acme](/wiki/company/companies/acme)."
        onChange={vi.fn()}
        readOnly
        onNavigateInternal={onNavigateInternal}
      />,
    );

    const link = await screen.findByRole("link", { name: "Acme" });
    expect(link.getAttribute("target")).toBeNull();
    expect(fireEvent.click(link)).toBe(false);
    expect(onNavigateInternal).toHaveBeenCalledWith("/wiki/company/companies/acme");
  });

  it("opens regular external markdown links in a new tab", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <MarkdownEditor
        content="See [Docs](https://example.com/docs)."
        onChange={vi.fn()}
        readOnly
      />,
    );

    const link = await screen.findByRole("link", { name: "Docs" });
    expect(fireEvent.click(link)).toBe(false);
    expect(open).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });

  it("does not fire onChange when props change identity without an edit", async () => {
    const onChange = vi.fn();
    const props = {
      content: "See [[page:acme|Acme]].",
      onChange,
      pageLinks: { "page:acme": "/wiki/company/companies/acme" },
      readOnly: false,
    } as const;
    const { rerender } = render(<MarkdownEditor {...props} onNavigateInternal={() => true} />);

    await screen.findByText("Acme");
    // Parents pass a fresh navigation closure every render; if that emitted a
    // phantom onChange, the resulting setState → re-render → new closure cycle
    // would loop forever and mark clean documents dirty.
    rerender(<MarkdownEditor {...props} onNavigateInternal={() => true} />);
    rerender(<MarkdownEditor {...props} onNavigateInternal={() => true} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses the latest internal navigation handler after a prop update", async () => {
    const firstHandler = vi.fn(() => true);
    const secondHandler = vi.fn(() => true);
    const props = {
      content: "See [[page:acme|Acme]].",
      onChange: vi.fn(),
      pageLinks: { "page:acme": "/wiki/company/companies/acme" },
      readOnly: true,
    } as const;
    const { rerender } = render(<MarkdownEditor {...props} onNavigateInternal={firstHandler} />);

    const link = await screen.findByRole("link", { name: "Acme" });
    rerender(<MarkdownEditor {...props} onNavigateInternal={secondHandler} />);
    expect(fireEvent.click(link)).toBe(false);
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledOnce();
  });
});
