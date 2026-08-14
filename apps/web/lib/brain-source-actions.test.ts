import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBrainSourceEnabledAction } from "./brain-source-actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

describe("Brain source API actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.example.test");
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        Cookie: "wos-session=sealed",
        Authorization: "Bearer actor-token",
        Origin: "https://my.opencompany.chat",
      }) as never,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards the browser origin and actor credentials to cookie-protected API mutations", async () => {
    let upstream: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        upstream = input instanceof Request ? input : new Request(input, init);
        return Response.json({
          data: {
            brainId: "brain_1",
            integrationId: "integration_1",
            provider: "slack",
            enabled: true,
          },
          meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
        });
      }),
    );

    await expect(
      setBrainSourceEnabledAction({
        brainRef: "brain_1",
        integrationId: "integration_1",
        provider: "slack",
        enabled: true,
      }),
    ).resolves.toEqual({ ok: true });

    const request = upstream as unknown as Request;
    expect(request.method).toBe("PUT");
    expect(new URL(request.url).pathname).toBe("/v1/brains/brain_1/sources/integration_1");
    expect(request.headers.get("cookie")).toBe("wos-session=sealed");
    expect(request.headers.get("authorization")).toBe("Bearer actor-token");
    expect(request.headers.get("origin")).toBe("https://my.opencompany.chat");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});
