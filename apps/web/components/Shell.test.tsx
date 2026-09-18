import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "./Shell";

const pathnameMock = vi.hoisted(() => ({ value: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock.value,
}));

vi.mock("./Sidebar", () => ({
  Sidebar: () => <div data-testid="primary-sidebar" />,
}));

vi.mock("./SettingsChrome", () => ({
  SettingsSidebar: () => <div data-testid="settings-sidebar" />,
}));

describe("Shell", () => {
  beforeEach(() => {
    pathnameMock.value = "/";
    window.localStorage.clear();
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });

  it("swaps in the settings sidebar under /settings", () => {
    pathnameMock.value = "/settings/workspace";
    render(
      <Shell>
        <div />
      </Shell>,
    );

    expect(screen.getByTestId("settings-sidebar")).toBeInTheDocument();
    expect(screen.queryByTestId("primary-sidebar")).not.toBeInTheDocument();
  });

  // Plugins and Skills are main-view destinations, not settings pages: opening one from the
  // sidebar must leave the primary sidebar in place instead of replacing it with settings nav.
  it.each(["/plugins", "/plugins/linear", "/skills", "/skills/weekly-report"])(
    "keeps the primary sidebar on %s",
    (pathname) => {
      pathnameMock.value = pathname;
      render(
        <Shell>
          <div />
        </Shell>,
      );

      expect(screen.getByTestId("primary-sidebar")).toBeInTheDocument();
      expect(screen.queryByTestId("settings-sidebar")).not.toBeInTheDocument();
    },
  );
});
