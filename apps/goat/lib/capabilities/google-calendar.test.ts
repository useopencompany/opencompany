import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbRows: [] as unknown[],
  loadCredential: vi.fn(),
  markStatus: vi.fn(),
  refreshCredential: vi.fn(),
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

vi.mock("@opencompany/db/goat-integrations", () => ({
  loadGoatIntegrationCredential: mocks.loadCredential,
  markGoatIntegrationStatus: mocks.markStatus,
  refreshGoatIntegrationCredential: mocks.refreshCredential,
}));

import { googleCalendarCapability } from "@/lib/capabilities/google-calendar";
import type {
  GoatCapabilityOperation,
  GoatCapabilityWorkerContext,
} from "@/lib/capabilities/types";

const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const READ_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const CONTEXT: GoatCapabilityWorkerContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-21T12:00:00.000Z"),
  userContext: {
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    timezone: "Europe/London",
  },
};

beforeEach(() => {
  mocks.dbRows = [connectedRow([WRITE_SCOPE])];
  mocks.loadCredential.mockReset();
  mocks.loadCredential.mockResolvedValue({
    payload: { access_token: "access_secret", refresh_token: "refresh_secret" },
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  mocks.markStatus.mockReset();
  mocks.markStatus.mockResolvedValue(undefined);
  mocks.refreshCredential.mockReset();
  mocks.refreshCredential.mockResolvedValue(undefined);
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client_id");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "client_secret");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Google Calendar capability", () => {
  it("is absent without a connected account and keeps legacy scopes read-only", async () => {
    mocks.dbRows = [];
    await expect(googleCalendarCapability.resolve("user_1")).resolves.toBeNull();

    mocks.dbRows = [connectedRow([READ_SCOPE])];
    const resolved = await googleCalendarCapability.resolve("user_1");
    expect(resolved?.operations).toEqual(["read"]);
    expect(resolved?.indexLine).toContain("reconnected with edit access");
  });

  it("advertises read, create, and write for event-write scopes", async () => {
    const resolved = await googleCalendarCapability.resolve("user_1");
    expect(resolved?.operations).toEqual(["read", "create", "write"]);
    expect(resolved?.indexLine).toContain("CAN create events");
    expect(resolved?.indexLine).toContain("update or delete");
    expect(resolved?.indexLine).toContain("CANNOT add attendees");
  });

  it("separates read, create, and write tool surfaces", async () => {
    const read = await createResolvedTools("read");
    const create = await createResolvedTools("create");
    const write = await createResolvedTools("write");

    expect(Object.keys(read)).toEqual([
      "calendar_list_calendars",
      "calendar_list_events",
      "calendar_get_event",
      "calendar_get_freebusy",
    ]);
    expect(Object.keys(create)).toContain("calendar_create_event");
    expect(Object.keys(create)).not.toContain("calendar_update_event");
    expect(Object.keys(create)).not.toContain("calendar_delete_event");
    expect(Object.keys(write)).toContain("calendar_update_event");
    expect(Object.keys(write)).toContain("calendar_delete_event");
    expect(Object.keys(write)).not.toContain("calendar_create_event");
  });

  it("creates a bounded event without attendees or notifications", async () => {
    const fetchMock = vi.fn(async (...request: [RequestInfo | URL, RequestInit?]) => {
      void request;
      return jsonResponse({
        id: "event_1",
        summary: "Planning",
        htmlLink: "https://calendar.google.com/event?eid=1",
        start: { dateTime: "2026-07-23T09:00:00+01:00" },
        end: { dateTime: "2026-07-23T09:30:00+01:00" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(await createResolvedTools("create"), "calendar_create_event", {
      summary: " Planning ",
      description: " Weekly plan ",
      start: "2026-07-23T09:00:00+01:00",
      end: "2026-07-23T09:30:00+01:00",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      summary: "Planning",
      description: "Weekly plan",
      start: { dateTime: "2026-07-23T09:00:00+01:00" },
      end: { dateTime: "2026-07-23T09:30:00+01:00" },
    });
    expect(JSON.stringify(result)).not.toContain("access_secret");
    expect(mocks.loadCredential).toHaveBeenCalledWith({
      userWorkosId: "user_1",
      integrationId: "gint_calendar_1",
      provider: "google_calendar",
      kind: "oauth_token",
      db: expect.any(Object),
    });
    expect(result).toMatchObject({
      account: "ada@example.com",
      calendarId: "primary",
      event: {
        id: "event_1",
        entity: {
          type: "google_calendar_event",
          id: "gint_calendar_1:primary:event_1",
          url: "https://calendar.google.com/event?eid=1",
        },
      },
    });
  });

  it("patches only requested fields and prevents a second mutation attempt", async () => {
    const fetchMock = vi.fn(async (...request: [RequestInfo | URL, RequestInit?]) => {
      void request;
      return jsonResponse({
        id: "event_1",
        summary: "Moved planning",
        start: { date: "2026-07-24" },
        end: { date: "2026-07-25" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tools = await createResolvedTools("write");

    await executeTool(tools, "calendar_update_event", {
      eventId: "event_1",
      summary: "Moved planning",
      description: null,
      start: "2026-07-24",
      end: "2026-07-25",
      allDay: true,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/event_1?sendUpdates=none",
    );
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      summary: "Moved planning",
      description: null,
      start: { date: "2026-07-24" },
      end: { date: "2026-07-25" },
    });

    await expect(
      executeTool(tools, "calendar_delete_event", { eventId: "event_1" }),
    ).rejects.toThrow("mutation was already attempted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deletes one confirmed event without notification updates", async () => {
    const fetchMock = vi.fn(async (...request: [RequestInfo | URL, RequestInit?]) => {
      void request;
      return jsonResponse({}, 204);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(await createResolvedTools("write"), "calendar_delete_event", {
      eventId: "event_to_delete",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/event_to_delete?sendUpdates=none",
    );
    expect(init?.method).toBe("DELETE");
    expect(result).toMatchObject({
      deleted: true,
      entity: {
        type: "google_calendar_event",
        id: "gint_calendar_1:primary:event_to_delete",
      },
    });
  });

  it("requires an explicit account when multiple calendars are connected", async () => {
    mocks.dbRows = [
      connectedRow([WRITE_SCOPE]),
      connectedRow([WRITE_SCOPE], {
        integrationId: "gint_calendar_2",
        accountEmail: "grace@example.com",
      }),
    ];
    const tools = await createResolvedTools("read");

    await expect(executeTool(tools, "calendar_list_calendars", {})).rejects.toThrow(
      "Multiple Google Calendar accounts",
    );
    expect(mocks.loadCredential).not.toHaveBeenCalled();
  });

  it("refreshes expired credentials and persists the rotated access token", async () => {
    mocks.loadCredential.mockResolvedValue({
      payload: { access_token: "expired", refresh_token: "refresh_secret" },
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    let requestCount = 0;
    const fetchMock = vi.fn(async (...request: [RequestInfo | URL, RequestInit?]) => {
      void request;
      requestCount += 1;
      return requestCount === 1
        ? jsonResponse({ access_token: "fresh_secret", expires_in: 3600, token_type: "Bearer" })
        : jsonResponse({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await executeTool(await createResolvedTools("read"), "calendar_list_calendars", {});

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://oauth2.googleapis.com/token");
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer fresh_secret",
    });
    expect(mocks.refreshCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        integrationId: "gint_calendar_1",
        provider: "google_calendar",
        kind: "oauth_token",
        payload: expect.objectContaining({ access_token: "fresh_secret" }),
      }),
    );
  });

  it("rejects partial event moves before calling Google", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeTool(await createResolvedTools("write"), "calendar_update_event", {
        eventId: "event_1",
        start: "2026-07-23T09:00:00+01:00",
      }),
    ).rejects.toThrow("requires both start and end");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the connection for reauthorization when Google reports insufficient scope", async () => {
    const fetchMock = vi.fn(async (...request: [RequestInfo | URL, RequestInit?]) => {
      void request;
      return jsonResponse({ error: { errors: [{ reason: "insufficientPermissions" }] } }, 403);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeTool(await createResolvedTools("create"), "calendar_create_event", {
        summary: "Planning",
        start: "2026-07-23T09:00:00+01:00",
        end: "2026-07-23T09:30:00+01:00",
      }),
    ).rejects.toThrow("Reconnect Google Calendar");
    expect(mocks.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        integrationId: "gint_calendar_1",
        provider: "google_calendar",
        status: "needs_reauth",
      }),
    );
  });
});

async function createResolvedTools(operation: GoatCapabilityOperation): Promise<ToolSet> {
  const resolved = await googleCalendarCapability.resolve("user_1");
  if (!resolved) throw new Error("Expected Google Calendar capability to resolve.");
  return (await resolved.createTools(CONTEXT, operation)).tools;
}

async function executeTool(tools: ToolSet, name: string, input: unknown) {
  const selected = tools[name];
  if (!selected?.execute) throw new Error(`Tool ${name} is not executable.`);
  return selected.execute(input, { toolCallId: "tool_call_1", messages: [] });
}

function connectedRow(
  scopes: string[],
  overrides: Partial<{
    integrationId: string;
    accountEmail: string | null;
    accountName: string | null;
    status: string;
  }> = {},
) {
  return {
    integrationId: "gint_calendar_1",
    accountEmail: "ada@example.com",
    accountName: "Ada",
    scopes,
    status: "connected",
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    ...(status === 204 ? {} : { headers: { "Content-Type": "application/json" } }),
  });
}
