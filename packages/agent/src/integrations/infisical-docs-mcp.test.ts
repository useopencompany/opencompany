import type { InfisicalConnectionMetadata } from "@opencompany/db/infisical-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { sentinel: "db" },
  loadMetadata: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({ getDb: () => mocks.db }));
vi.mock("@opencompany/db/infisical-auth", () => ({
  loadInfisicalConnectionMetadata: mocks.loadMetadata,
}));

import {
  getInfisicalDocsMcpIntegrationState,
  loadInfisicalDocsMcpWorkerConnection,
} from "./infisical-docs-mcp";

const identity = { userWorkosId: "user_1", workspaceId: "workspace_1" };

function metadata(
  status: InfisicalConnectionMetadata["status"] = "connected",
): InfisicalConnectionMetadata {
  return {
    workspaceId: identity.workspaceId,
    credentialGeneration: "generation_1",
    status,
    statusReason: null,
    host: "https://app.infisical.com",
    accountEmail: "developer@example.com",
    cliVersion: "0.43.118",
    bundleFormatVersion: 1,
    expiresAt: null,
    connectedByWorkosId: identity.userWorkosId,
    lastValidatedAt: new Date("2026-09-02T00:00:00.000Z"),
    lastRotatedAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadMetadata.mockResolvedValue(metadata());
});

describe("Infisical docs MCP connection", () => {
  it("gates the public docs endpoint on connected workspace CLI metadata", async () => {
    await expect(getInfisicalDocsMcpIntegrationState(identity)).resolves.toEqual({
      connected: true,
      integrationId: "infisical:workspace_1:generation_1",
      capabilityModes: {},
      toolModes: {},
    });
    const authorizationRequired = vi.fn(() => {
      throw new Error("Authorization callback must not run for the public docs endpoint.");
    });
    const connection = await loadInfisicalDocsMcpWorkerConnection({
      ...identity,
      onAuthorizationRequired: authorizationRequired,
    });
    expect(connection).toMatchObject({
      ok: true,
      integrationId: "infisical:workspace_1:generation_1",
    });
    if (!connection.ok) throw new Error("Expected a usable Infisical docs connection.");
    expect(await connection.authProvider.tokens()).toBeUndefined();
    expect(authorizationRequired).not.toHaveBeenCalled();
    expect(mocks.loadMetadata).toHaveBeenCalledWith({
      db: mocks.db,
      workspaceId: identity.workspaceId,
    });
  });

  it.each([
    [null, "not_connected"],
    [metadata("disconnected"), "not_connected"],
    [metadata("needs_reauth"), "needs_reauth"],
  ] as const)("maps unusable CLI state to %s", async (row, reason) => {
    mocks.loadMetadata.mockResolvedValue(row);
    await expect(
      loadInfisicalDocsMcpWorkerConnection({
        ...identity,
        onAuthorizationRequired: () => {
          throw new Error("unexpected");
        },
      }),
    ).resolves.toEqual({ ok: false, reason });
    await expect(getInfisicalDocsMcpIntegrationState(identity)).resolves.toMatchObject({
      connected: false,
      integrationId: null,
    });
  });
});
