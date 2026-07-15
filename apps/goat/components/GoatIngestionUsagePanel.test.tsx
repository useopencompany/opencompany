import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GoatIngestionUsagePanel } from "./GoatIngestionUsagePanel";

describe("GoatIngestionUsagePanel", () => {
  it("shows paused usage, seat math, and formats provider names for customers", () => {
    render(
      <GoatIngestionUsagePanel
        data={{
          plan: "pro",
          used: 1_250,
          limit: 1_200,
          seatQuantity: 4,
          perSeatAllowance: 300,
          overageUnits: 50,
          overageUsdMicros: 1_000_000,
          pending: 3,
          resetAt: "2026-08-01T00:00:00.000Z",
          providers: [{ provider: "google_drive", count: 12 }],
          recent: [
            {
              id: "reservation_1",
              provider: "goat-chat",
              rawEventCount: 1,
              status: "pending",
              createdAt: "2026-07-13T08:00:00.000Z",
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByText(/You've used your monthly allowance, so 3 events are paused/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/sooner once the workspace has credits to cover the overage/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/300 items × 4 seats, pooled across the workspace/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Plus 50 overage items \(\$1\.00 from credits\)/i)).toBeInTheDocument();
    expect(screen.getByText("Monthly Pro allowance")).toBeInTheDocument();
    expect(screen.getByText("Google Drive")).toBeInTheDocument();
    expect(screen.getByText("OpenCompany chat")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("offers upgrading as a path to capacity for Free workspaces", () => {
    render(
      <GoatIngestionUsagePanel
        data={{
          plan: "free",
          used: 300,
          limit: 300,
          seatQuantity: 1,
          perSeatAllowance: 300,
          overageUnits: 0,
          overageUsdMicros: 0,
          pending: 1,
          resetAt: "2026-08-01T00:00:00.000Z",
          providers: [],
          recent: [],
        }}
      />,
    );

    expect(screen.getByText(/sooner if the workspace upgrades to Pro/i)).toBeInTheDocument();
    expect(screen.getByText("Monthly Free allowance")).toBeInTheDocument();
  });
});
