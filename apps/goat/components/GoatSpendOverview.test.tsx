import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoatSpendOverview } from "./GoatSpendOverview";

const fetchMock = vi.fn();

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    prefetch?: boolean;
    className?: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("GoatSpendOverview", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders daily spend and selected-day itemized usage", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        timezone: "UTC",
        start: "2026-06-26",
        end: "2026-07-09",
        days: [dailyRow("2026-07-08", 500_000, 1), dailyRow("2026-07-09", 1_250_000, 3)],
        drilldown: {
          day: "2026-07-09",
          items: [
            {
              tag: "chat:session_1",
              kind: "chat",
              id: "session_1",
              label: "Planning chat",
              href: "/chat/session_1",
              totalCostUsdMicros: 750_000,
              requestCount: 2,
            },
            {
              tag: "task:task_1",
              kind: "task",
              id: "task_1",
              label: "GOAT-1 Research",
              href: "/tasks/task_1",
              totalCostUsdMicros: 500_000,
              requestCount: 1,
            },
          ],
        },
      }),
    );

    render(<GoatSpendOverview />);

    expect(await screen.findByText("$1.7500")).toBeInTheDocument();
    expect(screen.getByText("Planning chat")).toBeInTheDocument();
    expect(screen.getByText("GOAT-1 Research")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Planning chat/ })).toHaveAttribute(
      "href",
      "/chat/session_1",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/usage/daily?start=2026-06-26&end=2026-07-09&day=2026-07-09",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("loads drilldown for a clicked day", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          timezone: "UTC",
          start: "2026-06-26",
          end: "2026-07-09",
          days: [dailyRow("2026-07-08", 500_000, 1), dailyRow("2026-07-09", 0, 0)],
          drilldown: { day: "2026-07-09", items: [] },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          timezone: "UTC",
          start: "2026-06-26",
          end: "2026-07-09",
          days: [dailyRow("2026-07-08", 500_000, 1), dailyRow("2026-07-09", 0, 0)],
          drilldown: {
            day: "2026-07-08",
            items: [
              {
                tag: "ingest:ingest_1",
                kind: "ingest",
                id: "ingest_1",
                label: "gmail ingest (completed)",
                href: null,
                totalCostUsdMicros: 500_000,
                requestCount: 1,
              },
            ],
          },
        }),
      );

    const user = userEvent.setup();
    render(<GoatSpendOverview />);

    await user.click(await screen.findByRole("button", { name: /Jul 8 spend/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/usage/daily?start=2026-06-26&end=2026-07-09&day=2026-07-08",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(await screen.findByText("gmail ingest (completed)")).toBeInTheDocument();
  });
});

function dailyRow(day: string, totalCostUsdMicros: number, requestCount: number) {
  return {
    day,
    totalCostUsdMicros,
    marketCostUsdMicros: totalCostUsdMicros,
    surchargeCostUsdMicros: 0,
    gatewayCostUsdMicros: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    requestCount,
  };
}
