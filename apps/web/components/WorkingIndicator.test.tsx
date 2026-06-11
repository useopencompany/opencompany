import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatElapsed, useElapsedSeconds, WorkingIndicator } from "./WorkingIndicator";

// Minimal wrapper that renders the hook's value as text so tests can assert on it.
function ElapsedDisplay({ startedAt }: { startedAt?: string }) {
  const elapsed = useElapsedSeconds(startedAt);
  return <span data-testid="elapsed">{elapsed}</span>;
}

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

  it("shows 'Thinking' label with a spinner", () => {
    render(<WorkingIndicator />);
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(document.querySelector("svg")).toBeInTheDocument();
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

  it("does not reset elapsed time when startedAt changes to a later timestamp", () => {
    const start = new Date("2026-05-28T10:00:00.000Z");
    vi.setSystemTime(start);
    const { rerender } = render(<WorkingIndicator startedAt={start.toISOString()} />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("5s")).toBeInTheDocument();

    rerender(<WorkingIndicator startedAt={new Date(start.getTime() + 4000).toISOString()} />);

    expect(screen.getByText("5s")).toBeInTheDocument();
  });

  it("corrects elapsed time earlier when a server timestamp is older than the local start", () => {
    const mountedAt = new Date("2026-05-28T10:00:10.000Z");
    vi.setSystemTime(mountedAt);
    const { rerender } = render(<WorkingIndicator />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("5s")).toBeInTheDocument();

    rerender(<WorkingIndicator startedAt={new Date(mountedAt.getTime() - 5000).toISOString()} />);

    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByText("10s")).toBeInTheDocument();
  });

  it("keeps the earlier server timestamp when startedAt becomes unavailable", () => {
    const serverStartedAt = new Date("2026-05-28T10:00:00.000Z");
    const mountedAt = new Date("2026-05-28T10:00:10.000Z");
    vi.setSystemTime(mountedAt);
    const { rerender } = render(<WorkingIndicator startedAt={serverStartedAt.toISOString()} />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("15s")).toBeInTheDocument();

    rerender(<WorkingIndicator />);

    expect(screen.getByText("15s")).toBeInTheDocument();
  });
});

describe("useElapsedSeconds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at 0 with no startedAt", () => {
    render(<ElapsedDisplay />);
    expect(screen.getByTestId("elapsed")).toHaveTextContent("0");
  });

  it("increments every second", () => {
    render(<ElapsedDisplay />);
    expect(screen.getByTestId("elapsed")).toHaveTextContent("0");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("elapsed")).toHaveTextContent("1");

    act(() => {
      vi.advanceTimersByTime(19000);
    });
    expect(screen.getByTestId("elapsed")).toHaveTextContent("20");
  });

  it("uses a provided ISO timestamp as the start anchor", () => {
    const start = new Date("2026-05-28T10:00:00.000Z");
    vi.setSystemTime(new Date(start.getTime() + 25000));
    render(<ElapsedDisplay startedAt={start.toISOString()} />);
    expect(screen.getByTestId("elapsed")).toHaveTextContent("25");
  });

  it("corrects upward when a server timestamp is earlier than mount time", () => {
    const mountedAt = new Date("2026-05-28T10:00:10.000Z");
    vi.setSystemTime(mountedAt);
    const { rerender } = render(<ElapsedDisplay />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // 5s since mount
    expect(screen.getByTestId("elapsed")).toHaveTextContent("5");

    // Server says tool started 5s before mount — elapsed should jump to 10s
    rerender(<ElapsedDisplay startedAt={new Date(mountedAt.getTime() - 5000).toISOString()} />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByTestId("elapsed")).toHaveTextContent("10");
  });
});
