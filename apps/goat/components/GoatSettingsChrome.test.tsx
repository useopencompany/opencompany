import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoatSettingsSidebar } from "./GoatSettingsChrome";

const pathnameMock = vi.hoisted(() => ({ value: "/settings" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.value,
}));

describe("GoatSettingsSidebar", () => {
  afterEach(() => {
    pathnameMock.value = "/settings";
  });

  it("places usage under workspace settings", () => {
    render(<GoatSettingsSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const personalGroup = screen.getByText("Personal").parentElement;
    const workspaceGroup = screen.getByText("Workspace").parentElement;

    expect(personalGroup).not.toBeNull();
    expect(workspaceGroup).not.toBeNull();
    expect(within(personalGroup as HTMLElement).queryByRole("link", { name: "Usage" })).toBeNull();

    const usageLink = within(workspaceGroup as HTMLElement).getByRole("link", { name: "Usage" });
    expect(usageLink).toHaveAttribute("href", "/settings/workspace/usage");
  });

  it("marks workspace usage active without also marking members active", () => {
    pathnameMock.value = "/settings/workspace/usage";

    render(<GoatSettingsSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: "Usage" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Members" })).not.toHaveAttribute("aria-current");
  });
});
