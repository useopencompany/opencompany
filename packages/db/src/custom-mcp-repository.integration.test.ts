import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Actor, PluginGatewayDiscoveredTool } from "@opencompany/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { actionApprovalInputHash } from "./action-governance";
import { customMcpToolsFingerprint, PostgresCustomMcpRepository } from "./custom-mcp-repository";
import { integrationCredentials, integrations } from "./product-schema";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["skill:read", "skill:write"],
  authenticationMethod: "session",
};
const teammate = { ...actor, userId: "user_2" };
const anotherWorkspace = { ...actor, workspaceId: "workspace_2" };
const canary = "synthetic-credential-canary";
const tool: PluginGatewayDiscoveredTool = {
  name: "send",
  description: "Send",
  inputSchema: { type: "object" },
  classification: {
    capabilityId: "write",
    capabilityLabel: "Write",
    defaultMode: "ask",
    bucket: "write",
    curated: false,
  },
};
const probe = (tools = [tool]) => ({ tools, fingerprint: customMcpToolsFingerprint(tools) });

describe("personal custom MCP account persistence", () => {
  let database: PGlite;
  let db: ReturnType<typeof drizzle>;
  let repository: PostgresCustomMcpRepository;
  beforeAll(async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    database = new PGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);
      CREATE TABLE goat.workspaces (id text PRIMARY KEY);
      INSERT INTO goat.users VALUES ('user_1'), ('user_2');
      INSERT INTO goat.workspaces VALUES ('workspace_1'), ('workspace_2');
      CREATE TABLE goat.integrations (
        id text PRIMARY KEY, user_workos_id text NOT NULL REFERENCES goat.users, workspace_id text REFERENCES goat.workspaces,
        shared_with_workspace boolean NOT NULL DEFAULT false, provider text NOT NULL, external_id text NOT NULL,
        connection_label text, account_name text, account_email text, account_type text, status text NOT NULL DEFAULT 'connected', status_reason text,
        scopes jsonb NOT NULL DEFAULT '[]', capability_modes jsonb NOT NULL DEFAULT '{}', tool_modes jsonb NOT NULL DEFAULT '{}',
        last_synced_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT goat_integrations_provider_check CHECK (provider <> 'custom_mcp'), UNIQUE (id, user_workos_id, provider)
      );
      CREATE UNIQUE INDEX goat_integrations_user_provider_external_idx ON goat.integrations (user_workos_id, provider, external_id) WHERE workspace_id IS NULL;
      CREATE TABLE goat.integration_credentials (
        id text PRIMARY KEY, user_workos_id text NOT NULL, integration_id text NOT NULL, provider text NOT NULL, kind text NOT NULL,
        encrypted_payload jsonb NOT NULL, encryption_key_version integer NOT NULL, expires_at timestamptz, last_rotated_at timestamptz,
        refresh_lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT goat_integration_credentials_provider_check CHECK (provider <> 'custom_mcp'), UNIQUE (integration_id, kind),
        FOREIGN KEY (integration_id, user_workos_id, provider) REFERENCES goat.integrations (id, user_workos_id, provider) ON DELETE CASCADE
      );
      CREATE TABLE goat.integration_resources (provider text NOT NULL, CONSTRAINT goat_integration_resources_provider_check CHECK (provider <> 'custom_mcp'));
      CREATE TABLE goat.plugins (
        id text PRIMARY KEY, workspace_id text NOT NULL, name text NOT NULL, source_type text NOT NULL, status text NOT NULL DEFAULT 'enabled',
        source_ref text NOT NULL DEFAULT '', source_path text NOT NULL DEFAULT '', resolved_commit text NOT NULL DEFAULT '',
        CONSTRAINT plugins_source_type_check CHECK (source_type IN ('github', 'skills.sh')),
        CONSTRAINT plugins_commit_check CHECK (resolved_commit ~ '^[0-9a-f]{40}$')
      );
    `);
    const migration = await readFile(
      new URL("../../../drizzle/0259_custom_mcp_plugins.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await database.exec(statement);
    db = drizzle(database);
    repository = new PostgresCustomMcpRepository(db);
  });
  beforeEach(async () => {
    await database.exec(`DELETE FROM goat.integrations; DELETE FROM goat.plugins;
      INSERT INTO goat.plugins (id, workspace_id, name, source_type) VALUES ('plugin_1','workspace_1','custom-test','custom_mcp'), ('plugin_2','workspace_2','custom-test','custom_mcp');`);
  });
  afterAll(async () => {
    await database.close();
    vi.unstubAllEnvs();
  });

  it("encrypts headers and isolates members and workspaces even with identical plugin names", async () => {
    const first = await repository.save(actor, "custom-test", {
      ...probe(),
      headers: { authorization: `Bearer ${canary}` },
    });
    expect(await repository.account(teammate, "custom-test")).toBeNull();
    expect(await repository.account(anotherWorkspace, "custom-test")).toBeNull();
    await expect(repository.credentials(teammate, "custom-test", first.revision)).rejects.toThrow(
      "own account",
    );
    expect(await repository.credentials(actor, "custom-test", first.revision)).toEqual({
      headers: { authorization: `Bearer ${canary}` },
    });
    const vault = await db.select().from(integrationCredentials);
    expect(JSON.stringify(vault)).not.toContain(canary);
    expect(JSON.stringify(first)).not.toContain(canary);
    const second = await repository.save(teammate, "custom-test", {
      ...probe([{ ...tool, name: "private_tool" }]),
      headers: {},
    });
    expect(second.integrationId).not.toBe(first.integrationId);
    expect((await repository.account(actor, "custom-test"))?.tools).toEqual([tool]);
  });

  it("retains permissions for unchanged tools, resets changed grants, and keeps Off", async () => {
    const first = await repository.save(actor, "custom-test", {
      ...probe([tool, { ...tool, name: "blocked" }]),
      headers: {},
    });
    await repository.setToolMode(actor, "custom-test", {
      tool: "send",
      mode: "on",
      revision: first.revision,
    });
    await repository.setToolMode(actor, "custom-test", {
      tool: "blocked",
      mode: "off",
      revision: (await repository.account(actor, "custom-test"))!.revision,
    });
    const reviewed = (await repository.account(actor, "custom-test"))!;
    const unchanged = await repository.refresh(
      actor,
      "custom-test",
      reviewed.revision,
      probe([tool, { ...tool, name: "blocked" }]),
    );
    expect(unchanged.revision).toBe(reviewed.revision);
    expect(unchanged.toolModes.send).toBe("on");
    const changed = await repository.refresh(
      actor,
      "custom-test",
      reviewed.revision,
      probe([
        { ...tool, description: "Now sends to everyone" },
        { ...tool, name: "blocked", description: "Changed" },
        { ...tool, name: "new_tool" },
      ]),
    );
    expect(changed.toolModes).toEqual({ blocked: "off" });
    expect(changed.revision).not.toBe(first.revision);
    await expect(
      repository.setToolMode(actor, "custom-test", {
        tool: "send",
        mode: "on",
        revision: first.revision,
      }),
    ).rejects.toThrow("changed");
    expect(actionApprovalInputHash({ body: "hello" }, first.revision)).not.toBe(
      actionApprovalInputHash({ body: "hello" }, changed.revision),
    );
  });

  it("revokes stale credentials and standing grants on rotation", async () => {
    const first = await repository.save(actor, "custom-test", {
      ...probe(),
      headers: { authorization: canary },
    });
    await repository.setToolMode(actor, "custom-test", {
      tool: "send",
      mode: "on",
      revision: first.revision,
    });
    const rotated = await repository.save(actor, "custom-test", { ...probe(), headers: {} });
    expect(rotated.toolModes).toEqual({});
    expect(rotated.revision).not.toBe(first.revision);
    await expect(repository.credentials(actor, "custom-test", first.revision)).rejects.toThrow(
      "changed",
    );
  });

  it("surfaces runtime failure and prevents an old failure from poisoning a rotated account", async () => {
    const first = await repository.save(actor, "custom-test", { ...probe(), headers: {} });
    await repository.recordFailure(actor, "custom-test", first.revision, "Server unavailable");
    expect(await repository.account(actor, "custom-test")).toMatchObject({
      connected: false,
      error: "Server unavailable",
    });
    const recovered = await repository.refresh(actor, "custom-test", first.revision, probe());
    expect(recovered).toMatchObject({ connected: true, error: null });
    expect(recovered.revision).not.toBe(first.revision);
    await repository.recordFailure(actor, "custom-test", first.revision, "Stale error");
    expect((await repository.account(actor, "custom-test"))?.error).toBeNull();
  });

  it("disconnects only the acting member and physically deletes their credentials", async () => {
    const first = await repository.save(actor, "custom-test", { ...probe(), headers: {} });
    await repository.save(teammate, "custom-test", { ...probe(), headers: {} });
    await repository.disconnect(actor, "custom-test");
    expect(await repository.account(actor, "custom-test")).toBeNull();
    expect((await repository.account(teammate, "custom-test"))?.connected).toBe(true);
    expect(
      await db
        .select()
        .from(integrationCredentials)
        .where(eq(integrationCredentials.integrationId, first.integrationId)),
    ).toEqual([]);
    expect(
      (await db.select().from(integrations).where(eq(integrations.id, first.integrationId)))[0]
        ?.status,
    ).toBe("disconnected");
    await repository.disconnect(actor, "custom-test");
  });

  it("does not resurrect an account when its plugin is disabled or removed during setup", async () => {
    await database.exec("UPDATE goat.plugins SET status = 'disabled' WHERE id = 'plugin_1'");
    await expect(
      repository.save(actor, "custom-test", { ...probe(), headers: {} }),
    ).rejects.toThrow("disabled or removed");
    expect(await db.select().from(integrationCredentials)).toEqual([]);
  });
});
