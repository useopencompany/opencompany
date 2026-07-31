import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders unsafe links as inert text", () => {
    render(<Markdown content="[bad](javascript:alert(1)) [good](https://example.com)" />);

    expect(screen.getByText("bad").closest("a")).toBeNull();
    expect(screen.getByRole("link", { name: "good" }).getAttribute("href")).toBe(
      "https://example.com",
    );
  });

  it("renders http(s), mailto, and tel links as external links with the current target and rel", () => {
    render(
      <Markdown content="[web](https://example.com) [mail](mailto:a@example.com) [call](tel:+15551234)" />,
    );

    for (const name of ["web", "mail", "call"]) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer noopener");
    }
  });

  it("does not open a new tab for internal links", () => {
    render(<Markdown content="[go](/brain/page)" />);

    const link = screen.getByRole("link", { name: "go" });
    expect(link).toHaveAttribute("href", "/brain/page");
    expect(link).not.toHaveAttribute("target");
  });

  it("keeps protocol-relative and unsupported custom protocol links inert", () => {
    render(
      <Markdown content="[a](//example.com) [b](ftp://example.com) [c](weird-scheme:thing)" />,
    );

    expect(screen.getByText("a").closest("a")).toBeNull();
    expect(screen.getByText("b").closest("a")).toBeNull();
    expect(screen.getByText("c").closest("a")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders fragment links as same-document links", () => {
    render(<Markdown content="[jump](#section)" />);

    const link = screen.getByRole("link", { name: "jump" });
    expect(link).toHaveAttribute("href", "#section");
    expect(link).not.toHaveAttribute("target");
  });

  it("does not create HTML elements from raw HTML", () => {
    const { container } = render(<Markdown content={"before\n\n<div>raw</div>\n\nafter"} />);

    expect(container.querySelectorAll("div")).toHaveLength(1);
    expect(screen.getByText("before")).toBeInTheDocument();
    expect(screen.getByText("after")).toBeInTheDocument();
  });

  it("does not render markdown images", () => {
    const { container } = render(<Markdown content="![alt](https://example.com/a.png)" />);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByAltText("alt")).toBeNull();
  });

  it("renders GFM tables, strikethrough, and task lists", () => {
    const { container } = render(
      <Markdown
        content={
          "- [ ] task one\n- [x] task two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n~~strike~~ **bold**"
        }
      />,
    );

    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(container.querySelector('input[type="checkbox"][checked=""]')).toBeTruthy();
    expect(container.querySelector("table")).toBeTruthy();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(container.querySelector("del")?.textContent).toBe("strike");
  });

  it("renders soft newlines as <br> elements", () => {
    const { container } = render(<Markdown content={"First line\nSecond line\nThird line"} />);

    const paragraph = container.querySelector("p");
    expect(paragraph?.textContent).toBe("First line\nSecond line\nThird line");
    expect(paragraph?.querySelectorAll("br")).toHaveLength(2);
  });

  it("renders strong, list, table, and code DOM as plain semantic markup", () => {
    const { container } = render(
      <Markdown
        content={
          "**bold**\n\n- one\n- two\n\n| A |\n|---|\n| 1 |\n\n`inline code`\n\n```ts\nconst a = 1;\n```"
        }
      />,
    );

    const strong = container.querySelector("strong");
    expect(strong?.tagName).toBe("STRONG");
    expect(strong).not.toHaveAttribute("class");

    const ul = container.querySelector("ul");
    expect(ul).not.toHaveAttribute("class");
    for (const li of container.querySelectorAll("li")) {
      expect(li).not.toHaveAttribute("class");
    }

    const table = container.querySelector("table");
    expect(table).not.toHaveAttribute("class");
    expect(container.querySelector("thead")).toBeTruthy();
    expect(container.querySelector("tbody")).toBeTruthy();

    const inlineCode = container.querySelector("p code");
    expect(inlineCode).not.toHaveAttribute("class");
  });

  it("renders fenced code as plain pre/code with no copy, download, or language header controls", () => {
    const { container } = render(<Markdown content={"```ts\nconst a = 1;\n```"} />);

    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre?.querySelector("code")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps the session-markdown root class and neutralizes Streamdown's built-in vertical gap", () => {
    const { container } = render(<Markdown content="Hello" className="extra-class" />);

    const root = container.firstElementChild;
    expect(root?.className).toContain("session-markdown");
    expect(root?.className).toContain("space-y-0");
    expect(root?.className).toContain("extra-class");
    expect(root?.className).not.toContain("space-y-4");
  });

  it("repairs incomplete emphasis while streaming", () => {
    const { container } = render(<Markdown content="Some **bold text" mode="streaming" />);

    expect(container.querySelector("strong")?.textContent).toBe("bold text");
  });

  it("keeps incomplete fenced code readable while streaming", () => {
    const { container } = render(<Markdown content={"```ts\nconst a = 1;"} mode="streaming" />);

    const code = container.querySelector("pre code");
    expect(code?.textContent).toContain("const a = 1;");
  });

  it("does not repair incomplete markdown in static mode", () => {
    const { container } = render(<Markdown content="Some **bold text" mode="static" />);

    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("Some **bold text");
  });

  it("creates data-sd-animate spans for prose when isAnimating is true", () => {
    const { container } = render(<Markdown content="Hello world" mode="streaming" isAnimating />);

    expect(container.querySelectorAll("[data-sd-animate]").length).toBeGreaterThan(0);
  });

  it("removes all animation spans when rerendered with isAnimating false", () => {
    const { container, rerender } = render(
      <Markdown content="Hello world" mode="streaming" isAnimating />,
    );
    expect(container.querySelectorAll("[data-sd-animate]").length).toBeGreaterThan(0);

    rerender(<Markdown content="Hello world" mode="streaming" isAnimating={false} />);

    expect(container.querySelectorAll("[data-sd-animate]")).toHaveLength(0);
  });

  it("never adds animation spans inside code or pre content", () => {
    const { container } = render(
      <Markdown content={"Some prose\n\n```ts\nconst a = 1;\n```"} mode="streaming" isAnimating />,
    );

    const pre = container.querySelector("pre");
    expect(pre?.querySelector("[data-sd-animate]")).toBeNull();
    expect(container.querySelectorAll("[data-sd-animate]").length).toBeGreaterThan(0);
  });
});
