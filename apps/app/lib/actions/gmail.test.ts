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
          // The execute-time send permission re-check reads one integration row.
          limit: async () => mocks.dbRows,
        }),
      }),
    }),
  }),
}));
vi.mock("@opencompany/db/integrations", () => ({
  loadIntegrationCredential: mocks.loadCredential,
  refreshIntegrationCredential: mocks.refreshCredential,
  markIntegrationStatus: mocks.markStatus,
}));

import { executeAction } from "@opencompany/core/actions/execute";
import { resolveGmailActions } from "@opencompany/core/actions/gmail";
import {
  ActionAuthError,
  type ActionExecuteContext,
  ActionPermissionError,
} from "@opencompany/core/actions/types";

const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

const CONTEXT: ActionExecuteContext = {
  userWorkosId: "user_1",
  signal: new AbortController().signal,
  currentDate: new Date("2026-07-18T00:00:00.000Z"),
  userTimezone: "UTC",
};

function connectedRow(email = "louis@example.com", integrationId = "gint_gmail_1") {
  return {
    integrationId,
    accountEmail: email,
    accountName: "Louis",
    status: "connected",
    scopes: [GMAIL_READ_SCOPE, GMAIL_COMPOSE_SCOPE],
    capabilityModes: {},
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

const EMAIL = {
  to: ["maya@example.com"],
  cc: ["finance@example.com"],
  bcc: ["archive@example.com"],
  subject: "Résumé follow-up",
  body: "Hi Maya,\n\nHere is the follow-up.\n",
};

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

  it("exposes reads, draft creation, and an ask-before-send action for a connected account", async () => {
    mocks.dbRows = [connectedRow()];
    const catalog = await resolveGmailActions("user_1");
    expect(catalog?.actions.map((action) => action.id)).toEqual([
      "gmail.search_messages",
      "gmail.get_message",
      "gmail.get_thread",
      "gmail.create_draft",
      "gmail.send_email",
    ]);
    expect(catalog?.label).toContain("louis@example.com");
    expect(catalog?.description).toContain("create new drafts");
    expect(findAction(catalog, "gmail.create_draft")).toMatchObject({
      capability: "draft",
      permissionMode: "on",
      params: {
        required: ["to", "subject", "body"],
      },
    });
    expect(findAction(catalog, "gmail.send_email")).toMatchObject({
      capability: "write",
      permissionMode: "ask",
      permission: {
        provider: "gmail",
        capabilityId: "write",
        label: "Send emails",
        integrationIds: ["gint_gmail_1"],
      },
      params: {
        required: ["to", "subject", "body"],
      },
    });
  });

  it("honors separate per-account read, draft, and send modes", async () => {
    mocks.dbRows = [{ ...connectedRow(), capabilityModes: { draft: "off", write: "off" } }];
    let catalog = await resolveGmailActions("user_1");
    expect(catalog?.actions.map((action) => action.id)).toEqual([
      "gmail.search_messages",
      "gmail.get_message",
      "gmail.get_thread",
    ]);

    mocks.dbRows = [
      {
        ...connectedRow(),
        capabilityModes: { read: "off", draft: "ask", write: "off" },
      },
    ];
    catalog = await resolveGmailActions("user_1");
    expect(catalog?.actions.map((action) => action.id)).toEqual(["gmail.create_draft"]);
    expect(findAction(catalog, "gmail.create_draft")).toMatchObject({
      permissionMode: "ask",
      permission: {
        capabilityId: "draft",
        label: "Create drafts",
        integrationIds: ["gint_gmail_1"],
      },
    });

    mocks.dbRows = [
      {
        ...connectedRow(),
        capabilityModes: { read: "off", draft: "off", write: "on" },
      },
    ];
    catalog = await resolveGmailActions("user_1");
    expect(catalog?.actions.map((action) => action.id)).toEqual(["gmail.send_email"]);
    expect(findAction(catalog, "gmail.send_email").permissionMode).toBe("on");

    mocks.dbRows = [
      {
        ...connectedRow(),
        capabilityModes: { read: "off", draft: "off", write: "off" },
      },
    ];
    expect(await resolveGmailActions("user_1")).toBeNull();
  });

  it("requires compose scope for drafts while preserving existing send-only grants", async () => {
    mocks.dbRows = [
      {
        ...connectedRow(),
        scopes: [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE],
      },
    ];
    let catalog = await resolveGmailActions("user_1");
    expect(catalog?.actions.some((action) => action.id === "gmail.create_draft")).toBe(false);
    expect(catalog?.actions.some((action) => action.id === "gmail.send_email")).toBe(true);

    mocks.dbRows = [{ ...connectedRow(), scopes: [GMAIL_READ_SCOPE] }];
    catalog = await resolveGmailActions("user_1");
    expect(catalog?.actions.some((action) => action.id === "gmail.create_draft")).toBe(false);
    expect(catalog?.actions.some((action) => action.id === "gmail.send_email")).toBe(false);
  });
});

describe("gmail.search_messages", () => {
  it("lists matches and hydrates metadata headers", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.loadCredential.mockResolvedValue(freshCredential());
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const input = args[0];
      const url = String(input);
      if (url.includes("/messages?") || url.includes("q=")) {
        return jsonResponse({
          messages: [{ id: "m1", threadId: "t1" }],
          nextPageToken: "page_2",
        });
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
    const result = (await search.execute(
      { query: "from:jane", limit: 5, pageToken: "page_1" },
      CONTEXT,
    )) as {
      integrationId: string;
      nextPageToken?: string;
      messages: Array<{
        id?: string;
        from?: string;
        subject?: string;
        sourceRef?: string;
        integrationId?: string;
        url?: string;
      }>;
    };

    const listUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(listUrl).toContain("q=from%3Ajane");
    expect(listUrl).toContain("maxResults=5");
    expect(listUrl).toContain("pageToken=page_1");
    const hydrateUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(hydrateUrl).toContain("/messages/m1");
    expect(hydrateUrl).toContain("format=metadata");
    expect(result.messages).toEqual([
      expect.objectContaining({
        id: "m1",
        from: "jane@example.com",
        subject: "Invoice",
        sourceRef: "gmail:thread:t1",
        integrationId: "gint_gmail_1",
        url: "https://mail.google.com/mail/u/louis%40example.com/#all/t1",
      }),
    ]);
    expect(result.integrationId).toBe("gint_gmail_1");
    expect(result.nextPageToken).toBe("page_2");
  });

  it("refreshes an expired token before calling the API", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.loadCredential.mockResolvedValue({
      payload: { access_token: "ya29.stale", refresh_token: "refresh_1" },
      expiresAt: new Date(Date.now() - 1_000),
    });
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "secret");
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const input = args[0];
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

  it("surfaces a bounded Google error reason as provider_error", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.loadCredential.mockResolvedValue(freshCredential());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              message: "Invalid id value",
              errors: [{ reason: "invalid" }],
              status: "INVALID_ARGUMENT",
            },
          },
          400,
        ),
      ),
    );
    const providerCatalog = await resolveGmailActions("user_1");
    if (!providerCatalog) throw new Error("missing Gmail catalog");

    const result = await executeAction({
      catalog: {
        providers: [
          {
            id: providerCatalog.id,
            label: providerCatalog.label,
            description: providerCatalog.description,
          },
        ],
        actions: providerCatalog.actions,
      },
      actionId: "gmail.search_messages",
      params: { query: "is:unread" },
      userWorkosId: CONTEXT.userWorkosId,
      signal: CONTEXT.signal,
      currentDate: CONTEXT.currentDate,
      userTimezone: CONTEXT.userTimezone,
    });

    expect(result).toEqual({
      ok: false,
      action: "gmail.search_messages",
      error: {
        code: "provider_error",
        source: "gmail",
        message:
          "Google API request failed with 400: Invalid id value (invalid, INVALID_ARGUMENT).",
      },
    });
  });

  it("falls back to a status-only Google error for a non-JSON response", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.loadCredential.mockResolvedValue(freshCredential());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>upstream failed</html>", { status: 502 })),
    );
    const catalog = await resolveGmailActions("user_1");
    const search = findAction(catalog, "gmail.search_messages");

    await expect(search.execute({ query: "is:unread" }, CONTEXT)).rejects.toThrow(
      "Google API request failed with 502.",
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
      ActionAuthError,
    );
    expect(mocks.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "needs_reauth" }),
    );
  });
});

describe("gmail.create_draft", () => {
  it("creates a bounded plain-text Gmail draft without sending it", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.loadCredential.mockResolvedValue(freshCredential());
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      void args;
      return jsonResponse({
        id: "draft_1",
        message: {
          id: "msg_draft_1",
          threadId: "thread_draft_1",
          labelIds: ["DRAFT"],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const createDraft = findAction(await resolveGmailActions("user_1"), "gmail.create_draft");
    const result = (await createDraft.execute(EMAIL, CONTEXT)) as {
      integrationId: string;
      draft: Record<string, unknown>;
    };

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer ya29.fresh",
        "Content-Type": "application/json",
      }),
    );
    const payload = JSON.parse(String(request.body)) as { message: { raw: string } };
    const mime = Buffer.from(payload.message.raw, "base64url").toString("utf8");
    expect(mime).toContain("From: louis@example.com\r\n");
    expect(mime).toContain("To: maya@example.com\r\n");
    expect(mime).toContain("Cc: finance@example.com\r\n");
    expect(mime).toContain("Bcc: archive@example.com\r\n");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(result).toEqual({
      account: "louis@example.com",
      integrationId: "gint_gmail_1",
      draft: {
        id: "draft_1",
        messageId: "msg_draft_1",
        threadId: "thread_draft_1",
        sourceRef: "gmail:thread:thread_draft_1",
        url: "https://mail.google.com/mail/u/louis%40example.com/#drafts?compose=msg_draft_1",
        labelIds: ["DRAFT"],
      },
    });
  });

  it("refuses to create a draft when its permission is turned off after discovery", async () => {
    mocks.dbRows = [connectedRow()];
    const createDraft = findAction(await resolveGmailActions("user_1"), "gmail.create_draft");

    mocks.dbRows = [{ ...connectedRow(), capabilityModes: { draft: "off" } }];
    const execution = createDraft.execute(EMAIL, CONTEXT);
    await expect(execution).rejects.toBeInstanceOf(ActionPermissionError);
    await expect(execution).rejects.toMatchObject({
      message: expect.stringContaining("Creating drafts is turned off"),
    });
    expect(mocks.loadCredential).not.toHaveBeenCalled();
  });

  it("requires reconnecting when compose scope is removed after discovery", async () => {
    mocks.dbRows = [connectedRow()];
    const createDraft = findAction(await resolveGmailActions("user_1"), "gmail.create_draft");

    mocks.dbRows = [{ ...connectedRow(), scopes: [GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE] }];
    const execution = createDraft.execute(EMAIL, CONTEXT);
    await expect(execution).rejects.toBeInstanceOf(ActionAuthError);
    await expect(execution).rejects.toMatchObject({
      message: expect.stringContaining("enable drafts"),
    });
    expect(mocks.loadCredential).not.toHaveBeenCalled();
  });

  it("requires an explicit account when multiple draft-capable accounts are connected", async () => {
    mocks.dbRows = [
      connectedRow("a@example.com", "gint_a"),
      connectedRow("b@example.com", "gint_b"),
    ];
    const createDraft = findAction(await resolveGmailActions("user_1"), "gmail.create_draft");

    expect(createDraft.params.required).toEqual(["to", "subject", "body", "account"]);
    await expect(createDraft.execute(EMAIL, CONTEXT)).rejects.toThrow(
      "Multiple Gmail accounts are connected",
    );
    expect(mocks.loadCredential).not.toHaveBeenCalled();
  });
});

describe("gmail.send_email", () => {
  it("sends a bounded plain-text MIME message and returns canonical thread metadata", async () => {
    mocks.dbRows = [connectedRow()];
    mocks.loadCredential.mockResolvedValue(freshCredential());
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      void args;
      return jsonResponse({ id: "msg_sent_1", threadId: "thread_sent_1", labelIds: ["SENT"] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const send = findAction(await resolveGmailActions("user_1"), "gmail.send_email");
    const result = (await send.execute(EMAIL, CONTEXT)) as {
      integrationId: string;
      message: Record<string, unknown>;
    };

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer ya29.fresh",
        "Content-Type": "application/json",
      }),
    );
    const payload = JSON.parse(String(request.body)) as { raw: string };
    const mime = Buffer.from(payload.raw, "base64url").toString("utf8");
    expect(mime).toContain("From: louis@example.com\r\n");
    expect(mime).toContain("To: maya@example.com\r\n");
    expect(mime).toContain("Cc: finance@example.com\r\n");
    expect(mime).toContain("Bcc: archive@example.com\r\n");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    const encodedBody = mime.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") ?? "";
    expect(Buffer.from(encodedBody, "base64").toString("utf8")).toBe(
      "Hi Maya,\r\n\r\nHere is the follow-up.\r\n",
    );
    expect(result).toEqual({
      account: "louis@example.com",
      integrationId: "gint_gmail_1",
      message: {
        id: "msg_sent_1",
        threadId: "thread_sent_1",
        sourceRef: "gmail:thread:thread_sent_1",
        url: "https://mail.google.com/mail/u/louis%40example.com/#all/thread_sent_1",
        labelIds: ["SENT"],
      },
    });
  });

  it("validates recipients, subject, body, and unknown parameters before sending", async () => {
    mocks.dbRows = [connectedRow()];
    const send = findAction(await resolveGmailActions("user_1"), "gmail.send_email");

    await expect(send.execute({ ...EMAIL, to: [] }, CONTEXT)).rejects.toThrow(
      '"to" must be a non-empty array',
    );
    await expect(send.execute({ ...EMAIL, to: ["not-an-email"] }, CONTEXT)).rejects.toThrow(
      "not a valid email address",
    );
    await expect(
      send.execute({ ...EMAIL, subject: "Hello\r\nBcc: bad@example.com" }, CONTEXT),
    ).rejects.toThrow('"subject" cannot contain line breaks');
    await expect(send.execute({ ...EMAIL, body: " " }, CONTEXT)).rejects.toThrow(
      '"body" is required',
    );
    await expect(send.execute({ ...EMAIL, attachments: [] }, CONTEXT)).rejects.toThrow(
      "Unknown parameter",
    );
    expect(mocks.loadCredential).not.toHaveBeenCalled();
  });

  it("refuses to send when the permission is turned off after catalog resolution", async () => {
    mocks.dbRows = [connectedRow()];
    const send = findAction(await resolveGmailActions("user_1"), "gmail.send_email");

    mocks.dbRows = [{ ...connectedRow(), capabilityModes: { write: "off" } }];
    const execution = send.execute(EMAIL, CONTEXT);
    await expect(execution).rejects.toBeInstanceOf(ActionPermissionError);
    await expect(execution).rejects.toMatchObject({
      message: expect.stringContaining("turned off"),
    });
    expect(mocks.loadCredential).not.toHaveBeenCalled();
  });

  it("requires reconnecting when send scope is removed after catalog resolution", async () => {
    mocks.dbRows = [connectedRow()];
    const send = findAction(await resolveGmailActions("user_1"), "gmail.send_email");

    mocks.dbRows = [{ ...connectedRow(), scopes: [GMAIL_READ_SCOPE] }];
    const execution = send.execute(EMAIL, CONTEXT);
    await expect(execution).rejects.toBeInstanceOf(ActionAuthError);
    await expect(execution).rejects.toMatchObject({
      message: expect.stringContaining("enable sending"),
    });
    expect(mocks.loadCredential).not.toHaveBeenCalled();
  });

  it("pins sending to accounts with send scope and permission", async () => {
    mocks.dbRows = [
      {
        ...connectedRow("readonly@example.com", "gint_readonly"),
        scopes: [GMAIL_READ_SCOPE],
      },
      {
        ...connectedRow("sender@example.com", "gint_sender"),
        capabilityModes: { write: "ask" },
      },
    ];
    const send = findAction(await resolveGmailActions("user_1"), "gmail.send_email");

    expect(send.params.required).toEqual(["to", "subject", "body"]);
    expect(send.permission?.integrationIds).toEqual(["gint_sender"]);
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
