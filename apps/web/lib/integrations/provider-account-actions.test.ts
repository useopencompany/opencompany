import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAttioApiKeyAction } from "./attio-actions";
import { saveRenderApiKeyAction } from "./render-actions";
import {
  disconnectStripeIntegrationAction,
  saveStripeRestrictedApiKeyAction,
} from "./stripe-actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };

function stubApi(response: () => Response) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init));
      return response();
    }),
  );
  return requests;
}

function errorEnvelope(message: string, status: number) {
  return Response.json(
    {
      error: { code: "invalid_request", message, requestId: "request_1", retryable: false },
      meta,
    },
    { status },
  ) as Response;
}

describe("provider account command adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.example.test");
    vi.mocked(headers).mockResolvedValue(
      new Headers({ Cookie: "wos-session=sealed", Origin: "https://app.example.test" }) as never,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("connects Attio through PUT and returns the refreshed state", async () => {
    const state = {
      provider: "attio",
      connected: true,
      status: "connected",
      integrationId: "gint_attio",
      workspaceName: "Acme",
      statusReason: null,
    };
    const requests = stubApi(() => Response.json({ data: { state }, meta }));

    await expect(saveAttioApiKeyAction("attio-key-1234567890")).resolves.toEqual({
      ok: true,
      state,
    });
    const request = requests[0] as Request;
    expect(request.method).toBe("PUT");
    expect(new URL(request.url).pathname).toBe("/v1/integration-accounts/attio");
    await expect(request.json()).resolves.toEqual({ apiKey: "attio-key-1234567890" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("connects Render through PUT without exposing the API key in the response", async () => {
    const requests = stubApi(() =>
      Response.json({
        data: {
          state: {
            provider: "render",
            connected: true,
            status: "connected",
            integrationId: "gint_render",
            accountName: "Acme",
            statusReason: null,
            capabilityModes: {},
            toolModes: {},
          },
        },
        meta,
      }),
    );

    await expect(saveRenderApiKeyAction(" rnd_abcdefgh12345678 ")).resolves.toEqual({ ok: true });
    const request = requests[0] as Request;
    expect(request.method).toBe("PUT");
    expect(new URL(request.url).pathname).toBe("/v1/integration-accounts/render");
    await expect(request.json()).resolves.toEqual({ apiKey: "rnd_abcdefgh12345678" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("surfaces API validation copy for rejected keys without revalidating", async () => {
    stubApi(() => errorEnvelope("Attio rejected this API key. Check it and try again.", 400));

    await expect(saveAttioApiKeyAction("attio-key-1234567890")).resolves.toEqual({
      ok: false,
      error: "Attio rejected this API key. Check it and try again.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("keeps the retired admin-only Stripe copy from the API envelope", async () => {
    stubApi(() =>
      Response.json(
        {
          error: {
            code: "forbidden",
            message: "Only workspace admins can manage the Stripe integration.",
            requestId: "request_1",
            retryable: false,
          },
          meta,
        },
        { status: 403 },
      ),
    );

    await expect(saveStripeRestrictedApiKeyAction("rk_test_abcdefabcdefabcdef")).resolves.toEqual({
      ok: false,
      error: "Only workspace admins can manage the Stripe integration.",
    });
  });

  it("disconnects Stripe through the static provider path", async () => {
    const requests = stubApi(() => Response.json({ data: { deleted: true }, meta }));
    await expect(disconnectStripeIntegrationAction()).resolves.toEqual({ ok: true });
    const request = requests[0] as Request;
    expect(request.method).toBe("DELETE");
    expect(new URL(request.url).pathname).toBe("/v1/integration-accounts/stripe");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});
