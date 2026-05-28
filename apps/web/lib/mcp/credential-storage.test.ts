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
});

type StoredCredentialRow = {
  id: string;
  workspaceId: string;
  serverId: string;
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
              (row) => row.serverId === values.serverId && row.kind === values.kind,
            );
            if (existing) {
              Object.assign(existing, set);
              return [{ id: existing.id }];
            }

            rows.push({
              ...values,
              expiresAt: values.expiresAt ?? null,
              lastRotatedAt: values.lastRotatedAt ?? null,
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
