import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionStatusDot } from "./SessionStatusDot";

describe("SessionStatusDot", () => {
  it("renders a green fill for a running session", () => {
    const { container } = render(<SessionStatusDot status="running" pulse />);
    expect(container.querySelector("circle")?.getAttribute("fill")).toBe("var(--color-success)");
  });

  it("renders a blue fill when the session is unseen-finished", () => {
    const { container } = render(<SessionStatusDot status="completed" pulse unseen />);
    expect(container.querySelector("circle")?.getAttribute("fill")).toBe("var(--color-info)");
  });

  it("does not pulse the unseen dot", () => {
    const { container } = render(<SessionStatusDot status="completed" pulse unseen />);
    expect(container.querySelector("svg")?.getAttribute("class")).not.toContain("session-pulse");
  });
});
