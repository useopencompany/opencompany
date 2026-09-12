import { createMCPClient } from "@ai-sdk/mcp";
import { resolvePlugin } from "@opencompany/agent-runtime";
import { createOfficialPluginFetcher } from "@opencompany/agent-runtime/official-plugin-artifacts";
import { OFFICIAL_PLUGIN_SOURCES } from "@opencompany/agent-runtime/official-plugin-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicrosoftAccessAuthError } from "./microsoft-access-token";

const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  row: vi.fn(),
  api: vi.fn(),
  token: vi.fn(),
  download: vi.fn(),
}));
vi.mock("@opencompany/db/plugin-gateway-repository", () => ({
  isPluginGatewayRegistrationActive: mocks.active,
}));
vi.mock("./microsoft-data", () => ({ loadMicrosoftIntegration: mocks.row }));
vi.mock("./microsoft-access-token", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getMicrosoftAccessToken: mocks.token,
}));

import type { RemoteMcpOperation } from "../actions/remote-mcp";
import { integrationStateFromRows } from "../integration-state";
import {
  createMicrosoftMcpTicket,
  getMicrosoftMcpIntegrationState,
  loadMicrosoftMcpWorkerConnection,
  verifyMicrosoftMcpTicket,
} from "./microsoft-mcp";
import type { MicrosoftIntegrationProvider } from "./microsoft-scopes";
import {
  createOutlookCalendarMcpService,
  OUTLOOK_CALENDAR_TOOL_CAPABILITIES,
} from "./outlook-calendar-mcp-server";
import { createOutlookMcpService, OUTLOOK_TOOL_CAPABILITIES } from "./outlook-mcp-server";
import { createRemoteMcpStaticBearerAuthProvider } from "./remote-mcp-static-bearer";

const secret = "test-ticket-secret";
const identity = {
  userWorkosId: "user_1",
  workspaceId: "workspace_1",
  integrationId: "integration_1",
  registrationId: "registration_1",
};
const row = {
  id: identity.integrationId,
  userWorkosId: identity.userWorkosId,
  status: "connected",
  scopes: ["User.Read", "Mail.ReadWrite", "Calendars.ReadWrite"],
  capabilityModes: {},
  toolModes: {},
};
const definitions = {
  outlook: OUTLOOK_TOOL_CAPABILITIES,
  "outlook-calendar": OUTLOOK_CALENDAR_TOOL_CAPABILITIES,
};
function service(provider: MicrosoftIntegrationProvider) {
  const input = { db: {}, internalSecret: secret, apiCall: mocks.api };
  return provider === "outlook"
    ? createOutlookMcpService({ ...input, apiDownload: mocks.download })
    : createOutlookCalendarMcpService(input);
}
function request(
  provider: MicrosoftIntegrationProvider,
  operation: RemoteMcpOperation,
  method: string,
  params: unknown = {},
) {
  const { ticket } = createMicrosoftMcpTicket({ ...identity, provider, operation, secret });
  return new Request(`https://api.opencompany.chat/mcp/plugins/${provider}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ticket}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
async function rpcResult(response: Response) {
  const text = await response.text();
  return JSON.parse(
    response.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6)
      : text,
  );
}
async function call(
  provider: MicrosoftIntegrationProvider,
  tool: string,
  args: Record<string, unknown>,
) {
  const capability = (definitions[provider] as Record<string, "query" | "draft" | "write">)[tool]!;
  const response = await service(provider).handle(
    request(provider, { type: "tools/call", tool, capability }, "tools/call", {
      name: tool,
      arguments: args,
    }),
  );
  return (await rpcResult(response)).result;
}
const decode = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockReset();
  mocks.row.mockResolvedValue(row);
  mocks.active.mockResolvedValue(true);
  mocks.token.mockResolvedValue("graph-token-never-use-for-mcp");
  vi.stubEnv("API_INTERNAL_TOKEN", secret);
});
afterEach(() => vi.unstubAllEnvs());

describe.each(["outlook", "outlook-calendar"] as const)("%s MCP boundary", (provider) => {
  it("matches the pinned package's tool groups and ask defaults through the product importer", async () => {
    const url = OFFICIAL_PLUGIN_SOURCES[provider];
    const plugin = await resolvePlugin({
      url,
      fetcher: (await createOfficialPluginFetcher({ url }))!,
      trustedCapabilitySources: ["useopencompany/plugins"],
    });
    expect(
      Object.fromEntries(
        plugin.capabilities.flatMap((group) => group.tools.map((tool) => [tool, group.id])),
      ),
    ).toEqual(definitions[provider]);
    expect(plugin.capabilities.every((group) => group.defaultMode === "ask")).toBe(true);
    const response = await service(provider).handle(
      request(provider, { type: "tools/list" }, "tools/list"),
    );
    expect(
      (await rpcResult(response)).result.tools.map((tool: { name: string }) => tool.name).sort(),
    ).toEqual(Object.keys(definitions[provider]).sort());
  });
  it("completes a real MCP client handshake using a ticket, without a Graph token", async () => {
    const { ticket } = createMicrosoftMcpTicket({
      ...identity,
      provider,
      operation: { type: "tools/list" },
      secret,
    });
    const mcp = service(provider);
    const client = await createMCPClient({
      transport: {
        type: "http",
        url: `https://api.opencompany.chat/mcp/plugins/${provider}`,
        authProvider: createRemoteMcpStaticBearerAuthProvider({
          accessToken: ticket,
          onAuthorizationRequired: () => {
            throw new Error("auth required");
          },
        }),
        fetch: (url, init) => mcp.handle(new Request(url, init)),
      },
    });
    try {
      expect((await client.listTools()).tools.length).toBe(
        Object.keys(definitions[provider]).length,
      );
    } finally {
      await client.close();
    }
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("rejects discovery tickets used for writes and mismatched capabilities", async () => {
    const tool = provider === "outlook" ? "create_draft" : "create_event";
    expect(
      (
        await service(provider).handle(
          request(provider, { type: "tools/list" }, "tools/call", { name: tool, arguments: {} }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await service(provider).handle(
          request(provider, { type: "tools/call", tool, capability: "query" }, "tools/call", {
            name: tool,
            arguments: {},
          }),
        )
      ).status,
    ).toBe(403);
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("rejects cross-provider, expired, and tampered tickets", () => {
    const { ticket } = createMicrosoftMcpTicket({
      ...identity,
      provider,
      operation: { type: "tools/list" },
      secret,
      now: 1000,
    });
    expect(verifyMicrosoftMcpTicket({ provider, ticket, secret, now: 1001 })).not.toBeNull();
    expect(
      verifyMicrosoftMcpTicket({
        provider: provider === "outlook" ? "outlook-calendar" : "outlook",
        ticket,
        secret,
        now: 1001,
      }),
    ).toBeNull();
    expect(verifyMicrosoftMcpTicket({ provider, ticket, secret, now: 61000 })).toBeNull();
    expect(
      verifyMicrosoftMcpTicket({ provider, ticket: `${ticket}x`, secret, now: 1001 }),
    ).toBeNull();
  });
  it("rechecks installation, connection, account id, scopes, and disabled permissions", async () => {
    const tool = provider === "outlook" ? "get_message" : "get_event";
    const makeRequest = () =>
      request(provider, { type: "tools/call", tool, capability: "query" }, "tools/call", {
        name: tool,
        arguments: {},
      });
    mocks.active.mockResolvedValueOnce(false);
    expect((await service(provider).handle(makeRequest())).status).toBe(403);
    for (const replacement of [
      { ...row, status: "disconnected" },
      { ...row, id: "other" },
      { ...row, scopes: [] },
    ]) {
      mocks.row.mockResolvedValueOnce(replacement);
      expect((await service(provider).handle(makeRequest())).status).toBe(401);
    }
    mocks.row.mockResolvedValueOnce({ ...row, toolModes: { [tool]: "off" } });
    expect((await service(provider).handle(makeRequest())).status).toBe(403);
    mocks.row.mockResolvedValueOnce({ ...row, capabilityModes: { query: "off" } });
    expect((await service(provider).handle(makeRequest())).status).toBe(403);
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("requires scope grants before connecting the worker and exposes only ticket auth", async () => {
    mocks.row.mockResolvedValueOnce({ ...row, scopes: ["User.Read"] });
    expect((await getMicrosoftMcpIntegrationState(provider, identity)).connected).toBe(false);
    mocks.row.mockResolvedValueOnce({ ...row, scopes: ["User.Read"] });
    expect(
      await loadMicrosoftMcpWorkerConnection(provider, {
        ...identity,
        operation: { type: "tools/list" },
        onAuthorizationRequired: () => {
          throw new Error("auth");
        },
      }),
    ).toEqual({ ok: false, reason: "needs_reauth" });
    const result = await loadMicrosoftMcpWorkerConnection(provider, {
      ...identity,
      operation: { type: "tools/list" },
      onAuthorizationRequired: () => {
        throw new Error("auth");
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const tokens = await result.authProvider.tokens();
      expect(tokens?.access_token).not.toBe("graph-token-never-use-for-mcp");
      expect(
        verifyMicrosoftMcpTicket({ provider, ticket: tokens!.access_token, secret }),
      ).toMatchObject(identity);
    }
  });
});

describe("Outlook Graph behavior", () => {
  it("returns a structured reconnect envelope when auth expires during an operation", async () => {
    mocks.api.mockRejectedValueOnce(new MicrosoftAccessAuthError("expired"));
    const result = await call("outlook", "get_message", { messageId: "m1" });
    expect(result.isError).toBe(true);
    expect(decode(result)).toMatchObject({ error: { code: "auth_expired" } });
  });

  it("creates a draft without a send endpoint", async () => {
    mocks.api.mockResolvedValue({ id: "draft_1", isDraft: true });
    const result = await call("outlook", "create_draft", {
      to: ["person@example.com"],
      subject: "Review",
      body: "Hello",
    });
    expect(decode(result)).toMatchObject({ isDraft: true });
    expect(mocks.api.mock.calls[0]![1]).toBe("POST");
    expect(mocks.api.mock.calls[0]![2].pathname).toBe("/v1.0/me/messages");
    expect(mocks.api.mock.calls[0]![2].search).toBe("");
    expect(mocks.api.mock.calls[0]![3].body).toMatchObject({
      body: { contentType: "Text", content: "Hello" },
    });
  });
  it.each([
    ["archive_message", "archive"],
    ["trash_message", "deleteditems"],
  ])("%s uses a reversible move and returns the new id", async (tool, destinationId) => {
    mocks.api.mockResolvedValue({ id: "new-id" });
    expect(decode(await call("outlook", tool, { messageId: "old-id" }))).toMatchObject({
      id: "new-id",
    });
    expect(mocks.api.mock.calls[0]![3].body).toEqual({ destinationId });
    expect(mocks.api.mock.calls[0]![2].search).toBe("");
  });
  it("escapes conversation filters and rejects pagination that changes the resource", async () => {
    mocks.api.mockResolvedValue({ value: [] });
    await call("outlook", "get_conversation", { conversationId: "a'b" });
    expect(mocks.api.mock.calls[0]![2].searchParams.get("$filter")).toBe(
      "conversationId eq 'a''b'",
    );
    const result = await call("outlook", "search_messages", {
      pageToken: Buffer.from("https://evil.example/v1.0/me/messages").toString("base64url"),
    });
    expect(result.isError).toBe(true);
    expect(mocks.api).toHaveBeenCalledOnce();
  });
  it("rejects pagination that drops the conversation filter", async () => {
    mocks.api.mockResolvedValue({ value: [] });
    await call("outlook", "get_conversation", { conversationId: "c1" });
    const widened = new URL(mocks.api.mock.calls[0]![2]);
    widened.searchParams.delete("$filter");

    const result = await call("outlook", "get_conversation", {
      conversationId: "c1",
      pageToken: Buffer.from(widened.toString()).toString("base64url"),
    });

    expect(result.isError).toBe(true);
    expect(mocks.api).toHaveBeenCalledOnce();
  });
  it("rejects pagination that adds query parameters", async () => {
    mocks.api.mockResolvedValue({ value: [] });
    await call("outlook", "search_messages", {});
    const widened = new URL(mocks.api.mock.calls[0]![2]);
    widened.searchParams.set("$expand", "attachments");

    const result = await call("outlook", "search_messages", {
      pageToken: Buffer.from(widened.toString()).toString("base64url"),
    });

    expect(result.isError).toBe(true);
    expect(mocks.api).toHaveBeenCalledOnce();
  });
  it("binds attachment URLs to their ids and revokes them when the account disconnects", async () => {
    mocks.api.mockResolvedValue({
      "@odata.type": "#microsoft.graph.fileAttachment",
      id: "a1",
      name: "report.txt",
      size: 3,
    });
    const result = decode(
      await call("outlook", "download_attachment", { messageId: "m1", attachmentId: "a1" }),
    );
    const mcp = createOutlookMcpService({
      db: {},
      internalSecret: secret,
      apiCall: mocks.api,
      apiDownload: mocks.download,
    });
    mocks.download.mockResolvedValue({ bytes: Buffer.from("abc"), contentType: "text/plain" });
    const response = await mcp.downloadAttachment(new Request(result.downloadUrl));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    // Download bearers must not be usable to mint other links through the MCP tool.
    const replay = request(
      "outlook",
      { type: "tools/call", tool: "download_attachment", capability: "query" },
      "tools/call",
      { name: "download_attachment", arguments: { messageId: "other", attachmentId: "other" } },
    );
    replay.headers.set(
      "authorization",
      `Bearer ${new URL(result.downloadUrl).searchParams.get("ticket")}`,
    );
    expect((await mcp.handle(replay)).status).toBe(401);
    const changed = new URL(result.downloadUrl);
    changed.searchParams.set("attachmentId", "other");
    expect((await mcp.downloadAttachment(new Request(changed))).status).toBe(401);
    mocks.row.mockResolvedValueOnce({ ...row, status: "disconnected" });
    expect((await mcp.downloadAttachment(new Request(result.downloadUrl))).status).toBe(401);
    expect(mocks.download).toHaveBeenCalledOnce();
  });
  it("does not offer oversized or reference attachment downloads", async () => {
    for (const metadata of [
      { "@odata.type": "#microsoft.graph.referenceAttachment", name: "remote", size: 10 },
      { "@odata.type": "#microsoft.graph.fileAttachment", name: "big", size: 21 * 1024 * 1024 },
    ]) {
      mocks.api.mockResolvedValueOnce(metadata);
      expect(
        (await call("outlook", "download_attachment", { messageId: "m1", attachmentId: "a1" }))
          .isError,
      ).toBe(true);
    }
  });
});

describe("Outlook Calendar Graph behavior", () => {
  const range = { startTime: "2026-09-10T09:00:00+02:00", endTime: "2026-09-10T10:00:00+02:00" };
  it("expands recurrences through calendarView and reads every availability page for personal accounts", async () => {
    const start = { dateTime: "2026-09-10T07:00:00", timeZone: "UTC" },
      end = { dateTime: "2026-09-10T08:00:00", timeZone: "UTC" };
    mocks.api
      .mockImplementationOnce(async (_connection, _method, url) => {
        const next = new URL(url);
        next.searchParams.set("$skip", "100");
        return { value: [{ start, end, showAs: "free" }], "@odata.nextLink": next.toString() };
      })
      .mockResolvedValueOnce({ value: [{ start, end, showAs: "tentative" }] });
    const result = decode(await call("outlook-calendar", "check_availability", range));
    expect(result.complete).toBe(true);
    expect(result.busy).toEqual([{ start, end, status: "tentative" }]);
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.api.mock.calls[0]![2].pathname).toBe("/v1.0/me/calendar/calendarView");
  });
  it("refuses to claim availability for incomplete event data", async () => {
    mocks.api.mockResolvedValueOnce({ value: [{ start: {}, end: {}, showAs: "busy" }] });
    expect((await call("outlook-calendar", "check_availability", range)).isError).toBe(true);
  });
  it("normalizes offsets for Graph writes and preserves omitted fields when rescheduling", async () => {
    mocks.api
      .mockResolvedValueOnce({ id: "e1", type: "singleInstance", isAllDay: false })
      .mockResolvedValueOnce({ id: "e1" });
    await call("outlook-calendar", "update_event", { eventId: "e1", ...range });
    expect(mocks.api.mock.calls[1]![1]).toBe("PATCH");
    expect(mocks.api.mock.calls[1]![2].search).toBe("");
    expect(mocks.api.mock.calls[1]![3].body).toEqual({
      start: { dateTime: "2026-09-10T07:00:00.000", timeZone: "UTC" },
      end: { dateTime: "2026-09-10T08:00:00.000", timeZone: "UTC" },
    });
  });
  it("rejects invalid ranges and refuses series-wide or all-day rescheduling", async () => {
    expect(
      (
        await call("outlook-calendar", "create_event", {
          subject: "Meeting",
          startTime: range.endTime,
          endTime: range.startTime,
        })
      ).isError,
    ).toBe(true);
    expect(mocks.api).not.toHaveBeenCalled();
    for (const event of [
      { id: "e1", type: "seriesMaster" },
      { id: "e1", isAllDay: true },
    ]) {
      mocks.api.mockResolvedValueOnce(event);
      expect(
        (await call("outlook-calendar", "update_event", { eventId: "e1", ...range })).isError,
      ).toBe(true);
    }
    expect(mocks.api.mock.calls.every((call) => call[1] === "GET")).toBe(true);
  });
  it("refuses to overwrite an online meeting body but still updates its other fields", async () => {
    mocks.api.mockResolvedValueOnce({ id: "e1", type: "singleInstance", isOnlineMeeting: true });
    expect(
      (await call("outlook-calendar", "update_event", { eventId: "e1", body: "New agenda" }))
        .isError,
    ).toBe(true);
    expect(mocks.api.mock.calls.every((call) => call[1] === "GET")).toBe(true);
    expect(mocks.api.mock.calls[0]![2].searchParams.get("$select")).toContain("isOnlineMeeting");

    mocks.api.mockReset();
    mocks.api
      .mockResolvedValueOnce({ id: "e1", type: "singleInstance", isOnlineMeeting: true })
      .mockResolvedValueOnce({ id: "e1" });
    await call("outlook-calendar", "update_event", { eventId: "e1", subject: "Weekly sync" });
    expect(mocks.api.mock.calls[1]![1]).toBe("PATCH");
    expect(mocks.api.mock.calls[1]![3].body).toEqual({ subject: "Weekly sync" });
  });
  it("rewrites the body of an event that is not an online meeting", async () => {
    mocks.api
      .mockResolvedValueOnce({ id: "e1", type: "singleInstance", isOnlineMeeting: false })
      .mockResolvedValueOnce({ id: "e1" });
    await call("outlook-calendar", "update_event", { eventId: "e1", body: "New agenda" });
    expect(mocks.api.mock.calls[1]![3].body).toEqual({
      body: { contentType: "Text", content: "New agenda" },
    });
  });
  it("responds to an invite with explicit notification behavior", async () => {
    mocks.api
      .mockResolvedValueOnce({ id: "e1", isOrganizer: false, type: "singleInstance" })
      .mockResolvedValueOnce({});
    expect(
      decode(
        await call("outlook-calendar", "respond_to_invite", {
          eventId: "e1",
          response: "accept",
          sendResponse: false,
        }),
      ),
    ).toMatchObject({ responseSent: false });
    expect(mocks.api.mock.calls[1]![2].pathname).toBe("/v1.0/me/events/e1/accept");
    expect(mocks.api.mock.calls[1]![3].body.sendResponse).toBe(false);
  });
  it("shows missing Microsoft grants as reconnect-required in account settings", () => {
    const state = integrationStateFromRows([
      { ...row, provider: "outlook", status: "connected", scopes: ["User.Read"] },
    ]);
    expect(state.personalAccounts.outlook[0]).toMatchObject({
      connected: false,
      status: "needs_reauth",
    });
  });
});
