import type { WorkspaceIntegrationCredentialEncryptedPayload } from "@opencompany/db/schema";
import { workspaceIntegrations } from "@opencompany/db/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteIntegrationCredential,
  loadIntegrationCredential,
  markIntegrationCredentialRefreshFailed,
  saveIntegrationCredential,
} from "@/lib/integrations/credential-storage";

const credentialContext = {
  workspaceId: "wks_123",
  integrationId: "wint_123",
  provider: "github",
  kind: "oauth_token",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("integration credential storage", () => {
  it("round-trips encrypted credential payloads without storing plaintext", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", credentialKey(1));
    const { db, rows } = createCredentialDb();

    await saveIntegrationCredential({
      ...credentialContext,
      payload: {
        accessToken: "secret-access-token",
        refreshToken: "secret-refresh-token",
      },
      db,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("secret-access-token");
    expect(rows[0]?.encryptedPayload).toEqual(
      expect.objectContaining({
        algorithm: "aes-256-gcm",
        iv: expect.any(String),
        ciphertext: expect.any(String),
        authTag: expect.any(String),
      }),
    );

    const loaded = await loadIntegrationCredential({ ...credentialContext, db });

    expect(loaded?.payload).toEqual({
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
    });
  });

  it("rejects malformed encryption keys", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", "not-base64");
    const { db } = createCredentialDb();

    await expect(
      saveIntegrationCredential({
        ...credentialContext,
        payload: { accessToken: "secret-access-token" },
        db,
      }),
    ).rejects.toThrow(
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  });

  it("rejects credentials encrypted with another key", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", credentialKey(1));
    const { db } = createCredentialDb();

    await saveIntegrationCredential({
      ...credentialContext,
      payload: { accessToken: "secret-access-token" },
      db,
    });

    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", credentialKey(2));

    await expect(loadIntegrationCredential({ ...credentialContext, db })).rejects.toThrow(
      "Integration credential could not be decrypted.",
    );
  });

  it("binds ciphertext to the credential row context", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", credentialKey(1));
    const { db, rows } = createCredentialDb();

    await saveIntegrationCredential({
      ...credentialContext,
      payload: { accessToken: "secret-access-token" },
      db,
    });

    rows[0] = { ...rows[0]!, provider: "slack" };

    await expect(
      loadIntegrationCredential({ ...credentialContext, provider: "slack", db }),
    ).rejects.toThrow("Integration credential could not be decrypted.");
  });

  it("rejects credential rows that do not match the requested context", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", credentialKey(1));
    const { db, rows } = createCredentialDb();

    await saveIntegrationCredential({
      ...credentialContext,
      payload: { accessToken: "secret-access-token" },
      db,
    });

    rows[0] = { ...rows[0]!, workspaceId: "wks_other" };

    await expect(loadIntegrationCredential({ ...credentialContext, db })).rejects.toThrow(
      "Integration credential row did not match the requested context.",
    );
  });

  it("rejects unsupported credential key versions", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", credentialKey(1));
    const { db, rows } = createCredentialDb();

    await saveIntegrationCredential({
      ...credentialContext,
      payload: { accessToken: "secret-access-token" },
      db,
    });

    rows[0] = { ...rows[0]!, encryptionKeyVersion: 99 };

    await expect(loadIntegrationCredential({ ...credentialContext, db })).rejects.toThrow(
      "Unsupported integration credential encryption key version 99.",
    );
  });

  it("deletes a credential row by context", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", credentialKey(1));
    const { db, rows } = createCredentialDb();

    await saveIntegrationCredential({
      ...credentialContext,
      payload: { accessToken: "secret-access-token" },
      db,
    });
    await deleteIntegrationCredential({ ...credentialContext, db });

    expect(rows).toHaveLength(0);
  });

  it("marks refresh failures on the integration row with a sanitized reason", async () => {
    const set = vi.fn(() => ({ where: vi.fn() }));
    const db = {
      update: vi.fn(() => ({ set })),
    } as never;
    const now = new Date("2026-01-01T00:00:00.000Z");

    await markIntegrationCredentialRefreshFailed({
      workspaceId: "wks_123",
      integrationId: "wint_123",
      provider: "gmail",
      status: "needs_reauth",
      statusReason: "invalid\nrefresh\u0000token",
      db,
      now,
    });

    expect(db.update).toHaveBeenCalledWith(workspaceIntegrations);
    expect(set).toHaveBeenCalledWith({
      status: "needs_reauth",
      statusReason: "invalid refresh token",
      updatedAt: now,
    });
  });
});

type StoredCredentialRow = {
  id: string;
  workspaceId: string;
  integrationId: string;
  provider: string;
  kind: string;
  encryptedPayload: WorkspaceIntegrationCredentialEncryptedPayload;
  encryptionKeyVersion: number;
  expiresAt: Date | null;
  lastRotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function createCredentialDb() {
  const rows: StoredCredentialRow[] = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Omit<StoredCredentialRow, "createdAt">) => ({
        onConflictDoUpdate: vi.fn(({ set }) => ({
          returning: vi.fn(async () => {
            const existing = rows.find(
              (row) => row.integrationId === values.integrationId && row.kind === values.kind,
            );
            if (existing) {
              Object.assign(existing, set);
              return [toReturnedCredential(existing)];
            }

            const row = {
              ...values,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
            };
            rows.push(row);
            return [toReturnedCredential(row)];
          }),
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (rows[0] ? [toSelectedCredential(rows[0])] : [])),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => {
        rows.splice(0, rows.length);
      }),
    })),
  } as never;

  return { db, rows };
}

function toReturnedCredential(row: StoredCredentialRow) {
  return {
    id: row.id,
    expiresAt: row.expiresAt,
    lastRotatedAt: row.lastRotatedAt,
    updatedAt: row.updatedAt,
    encryptionKeyVersion: row.encryptionKeyVersion,
  };
}

function toSelectedCredential(row: StoredCredentialRow) {
  return {
    workspaceId: row.workspaceId,
    integrationId: row.integrationId,
    provider: row.provider,
    kind: row.kind,
    encryptedPayload: row.encryptedPayload,
    encryptionKeyVersion: row.encryptionKeyVersion,
    expiresAt: row.expiresAt,
    lastRotatedAt: row.lastRotatedAt,
    updatedAt: row.updatedAt,
  };
}

function credentialKey(fill: number) {
  return Buffer.alloc(32, fill).toString("base64");
}
