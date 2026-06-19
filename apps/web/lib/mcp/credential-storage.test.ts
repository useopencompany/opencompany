import type { WorkspaceIntegrationCredentialEncryptedPayload } from "@opencompany/db/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteMcpCredential,
  loadMcpCredential,
  saveMcpCredential,
} from "@/lib/mcp/credential-storage";

const credentialContext = {
  workspaceId: "wks_123",
  serverId: "wmcps_123",
  kind: "bearer_token",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MCP credential storage", () => {
  it("round-trips encrypted bearer tokens without storing plaintext", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", credentialKey(1));
    const { db, rows } = createCredentialDb();

    await saveMcpCredential({
      ...credentialContext,
      bearerToken: "lin_api_secret",
      db,
    });

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("lin_api_secret");
    expect(rows[0]?.encryptedPayload).toEqual(
      expect.objectContaining({
        algorithm: "aes-256-gcm",
        iv: expect.any(String),
        ciphertext: expect.any(String),
        authTag: expect.any(String),
      }),
    );

    await expect(loadMcpCredential({ ...credentialContext, db })).resolves.toEqual(
      expect.objectContaining({
        bearerToken: "lin_api_secret",
        payload: { bearerToken: "lin_api_secret" },
      }),
    );
  });

  it("deletes a credential row by context", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", credentialKey(1));
    const { db, rows } = createCredentialDb();

    await saveMcpCredential({ ...credentialContext, bearerToken: "lin_api_secret", db });
    await deleteMcpCredential({ ...credentialContext, db });

    expect(rows).toHaveLength(0);
  });

  it("surfaces missing encryption key configuration instead of masking it as decrypt failure", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", credentialKey(1));
    const { db } = createCredentialDb();

    await saveMcpCredential({ ...credentialContext, bearerToken: "lin_api_secret", db });
    vi.unstubAllEnvs();

    await expect(loadMcpCredential({ ...credentialContext, db })).rejects.toThrow(
      "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY is required.",
    );
  });
});

type StoredCredentialRow = {
  id: string;
  workspaceId: string;
  serverId: string;
  kind: string;
  accountKey: string;
  externalAccountId: string | null;
  accountLabel: string | null;
  accountEmail: string | null;
  connectedByUserId: string | null;
  encryptedPayload: WorkspaceIntegrationCredentialEncryptedPayload;
  encryptionKeyVersion: number;
  expiresAt: Date | null;
  lastRotatedAt: Date | null;
  metadata: Record<string, unknown>;
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
              (row) =>
                row.serverId === values.serverId &&
                row.kind === values.kind &&
                row.accountKey === values.accountKey,
            );
            if (existing) {
              Object.assign(existing, set);
              return [{ id: existing.id }];
            }

            rows.push({
              ...values,
              accountKey: values.accountKey ?? "default",
              externalAccountId: values.externalAccountId ?? null,
              accountLabel: values.accountLabel ?? null,
              accountEmail: values.accountEmail ?? null,
              connectedByUserId: values.connectedByUserId ?? null,
              expiresAt: values.expiresAt ?? null,
              lastRotatedAt: values.lastRotatedAt ?? null,
              metadata: values.metadata ?? {},
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
            });
            return [{ id: values.id }];
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

function toSelectedCredential(row: StoredCredentialRow) {
  return {
    workspaceId: row.workspaceId,
    serverId: row.serverId,
    kind: row.kind,
    accountKey: row.accountKey,
    externalAccountId: row.externalAccountId,
    accountLabel: row.accountLabel,
    accountEmail: row.accountEmail,
    connectedByUserId: row.connectedByUserId,
    encryptedPayload: row.encryptedPayload,
    encryptionKeyVersion: row.encryptionKeyVersion,
    expiresAt: row.expiresAt,
    lastRotatedAt: row.lastRotatedAt,
    updatedAt: row.updatedAt,
    metadata: row.metadata,
  };
}

function credentialKey(fill: number) {
  return Buffer.alloc(32, fill).toString("base64");
}
