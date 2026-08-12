import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };

describe("/api/skills compatibility adapter", () => {
  beforeEach(() => vi.stubEnv("GOAT_API_ORIGIN", "https://api.example.test"));

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("projects the canonical Skill catalog into the legacy response shape", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          data: [
            {
              id: "visual-review",
              name: "Visual Review",
              description: "Review visual artifacts.",
            },
          ],
          meta,
        },
        { headers: { "Set-Cookie": "wos-session=rotated; Path=/; HttpOnly" } },
      ),
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toContain("wos-session=rotated");
    await expect(response.json()).resolves.toEqual({
      skills: [
        {
          id: "visual-review",
          name: "Visual Review",
          description: "Review visual artifacts.",
        },
      ],
    });
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const upstream = input instanceof Request ? input : new Request(input!, init);
    expect(new URL(upstream.url).pathname).toBe("/v1/skills/catalog");
    expect(upstream.headers.get("cookie")).toBe("wos-session=sealed");
    expect(upstream.headers.get("authorization")).toBe("Bearer token");
    expect(upstream.headers.get("origin")).toBe("http://localhost");
  });

  it("fails closed when the canonical API origin is unavailable", async () => {
    vi.stubEnv("GOAT_API_ORIGIN", "");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "The Skill API is unavailable." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function request() {
  return new Request("http://localhost/api/skills", {
    headers: {
      Cookie: "wos-session=sealed",
      Authorization: "Bearer token",
      Origin: "http://localhost",
    },
  });
}
