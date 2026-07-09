import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GoatSidebar } from "./GoatSidebar";

const pathnameMock = vi.hoisted(() => ({ value: "/" }));
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.value,
  useRouter: () => routerMock,
}));

vi.mock("@/lib/workspace-actions", () => ({
  switchGoatBrainAction: vi.fn(),
  createGoatBrainAction: vi.fn(),
  setGoatBrainAccessAction: vi.fn(),
  getGoatBrainAccessDetailsAction: vi.fn(),
}));

vi.mock("@/components/GoatAppDataProvider", () => ({
  useGoatAppData: () => ({
    user: {
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
    },
    workspace: { id: "goat_ws_1", name: "Ada's Workspace", role: "admin" },
    brains: [
      {
        id: "goat_brain_1",
        name: "General",
        slug: "general",
        description: null,
        visibility: "workspace",
      },
    ],
    activeBrain: {
      id: "goat_brain_1",
      name: "General",
      slug: "general",
      description: null,
      visibility: "workspace",
    },
  }),
}));

describe("GoatSidebar", () => {
  it("renders home, the brain list, and settings in the account footer", () => {
    pathnameMock.value = "/";
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "Goat primary" });
    const home = within(nav).getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("href", "/");
    expect(home).toHaveAttribute("aria-current", "page");
    expect(within(nav).queryByRole("link", { name: "Brain" })).not.toBeInTheDocument();
    expect(screen.getByText("Brains")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "General" })).not.toHaveAttribute("aria-current");
    expect(
      screen.queryByRole("button", { name: "Manage access to General" }),
    ).not.toBeInTheDocument();

    const settings = screen.getByRole("link", { name: /Ada Lovelace/ });
    expect(settings).toHaveAttribute("href", "/settings");
  });

  it("does not mark home active on nested brain routes", () => {
    pathnameMock.value = "/brain/people/ada-lovelace";
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const nav = screen.getByRole("navigation", { name: "Goat primary" });
    expect(within(nav).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "true");
  });

  it("opens the active brain route from the brain list", async () => {
    const user = userEvent.setup();
    pathnameMock.value = "/";
    render(<GoatSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    await user.click(screen.getByRole("button", { name: "General" }));

    expect(routerMock.push).toHaveBeenCalledWith("/brain/goat_brain_1");
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
