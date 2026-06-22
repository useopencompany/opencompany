import { fireEvent, render, screen } from "@testing-library/react";
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

describe("ShellChrome swipe gesture", () => {
  // Drive a pointer drag on `document` (where the gesture listens, in the capture phase).
  // jsdom can't time a flick, so these cover distance/axis/direction behavior; velocity is
  // unit-tested in drawerGesture.test.ts.
  function fireDrag(points: Array<[number, number]>) {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return;
    fireEvent.pointerDown(document, { pointerId: 1, clientX: first[0], clientY: first[1] });
    for (const [x, y] of points.slice(1)) {
      fireEvent.pointerMove(document, { pointerId: 1, clientX: x, clientY: y });
    }
    fireEvent.pointerUp(document, { pointerId: 1, clientX: last[0], clientY: last[1] });
  }

  it("opens the menu on a rightward drag from the left edge", () => {
    setMobile(true);
    render(
      <ShellChrome sidebar={<nav>SIDEBAR</nav>}>
        <div>CONTENT</div>
      </ShellChrome>,
    );
    expect(screen.queryByTestId("drawer-scrim")).toBeNull();
    fireDrag([
      [12, 200],
      [120, 202],
      [240, 205],
    ]);
    expect(screen.getByTestId("drawer-scrim")).toBeInTheDocument();
  });

  it("opens the menu on a rightward drag that starts away from the edge (filmstrip: direction, not position)", () => {
    setMobile(true);
    render(
      <ShellChrome sidebar={<nav>SIDEBAR</nav>}>
        <div>CONTENT</div>
      </ShellChrome>,
    );
    expect(screen.queryByTestId("drawer-scrim")).toBeNull();
    fireDrag([
      [220, 200],
      [340, 202],
      [440, 205],
    ]);
    expect(screen.getByTestId("drawer-scrim")).toBeInTheDocument();
  });

  it("does nothing on a leftward drag when nothing is open and there is no details panel", () => {
    setMobile(true);
    render(
      <ShellChrome sidebar={<nav>SIDEBAR</nav>}>
        <div>CONTENT</div>
      </ShellChrome>,
    );
    // No MobileInspectorProvider here, so the right panel is unavailable — a leftward
    // swipe has nowhere to go and must leave the page alone.
    fireDrag([
      [300, 200],
      [180, 202],
      [60, 205],
    ]);
    expect(screen.queryByTestId("drawer-scrim")).toBeNull();
  });

  it("ignores a vertical drag so the page can still scroll", () => {
    setMobile(true);
    render(
      <ShellChrome sidebar={<nav>SIDEBAR</nav>}>
        <div>CONTENT</div>
      </ShellChrome>,
    );
    fireDrag([
      [12, 100],
      [16, 220],
      [18, 360],
    ]);
    expect(screen.queryByTestId("drawer-scrim")).toBeNull();
  });

  it("closes on a leftward drag when the drawer is open", async () => {
    setMobile(true);
    const user = userEvent.setup();
    render(
      <ShellChrome sidebar={<nav>SIDEBAR</nav>}>
        <DrawerOpener />
      </ShellChrome>,
    );
    await user.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByTestId("drawer-scrim")).toBeInTheDocument();
    fireDrag([
      [280, 200],
      [160, 202],
      [40, 205],
    ]);
    expect(screen.queryByTestId("drawer-scrim")).toBeNull();
  });

  it("is inert on desktop (no swipe handling)", () => {
    setMobile(false);
    render(
      <ShellChrome sidebar={<nav>SIDEBAR</nav>}>
        <div>CONTENT</div>
      </ShellChrome>,
    );
    fireDrag([
      [12, 200],
      [120, 202],
      [240, 205],
    ]);
    expect(screen.queryByTestId("drawer-scrim")).toBeNull();
  });
});
