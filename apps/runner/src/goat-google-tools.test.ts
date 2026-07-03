import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";

const mocks = vi.hoisted(() => {
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "gint_gmail",
            accountEmail: "user@example.com",
            status: "connected",
          },
        ]),
      })),
    })),
  };
  return {
    db,
    getDb: vi.fn(() => db),
    loadGoatIntegrationCredential: vi.fn(),
    markGoatIntegrationStatus: vi.fn(),
    refreshGoatIntegrationCredential: vi.fn(),
  };
});

vi.mock("./db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@opencompany/db/goat-integrations", () => ({
  loadGoatIntegrationCredential: mocks.loadGoatIntegrationCredential,
  markGoatIntegrationStatus: mocks.markGoatIntegrationStatus,
  refreshGoatIntegrationCredential: mocks.refreshGoatIntegrationCredential,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("executeGoatGoogleTool", () => {
  it("refreshes expired Goat Google credentials with the runner pooled db", async () => {
    const { executeGoatGoogleTool } = await import("./goat-google-tools");
    mocks.loadGoatIntegrationCredential.mockResolvedValue({
      payload: {
        access_token: "expired-access-token",
        refresh_token: "refresh-token",
      },
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
      lastRotatedAt: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "fresh-access-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            threads: [{ id: "thread_1", snippet: "Latest message" }],
            resultSizeEstimate: 1,
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeGoatGoogleTool({
        name: "gmail_list_threads",
        args: { query: "in:inbox", maxResults: 1 },
        userWorkosId: "user_1",
        env: runnerEnv(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      threads: [{ id: "thread_1", snippet: "Latest message" }],
      resultSizeEstimate: 1,
    });

    expect(mocks.refreshGoatIntegrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        integrationId: "gint_gmail",
        provider: "gmail",
        kind: "oauth_token",
        db: mocks.db,
      }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("https://gmail.googleapis.com/gmail/v1/users/me/threads"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-access-token",
        }),
      }),
    );
  });
});

function runnerEnv(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: undefined,
    publicUrl: "https://runner.example.com",
    llmBrokerEnabled: true,
    integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
    exaApiKey: "exa",
    xApiBearerToken: undefined,
    supadataApiKey: undefined,
    ampApiKey: undefined,
    googleOAuthClientId: "google-client-id",
    googleOAuthClientSecret: "google-client-secret",
    e2bTemplate: undefined,
    ampE2bTemplate: undefined,
    codexE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    blobReadWriteToken: undefined,
    opencodeTimeoutMs: 1_200_000,
    codexTimeoutMs: 1_200_000,
    codexModel: "gpt-5.5",
    toolArgRepairEnabled: false,
    jobLeaseTtlMs: 300_000,
    jobMaxLeaseBusyAttempts: 10,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner_1",
    ...overrides,
  };
}
