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
});
