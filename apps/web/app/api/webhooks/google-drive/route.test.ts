import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

describe("POST /api/webhooks/google-drive relay", () => {
  beforeEach(() => {
    vi.stubEnv("GOAT_API_ORIGIN", "https://api.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards the notification headers to the canonical API ingress path", async () => {
    let upstream: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        upstream = input instanceof Request ? input : new Request(input, init);
        return new Response(null, { status: 204 });
      }),
    );

    const response = await POST(
      new Request("https://my.opencompany.chat/api/webhooks/google-drive", {
        method: "POST",
        headers: {
          "x-goog-channel-id": "channel_1",
          "x-goog-channel-token": "secret-token",
          "x-goog-resource-id": "resource_1",
          "x-goog-resource-state": "change",
        },
      }),
    );

    expect(response.status).toBe(204);
    const request = upstream as unknown as Request;
    expect(new URL(request.url).href).toBe("https://api.example.test/webhooks/google-drive");
    expect(request.headers.get("x-goog-channel-id")).toBe("channel_1");
    expect(request.headers.get("x-goog-channel-token")).toBe("secret-token");
    expect(request.headers.get("x-goog-resource-state")).toBe("change");
  });

  it("fails closed when the API origin is unset", async () => {
    vi.stubEnv("GOAT_API_ORIGIN", "");
    const response = await POST(
      new Request("https://my.opencompany.chat/api/webhooks/google-drive", { method: "POST" }),
    );
    expect(response.status).toBe(503);
  });
});
