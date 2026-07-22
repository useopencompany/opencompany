import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbRows: [] as unknown[],
  loadCredential: vi.fn(),
  refreshCredential: vi.fn(),
  markStatus: vi.fn(),
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
  refreshGoatIntegrationCredential: mocks.refreshCredential,
  markGoatIntegrationStatus: mocks.markStatus,
}));

import { resolveGmailActions } from "@/lib/actions/gmail";
import { GoatActionAuthError, type GoatActionExecuteContext } from "@/lib/actions/types";

const CONTEXT: GoatActionExecuteContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-18T00:00:00.000Z"),
};

function connectedRow(email = "louis@example.com") {
  return {
    integrationId: "gint_gmail_1",
    accountEmail: email,
    accountName: "Louis",
    status: "connected",
  };
}

function freshCredential() {
  return {
    payload: { access_token: "ya29.fresh", refresh_token: "refresh_1" },
    expiresAt: new Date(Date.now() + 3_600_000),
  };
}

function findAction(catalog: Awaited<ReturnType<typeof resolveGmailActions>>, id: string) {
  const action = catalog?.actions.find((entry) => entry.id === id);
  if (!action) throw new Error(`missing action ${id}`);
  return action;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("resolveGmailActions", () => {
  it("is absent without a connected Gmail account", async () => {
    mocks.dbRows = [];
    expect(await resolveGmailActions("user_1")).toBeNull();
    mocks.dbRows = [{ ...connectedRow(), status: "needs_reauth" }];
    expect(await resolveGmailActions("user_1")).toBeNull();
  });

  it("exposes the three read actions for a connected account", async () => {
    mocks.dbRows = [connectedRow()];
    const catalog = await resolveGmailActions("user_1");
    expect(catalog?.actions.map((action) => action.id)).toEqual([
      "gmail.search_messages",
      "gmail.get_message",
      "gmail.get_thread",
    ]);
    expect(catalog?.label).toContain("louis@example.com");
  });
});

describe("gmail.search_messages", () => {
  it("lists matches and hydrates metadata headers", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.loadCredential.mockResolvedValue(freshCredential());
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages?") || url.includes("q=")) {
        return jsonResponse({ messages: [{ id: "m1", threadId: "t1" }] });
      }
      return jsonResponse({
        id: "m1",
        threadId: "t1",
        snippet: "hello there",
        payload: {
          headers: [
            { name: "From", value: "jane@example.com" },
            { name: "Subject", value: "Invoice" },
            { name: "Date", value: "Fri, 17 Jul 2026 10:00:00 +0000" },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await resolveGmailActions("user_1");
    const search = findAction(catalog, "gmail.search_messages");
    const result = (await search.execute({ query: "from:jane", limit: 5 }, CONTEXT)) as {
      messages: Array<{ id?: string; from?: string; subject?: string }>;
    };

    const listUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(listUrl).toContain("q=from%3Ajane");
    expect(listUrl).toContain("maxResults=5");
    const hydrateUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(hydrateUrl).toContain("/messages/m1");
    expect(hydrateUrl).toContain("format=metadata");
    expect(result.messages).toEqual([
      expect.objectContaining({ id: "m1", from: "jane@example.com", subject: "Invoice" }),
    ]);
  });

  it("refreshes an expired token before calling the API", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.loadCredential.mockResolvedValue({
      payload: { access_token: "ya29.stale", refresh_token: "refresh_1" },
      expiresAt: new Date(Date.now() - 1_000),
    });
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "secret");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "ya29.new", expires_in: 3600 });
      }
      return jsonResponse({ messages: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await resolveGmailActions("user_1");
    const search = findAction(catalog, "gmail.search_messages");
    await search.execute({ query: "is:unread" }, CONTEXT);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("oauth2.googleapis.com/token");
    expect(mocks.refreshCredential).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "gmail", integrationId: "gint_gmail_1" }),
    );
    const apiCall = fetchMock.mock.calls[1];
    expect((apiCall?.[1] as RequestInit).headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer ya29.new" }),
    );
  });

  it("marks needs_reauth and throws an auth error on invalid_grant", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.loadCredential.mockResolvedValue({
      payload: { access_token: "ya29.stale", refresh_token: "refresh_1" },
      expiresAt: new Date(Date.now() - 1_000),
    });
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("error=invalid_grant", { status: 400 })),
    );

    const catalog = await resolveGmailActions("user_1");
    const search = findAction(catalog, "gmail.search_messages");
    await expect(search.execute({ query: "is:unread" }, CONTEXT)).rejects.toBeInstanceOf(
      GoatActionAuthError,
    );
    expect(mocks.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "needs_reauth" }),
    );
  });
});

describe("gmail.get_message and gmail.get_thread", () => {
  it("extracts nested text/plain bodies and truncates them", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.loadCredential.mockResolvedValue(freshCredential());
    const body = Buffer.from(`plain body ${"z".repeat(9_000)}`, "utf8").toString("base64url");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: "m1",
          threadId: "t1",
          snippet: "snippet",
          payload: {
            mimeType: "multipart/alternative",
            headers: [{ name: "From", value: "jane@example.com" }],
            parts: [
              {
                mimeType: "text/html",
                body: { data: Buffer.from("<b>hi</b>").toString("base64url") },
              },
              {
                mimeType: "multipart/mixed",
                parts: [{ mimeType: "text/plain", body: { data: body } }],
              },
            ],
          },
        }),
      ),
    );

    const catalog = await resolveGmailActions("user_1");
    const getMessage = findAction(catalog, "gmail.get_message");
    const result = (await getMessage.execute({ id: "m1" }, CONTEXT)) as {
      message: { bodyText?: string; from?: string };
    };
    expect(result.message.from).toBe("jane@example.com");
    expect(result.message.bodyText?.startsWith("plain body")).toBe(true);
    expect(result.message.bodyText?.length).toBe(8_001);
  });

  it("keeps only the newest thread messages", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.loadCredential.mockResolvedValue(freshCredential());
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `m${index}`,
      threadId: "t1",
      snippet: `msg ${index}`,
      payload: { headers: [] },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "t1", messages })),
    );

    const catalog = await resolveGmailActions("user_1");
    const getThread = findAction(catalog, "gmail.get_thread");
    const result = (await getThread.execute({ id: "t1" }, CONTEXT)) as {
      totalMessages: number;
      messages: Array<{ id?: string }>;
    };
    expect(result.totalMessages).toBe(20);
    expect(result.messages).toHaveLength(15);
    expect(result.messages[0]?.id).toBe("m5");
    expect(result.messages.at(-1)?.id).toBe("m19");
  });

  it("requires an account param when multiple accounts are connected", async () => {
    mocks.dbRows = [connectedRow("a@example.com"), connectedRow("b@example.com")];
    const catalog = await resolveGmailActions("user_1");
    const getMessage = findAction(catalog, "gmail.get_message");
    await expect(getMessage.execute({ id: "m1" }, CONTEXT)).rejects.toThrow(
      "Multiple Gmail accounts",
    );
    await expect(
      getMessage.execute({ id: "m1", account: "missing@example.com" }, CONTEXT),
    ).rejects.toThrow("No connected Gmail account");
  });
});
