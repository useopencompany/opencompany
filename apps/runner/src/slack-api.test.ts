import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSlackConversationContext } from "./slack-api";

type MockResponseInput = {
  ok?: boolean;
  status?: number;
  body?: Record<string, unknown>;
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSlackConversationContext", () => {
  it("fetches previous channel and thread context, filters noise, sorts, and dedupes current messages", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const method = url.split("/").pop();
      const form = new URLSearchParams(init.body as string);

      if (method === "conversations.history") {
        expect(form.get("channel")).toBe("C09ABC");
        expect(form.get("latest")).toBe("1783950120.000200");
        expect(form.get("inclusive")).toBe("false");
        expect(form.get("limit")).toBe("10");
        return jsonResponse({
          body: {
            ok: true,
            messages: [
              {
                ts: "1783950120.000200",
                user: "U02",
                text: "duplicate current message",
              },
              { ts: "1783950060.000100", user: "U01", text: "Previous question" },
              { ts: "1783950090.000150", bot_id: "B01", text: "bot noise" },
              { ts: "1783950030.000050", user: "U03", text: "Previous setup" },
              { ts: "1783950020.000040", user: "U04", subtype: "message_changed" },
            ],
          },
        });
      }

      if (method === "conversations.replies") {
        expect(form.get("channel")).toBe("C09ABC");
        expect(form.get("ts")).toBe("1783950000.000010");
        expect(form.get("latest")).toBe("1783950120.000200");
        expect(form.get("inclusive")).toBe("false");
        expect(form.get("limit")).toBe("10");
        return jsonResponse({
          body: {
            ok: true,
            messages: [
              { ts: "1783950000.000010", user: "U01", text: "Thread root" },
              {
                ts: "1783950120.000200",
                thread_ts: "1783950000.000010",
                user: "U02",
                text: "duplicate current reply",
              },
              {
                ts: "1783950065.000120",
                thread_ts: "1783950000.000010",
                user: "U03",
                text: "Earlier reply",
              },
            ],
          },
        });
      }

      if (method === "users.info") {
        const user = form.get("user");
        return jsonResponse({
          body: {
            ok: true,
            user: {
              real_name:
                user === "U01" ? "Jamie" : user === "U02" ? "Ada" : user === "U03" ? "Alex" : "",
            },
          },
        });
      }

      throw new Error(`Unexpected Slack API method ${method}`);
    });

    const context = await fetchSlackConversationContext({
      token: "xoxp_test",
      teamId: "T012345",
      channelId: "C09ABC",
      windowStartTs: "1783950120.000200",
      currentMessages: [
        {
          ts: "1783950120.000200",
          threadTs: "1783950000.000010",
          userId: "U02",
          text: "Current reply",
        },
      ],
    });

    expect(context?.previousMessages).toEqual([
      { ts: "1783950030.000050", userId: "U03", userName: "Alex", text: "Previous setup" },
      { ts: "1783950060.000100", userId: "U01", userName: "Jamie", text: "Previous question" },
    ]);
    expect(context?.threads).toEqual([
      {
        threadTs: "1783950000.000010",
        messages: [
          { ts: "1783950000.000010", userId: "U01", userName: "Jamie", text: "Thread root" },
          {
            ts: "1783950065.000120",
            threadTs: "1783950000.000010",
            userId: "U03",
            userName: "Alex",
            text: "Earlier reply",
          },
        ],
      },
    ]);
  });

  it("returns empty context when Slack context lookups fail", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, status: 500, body: { ok: false } }));

    const context = await fetchSlackConversationContext({
      token: "xoxp_test",
      teamId: "T012345",
      channelId: "C09ABC",
      windowStartTs: "1783950120.000200",
      currentMessages: [{ ts: "1783950120.000200", userId: "U02", text: "Current" }],
    });

    expect(context).toBeUndefined();
  });
});

function jsonResponse(input: MockResponseInput = {}) {
  return {
    ok: input.ok ?? true,
    status: input.status ?? 200,
    headers: { get: () => null },
    json: async () => input.body ?? { ok: true },
  } as unknown as Response;
}
