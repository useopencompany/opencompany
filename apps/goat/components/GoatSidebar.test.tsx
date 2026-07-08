import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoatSidebar } from "./GoatSidebar";

const pathnameMock = vi.hoisted(() => ({ value: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.value,
}));

vi.mock("@/components/GoatAppDataProvider", () => ({
  useGoatAppData: () => ({
    user: {
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
    },
  }),
}));

describe("GoatSidebar", () => {
  it("renders home and brain tabs with settings in the account footer", () => {
    pathnameMock.value = "/";
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "Goat primary" });
    const home = within(nav).getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("href", "/");
    expect(home).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Brain" })).toHaveAttribute("href", "/brain");
    expect(within(nav).getByRole("link", { name: "Brain" })).not.toHaveAttribute("aria-current");

    const settings = screen.getByRole("link", { name: /Ada Lovelace/ });
    expect(settings).toHaveAttribute("href", "/settings");
  });

  it("marks the brain tab active on nested brain routes", () => {
    pathnameMock.value = "/brain/people/ada-lovelace";
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "Goat primary" });
    expect(within(nav).getByRole("link", { name: "Brain" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("collapses to zero width and toggles via the sidebar button", () => {
    pathnameMock.value = "/";
    const onToggleCollapsed = vi.fn();
    render(<GoatSidebar collapsed onToggleCollapsed={onToggleCollapsed} />);

    const aside = document.querySelector("aside");
    expect(aside).toHaveAttribute("aria-hidden", "true");
    expect(aside?.className).toContain("w-0");
  });
});
