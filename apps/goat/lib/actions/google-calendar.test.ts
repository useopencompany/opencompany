import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbRows: [] as unknown[],
  googleApiCall: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => mocks.dbRows,
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/integrations/google-access-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/google-access-token")>();
  return { ...actual, googleApiCall: mocks.googleApiCall };
});

import { resolveGoogleCalendarActions } from "@/lib/actions/google-calendar";
import {
  GoatActionAuthError,
  type GoatActionExecuteContext,
  GoatActionInvalidParamsError,
} from "@/lib/actions/types";
import { GoogleAccessAuthError } from "@/lib/integrations/google-access-token";

const CONTEXT: GoatActionExecuteContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-22T12:00:00.000Z"),
  userTimezone: "UTC",
};
const WINDOW = {
  time_min: "2026-07-22T00:00:00Z",
  time_max: "2026-07-23T00:00:00Z",
};

function connectedRow(email = "louis@example.com", integrationId = "gint_calendar_1") {
  return {
    integrationId,
    accountEmail: email,
    accountName: "Louis",
    status: "connected",
  };
}

function findListEvents(catalog: Awaited<ReturnType<typeof resolveGoogleCalendarActions>>) {
  const action = catalog?.actions.find((entry) => entry.id === "google_calendar.list_events");
  if (!action) throw new Error("missing google_calendar.list_events");
  return action;
}

beforeEach(() => {
  mocks.dbRows = [];
  mocks.googleApiCall.mockReset();
});

describe("resolveGoogleCalendarActions", () => {
  it("is absent unless a Google Calendar account is currently connected", async () => {
    expect(await resolveGoogleCalendarActions("user_1")).toBeNull();

    mocks.dbRows = [{ ...connectedRow(), status: "needs_reauth" }];
    expect(await resolveGoogleCalendarActions("user_1")).toBeNull();

    mocks.dbRows = [{ ...connectedRow(), status: "disconnected" }];
    expect(await resolveGoogleCalendarActions("user_1")).toBeNull();
  });

  it("exposes one read-only action with a strict bounded-window schema", async () => {
    mocks.dbRows = [connectedRow()];
    const catalog = await resolveGoogleCalendarActions("user_1");
    const action = findListEvents(catalog);

    expect(catalog).toMatchObject({
      id: "google_calendar",
      label: "Google Calendar (louis@example.com)",
      description: "List calendar events in a bounded time window.",
    });
    expect(catalog?.actions).toHaveLength(1);
    expect(action).toMatchObject({
      id: "google_calendar.list_events",
      provider: "google_calendar",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["time_min", "time_max"],
        properties: {
          time_min: { type: "string", description: expect.stringContaining("plain date") },
          time_max: { type: "string", description: expect.stringContaining("full local day") },
          limit: { type: "integer", minimum: 1, maximum: 25 },
        },
      },
    });
    expect(action.description).toContain("bounded time window");
    expect(action.id).not.toMatch(/create|update|delete|write/);
  });
});

describe("google_calendar.list_events", () => {
  it("calls the Calendar API and returns a compact, truncated event result", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({
      timeZone: "Europe/Paris",
      nextPageToken: "next-secret-page-token",
      items: [
        {
          id: "evt_1",
          status: "confirmed",
          summary: "s".repeat(400),
          description: "d".repeat(1_200),
          location: "l".repeat(700),
          htmlLink: "https://calendar.google.com/event?eid=evt_1",
          hangoutLink: "https://evil.example/meeting",
          start: { dateTime: "2026-07-22T14:00:00+02:00", timeZone: "Europe/Paris" },
          end: { dateTime: "2026-07-22T14:30:00+02:00", timeZone: "Europe/Paris" },
          organizer: {
            email: "louis@example.com",
            displayName: "Louis",
            self: true,
            ignored: "provider-only field",
          },
          attendees: Array.from({ length: 24 }, (_, index) => ({
            email: `person-${index}@example.com`,
            displayName: `Person ${index}`,
            responseStatus: "accepted",
            comment: "not exposed",
          })),
          attachments: [{ fileUrl: "not exposed" }],
        },
        { id: "invalid_without_times", summary: "Ignored" },
        "not-an-event",
      ],
    });

    const action = findListEvents(await resolveGoogleCalendarActions("user_1"));
    const result = (await action.execute(
      { ...WINDOW, calendar_id: "team@example.com", query: "planning", limit: 7 },
      CONTEXT,
    )) as {
      account: string;
      calendarId: string;
      timeZone?: string;
      hasMore: boolean;
      events: Array<Record<string, unknown>>;
    };

    expect(mocks.googleApiCall).toHaveBeenCalledWith(
      {
        userWorkosId: "user_1",
        integrationId: "gint_calendar_1",
        provider: "google_calendar",
      },
      "GET",
      expect.any(URL),
      { signal: CONTEXT.signal },
    );
    const url = mocks.googleApiCall.mock.calls[0]?.[2] as URL;
    expect(url.pathname).toBe("/calendar/v3/calendars/team%40example.com/events");
    expect(url.searchParams.get("timeMin")).toBe(WINDOW.time_min);
    expect(url.searchParams.get("timeMax")).toBe(WINDOW.time_max);
    expect(url.searchParams.get("q")).toBe("planning");
    expect(url.searchParams.get("maxResults")).toBe("7");
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");

    expect(result).toMatchObject({
      account: "louis@example.com",
      calendarId: "team@example.com",
      timeZone: "Europe/Paris",
      hasMore: true,
    });
    expect(result).not.toHaveProperty("nextPageToken");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.summary).toHaveLength(301);
    expect(result.events[0]?.description).toHaveLength(1_001);
    expect(result.events[0]?.location).toHaveLength(501);
    expect(result.events[0]?.attendees).toHaveLength(20);
    expect(result.events[0]?.htmlLink).toBe("https://calendar.google.com/event?eid=evt_1");
    expect(result.events[0]).not.toHaveProperty("hangoutLink");
    expect(result.events[0]).not.toHaveProperty("attachments");
    expect((result.events[0]?.organizer as Record<string, unknown>).ignored).toBeUndefined();
    expect(
      ((result.events[0]?.attendees as Array<Record<string, unknown>>)[0] ?? {}).comment,
    ).toBeUndefined();
  });

  it("validates required, bounded, and unknown parameters before calling Google", async () => {
    mocks.dbRows = [connectedRow()];
    const action = findListEvents(await resolveGoogleCalendarActions("user_1"));

    await expect(action.execute({ time_min: WINDOW.time_min }, CONTEXT)).rejects.toThrow(
      '"time_max" is required',
    );
    await expect(
      action.execute({ ...WINDOW, time_min: "2026-02-30T00:00:00Z" }, CONTEXT),
    ).rejects.toThrow("RFC 3339");
    await expect(
      action.execute(
        { time_min: "2026-07-23T00:00:00Z", time_max: "2026-07-22T00:00:00Z" },
        CONTEXT,
      ),
    ).rejects.toThrow('"time_max" must be after "time_min"');
    await expect(action.execute({ ...WINDOW, limit: 1.5 }, CONTEXT)).rejects.toThrow(
      '"limit" must be an integer',
    );
    await expect(action.execute({ ...WINDOW, limit: null }, CONTEXT)).rejects.toThrow(
      '"limit" must be an integer',
    );
    await expect(action.execute({ ...WINDOW, query: " " }, CONTEXT)).rejects.toThrow(
      '"query" must be a non-empty string',
    );
    await expect(action.execute({ ...WINDOW, unexpected: true }, CONTEXT)).rejects.toThrow(
      "Unknown parameter",
    );
    expect(mocks.googleApiCall).not.toHaveBeenCalled();
  });

  it("coerces matching plain dates to a full day in the user's timezone", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({ items: [] });
    const action = findListEvents(await resolveGoogleCalendarActions("user_1"));

    await action.execute(
      { time_min: "2026-07-22", time_max: "2026-07-22" },
      { ...CONTEXT, userTimezone: "America/New_York" },
    );

    const url = mocks.googleApiCall.mock.calls[0]?.[2] as URL;
    expect(url.searchParams.get("timeMin")).toBe("2026-07-22T00:00:00-04:00");
    expect(url.searchParams.get("timeMax")).toBe("2026-07-23T00:00:00-04:00");
  });

  it("uses the offset on each local midnight across a DST boundary", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({ items: [] });
    const action = findListEvents(await resolveGoogleCalendarActions("user_1"));

    await action.execute(
      { time_min: "2026-03-08", time_max: "2026-03-08" },
      { ...CONTEXT, userTimezone: "America/New_York" },
    );

    const url = mocks.googleApiCall.mock.calls[0]?.[2] as URL;
    expect(url.searchParams.get("timeMin")).toBe("2026-03-08T00:00:00-05:00");
    expect(url.searchParams.get("timeMax")).toBe("2026-03-09T00:00:00-04:00");
  });

  it("keeps full timestamps unchanged when mixed with a plain date", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({ items: [] });
    const action = findListEvents(await resolveGoogleCalendarActions("user_1"));

    await action.execute(
      { time_min: "2026-07-22", time_max: "2026-07-23T12:00:00Z" },
      { ...CONTEXT, userTimezone: "America/New_York" },
    );

    const url = mocks.googleApiCall.mock.calls[0]?.[2] as URL;
    expect(url.searchParams.get("timeMin")).toBe("2026-07-22T00:00:00-04:00");
    expect(url.searchParams.get("timeMax")).toBe("2026-07-23T12:00:00Z");
  });

  it("falls back to UTC for an invalid user timezone", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({ items: [] });
    const action = findListEvents(await resolveGoogleCalendarActions("user_1"));

    await action.execute(
      { time_min: "2026-07-22", time_max: "2026-07-22" },
      { ...CONTEXT, userTimezone: "Not/A_Timezone" },
    );

    const url = mocks.googleApiCall.mock.calls[0]?.[2] as URL;
    expect(url.searchParams.get("timeMin")).toBe("2026-07-22T00:00:00Z");
    expect(url.searchParams.get("timeMax")).toBe("2026-07-23T00:00:00Z");
  });

  it("never returns more events than the requested limit", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockResolvedValue({
      items: Array.from({ length: 30 }, (_, index) => ({
        id: `evt_${index}`,
        summary: `Event ${index}`,
        start: { dateTime: "2026-07-22T10:00:00Z" },
        end: { dateTime: "2026-07-22T10:30:00Z" },
      })),
    });
    const action = findListEvents(await resolveGoogleCalendarActions("user_1"));

    const result = (await action.execute({ ...WINDOW, limit: 5 }, CONTEXT)) as {
      events: unknown[];
    };
    expect(result.events).toHaveLength(5);
  });

  it("requires an explicit, unambiguous account when multiple accounts are connected", async () => {
    mocks.dbRows = [
      connectedRow("a@example.com", "gint_calendar_a"),
      connectedRow("b@example.com", "gint_calendar_b"),
    ];
    mocks.googleApiCall.mockResolvedValue({ items: [] });
    const action = findListEvents(await resolveGoogleCalendarActions("user_1"));

    expect(action.params.required).toEqual(["time_min", "time_max", "account"]);
    await expect(action.execute(WINDOW, CONTEXT)).rejects.toThrow(
      "Multiple Google Calendar accounts",
    );
    await expect(
      action.execute({ ...WINDOW, account: "missing@example.com" }, CONTEXT),
    ).rejects.toThrow("No connected Google Calendar account");

    await action.execute({ ...WINDOW, account: "b@example.com" }, CONTEXT);
    expect(mocks.googleApiCall).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gint_calendar_b" }),
      "GET",
      expect.any(URL),
      expect.anything(),
    );
  });

  it("uses unique selectors when connected accounts have the same label", async () => {
    mocks.dbRows = [
      {
        ...connectedRow("first@example.com", "gint_calendar_first"),
        accountEmail: null,
        accountName: "Shared account",
      },
      {
        ...connectedRow("second@example.com", "gint_calendar_second"),
        accountEmail: null,
        accountName: "Shared account",
      },
    ];
    mocks.googleApiCall.mockResolvedValue({ items: [] });
    const action = findListEvents(await resolveGoogleCalendarActions("user_1"));

    expect(action.params.properties?.account).toMatchObject({
      description: expect.stringContaining("Shared account (gint_calendar_second)"),
    });
    await expect(action.execute({ ...WINDOW, account: "Shared account" }, CONTEXT)).rejects.toThrow(
      "No connected Google Calendar account",
    );
    await action.execute({ ...WINDOW, account: "Shared account (gint_calendar_second)" }, CONTEXT);

    expect(mocks.googleApiCall).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "gint_calendar_second" }),
      "GET",
      expect.any(URL),
      expect.anything(),
    );
  });

  it.each([
    "No stored Google credentials for this account.",
    "Google refused the refresh token.",
  ])("maps missing or expired authentication to a reconnect error: %s", async (detail) => {
    mocks.dbRows = [connectedRow()];
    mocks.googleApiCall.mockRejectedValue(new GoogleAccessAuthError(detail));
    const action = findListEvents(await resolveGoogleCalendarActions("user_1"));

    const execution = action.execute(WINDOW, CONTEXT);
    await expect(execution).rejects.toBeInstanceOf(GoatActionAuthError);
    await expect(execution).rejects.toMatchObject({
      code: "auth_expired",
      provider: "google_calendar",
      message: expect.stringContaining("Settings → Integrations"),
    });
  });

  it("surfaces Calendar API failures as provider errors", async () => {
    mocks.dbRows = [connectedRow()];
    const providerError = new Error(
      "Google API request failed with 503: Calendar backend unavailable (backendError).",
    );
    mocks.googleApiCall.mockRejectedValue(providerError);
    const action = findListEvents(await resolveGoogleCalendarActions("user_1"));

    await expect(action.execute(WINDOW, CONTEXT)).rejects.toBe(providerError);
  });

  it("throws typed validation errors for invalid model arguments", async () => {
    mocks.dbRows = [connectedRow()];
    const action = findListEvents(await resolveGoogleCalendarActions("user_1"));

    await expect(action.execute({ ...WINDOW, limit: 0 }, CONTEXT)).rejects.toBeInstanceOf(
      GoatActionInvalidParamsError,
    );
  });
});
