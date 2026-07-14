import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownGoatBrainEditor } from "./MarkdownGoatBrainEditor";

describe("MarkdownGoatBrainEditor", () => {
  it("renders web source refs as source chips when the URL is auto-linked", async () => {
    render(
      <MarkdownGoatBrainEditor
        content="OpenCompany ([[source:web:https://www.opencompany.cloud/about|About]])."
        onChange={vi.fn()}
        readOnly
      />,
    );

    const sourceLink = await screen.findByRole("link", { name: "About" });
    expect(sourceLink.getAttribute("data-brain-href")).toBe("https://www.opencompany.cloud/about");
    expect(sourceLink.tagName).toBe("A");
    expect(sourceLink.getAttribute("target")).toBe("_blank");
    expect(sourceLink.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps a leading link collapsed in read-only documents", async () => {
    render(
      <MarkdownGoatBrainEditor
        content="[[page:acme|Acme]] is a customer."
        onChange={vi.fn()}
        brainLinks={{ "page:acme": "/brain/companies/acme" }}
        readOnly
      />,
    );

    expect((await screen.findByRole("link", { name: "Acme" })).getAttribute("href")).toBe(
      "/brain/companies/acme",
    );
    expect(document.querySelector(".wiki-brain-syntax")).toBeNull();
  });

  it("preserves document positions after hard breaks", async () => {
    render(
      <MarkdownGoatBrainEditor
        content={"Before  \n[[page:acme|Acme]]"}
        onChange={vi.fn()}
        brainLinks={{ "page:acme": "/brain/companies/acme" }}
        readOnly
      />,
    );

    expect((await screen.findByRole("link", { name: "Acme" })).getAttribute("href")).toBe(
      "/brain/companies/acme",
    );
  });

  it("leaves wiki syntax literal inside inline and fenced code", async () => {
    render(
      <MarkdownGoatBrainEditor
        content={[
          "Literal `[[page:acme|Inline]]`.",
          "",
          "```text",
          "[[page:acme|Fenced]]",
          "```",
        ].join("\n")}
        onChange={vi.fn()}
        brainLinks={{ "page:acme": "/brain/companies/acme" }}
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
      <MarkdownGoatBrainEditor
        content="See [[page:acme|Acme]]."
        onChange={onChange}
        readOnly={false}
      />,
    );

    expect(screen.queryByRole("link", { name: "Acme" })).toBeNull();
    rerender(
      <MarkdownGoatBrainEditor
        content="See [[page:acme|Acme]]."
        onChange={onChange}
        brainLinks={{ "page:acme": "/brain/companies/acme" }}
        readOnly
      />,
    );

    expect((await screen.findByRole("link", { name: "Acme" })).getAttribute("href")).toBe(
      "/brain/companies/acme",
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
      <MarkdownGoatBrainEditor
        content="See [[page:acme|Acme]]."
        onChange={vi.fn()}
        brainLinks={{ "page:acme": "/brain/companies/acme" }}
        readOnly
        onNavigateInternal={onNavigateInternal}
      />,
    );

    const link = await screen.findByRole("link", { name: "Acme" });
    expect(fireEvent.click(link)).toBe(false);
    expect(onNavigateInternal).toHaveBeenCalledOnce();
  });
});
