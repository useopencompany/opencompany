import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disconnectClaudeCodeAuth,
  isClaudeCodeConnectedForUser,
  loadCurrentClaudeCodeAuthSettings,
  saveClaudeCodeToken,
} from "./claude-code-auth";
import {
  disconnectCodexAuth,
  isCodexConnectedForUser,
  pollCodexDeviceAuth,
  startCodexDeviceAuth,
} from "./codex-auth";
import {
  completeInfisicalAuth,
  disconnectInfisicalAuth,
  loadCurrentInfisicalAuthSettings,
  startInfisicalAuth,
} from "./infisical-auth";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@opencompany/db/client", () => ({ getDb: vi.fn(() => ({ db: "sentinel" })) }));
vi.mock("@opencompany/db/claude-code-auth", () => ({
  loadClaudeCodeAuthStatus: vi.fn(async () => null),
}));
vi.mock("@opencompany/db/codex-auth", () => ({
  loadCodexAuthStatus: vi.fn(async () => null),
}));

import { loadClaudeCodeAuthStatus } from "@opencompany/db/claude-code-auth";
import { loadCodexAuthStatus } from "@opencompany/db/codex-auth";

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

describe("engine auth command adapters", () => {
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

  it("loads Claude Code status through GET /v1/engine-auth/claude-code", async () => {
    const requests = stubApi(() =>
      Response.json({
        data: {
          status: "connected",
          statusReason: null,
          lastValidatedAt: "2026-08-12T10:00:00.000Z",
          lastRotatedAt: null,
        },
        meta,
      }),
    );
    await expect(loadCurrentClaudeCodeAuthSettings()).resolves.toEqual({
      status: "connected",
      statusReason: null,
      lastValidatedAt: "2026-08-12T10:00:00.000Z",
      lastRotatedAt: null,
    });
    expect(requests[0]?.method).toBe("GET");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v1/engine-auth/claude-code");
  });

  it("saves the Claude Code token through PUT and revalidates settings", async () => {
    const requests = stubApi(() =>
      Response.json({
        data: {
          status: "connected",
          statusReason: null,
          lastValidatedAt: null,
          lastRotatedAt: null,
        },
        meta,
      }),
    );
    await expect(saveClaudeCodeToken("sk-ant-oat01-token")).resolves.toEqual({ ok: true });
    expect(requests[0]?.method).toBe("PUT");
    await expect(requests[0]?.json()).resolves.toEqual({ token: "sk-ant-oat01-token" });
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("passes the validator's error copy through unchanged", async () => {
    stubApi(() => errorEnvelope("Paste the token printed by `claude setup-token`.", 400));
    await expect(saveClaudeCodeToken("")).resolves.toEqual({
      ok: false,
      error: "Paste the token printed by `claude setup-token`.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("disconnects Claude Code through DELETE", async () => {
    const requests = stubApi(() => Response.json({ data: { deleted: true }, meta }));
    await expect(disconnectClaudeCodeAuth()).resolves.toEqual({ ok: true });
    expect(requests[0]?.method).toBe("DELETE");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v1/engine-auth/claude-code");
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("keeps the by-user connectivity reads on the db while legacy callers remain", async () => {
    vi.mocked(loadClaudeCodeAuthStatus).mockResolvedValueOnce({
      status: "connected",
      statusReason: null,
      lastValidatedAt: null,
      lastRotatedAt: null,
    });
    await expect(isClaudeCodeConnectedForUser("user_1")).resolves.toBe(true);
    expect(loadClaudeCodeAuthStatus).toHaveBeenCalledWith({
      db: { db: "sentinel" },
      userWorkosId: "user_1",
    });

    await expect(isCodexConnectedForUser("user_1")).resolves.toBe(false);
    expect(loadCodexAuthStatus).toHaveBeenCalledWith({
      db: { db: "sentinel" },
      userWorkosId: "user_1",
    });
  });

  it("starts a Codex device flow through POST /v1/engine-auth/codex/device", async () => {
    const flow = {
      id: "gcodf_1",
      status: "code_ready",
      userCode: "ABCD-1234",
      verificationUri: "https://auth.example.com/device",
      statusReason: null,
      expiresAt: "2026-08-13T09:15:00.000Z",
    };
    const requests = stubApi(() => Response.json({ data: { flow }, meta }, { status: 201 }));
    await expect(startCodexDeviceAuth()).resolves.toEqual({ ok: true, flow });
    expect(requests[0]?.method).toBe("POST");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v1/engine-auth/codex/device");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("requires a flow id before polling and revalidates on completion", async () => {
    await expect(pollCodexDeviceAuth("   ")).resolves.toEqual({
      ok: false,
      error: "Codex auth flow is required.",
    });

    const flow = {
      id: "gcodf_1",
      status: "completed",
      userCode: null,
      verificationUri: null,
      statusReason: null,
      expiresAt: "2026-08-13T09:15:00.000Z",
    };
    const requests = stubApi(() => Response.json({ data: { flow }, meta }));
    await expect(pollCodexDeviceAuth("gcodf_1")).resolves.toEqual({ ok: true, flow });
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/engine-auth/codex/device/gcodf_1/poll",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("surfaces runner failure copy from the API on Codex starts", async () => {
    stubApi(() => errorEnvelope("Runner is not configured.", 503));
    await expect(startCodexDeviceAuth()).resolves.toEqual({
      ok: false,
      error: "Runner is not configured.",
    });
  });

  it("disconnects Codex through DELETE", async () => {
    const requests = stubApi(() => Response.json({ data: { deleted: true }, meta }));
    await expect(disconnectCodexAuth()).resolves.toEqual({ ok: true });
    expect(requests[0]?.method).toBe("DELETE");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v1/engine-auth/codex");
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("loads the workspace Infisical status through GET", async () => {
    const requests = stubApi(() =>
      Response.json({
        data: {
          status: "connected",
          statusReason: null,
          accountEmail: "ops@example.com",
          host: "https://eu.infisical.com",
          lastValidatedAt: null,
        },
        meta,
      }),
    );
    await expect(loadCurrentInfisicalAuthSettings()).resolves.toMatchObject({
      status: "connected",
      host: "https://eu.infisical.com",
    });
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v1/engine-auth/infisical");
  });

  it("passes the admin-gate copy through on Infisical starts", async () => {
    stubApi(() => errorEnvelope("Only workspace admins can manage Infisical.", 403));
    await expect(startInfisicalAuth({ host: "https://app.infisical.com" })).resolves.toEqual({
      ok: false,
      error: "Only workspace admins can manage Infisical.",
    });
  });

  it("starts an Infisical flow with the selected host", async () => {
    const flow = {
      id: "ginff_1",
      status: "link_ready",
      loginUrl: "https://eu.infisical.com/login?flow=1",
      statusReason: null,
      expiresAt: "2026-08-13T09:15:00.000Z",
    };
    const requests = stubApi(() => Response.json({ data: { flow }, meta }, { status: 201 }));
    await expect(startInfisicalAuth({ host: "https://eu.infisical.com" })).resolves.toEqual({
      ok: true,
      flow,
    });
    await expect(requests[0]?.json()).resolves.toEqual({ host: "https://eu.infisical.com" });
  });

  it("keeps the retired browser-token guards before calling the API", async () => {
    const requests = stubApi(() => {
      throw new Error("The API must not be called.");
    });
    await expect(
      completeInfisicalAuth({ flowId: "ginff_1", browserToken: "   " }),
    ).resolves.toEqual({ ok: false, error: "Paste the browser token from Infisical." });
    await expect(
      completeInfisicalAuth({ flowId: "ginff_1", browserToken: "a".repeat(64 * 1024 + 1) }),
    ).resolves.toEqual({ ok: false, error: "That Infisical browser token is too large." });
    expect(requests).toHaveLength(0);
  });

  it("completes an Infisical flow and revalidates settings on completion", async () => {
    const flow = {
      id: "ginff_1",
      status: "completed",
      loginUrl: null,
      statusReason: null,
      expiresAt: "2026-08-13T09:15:00.000Z",
    };
    const requests = stubApi(() => Response.json({ data: { flow }, meta }));
    await expect(
      completeInfisicalAuth({ flowId: " ginff_1 ", browserToken: " browser-token " }),
    ).resolves.toEqual({ ok: true, flow });
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/engine-auth/infisical/ginff_1/complete",
    );
    await expect(requests[0]?.json()).resolves.toEqual({ browserToken: "browser-token" });
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("returns the disconnect gate copy instead of throwing for Infisical", async () => {
    stubApi(() => errorEnvelope("Only workspace admins can manage Infisical.", 403));
    await expect(disconnectInfisicalAuth()).resolves.toEqual({
      ok: false,
      error: "Only workspace admins can manage Infisical.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();

    const requests = stubApi(() => Response.json({ data: { deleted: true }, meta }));
    await expect(disconnectInfisicalAuth()).resolves.toEqual({ ok: true });
    expect(requests[0]?.method).toBe("DELETE");
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });
});
