import type { Actor } from "@opencompany/core";
import {
  deleteClaudeCodeCredential,
  loadClaudeCodeAuthStatus,
  saveClaudeCodeCredential,
} from "@opencompany/db/claude-code-auth";
import {
  deleteCodexCredential,
  disableWorkspaceCodexEngineAccount,
  loadCodexAuthStatus,
  loadWorkspaceCodexEngineAccount,
  setWorkspaceCodexEngineAccount,
} from "@opencompany/db/codex-auth";
import {
  disconnectInfisicalConnection,
  loadInfisicalConnectionMetadata,
} from "@opencompany/db/infisical-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineAuthService } from "./engine-auth";
import type { RunnerClient } from "./runner-client";

beforeEach(() => {
  vi.clearAllMocks();
});

vi.mock("@opencompany/db/claude-code-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadClaudeCodeAuthStatus: vi.fn(async () => null),
  saveClaudeCodeCredential: vi.fn(async () => ({ userWorkosId: "user_1" })),
  deleteClaudeCodeCredential: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/codex-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadCodexAuthStatus: vi.fn(async () => null),
  loadWorkspaceCodexEngineAccount: vi.fn(async () => null),
  setWorkspaceCodexEngineAccount: vi.fn(async () => null),
  disableWorkspaceCodexEngineAccount: vi.fn(async () => null),
  deleteCodexCredential: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/infisical-auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadInfisicalConnectionMetadata: vi.fn(async () => null),
  disconnectInfisicalConnection: vi.fn(async () => undefined),
}));

const admin: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: [],
  authenticationMethod: "session",
};
const member: Actor = { ...admin, role: "member" };

// The db handle is threaded verbatim into the persistence helpers; the service
// never reaches for a global client.
const dbSentinel = { sentinel: true } as never;

function fakeRunner(results: unknown[] = []) {
  let call = 0;
  const calls: { path: string; body: Record<string, unknown>; options: unknown }[] = [];
  const runner: RunnerClient = {
    requestJson: vi.fn(async () => {
      throw new Error("Unexpected generic runner call.");
    }) as RunnerClient["requestJson"],
    postJson: vi.fn(async (path, body, options) => {
      calls.push({ path, body, options });
      const result = results[call++];
      if (result instanceof Error) throw result;
      if (result === undefined) throw new Error("Unexpected runner call.");
      return result as never;
    }) as RunnerClient["postJson"],
  };
  return { runner, calls };
}

function service(runner?: RunnerClient) {
  return createEngineAuthService({
    db: dbSentinel,
    runner: runner ?? fakeRunner().runner,
  });
}

const codexFlow = {
  id: "gcodf_1",
  status: "code_ready" as const,
  userCode: "ABCD-1234",
  verificationUri: "https://auth.example.com/device",
  statusReason: null,
  expiresAt: "2026-08-13T09:15:00.000Z",
};

const infisicalFlow = {
  id: "ginff_1",
  status: "link_ready" as const,
  loginUrl: "https://app.infisical.com/login?flow=1",
  statusReason: null,
  expiresAt: "2026-08-13T09:15:00.000Z",
};

describe("engine auth service", () => {
  it("maps missing credentials to the retired null status DTO", async () => {
    await expect(service().getClaudeCodeStatus(member)).resolves.toEqual({
      status: null,
      statusReason: null,
      lastValidatedAt: null,
      lastRotatedAt: null,
    });
    expect(loadClaudeCodeAuthStatus).toHaveBeenCalledWith({
      db: dbSentinel,
      userWorkosId: "user_1",
    });
  });

  it("admin-gates and persists the workspace Codex engine designation", async () => {
    await expect(service().setCodexWorkspaceEngine(member, true)).rejects.toMatchObject({
      status: 403,
      message: "Only workspace admins can manage subscription-backed models.",
    });
    expect(setWorkspaceCodexEngineAccount).not.toHaveBeenCalled();

    await service().setCodexWorkspaceEngine(admin, true);
    expect(setWorkspaceCodexEngineAccount).toHaveBeenCalledWith({
      db: dbSentinel,
      workspaceId: "workspace_1",
      providerUserWorkosId: "user_1",
      updatedByWorkosId: "user_1",
    });
    await service().setCodexWorkspaceEngine(admin, false);
    expect(disableWorkspaceCodexEngineAccount).toHaveBeenCalledWith({
      db: dbSentinel,
      workspaceId: "workspace_1",
      updatedByWorkosId: "user_1",
    });
    expect(loadWorkspaceCodexEngineAccount).toHaveBeenCalled();
  });

  it("serializes credential status rows to ISO strings", async () => {
    vi.mocked(loadCodexAuthStatus).mockResolvedValueOnce({
      status: "needs_reauth",
      statusReason: "Token expired.",
      lastValidatedAt: new Date("2026-08-01T00:00:00.000Z"),
      lastRotatedAt: null,
    });
    await expect(service().getCodexStatus(member)).resolves.toEqual({
      status: "needs_reauth",
      statusReason: "Token expired.",
      lastValidatedAt: "2026-08-01T00:00:00.000Z",
      lastRotatedAt: null,
      workspaceEngine: null,
    });
    expect(loadCodexAuthStatus).toHaveBeenCalledWith({
      db: dbSentinel,
      userWorkosId: "user_1",
    });
  });

  it("keeps the retired validator copy for malformed Claude Code tokens", async () => {
    await expect(service().saveClaudeCodeToken(member, "   ")).rejects.toMatchObject({
      status: 400,
      message: "Paste the token printed by `claude setup-token`.",
    });
    await expect(service().saveClaudeCodeToken(member, "sk-ant-api03-nope")).rejects.toMatchObject({
      status: 400,
      message: "That doesn't look like a Claude Code token (expected it to start with sk-ant-oat).",
    });
    expect(saveClaudeCodeCredential).not.toHaveBeenCalled();
  });

  it("persists a normalized Claude Code token with an unvalidated status", async () => {
    const token = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";
    vi.mocked(loadClaudeCodeAuthStatus).mockResolvedValueOnce({
      status: "connected",
      statusReason: null,
      lastValidatedAt: null,
      lastRotatedAt: new Date("2026-08-13T09:00:00.000Z"),
    });
    await expect(service().saveClaudeCodeToken(member, `  ${token}\n`)).resolves.toMatchObject({
      status: "connected",
      lastValidatedAt: null,
    });
    expect(saveClaudeCodeCredential).toHaveBeenCalledWith({
      db: dbSentinel,
      userWorkosId: "user_1",
      authJson: { token },
      validatedAt: null,
    });
  });

  it("disconnects Claude Code and Codex through the threaded db handle", async () => {
    await expect(service().disconnectClaudeCode(member)).resolves.toBeUndefined();
    expect(deleteClaudeCodeCredential).toHaveBeenCalledWith({
      db: dbSentinel,
      userWorkosId: "user_1",
    });
    await expect(service().disconnectCodex(member)).resolves.toBeUndefined();
    expect(deleteCodexCredential).toHaveBeenCalledWith({
      db: dbSentinel,
      userWorkosId: "user_1",
    });
  });

  it("starts a Codex device flow through the runner control route", async () => {
    const { runner, calls } = fakeRunner([{ ok: true, flow: codexFlow }]);
    await expect(service(runner).startCodexDeviceAuth(member)).resolves.toEqual(codexFlow);
    expect(calls).toEqual([
      {
        path: "/internal/goat/codex-auth/device/start",
        body: { userWorkosId: "user_1" },
        options: { errorFormat: "status-text" },
      },
    ]);
  });

  it("requires a flow id and URL-encodes it for Codex polls", async () => {
    await expect(service().pollCodexDeviceAuth(member, "   ")).rejects.toMatchObject({
      status: 400,
      message: "Codex auth flow is required.",
    });

    const { runner, calls } = fakeRunner([{ ok: true, flow: codexFlow }]);
    await service(runner).pollCodexDeviceAuth(member, " flow/1 ");
    expect(calls[0]?.path).toBe("/internal/goat/codex-auth/device/flow%2F1/poll");
  });

  it("surfaces Codex runner failures with the retired message copy", async () => {
    const { runner } = fakeRunner([new Error("Runner request failed with 502: bad gateway")]);
    await expect(service(runner).startCodexDeviceAuth(member)).rejects.toMatchObject({
      status: 503,
      message: "Runner request failed with 502: bad gateway",
    });
  });

  it("admin-gates every Infisical mutation with the retired copy", async () => {
    const forbidden = {
      status: 403,
      message: "Only workspace admins can manage Infisical.",
    };
    await expect(
      service().startInfisicalAuth(member, "https://app.infisical.com"),
    ).rejects.toMatchObject(forbidden);
    await expect(service().completeInfisicalAuth(member, "ginff_1", "token")).rejects.toMatchObject(
      forbidden,
    );
    await expect(service().disconnectInfisical(member)).rejects.toMatchObject(forbidden);
    expect(disconnectInfisicalConnection).not.toHaveBeenCalled();
  });

  it("keeps the Infisical status read member-visible", async () => {
    vi.mocked(loadInfisicalConnectionMetadata).mockResolvedValueOnce({
      status: "connected",
      statusReason: null,
      accountEmail: "ops@example.com",
      host: "https://eu.infisical.com",
      lastValidatedAt: new Date("2026-08-12T08:00:00.000Z"),
    } as never);
    await expect(service().getInfisicalStatus(member)).resolves.toEqual({
      status: "connected",
      statusReason: null,
      accountEmail: "ops@example.com",
      host: "https://eu.infisical.com",
      lastValidatedAt: "2026-08-12T08:00:00.000Z",
    });
    expect(loadInfisicalConnectionMetadata).toHaveBeenCalledWith({
      db: dbSentinel,
      workspaceId: "workspace_1",
    });
  });

  it("validates the Infisical host with the retired copy", async () => {
    await expect(
      service().startInfisicalAuth(admin, "https://evil.example.com"),
    ).rejects.toMatchObject({
      status: 400,
      message: "Choose a supported Infisical region.",
    });
  });

  it("starts an Infisical flow and rejects host mismatches from the runner", async () => {
    const { runner, calls } = fakeRunner([{ ok: true, flow: infisicalFlow }]);
    await expect(
      service(runner).startInfisicalAuth(admin, "https://app.infisical.com"),
    ).resolves.toEqual(infisicalFlow);
    expect(calls).toEqual([
      {
        path: "/internal/goat/infisical-auth/start",
        body: {
          workspaceId: "workspace_1",
          requestedByWorkosId: "user_1",
          host: "https://app.infisical.com",
        },
        options: { errorFormat: "error-message" },
      },
    ]);

    const mismatched = fakeRunner([{ ok: true, flow: infisicalFlow }]);
    await expect(
      service(mismatched.runner).startInfisicalAuth(admin, "https://eu.infisical.com"),
    ).rejects.toMatchObject({
      status: 503,
      message: "The selected Infisical region is still updating. Please try again in a minute.",
    });
  });

  it("requires the pasted browser token and trims it before the runner call", async () => {
    await expect(service().completeInfisicalAuth(admin, "ginff_1", "   ")).rejects.toMatchObject({
      status: 400,
      message: "Paste the browser token from Infisical.",
    });

    const completedFlow = { ...infisicalFlow, status: "completed" as const, loginUrl: null };
    const { runner, calls } = fakeRunner([{ ok: true, flow: completedFlow }]);
    await expect(
      service(runner).completeInfisicalAuth(admin, " ginff_1 ", " browser-token "),
    ).resolves.toEqual(completedFlow);
    expect(calls).toEqual([
      {
        path: "/internal/goat/infisical-auth/ginff_1/complete",
        body: {
          workspaceId: "workspace_1",
          requestedByWorkosId: "user_1",
          browserToken: "browser-token",
        },
        options: { errorFormat: "error-message" },
      },
    ]);
  });

  it("surfaces Infisical runner failures with the runner's error copy", async () => {
    const { runner } = fakeRunner([new Error("That login link expired.")]);
    await expect(
      service(runner).completeInfisicalAuth(admin, "ginff_1", "browser-token"),
    ).rejects.toMatchObject({ status: 503, message: "That login link expired." });
  });

  it("disconnects Infisical through the threaded db handle", async () => {
    await expect(service().disconnectInfisical(admin)).resolves.toBeUndefined();
    expect(disconnectInfisicalConnection).toHaveBeenCalledWith({
      db: dbSentinel,
      workspaceId: "workspace_1",
    });
  });
});
