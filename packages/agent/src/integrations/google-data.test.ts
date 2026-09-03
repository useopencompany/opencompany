import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: mocks.getDb,
}));

import { GOOGLE_CALENDAR_EVENTS_SCOPE, GOOGLE_CALENDAR_READ_SCOPE } from "./google-calendar-scopes";
import { getGoogleIntegrationState } from "./google-data";
import { GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_READ_SCOPE } from "./google-drive-scopes";

describe("getGoogleIntegrationState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves Drive scopes and capability modes in the query-shaped initial state", async () => {
    const sourceRow = {
      id: "gint_drive",
      provider: "google_drive",
      accountEmail: "ada@example.com",
      accountName: "Ada",
      status: "connected",
      scopes: [GOOGLE_DRIVE_READ_SCOPE, GOOGLE_DRIVE_FILE_SCOPE],
      capabilityModes: { read: "ask", query: "ask", write: "ask" },
      updatedAt: new Date("2026-09-03T08:00:00.000Z"),
    };
    mocks.getDb.mockReturnValue(queryShapedDb(sourceRow));

    const state = await getGoogleIntegrationState("user_1");

    expect(state.personalAccounts.google_drive).toEqual([
      expect.objectContaining({
        integrationId: "gint_drive",
        connected: true,
        status: "connected",
        scopes: [GOOGLE_DRIVE_READ_SCOPE, GOOGLE_DRIVE_FILE_SCOPE],
        capabilityModes: { read: "ask", query: "ask", write: "ask" },
      }),
    ]);
  });

  it("preserves Calendar scopes and capability modes in the query-shaped initial state", async () => {
    const sourceRow = {
      id: "gint_google_calendar",
      provider: "google_calendar",
      accountEmail: "calendar@example.com",
      accountName: "Calendar User",
      status: "connected",
      scopes: [GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_EVENTS_SCOPE],
      capabilityModes: { read: "ask", write: "ask" },
      updatedAt: new Date("2026-09-03T09:00:00.000Z"),
    };
    mocks.getDb.mockReturnValue(queryShapedDb(sourceRow));

    const state = await getGoogleIntegrationState("user_1");

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

function queryShapedDb(sourceRow: Record<string, unknown>) {
  return {
    select: vi.fn((selection: Record<string, unknown>) => {
      const projectedRow = Object.fromEntries(
        Object.keys(selection).map((field) => [field, sourceRow[field]]),
      );
      const builder = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn(async () => [projectedRow]),
      };
      return builder;
    }),
  };
}
