import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellChrome, useDrawer } from "./ShellChrome";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

afterEach(() => vi.unstubAllGlobals());

function setMobile(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => true,
  }));
}

// Minimal consumer that toggles the drawer via the exported context hook.
function DrawerOpener() {
  const { setOpen } = useDrawer();
  return (
    <button type="button" onClick={() => setOpen(true)}>
      open
    </button>
  );
}

describe("ShellChrome", () => {
  it("renders sidebar and content", () => {
    setMobile(false);
    render(
      <ShellChrome sidebar={<nav>SIDEBAR</nav>}>
        <div>CONTENT</div>
      </ShellChrome>,
    );
    expect(screen.getByText("SIDEBAR")).toBeInTheDocument();
    expect(screen.getByText("CONTENT")).toBeInTheDocument();
  });

  it("on mobile, shows a scrim when the drawer opens and hides it on scrim click", async () => {
    setMobile(true);
    const user = userEvent.setup();
    render(
      <ShellChrome sidebar={<nav>SIDEBAR</nav>}>
        <DrawerOpener />
      </ShellChrome>,
    );
    expect(screen.queryByTestId("drawer-scrim")).toBeNull();
    await user.click(screen.getByRole("button", { name: "open" }));
    const scrim = screen.getByTestId("drawer-scrim");
    expect(scrim).toBeInTheDocument();
    await user.click(scrim);
    expect(screen.queryByTestId("drawer-scrim")).toBeNull();
  });
});
