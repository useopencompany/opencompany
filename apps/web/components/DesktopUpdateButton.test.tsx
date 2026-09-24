import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdateButton } from "./DesktopUpdateButton";

type Desktop = NonNullable<Window["opencompanyDesktop"]>;

function installDesktopBridge(overrides: Partial<Desktop> = {}) {
  window.opencompanyDesktop = {
    version: "0.2.0",
    platform: "darwin",
    signInWithGoogle: vi.fn(),
    retryConnection: vi.fn(),
    ...overrides,
  };
}

describe("DesktopUpdateButton", () => {
  afterEach(() => {
    delete window.opencompanyDesktop;
  });

  it("stays hidden until the shell has staged an update, then restarts on click", () => {
    let notifyReady: (version: string) => void = () => {};
    const unsubscribe = vi.fn();
    const restartToUpdate = vi.fn();
    installDesktopBridge({
      onUpdateReady: (listener) => {
        notifyReady = listener;
        return unsubscribe;
      },
      restartToUpdate,
    });

    const { unmount } = render(<DesktopUpdateButton />);
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();

    act(() => notifyReady("0.2.1"));
    const button = screen.getByRole("button", { name: "Update" });
    expect(button).toHaveAttribute("title", "Restart to install opencompany 0.2.1");

    fireEvent.click(button);
    expect(restartToUpdate).toHaveBeenCalledOnce();

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("renders nothing for browsers and shells without the update bridge", () => {
    const { container, rerender } = render(<DesktopUpdateButton />);
    expect(container).toBeEmptyDOMElement();

    installDesktopBridge();
    rerender(<DesktopUpdateButton key="older-shell" />);
    expect(container).toBeEmptyDOMElement();
  });
});
