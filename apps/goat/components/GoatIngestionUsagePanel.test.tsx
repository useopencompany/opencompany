import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GoatIngestionUsagePanel } from "./GoatIngestionUsagePanel";

describe("GoatIngestionUsagePanel", () => {
  it("shows paused usage and formats provider names for customers", () => {
    render(
      <GoatIngestionUsagePanel
        data={{
          plan: "pro",
          used: 1_550,
          limit: 1_550,
          baseLimit: 1_500,
          sourceBonus: 50,
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
    expect(screen.getByText(/sooner if the workspace connects more sources/i)).toBeInTheDocument();
    expect(
      screen.getByText(/1,500 plan allowance \+ 50 connected source bonus/i),
    ).toBeInTheDocument();
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
          used: 150,
          limit: 150,
          baseLimit: 150,
          sourceBonus: 0,
          pending: 1,
          resetAt: "2026-08-01T00:00:00.000Z",
          providers: [],
          recent: [],
        }}
      />,
    );

    expect(screen.getByText(/upgrades to Pro or connects more sources/i)).toBeInTheDocument();
    expect(screen.getByText("Monthly Free allowance")).toBeInTheDocument();
  });
});
