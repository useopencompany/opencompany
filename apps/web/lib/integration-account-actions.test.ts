import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alwaysAllowGoatChatActionAction,
  disconnectGoatIntegrationAccountAction,
  getGoatIntegrationAccountUsageAction,
  setGoatIntegrationCapabilityModeAction,
} from "./integration-account-actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

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

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };

describe("integration account adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOAT_API_ORIGIN", "https://api.example.test");
    vi.mocked(headers).mockResolvedValue(
      new Headers({ Cookie: "wos-session=sealed", Origin: "https://app.example.test" }) as never,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads account usage through the typed usage query", async () => {
    const requests = stubApi(() => Response.json({ data: { affectedBrainSourceCount: 2 }, meta }));

    await expect(getGoatIntegrationAccountUsageAction("gint_abc")).resolves.toEqual({
      ok: true,
      affectedBrainSourceCount: 2,
    });
    const request = requests[0] as Request;
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/v1/integration-accounts/gint_abc/usage");
    expect(request.headers.get("cookie")).toBe("wos-session=sealed");
  });

  it("keeps the retired owner-only copy on non-owned disconnects", async () => {
    stubApi(
      () =>
        Response.json(
          {
            error: {
              code: "not_found",
              message: "Only the connection owner can manage this account.",
              requestId: "request_1",
              retryable: false,
            },
            meta,
          },
          { status: 404 },
        ) as Response,
    );

    await expect(disconnectGoatIntegrationAccountAction("gint_abc")).resolves.toEqual({
      ok: false,
      error: "Only the connection owner can manage this account.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("disconnects through DELETE and revalidates the whole app", async () => {
    const requests = stubApi(() =>
      Response.json({ data: { integrationId: "gint_abc", deleted: true }, meta }),
    );

    await expect(disconnectGoatIntegrationAccountAction("gint_abc")).resolves.toEqual({
      ok: true,
    });
    const request = requests[0] as Request;
    expect(request.method).toBe("DELETE");
    expect(new URL(request.url).pathname).toBe("/v1/integration-accounts/gint_abc");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("saves a capability mode through the typed command", async () => {
    const requests = stubApi(() =>
      Response.json({
        data: { integrationId: "gint_abc", capabilityId: "write", mode: "ask" },
        meta,
      }),
    );

    await expect(
      setGoatIntegrationCapabilityModeAction("gint_abc", "write", "ask"),
    ).resolves.toEqual({ ok: true });
    const request = requests[0] as Request;
    expect(request.method).toBe("PUT");
    expect(new URL(request.url).pathname).toBe(
      "/v1/integration-accounts/gint_abc/capability-modes/write",
    );
    await expect(request.json()).resolves.toEqual({ mode: "ask" });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("surfaces the API's vocabulary error for unknown modes", async () => {
    stubApi(
      () =>
        Response.json(
          {
            error: {
              code: "invalid_request",
              message: "Unknown permission mode.",
              requestId: "request_1",
              retryable: false,
            },
            meta,
          },
          { status: 400 },
        ) as Response,
    );

    await expect(
      setGoatIntegrationCapabilityModeAction("gint_abc", "write", "sometimes"),
    ).resolves.toEqual({ ok: false, error: "Unknown permission mode." });
  });

  it("persists standing action permission through the typed command", async () => {
    const requests = stubApi(() =>
      Response.json({ data: { actionId: "gmail.send_email", state: "allowed" }, meta }),
    );

    await expect(alwaysAllowGoatChatActionAction("gmail.send_email")).resolves.toEqual({
      ok: true,
    });
    const request = requests[0] as Request;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(
      "/v1/actions/gmail.send_email/permissions/always-allow",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});
