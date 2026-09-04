import { describe, expect, it, vi } from "vitest";
import {
  isValidRenderApiKey,
  RENDER_API_BASE_URL,
  RENDER_MCP_ENDPOINT_URL,
  validateRenderApiKey,
} from "./render-mcp";

describe("Render MCP integration", () => {
  it("pins the provider endpoints", () => {
    expect(RENDER_MCP_ENDPOINT_URL).toBe("https://mcp.render.com/mcp");
    expect(RENDER_API_BASE_URL).toBe("https://api.render.com/v1");
  });

  it("accepts only Render-shaped API keys", () => {
    expect(isValidRenderApiKey("rnd_abcdefgh12345678")).toBe(true);
    expect(isValidRenderApiKey(" rnd_abcdefgh12345678 ")).toBe(false);
    expect(isValidRenderApiKey("sk_abcdefgh12345678")).toBe(false);
    expect(isValidRenderApiKey("rnd_short")).toBe(false);
  });

  it("validates the key against Render without returning it", async () => {
    const fetch = vi.fn(async () =>
      Response.json([
        { owner: { id: "tea_123", name: "Acme", email: "founder@example.com", type: "team" } },
      ]),
    );
    await expect(validateRenderApiKey("rnd_abcdefgh12345678", { fetch })).resolves.toEqual({
      ok: true,
      owner: { id: "tea_123", name: "Acme", email: "founder@example.com" },
    });
    expect(fetch).toHaveBeenCalledWith(`${RENDER_API_BASE_URL}/owners?limit=1`, {
      headers: { Authorization: "Bearer rnd_abcdefgh12345678" },
      signal: expect.any(AbortSignal),
    });
  });

  it("turns rejected and malformed responses into safe connection errors", async () => {
    await expect(
      validateRenderApiKey("rnd_abcdefgh12345678", {
        fetch: vi.fn(async () => new Response(null, { status: 401 })),
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Render rejected this API key. Check it and try again.",
    });
    await expect(
      validateRenderApiKey("rnd_abcdefgh12345678", {
        fetch: vi.fn(async () => Response.json({ owner: {} })),
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Render returned an unexpected response while validating the key.",
    });
  });
});
