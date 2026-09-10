import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { xAccountApiCall } from "./x-access-token";
import { executeXApiTool, xApiToolDefinitions } from "./x-api-tools";

const connection = { userWorkosId: "user_1", integrationId: "gint_x" };
const signal = new AbortController().signal;

function execute(
  name: string,
  params: unknown,
  apiCall = vi.fn<typeof xAccountApiCall>(async () => ({ data: { id: "123" } })),
) {
  return { apiCall, result: executeXApiTool({ name, params, apiCall, connection, signal }) };
}

describe("X API tools", () => {
  it("publishes the requested reply and media using the bound account and returns a post link", async () => {
    const { result, apiCall } = execute("create_posts", {
      text: "Shipping today 🚀",
      reply_to_id: "456",
      media_ids: ["789"],
      made_with_ai: true,
    });
    await expect(result).resolves.toMatchObject({
      data: { id: "123", url: "https://x.com/i/status/123" },
    });
    expect(apiCall).toHaveBeenCalledExactlyOnceWith(
      connection,
      "POST",
      new URL("https://api.x.com/2/tweets"),
      {
        signal,
        body: {
          text: "Shipping today 🚀",
          reply: { in_reply_to_tweet_id: "456" },
          media: { media_ids: ["789"] },
          made_with_ai: true,
        },
      },
    );
  });

  it.each([
    {},
    { text: "   " },
    { text: "a", draft: true },
    { text: "a", reply_to_id: "../me" },
    { text: "a", reply_to_id: "1", quote_tweet_id: "2" },
    { text: "a", poll: { options: ["one"], duration_minutes: 5 } },
    { text: "a", poll: { options: ["one", "two"], duration_minutes: 4 } },
    { text: "a", poll: { options: ["one", "two"], duration_minutes: 5 }, media_ids: ["1"] },
    { text: "a", poll: { options: ["one", "two"], duration_minutes: 5 }, quote_tweet_id: "1" },
    { text: "a", media_ids: ["1", "2", "3", "4", "5"] },
  ])("rejects invalid publishing input without an API call: %j", async (params) => {
    const { result, apiCall } = execute("create_posts", params);
    await expect(result).rejects.toThrow();
    expect(apiCall).not.toHaveBeenCalled();
  });

  it("allows a media-only post and keeps poll and quote payloads", async () => {
    const media = execute("create_posts", { media_ids: ["1"] });
    await media.result;
    expect(media.apiCall.mock.calls[0]?.[3]).toMatchObject({
      body: { text: "", media: { media_ids: ["1"] } },
    });
    const poll = { options: ["Yes", "No"], duration_minutes: 60 };
    const vote = execute("create_posts", { text: "Ship it?", poll });
    await vote.result;
    expect(vote.apiCall.mock.calls[0]?.[3]).toMatchObject({ body: { poll } });
    const quote = execute("create_posts", { text: "An update", quote_tweet_id: "42" });
    await quote.result;
    expect(quote.apiCall.mock.calls[0]?.[3]).toMatchObject({ body: { quote_tweet_id: "42" } });
  });

  it("uploads PNG bytes without publishing and sends alt text separately", async () => {
    const media = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
    const upload = execute("upload_image", { media });
    await upload.result;
    expect(upload.apiCall).toHaveBeenCalledWith(
      connection,
      "POST",
      new URL("https://api.x.com/2/media/upload"),
      {
        signal,
        body: { media, media_category: "tweet_image" },
      },
    );
    const alt = execute("set_media_alt_text", {
      media_id: "123",
      alt_text: "A product screenshot",
    });
    await alt.result;
    expect(alt.apiCall).toHaveBeenCalledWith(
      connection,
      "POST",
      new URL("https://api.x.com/2/media/metadata"),
      {
        signal,
        body: { id: "123", metadata: { alt_text: { text: "A product screenshot" } } },
      },
    );
  });

  it.each([
    "not base64",
    "data:image/png;base64,aGVsbG8=",
    "aGVsbG8=",
    "aGVsbG8",
    "A".repeat(7_000_000),
  ])("rejects invalid or oversized image data before upload", async (media) => {
    const { result, apiCall } = execute("upload_image", { media });
    await expect(result).rejects.toThrow();
    expect(apiCall).not.toHaveBeenCalled();
  });

  it("encodes search operators and pagination without turning input into URL parameters", async () => {
    const { result, apiCall } = execute("search_posts_recent", {
      query: "hello & from:someone",
      next_token: "abc+=",
      "post.fields": "public_metrics,created_at",
    });
    await result;
    const url = apiCall.mock.calls[0]?.[2] as URL;
    expect(url.pathname).toBe("/2/tweets/search/recent");
    expect(url.searchParams.get("query")).toBe("hello & from:someone");
    expect(url.searchParams.get("next_token")).toBe("abc+=");
    expect(url.searchParams.size).toBe(3);
  });

  it("preserves partial analytics results and encodes the requested range", async () => {
    const partial = { data: [{ id: "1" }], errors: [{ resource_id: "2", title: "Forbidden" }] };
    const apiCall = vi.fn().mockResolvedValue(partial);
    const params = {
      ids: ["1", "2"],
      start_time: "2026-09-01T00:00:00Z",
      end_time: "2026-09-02T00:00:00Z",
    };
    await expect(
      executeXApiTool({ name: "get_posts_analytics", params, connection, apiCall }).then((x) => x),
    ).resolves.toEqual(partial);
    const url = apiCall.mock.calls[0]?.[2] as URL;
    expect(url.searchParams.get("ids")).toBe("1,2");
    expect(url.searchParams.get("granularity")).toBe("total");
    expect(url.searchParams.get("start_time")).toBe(params.start_time);
    await expect(
      executeXApiTool({
        name: "get_posts_analytics",
        params: { ...params, end_time: params.start_time },
        connection,
        apiCall,
      }),
    ).rejects.toThrow("start_time");
    expect(apiCall).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation of writes and never retries ambiguous failures", async () => {
    const apiCall = vi.fn().mockResolvedValue({ errors: [{ title: "Rejected" }] });
    await expect(
      executeXApiTool({ name: "create_posts", params: { text: "hello" }, connection, apiCall }),
    ).rejects.toThrow("did not confirm");
    expect(apiCall).toHaveBeenCalledTimes(1);
    apiCall.mockRejectedValue(new Error("Request timed out"));
    await expect(
      executeXApiTool({ name: "create_posts", params: { text: "hello" }, connection, apiCall }),
    ).rejects.toThrow("timed out");
    expect(apiCall).toHaveBeenCalledTimes(2);
  });

  it("does not report alt text as saved without confirmation for that image", async () => {
    const apiCall = vi.fn().mockResolvedValue({ data: { id: "999" } });
    await expect(
      executeXApiTool({
        name: "set_media_alt_text",
        params: { media_id: "123", alt_text: "A screenshot" },
        connection,
        apiCall,
      }),
    ).rejects.toThrow("requested image");
    apiCall.mockResolvedValue({ errors: [{ title: "Forbidden" }] });
    await expect(
      executeXApiTool({
        name: "set_media_alt_text",
        params: { media_id: "123", alt_text: "A screenshot" },
        connection,
        apiCall,
      }),
    ).rejects.toThrow("did not confirm");
  });

  it("deletes only the supplied numeric id and requires a deleted response", async () => {
    const apiCall = vi.fn().mockResolvedValue({ data: { deleted: true } });
    await executeXApiTool({ name: "delete_posts", params: { id: "123" }, connection, apiCall });
    expect(apiCall).toHaveBeenCalledWith(
      connection,
      "DELETE",
      new URL("https://api.x.com/2/tweets/123"),
      expect.any(Object),
    );
    apiCall.mockResolvedValue({ data: { deleted: false } });
    await expect(
      executeXApiTool({ name: "delete_posts", params: { id: "123" }, connection, apiCall }),
    ).rejects.toThrow("did not confirm");
  });

  it("discovers bounded schemas and accurate effects for every new action", () => {
    for (const tool of xApiToolDefinitions()) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.annotations.readOnlyHint).toBe(
        ["search_posts_recent", "get_posts_analytics"].includes(tool.name),
      );
    }
  });
});
