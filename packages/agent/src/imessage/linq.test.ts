import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinqImessageProvider } from "./linq";

const provider = createLinqImessageProvider({
  token: "linq_test_token",
  fromNumber: "+12223334444",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLinqImessageProvider", () => {
  it("posts the Linq v3 chat payload and returns the message id", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "msg_123" }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.send({ to: "+15556667777", text: "Hello!" });

    expect(result).toEqual({ ok: true, providerMessageId: "msg_123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.linqapp.com/api/partner/v3/chats");
    expect(init.headers).toMatchObject({ Authorization: "Bearer linq_test_token" });
    expect(JSON.parse(init.body as string)).toEqual({
      from: "+12223334444",
      to: ["+15556667777"],
      message: { parts: [{ type: "text", value: "Hello!" }] },
    });
  });

  it("treats an unparseable success body as a delivered send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    const result = await provider.send({ to: "+15556667777", text: "Hi" });

    expect(result).toEqual({ ok: true, providerMessageId: null });
  });

  it("maps auth failures to a credentials error without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    const result = await provider.send({ to: "+15556667777", text: "Hi" });

    expect(result).toEqual({
      ok: false,
      error: "Message provider rejected the platform credentials.",
    });
  });

  it("distinguishes provider outages from rejected sends", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    expect(await provider.send({ to: "+15556667777", text: "Hi" })).toEqual({
      ok: false,
      error: "Message provider is unavailable (HTTP 503).",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 422 })),
    );
    expect(await provider.send({ to: "+15556667777", text: "Hi" })).toEqual({
      ok: false,
      error: "Message provider rejected the send (HTTP 422).",
    });
  });

  it("returns a reachability error when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    expect(await provider.send({ to: "+15556667777", text: "Hi" })).toEqual({
      ok: false,
      error: "Could not reach the message provider.",
    });
  });
});
