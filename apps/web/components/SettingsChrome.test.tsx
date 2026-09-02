import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSidebar } from "./SettingsChrome";

const pathnameMock = vi.hoisted(() => ({ value: "/settings" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.value,
}));

describe("SettingsSidebar", () => {
  afterEach(() => {
    pathnameMock.value = "/settings";
  });

  it("places usage under workspace settings", () => {
    render(<SettingsSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    const personalGroup = screen.getByText("Personal").parentElement;
    const workspaceGroup = screen.getByText("Workspace").parentElement;

    expect(personalGroup).not.toBeNull();
    expect(workspaceGroup).not.toBeNull();
    expect(within(personalGroup as HTMLElement).queryByRole("link", { name: "Usage" })).toBeNull();

    const usageLink = within(workspaceGroup as HTMLElement).getByRole("link", { name: "Usage" });
    expect(usageLink).toHaveAttribute("href", "/settings/workspace/usage");
    expect(
      within(workspaceGroup as HTMLElement).getByRole("link", { name: "Billing" }),
    ).toHaveAttribute("href", "/settings/workspace/billing");
    expect(
      within(workspaceGroup as HTMLElement).getByRole("link", { name: "Repositories" }),
    ).toHaveAttribute("href", "/settings/repositories");
    expect(
      within(workspaceGroup as HTMLElement).getByRole("link", { name: "Plugins" }),
    ).toHaveAttribute("href", "/settings/plugins");
    expect(
      within(workspaceGroup as HTMLElement).getByRole("link", { name: "Inference" }),
    ).toHaveAttribute("href", "/settings/workspace/inference");
  });

  it("marks workspace usage active without also marking members active", () => {
    pathnameMock.value = "/settings/workspace/usage";

    render(<SettingsSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: "Usage" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Members" })).not.toHaveAttribute("aria-current");
  });

  it("marks inference active without also marking members active", () => {
    pathnameMock.value = "/settings/workspace/inference";

    render(<SettingsSidebar collapsed={false} onToggleCollapsed={() => {}} />);

    expect(screen.getByRole("link", { name: "Inference" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Members" })).not.toHaveAttribute("aria-current");
  });
});
