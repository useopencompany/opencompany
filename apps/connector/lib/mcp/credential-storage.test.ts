import type { WorkspaceIntegrationCredentialEncryptedPayload } from "@opencompany/db/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteConnectorMcpCredential,
  loadConnectorMcpCredential,
  saveConnectorMcpCredential,
} from "./credential-storage";

const credentialContext = {
  organizationId: "corg_123",
  serverId: "cmcps_linear",
  kind: "oauth",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("connector MCP credential storage", () => {
  it("round-trips encrypted OAuth payloads without storing plaintext", async () => {
    vi.stubEnv("CONNECTOR_CREDENTIAL_ENCRYPTION_KEY", credentialKey(1));
    const { db, rows } = createCredentialDb();

    await saveConnectorMcpCredential({
      ...credentialContext,
      payload: { tokens: { access_token: "lin_secret", token_type: "Bearer" } },
      db,
    });

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("lin_secret");
    expect(rows[0]?.encryptedPayload).toEqual(
      expect.objectContaining({
        algorithm: "aes-256-gcm",
        iv: expect.any(String),
        ciphertext: expect.any(String),
        authTag: expect.any(String),
      }),
    );

    await expect(loadConnectorMcpCredential({ ...credentialContext, db })).resolves.toEqual(
      expect.objectContaining({
        payload: { tokens: { access_token: "lin_secret", token_type: "Bearer" } },
      }),
    );
  });

  it("deletes a credential row by organization, server, and kind", async () => {
    vi.stubEnv("CONNECTOR_CREDENTIAL_ENCRYPTION_KEY", credentialKey(1));
    const { db, rows } = createCredentialDb();

    await saveConnectorMcpCredential({
      ...credentialContext,
      payload: { tokens: { access_token: "lin_secret", token_type: "Bearer" } },
      db,
    });
    await deleteConnectorMcpCredential({ ...credentialContext, db });

    expect(rows).toHaveLength(0);
  });

  it("surfaces missing connector encryption key configuration", async () => {
    vi.stubEnv("CONNECTOR_CREDENTIAL_ENCRYPTION_KEY", credentialKey(1));
    const { db } = createCredentialDb();

    await saveConnectorMcpCredential({
      ...credentialContext,
      payload: { tokens: { access_token: "lin_secret", token_type: "Bearer" } },
      db,
    });
    vi.stubEnv("CONNECTOR_CREDENTIAL_ENCRYPTION_KEY", "");

    await expect(loadConnectorMcpCredential({ ...credentialContext, db })).rejects.toThrow(
      "CONNECTOR_CREDENTIAL_ENCRYPTION_KEY is required.",
    );
  });
});

type StoredConnectorCredentialRow = {
  id: string;
  organizationId: string;
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
  const rows: StoredConnectorCredentialRow[] = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Omit<StoredConnectorCredentialRow, "createdAt">) => ({
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

function toSelectedCredential(row: StoredConnectorCredentialRow) {
  return {
    organizationId: row.organizationId,
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
