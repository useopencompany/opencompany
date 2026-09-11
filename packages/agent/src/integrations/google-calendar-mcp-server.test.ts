import { createMCPClient } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isActive: vi.fn(async () => true),
  loadIntegration: vi.fn(),
  apiCall: vi.fn(),
}));

vi.mock("@opencompany/db/plugin-gateway-repository", () => ({
  isPluginGatewayRegistrationActive: mocks.isActive,
}));
vi.mock("./google-data", () => ({
  loadGoogleCalendarIntegration: mocks.loadIntegration,
}));

import { GoogleAccessAuthError } from "./google-access-token";
import { createGoogleCalendarMcpService } from "./google-calendar-mcp-server";
import {
  createGoogleCalendarMcpTicket,
  type GoogleCalendarMcpOperation,
} from "./google-calendar-mcp-ticket";
import { GOOGLE_CALENDAR_EVENTS_SCOPE, GOOGLE_CALENDAR_READ_SCOPE } from "./google-calendar-scopes";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

const SECRET = "shared-test-secret";
const connectedRow = {
  id: "integration_1",
  userWorkosId: "user_1",
  status: "connected",
  scopes: [GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_EVENTS_SCOPE],
  capabilityModes: { read: "ask", query: "ask", write: "ask" },
  toolModes: {},
};

function service() {
  return createGoogleCalendarMcpService({
    db: { sentinel: "db" },
    internalSecret: SECRET,
    calendarApiCall: mocks.apiCall,
  });
}

function request(operation: GoogleCalendarMcpOperation, method: string, params: unknown = {}) {
  const { ticket } = createGoogleCalendarMcpTicket({
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    integrationId: "integration_1",
    registrationId: "registration_1",
    operation,
    secret: SECRET,
  });
  return new Request("https://api.opencompany.chat/mcp/plugins/google-calendar", {
    method: "POST",
    headers: {
      authorization: `Bearer ${ticket}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function responseJson(response: Response) {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    return JSON.parse(data ?? "null") as any;
  }
  return JSON.parse(text) as any;
}

describe("opencompany Google Calendar MCP server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isActive.mockResolvedValue(true);
    mocks.loadIntegration.mockResolvedValue(connectedRow);
    mocks.apiCall.mockResolvedValue({ items: [] });
  });

  it("discovers the supported calendar tools, including rescheduling", async () => {
    const response = await service().handle(request({ type: "tools/list" }, "tools/list"));
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "list_calendars",
      "list_events",
      "get_event",
      "create_event",
      "reschedule_event",
    ]);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("completes a real MCP client handshake and discovery request", async () => {
    const calendarMcp = service();
    const { ticket } = createGoogleCalendarMcpTicket({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      integrationId: "integration_1",
      registrationId: "registration_1",
      operation: { type: "tools/list" },
      secret: SECRET,
    });
    const authProvider = createRemoteMcpStaticBearerAuthProvider({
      accessToken: ticket,
      onAuthorizationRequired: () => {
        throw new Error("authorization required");
      },
    });
    const client = await createMCPClient({
      clientName: "calendar-test",
      version: "0.1.0",
      transport: {
        type: "http",
        url: "https://api.opencompany.chat/mcp/plugins/google-calendar",
        authProvider,
        fetch: async (url, init) => calendarMcp.handle(new Request(url, init)),
      },
    });
    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          { name: "list_calendars" },
          { name: "list_events" },
          { name: "get_event" },
          { name: "create_event" },
          { name: "reschedule_event" },
        ],
      });
    } finally {
      await client.close();
    }
  });

  it("binds an execution ticket to one exact tool and maps create_event to Calendar REST", async () => {
    mocks.apiCall.mockResolvedValueOnce({
      id: "event_1",
      summary: "Planning",
      start: { dateTime: "2026-09-04T10:00:00Z" },
      end: { dateTime: "2026-09-04T10:30:00Z" },
    });
    const operation = { type: "tools/call", tool: "create_event", capability: "write" } as const;
    const response = await service().handle(
      request(operation, "tools/call", {
        name: "create_event",
        arguments: {
          summary: "Planning",
          startTime: "2026-09-04T10:00:00Z",
          endTime: "2026-09-04T10:30:00Z",
          attendees: [{ email: "ada@example.com", optionalAttendee: true }],
          notificationLevel: "EXTERNAL_ONLY",
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body.result.isError).not.toBe(true);
    expect(mocks.apiCall).toHaveBeenCalledOnce();
    const [connection, method, url, options] = mocks.apiCall.mock.calls[0]!;
    expect(connection).toEqual({
      userWorkosId: "user_1",
      integrationId: "integration_1",
      provider: "google_calendar",
    });
    expect(method).toBe("POST");
    expect(url.toString()).toContain("/calendars/primary/events?sendUpdates=externalOnly");
    expect(options.body).toMatchObject({
      summary: "Planning",
      attendees: [{ email: "ada@example.com", optional: true }],
    });
  });

  it("reschedules the original event without creating copies or replacing its meeting details", async () => {
    const original = {
      id: "event/1",
      status: "confirmed",
      summary: "Planning",
      start: { dateTime: "2026-09-09T16:30:00+02:00", timeZone: "Europe/Berlin" },
      end: { dateTime: "2026-09-09T17:00:00+02:00", timeZone: "Europe/Berlin" },
      attendees: [{ email: "ada@example.com", responseStatus: "accepted" }],
      hangoutLink: "https://meet.google.com/abc-defg-hij",
    };
    const events = new Map([[original.id, original]]);
    mocks.apiCall.mockImplementation(async (_connection, method, url, options) => {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      if (method === "GET") return events.get(id);
      if (method !== "PATCH") throw new Error("Rescheduling must only patch the existing event");
      expect(url.searchParams.get("sendUpdates")).toBe("all");
      expect(Object.keys(options.body).sort()).toEqual(["end", "start"]);
      const updated = { ...events.get(id)!, ...options.body };
      events.set(id, updated);
      return updated;
    });
    const operation = {
      type: "tools/call",
      tool: "reschedule_event",
      capability: "write",
    } as const;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await service().handle(
        request(operation, "tools/call", {
          name: "reschedule_event",
          arguments: {
            calendarId: "team@example.com",
            eventId: original.id,
            startTime: "2026-09-10T16:00:00+02:00",
            endTime: "2026-09-10T16:30:00+02:00",
          },
        }),
      );
      expect(response.status).toBe(200);
      const body = await responseJson(response);
      expect(body.result.isError).not.toBe(true);
    }
    expect(events.size).toBe(1);
    expect(events.get(original.id)).toMatchObject({
      id: original.id,
      start: { dateTime: "2026-09-10T16:00:00+02:00", timeZone: "Europe/Berlin" },
      attendees: original.attendees,
      hangoutLink: original.hangoutLink,
    });
    expect(mocks.apiCall.mock.calls.filter((call) => call[1] === "PATCH")).toHaveLength(1);
  });

  it("maps all three read tools to the stable Calendar REST API", async () => {
    mocks.apiCall
      .mockResolvedValueOnce({ items: [{ id: "primary", summary: "Main" }] })
      .mockResolvedValueOnce({ items: [{ id: "event_1", start: {}, end: {} }] })
      .mockResolvedValueOnce({ id: "event_1", start: {}, end: {} });
    const calls = [
      {
        tool: "list_calendars",
        capability: "read" as const,
        arguments: { pageSize: 5 },
      },
      {
        tool: "list_events",
        capability: "query" as const,
        arguments: {
          calendarId: "team@example.com",
          startTime: "2026-09-01T00:00:00Z",
          endTime: "2026-10-01T00:00:00Z",
          fullText: "planning",
        },
      },
      {
        tool: "get_event",
        capability: "query" as const,
        arguments: { calendarId: "team@example.com", eventId: "event/1" },
      },
    ];
    for (const call of calls) {
      const response = await service().handle(
        request(
          { type: "tools/call", tool: call.tool, capability: call.capability },
          "tools/call",
          { name: call.tool, arguments: call.arguments },
        ),
      );
      expect(response.status).toBe(200);
    }

    expect(mocks.apiCall.mock.calls[0]?.[2].toString()).toContain("/users/me/calendarList");
    expect(mocks.apiCall.mock.calls[1]?.[2].toString()).toContain(
      "/calendars/team%40example.com/events",
    );
    expect(mocks.apiCall.mock.calls[1]?.[2].searchParams.get("q")).toBe("planning");
    expect(mocks.apiCall.mock.calls[2]?.[2].toString()).toContain(
      "/calendars/team%40example.com/events/event%2F1",
    );
  });

  it.each([
    { original: { recurrence: ["RRULE:FREQ=WEEKLY"] }, expected: "specific recurring occurrence" },
    { original: { status: "cancelled" }, expected: "unavailable or cancelled" },
    { original: { start: { date: "2026-09-09" } }, expected: "timed or all-day" },
  ])("refuses unsafe rescheduling: $expected", async ({ original, expected }) => {
    mocks.apiCall.mockResolvedValueOnce({
      id: "event_1",
      start: { dateTime: "2026-09-09T10:00:00Z" },
      end: { dateTime: "2026-09-09T11:00:00Z" },
      ...original,
    });
    const response = await service().handle(
      request({ type: "tools/call", tool: "reschedule_event", capability: "write" }, "tools/call", {
        name: "reschedule_event",
        arguments: {
          eventId: "event_1",
          startTime: "2026-09-10T10:00:00Z",
          endTime: "2026-09-10T11:00:00Z",
        },
      }),
    );
    const body = await responseJson(response);
    expect(body.result.isError).toBe(true);
    expect(JSON.stringify(body.result.content)).toContain(expected);
    expect(mocks.apiCall).toHaveBeenCalledOnce();
    expect(mocks.apiCall.mock.calls[0]![1]).toBe("GET");
  });

  it("moves one all-day recurring occurrence using exclusive end dates", async () => {
    mocks.apiCall
      .mockResolvedValueOnce({
        id: "series_20260909",
        recurringEventId: "series",
        start: { date: "2026-09-09" },
        end: { date: "2026-09-10" },
      })
      .mockResolvedValueOnce({
        id: "series_20260909",
        start: { date: "2026-09-10" },
        end: { date: "2026-09-11" },
      });
    const response = await service().handle(
      request({ type: "tools/call", tool: "reschedule_event", capability: "write" }, "tools/call", {
        name: "reschedule_event",
        arguments: {
          eventId: "series_20260909",
          startTime: "2026-09-10",
          endTime: "2026-09-10",
          notificationLevel: "EXTERNAL_ONLY",
        },
      }),
    );
    expect((await responseJson(response)).result.isError).not.toBe(true);
    const [, method, url, options] = mocks.apiCall.mock.calls[1]!;
    expect(method).toBe("PATCH");
    expect(url.pathname).toContain("/events/series_20260909");
    expect(url.searchParams.get("sendUpdates")).toBe("externalOnly");
    expect(options.body).toEqual({ start: { date: "2026-09-10" }, end: { date: "2026-09-11" } });
  });

  it("returns provider failures without creating a replacement", async () => {
    mocks.apiCall.mockRejectedValueOnce(new Error("Google API request failed with 403"));
    const response = await service().handle(
      request({ type: "tools/call", tool: "reschedule_event", capability: "write" }, "tools/call", {
        name: "reschedule_event",
        arguments: {
          eventId: "event_1",
          startTime: "2026-09-10T10:00:00Z",
          endTime: "2026-09-10T11:00:00Z",
        },
      }),
    );
    expect((await responseJson(response)).result.isError).toBe(true);
    expect(mocks.apiCall).toHaveBeenCalledOnce();
  });

  it("enforces rescheduling permissions before calling Google", async () => {
    mocks.loadIntegration.mockResolvedValueOnce({
      ...connectedRow,
      toolModes: { reschedule_event: "off" },
    });
    const response = await service().handle(
      request({ type: "tools/call", tool: "reschedule_event", capability: "write" }, "tools/call", {
        name: "reschedule_event",
        arguments: {
          eventId: "event_1",
          startTime: "2026-09-10T10:00:00Z",
          endTime: "2026-09-10T11:00:00Z",
        },
      }),
    );
    expect(response.status).toBe(403);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("returns a trusted reconnect envelope when Google revokes access during a call", async () => {
    mocks.apiCall.mockRejectedValueOnce(new GoogleAccessAuthError("revoked"));
    const response = await service().handle(
      request({ type: "tools/call", tool: "list_events", capability: "query" }, "tools/call", {
        name: "list_events",
        arguments: {},
      }),
    );
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body.result).toMatchObject({ isError: true });
    expect(body.result.content[0].text).toContain('"code":"auth_expired"');
  });

  it("rejects cross-operation and cross-tool reuse before calling Google", async () => {
    const discoveryCall = await service().handle(
      request({ type: "tools/list" }, "tools/call", {
        name: "list_events",
        arguments: {},
      }),
    );
    expect(discoveryCall.status).toBe(403);

    const wrongTool = await service().handle(
      request({ type: "tools/call", tool: "get_event", capability: "query" }, "tools/call", {
        name: "create_event",
        arguments: {},
      }),
    );
    expect(wrongTool.status).toBe(403);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("rejects missing and incorrectly signed bearer tickets", async () => {
    const missing = await service().handle(
      new Request("https://api.opencompany.chat/mcp/plugins/google-calendar", {
        method: "POST",
      }),
    );
    expect(missing.status).toBe(401);

    const invalid = request({ type: "tools/list" }, "tools/list");
    invalid.headers.set("authorization", "Bearer invalid.ticket");
    expect((await service().handle(invalid)).status).toBe(401);
    expect(mocks.apiCall).not.toHaveBeenCalled();
  });

  it("rechecks plugin, account scope, and tool permission on every request", async () => {
    mocks.isActive.mockResolvedValueOnce(false);
    const disabledPlugin = await service().handle(request({ type: "tools/list" }, "tools/list"));
    expect(disabledPlugin.status).toBe(403);

    mocks.loadIntegration.mockResolvedValueOnce({
      ...connectedRow,
      scopes: [GOOGLE_CALENDAR_READ_SCOPE],
    });
    const missingScope = await service().handle(request({ type: "tools/list" }, "tools/list"));
    expect(missingScope.status).toBe(401);

    mocks.loadIntegration.mockResolvedValueOnce({
      ...connectedRow,
      toolModes: { create_event: "off" },
    });
    const disabledTool = await service().handle(
      request({ type: "tools/call", tool: "create_event", capability: "write" }, "initialize"),
    );
    expect(disabledTool.status).toBe(403);
  });
});
