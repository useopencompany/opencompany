import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatElapsed, WorkingIndicator } from "./WorkingIndicator";

describe("formatElapsed", () => {
  it("formats 0 seconds as '0s'", () => {
    expect(formatElapsed(0)).toBe("0s");
  });

  it("formats 59 seconds as '59s'", () => {
    expect(formatElapsed(59)).toBe("59s");
  });

  it("formats 60 seconds as '1m 0s'", () => {
    expect(formatElapsed(60)).toBe("1m 0s");
  });

  it("formats 125 seconds as '2m 5s'", () => {
    expect(formatElapsed(125)).toBe("2m 5s");
  });

  it("formats 3661 seconds correctly", () => {
    expect(formatElapsed(3661)).toBe("61m 1s");
  });
});

describe("WorkingIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("has role='status' and aria-live='polite'", () => {
    render(<WorkingIndicator />);
    const el = screen.getByRole("status");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("aria-live", "polite");
  });

  it("shows 'Thinking' label and a pulsing dot", () => {
    render(<WorkingIndicator />);
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    const svg = document.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("shows elapsed time starting at 0s", () => {
    render(<WorkingIndicator />);
    expect(screen.getByText("0s")).toBeInTheDocument();
  });

  it("increments elapsed time every second", () => {
    render(<WorkingIndicator />);
    expect(screen.getByText("0s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("1s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText("5s")).toBeInTheDocument();
  });

  it("resets elapsed counter to 0 when remounted", () => {
    const { unmount } = render(<WorkingIndicator />);

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("10s")).toBeInTheDocument();

    unmount();
    render(<WorkingIndicator />);
    expect(screen.getByText("0s")).toBeInTheDocument();
  });
});
