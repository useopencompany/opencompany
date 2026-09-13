import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCurrentClaudeCodeUsage } from "@/lib/claude-code-auth";
import { loadCurrentCodexUsage } from "@/lib/codex-auth";
import { SubscriptionUsage } from "./SubscriptionUsage";

vi.mock("@/lib/codex-auth", () => ({ loadCurrentCodexUsage: vi.fn() }));
vi.mock("@/lib/claude-code-auth", () => ({ loadCurrentClaudeCodeUsage: vi.fn() }));
const snapshot = () => ({
  updatedAt: new Date().toISOString(),
  windows: [
    {
      id: "weekly",
      label: "Weekly",
      usedPercent: 50,
      resetsAt: new Date(Date.now() + 412_200_000).toISOString(),
    },
    {
      id: "spark",
      label: "Codex Spark 5-hour",
      usedPercent: 0,
      resetsAt: new Date(Date.now() + 18_000_000).toISOString(),
    },
  ],
});

describe("Subscription usage display", () => {
  beforeEach(() => {
    vi.mocked(loadCurrentCodexUsage).mockReset();
    vi.mocked(loadCurrentClaudeCodeUsage).mockReset();
    vi.mocked(loadCurrentCodexUsage).mockResolvedValue({ ok: true, usage: snapshot() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows remaining allowance and reset times in the same direction as the bars", async () => {
    render(<SubscriptionUsage provider="codex" />);
    expect(screen.getByText("Checking usage…")).toBeInTheDocument();
    expect(await screen.findByText("50% left")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Weekly remaining" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(
      screen.getByRole("progressbar", { name: "Codex Spark 5-hour remaining" }),
    ).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("Resets in 4d 18h")).toBeInTheDocument();
    expect(screen.getByText("Your subscription usage across all apps.")).toBeInTheDocument();
  });

  it("retains the previous snapshot and marks refresh failures", async () => {
    render(<SubscriptionUsage provider="codex" />);
    await screen.findByText("50% left");
    vi.mocked(loadCurrentCodexUsage).mockResolvedValueOnce({
      ok: false,
      error: "Temporarily unavailable.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh Codex usage" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Temporarily unavailable. Showing the last update.",
    );
    expect(screen.getByText("50% left")).toBeInTheDocument();
  });

  it("shows an unavailable state instead of a full allowance on initial failure", async () => {
    vi.mocked(loadCurrentCodexUsage).mockResolvedValueOnce({
      ok: false,
      error: "Reconnect Codex to view subscription usage.",
    });
    render(<SubscriptionUsage provider="codex" />);
    expect(await screen.findByText("Usage unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh Codex usage" })).toBeEnabled();
  });

  it("handles accounts without reported windows", async () => {
    vi.mocked(loadCurrentCodexUsage).mockResolvedValueOnce({
      ok: true,
      usage: { ...snapshot(), windows: [] },
    });
    render(<SubscriptionUsage provider="codex" />);
    expect(
      await screen.findByText("Codex hasn’t reported usage limits for this account."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("does not claim a reset has restored the allowance before a new reading", async () => {
    const usage = snapshot();
    usage.windows[0]!.resetsAt = new Date(Date.now() - 60_000).toISOString();
    vi.mocked(loadCurrentCodexUsage).mockResolvedValueOnce({ ok: true, usage });
    render(<SubscriptionUsage provider="codex" />);
    expect(await screen.findByText("Awaiting update")).toBeInTheDocument();
    expect(screen.getByText("Reset time passed")).toBeInTheDocument();
  });

  it("refreshes visible settings once per minute and stops after unmount", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = render(<SubscriptionUsage provider="codex" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(loadCurrentCodexUsage).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(loadCurrentCodexUsage).toHaveBeenCalledTimes(2);
    view.unmount();
    visibility.mockReturnValue("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(loadCurrentCodexUsage).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });

  it("polls Claude slowly because each read costs a real inference request", async () => {
    vi.useFakeTimers();
    vi.mocked(loadCurrentClaudeCodeUsage).mockResolvedValue({
      ok: true,
      usage: { windows: [], updatedAt: new Date().toISOString() },
    });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    render(<SubscriptionUsage provider="claude_code" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240_000);
    });
    expect(loadCurrentClaudeCodeUsage).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(loadCurrentClaudeCodeUsage).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });

  it("ignores a late response after changing connections", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof loadCurrentCodexUsage>>) => void;
    vi.mocked(loadCurrentCodexUsage).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<SubscriptionUsage key="old" provider="codex" />);
    view.rerender(<SubscriptionUsage key="new" provider="codex" />);
    await screen.findByText("50% left");
    await act(async () => {
      resolve({ ok: false, error: "Old account failure" });
    });
    await waitFor(() => expect(screen.queryByText("Old account failure")).not.toBeInTheDocument());
  });

  it("reads Claude windows from the Claude Code connection", async () => {
    vi.mocked(loadCurrentClaudeCodeUsage).mockResolvedValue({
      ok: true,
      usage: {
        updatedAt: new Date().toISOString(),
        windows: [
          {
            id: "claude-code:5h",
            label: "Session",
            usedPercent: 20,
            resetsAt: new Date(Date.now() + 18_000_000).toISOString(),
          },
        ],
      },
    });
    render(<SubscriptionUsage provider="claude_code" />);
    expect(await screen.findByText("80% left")).toBeInTheDocument();
    expect(screen.getByLabelText("Claude subscription usage")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh Claude usage" })).toBeInTheDocument();
    expect(loadCurrentCodexUsage).not.toHaveBeenCalled();
  });
});
