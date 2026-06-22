import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileMenuButton } from "./MobileMenuButton";
import { ShellChrome } from "./ShellChrome";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

afterEach(() => vi.unstubAllGlobals());

function setMobile() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => true,
  }));
}

describe("MobileMenuButton", () => {
  it("opens the drawer when tapped", async () => {
    setMobile();
    const user = userEvent.setup();
    render(
      <ShellChrome sidebar={<nav>SIDEBAR</nav>}>
        <MobileMenuButton />
      </ShellChrome>,
    );
    expect(screen.queryByTestId("drawer-scrim")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getByTestId("drawer-scrim")).toBeInTheDocument();
  });
});
