import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOPPLER_AUTH_BUNDLE_FORMAT_VERSION,
  disconnectDopplerConnection,
  loadDopplerConnection,
  saveDopplerConnection,
} from "./doppler-auth";

describe("opencompany Doppler credentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("encrypts a workspace-bound auth bundle and decrypts it for that workspace", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    const now = new Date("2026-08-05T16:00:00.000Z");
    let stored: Record<string, unknown> | null = null;
    const insertDb = {
      ...selectDbReturning({ enabled: true }),
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => {
          stored = value;
          return {
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn(async () => [
                {
                  workspaceId: "workspace_1",
                  credentialGeneration: value.credentialGeneration,
                },
              ]),
            })),
          };
        }),
      })),
    };
    const bundle = {
      formatVersion: DOPPLER_AUTH_BUNDLE_FORMAT_VERSION,
      token: "dp.ct.test_token",
    };

    await saveDopplerConnection({
      userId: "user_1",
      db: insertDb as never,
      workspaceId: "workspace_1",
      authBundle: bundle,
      accountName: "founder@example.com",
      cliVersion: "3.76.5",
      connectedByWorkosId: "user_1",
      now,
    });
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain("dp.ct.test_token");

    const row = {
      ...(stored as unknown as Record<string, unknown>),
      workspaceId: "workspace_1",
      statusReason: null,
      expiresAt: null,
      lastValidatedAt: now,
      lastRotatedAt: now,
      updatedAt: now,
    };
    const selectDb = selectDbReturning(row);
    await expect(
      loadDopplerConnection({
        userId: "user_1",
        db: selectDb as never,
        workspaceId: "workspace_1",
      }),
    ).resolves.toMatchObject({ authBundle: bundle, status: "connected" });

    await expect(
      loadDopplerConnection({
        userId: "user_2",
        db: selectDbReturning(row) as never,
        workspaceId: "workspace_1",
      }),
    ).rejects.toThrow("Doppler credential could not be decrypted.");

    const copiedToOtherWorkspace = selectDbReturning({ ...row, workspaceId: "workspace_2" });
    await expect(
      loadDopplerConnection({
        userId: "user_1",
        db: copiedToOtherWorkspace as never,
        workspaceId: "workspace_2",
      }),
    ).rejects.toThrow("Doppler credential could not be decrypted.");
  });

  it("disconnects with a new generation and removes encrypted material", async () => {
    const values = vi.fn(() => ({
      onConflictDoUpdate: vi.fn(async () => undefined),
    }));
    const db = { ...selectDbReturning({ enabled: true }), insert: vi.fn(() => ({ values })) };

    const result = await disconnectDopplerConnection({
      userId: "user_1",
      db: db as never,
      workspaceId: "workspace_1",
    });

    expect(result.credentialGeneration).toBeTypeOf("string");
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        encryptedAuthBundle: null,
        encryptionKeyVersion: null,
        status: "disconnected",
        credentialGeneration: result.credentialGeneration,
      }),
    );
  });
});

function selectDbReturning(row: Record<string, unknown>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [row]),
        })),
      })),
    })),
  };
}
