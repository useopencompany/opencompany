import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disconnectInfisicalConnection,
  INFISICAL_AUTH_BUNDLE_FORMAT_VERSION,
  INFISICAL_EU_HOST,
  INFISICAL_US_HOST,
  isInfisicalHost,
  isInfisicalSessionDomain,
  loadInfisicalConnection,
  saveInfisicalConnection,
} from "./infisical-auth";

describe("Infisical credentials", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("encrypts a workspace-bound auth bundle and decrypts it for that workspace", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    const now = new Date("2026-08-05T16:00:00.000Z");
    let stored: Record<string, unknown> | null = null;
    const insertDb = {
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
      formatVersion: INFISICAL_AUTH_BUNDLE_FORMAT_VERSION,
      files: [
        {
          path: ".infisical/infisical-config.json",
          contentsBase64: Buffer.from("config").toString("base64"),
          mode: 0o600,
        },
      ],
      redactionValues: ["signed.jwt.token"],
    };

    await saveInfisicalConnection({
      db: insertDb as never,
      workspaceId: "workspace_1",
      authBundle: bundle,
      host: INFISICAL_EU_HOST,
      accountEmail: "founder@example.com",
      cliVersion: "0.43.118",
      connectedByWorkosId: "user_1",
      now,
    });
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain("signed.jwt.token");
    expect(stored).toMatchObject({ host: INFISICAL_EU_HOST });

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
      loadInfisicalConnection({ db: selectDb as never, workspaceId: "workspace_1" }),
    ).resolves.toMatchObject({ authBundle: bundle, status: "connected" });

    const copiedToOtherWorkspace = selectDbReturning({ ...row, workspaceId: "workspace_2" });
    await expect(
      loadInfisicalConnection({
        db: copiedToOtherWorkspace as never,
        workspaceId: "workspace_2",
      }),
    ).rejects.toThrow("Infisical credential could not be decrypted.");
  });

  it("allows only the two Infisical Cloud hosts and matches their CLI session domains", () => {
    expect(isInfisicalHost(INFISICAL_US_HOST)).toBe(true);
    expect(isInfisicalHost(INFISICAL_EU_HOST)).toBe(true);
    expect(isInfisicalHost("https://evil.example")).toBe(false);

    expect(isInfisicalSessionDomain(INFISICAL_EU_HOST, INFISICAL_EU_HOST)).toBe(true);
    expect(isInfisicalSessionDomain(`${INFISICAL_EU_HOST}/api`, INFISICAL_EU_HOST)).toBe(true);
    expect(isInfisicalSessionDomain(INFISICAL_US_HOST, INFISICAL_EU_HOST)).toBe(false);
  });

  it("disconnects with a new generation and removes encrypted material", async () => {
    const values = vi.fn(() => ({
      onConflictDoUpdate: vi.fn(async () => undefined),
    }));
    const db = { insert: vi.fn(() => ({ values })) };

    const result = await disconnectInfisicalConnection({
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
