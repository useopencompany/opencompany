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
          used: 200,
          limit: 200,
          pending: 3,
          resetAt: "2026-07-14T00:00:00.000Z",
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

    expect(screen.getByText(/3 events are paused by the plan limit/i)).toBeInTheDocument();
    expect(screen.getByText("Google Drive")).toBeInTheDocument();
    expect(screen.getByText("OpenCompany chat")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });
});
