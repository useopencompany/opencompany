import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({ select: mocks.select }),
}));

import { GOOGLE_CALENDAR_EVENTS_SCOPE, GOOGLE_CALENDAR_READ_SCOPE } from "./google-calendar-scopes";
import { getGoogleIntegrationState } from "./google-data";

const storedCalendarRow: Record<string, unknown> = {
  id: "gint_google_calendar",
  provider: "google_calendar",
  accountEmail: "calendar@example.com",
  accountName: "Calendar User",
  status: "connected",
  scopes: [GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_EVENTS_SCOPE],
  capabilityModes: { read: "ask", write: "ask" },
  updatedAt: new Date("2026-09-03T08:00:00.000Z"),
};

describe("getGoogleIntegrationState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockImplementation((selection: Record<string, unknown>) => {
      const queryShapedRow = Object.fromEntries(
        Object.keys(selection).map((field) => [field, storedCalendarRow[field]]),
      );
      return {
        from: () => ({
          where: () => ({
            orderBy: async () => [queryShapedRow],
          }),
        }),
      };
    });
  });

  it("selects the Calendar OAuth fields needed by the server snapshot", async () => {
    const state = await getGoogleIntegrationState("user_1");

    expect(mocks.select).toHaveBeenCalledTimes(1);
    const selection = mocks.select.mock.calls[0]?.[0];
    expect(selection).toEqual(
      expect.objectContaining({
        scopes: expect.anything(),
        capabilityModes: expect.anything(),
      }),
    );
    expect(state.personalAccounts.google_calendar).toEqual([
      expect.objectContaining({
        connected: true,
        status: "connected",
        scopes: [GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_EVENTS_SCOPE],
        capabilityModes: { read: "ask", write: "ask" },
      }),
    ]);
  });
});
