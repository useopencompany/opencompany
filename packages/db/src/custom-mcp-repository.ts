import { createHash, randomUUID } from "node:crypto";
import {
  type Actor,
  CoreError,
  type CustomMcpAccount,
  type CustomMcpCredentials,
  type CustomMcpProbe,
  type CustomMcpRepository,
  type CustomMcpToolMode,
  type PluginGatewayDiscoveredTool,
} from "@opencompany/core";
import { and, eq, isNull } from "drizzle-orm";
import { loadIntegrationCredential, saveIntegrationCredential } from "./integrations";
import { customMcpAccounts, integrationCredentials, integrations, plugins } from "./product-schema";

type DbLike = any;
type Identity = Pick<Actor, "userId" | "workspaceId">;

export function customMcpToolFingerprint(tool: PluginGatewayDiscoveredTool): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(tool)))
    .digest("hex");
}
export function customMcpToolsFingerprint(tools: PluginGatewayDiscoveredTool[]): string {
  return createHash("sha256")
    .update(tools.map(customMcpToolFingerprint).sort().join("\n"))
    .digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

export class PostgresCustomMcpRepository implements CustomMcpRepository {
  constructor(private readonly db: DbLike) {}

  async account(actor: Identity, name: string): Promise<CustomMcpAccount | null> {
    const [row] = await this.db
      .select({
        integrationId: customMcpAccounts.integrationId,
        revision: customMcpAccounts.revision,
        status: integrations.status,
        tools: customMcpAccounts.tools,
        toolModes: integrations.toolModes,
        checkedAt: customMcpAccounts.checkedAt,
        error: customMcpAccounts.error,
      })
      .from(customMcpAccounts)
      .innerJoin(
        integrations,
        and(
          eq(integrations.id, customMcpAccounts.integrationId),
          eq(integrations.userWorkosId, customMcpAccounts.userWorkosId),
          eq(integrations.provider, "custom_mcp"),
          isNull(integrations.workspaceId),
        ),
      )
      .where(owner(actor, name))
      .limit(1);
    if (!row || row.status === "disconnected") return null;
    return {
      integrationId: row.integrationId,
      revision: row.revision,
      connected: row.status === "connected" && !row.error,
      tools: row.tools,
      toolModes: row.toolModes,
      checkedAt: row.checkedAt,
      error: row.error,
    };
  }

  async save(
    actor: Actor,
    name: string,
    input: CustomMcpCredentials & CustomMcpProbe,
  ): Promise<CustomMcpAccount> {
    await this.db.transaction(async (tx: DbLike) => {
      const active = await tx
        .select({ id: plugins.id })
        .from(plugins)
        .where(
          and(
            eq(plugins.workspaceId, actor.workspaceId),
            eq(plugins.name, name),
            eq(plugins.sourceType, "custom_mcp"),
            eq(plugins.status, "enabled"),
          ),
        )
        .for("share");
      if (!active.length)
        throw new CoreError(
          "conflict",
          "This custom plugin was disabled or removed. Start a new connection.",
        );
      const now = new Date();
      const [integration] = await tx
        .insert(integrations)
        .values({
          id: `gint_custom_${randomUUID()}`,
          userWorkosId: actor.userId,
          provider: "custom_mcp",
          externalId: `${actor.workspaceId}:${name}`,
          status: "connected",
          connectionLabel: name,
          accountName: "Your custom MCP account",
          toolModes: {},
        })
        .onConflictDoUpdate({
          target: [integrations.userWorkosId, integrations.provider, integrations.externalId],
          targetWhere: isNull(integrations.workspaceId),
          set: { status: "connected", statusReason: null, toolModes: {}, updatedAt: now },
        })
        .returning({ id: integrations.id });
      if (!integration) throw new CoreError("conflict", "Could not save your connection.");
      await saveIntegrationCredential({
        db: tx,
        userWorkosId: actor.userId,
        integrationId: integration.id,
        provider: "custom_mcp",
        kind: "api_key",
        payload: { headers: input.headers },
        now,
      });
      await tx
        .insert(customMcpAccounts)
        .values({
          integrationId: integration.id,
          workspaceId: actor.workspaceId,
          pluginName: name,
          userWorkosId: actor.userId,
          revision: randomUUID(),
          tools: input.tools,
          checkedAt: now,
          error: null,
        })
        .onConflictDoUpdate({
          target: customMcpAccounts.integrationId,
          set: { revision: randomUUID(), tools: input.tools, checkedAt: now, error: null },
        });
    });
    return this.requireAccount(actor, name);
  }

  async credentials(
    actor: Identity,
    name: string,
    revision: string,
  ): Promise<CustomMcpCredentials> {
    const account = await this.requireAccount(actor, name);
    requireRevision(account, revision);
    const credential = await loadIntegrationCredential({
      db: this.db,
      userWorkosId: actor.userId,
      integrationId: account.integrationId,
      provider: "custom_mcp",
      kind: "api_key",
    });
    if (
      !credential ||
      !credential.payload.headers ||
      typeof credential.payload.headers !== "object" ||
      Array.isArray(credential.payload.headers) ||
      Object.values(credential.payload.headers).some((value) => typeof value !== "string")
    ) {
      throw new CoreError("conflict", "Reconnect your custom MCP account in Plugins.");
    }
    // Rotation between the account lookup and vault read must not switch credentials mid-call.
    requireRevision(await this.requireAccount(actor, name), revision);
    return { headers: credential.payload.headers as Record<string, string> };
  }

  async refresh(
    actor: Actor,
    name: string,
    revision: string,
    input: CustomMcpProbe | { error: string },
  ) {
    await this.db.transaction(async (tx: DbLike) => {
      await lockIntegration(tx, actor, name);
      const locked = await tx
        .select({ id: customMcpAccounts.integrationId })
        .from(customMcpAccounts)
        .where(and(owner(actor, name), eq(customMcpAccounts.revision, revision)))
        .for("update");
      if (!locked.length) throw changed();
      const repository = new PostgresCustomMcpRepository(tx);
      const current = await repository.requireAccount(actor, name);
      requireRevision(current, revision);
      const failed = "error" in input;
      const modes = failed
        ? current.toolModes
        : Object.fromEntries(
            Object.entries(current.toolModes).filter(([tool, mode]) => {
              if (mode === "off") return true;
              const before = current.tools.find((entry) => entry.name === tool);
              const after = input.tools.find((entry) => entry.name === tool);
              return (
                before &&
                after &&
                customMcpToolFingerprint(before) === customMcpToolFingerprint(after)
              );
            }),
          );
      await tx
        .update(integrations)
        .set({
          status: failed ? "sync_failed" : "connected",
          statusReason: failed ? input.error : null,
          toolModes: modes,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(integrations.id, current.integrationId),
            eq(integrations.userWorkosId, actor.userId),
          ),
        );
      await tx
        .update(customMcpAccounts)
        .set({
          checkedAt: new Date(),
          error: failed ? input.error : null,
          ...(!failed ? { tools: input.tools } : {}),
          revision:
            !failed &&
            current.connected &&
            customMcpToolsFingerprint(current.tools) === input.fingerprint
              ? revision
              : randomUUID(),
        })
        .where(owner(actor, name));
    });
    return this.requireAccount(actor, name);
  }

  async disconnect(actor: Actor, name: string) {
    await this.db.transaction(async (tx: DbLike) => {
      await lockIntegration(tx, actor, name);
      const [account] = await tx
        .select({ integrationId: customMcpAccounts.integrationId })
        .from(customMcpAccounts)
        .where(owner(actor, name))
        .for("update");
      if (!account) return;
      await tx
        .update(integrations)
        .set({ status: "disconnected", statusReason: null, toolModes: {}, updatedAt: new Date() })
        .where(
          and(
            eq(integrations.id, account.integrationId),
            eq(integrations.userWorkosId, actor.userId),
            eq(integrations.provider, "custom_mcp"),
            isNull(integrations.workspaceId),
          ),
        );
      await tx
        .delete(integrationCredentials)
        .where(
          and(
            eq(integrationCredentials.integrationId, account.integrationId),
            eq(integrationCredentials.userWorkosId, actor.userId),
            eq(integrationCredentials.provider, "custom_mcp"),
          ),
        );
      await tx.delete(customMcpAccounts).where(owner(actor, name));
    });
  }

  async recordFailure(actor: Identity, name: string, revision: string, error: string) {
    await this.db
      .update(customMcpAccounts)
      .set({ error: error.slice(0, 2000), checkedAt: new Date() })
      .where(and(owner(actor, name), eq(customMcpAccounts.revision, revision)));
  }

  async setToolMode(
    actor: Actor,
    name: string,
    input: { tool: string; mode: CustomMcpToolMode; revision: string },
  ) {
    await this.db.transaction(async (tx: DbLike) => {
      await lockIntegration(tx, actor, name);
      await tx
        .select({ id: customMcpAccounts.integrationId })
        .from(customMcpAccounts)
        .where(owner(actor, name))
        .for("update");
      const current = await new PostgresCustomMcpRepository(tx).requireAccount(actor, name);
      requireRevision(current, input.revision);
      if (
        !current.tools.some((tool) => tool.name === input.tool) ||
        !["on", "ask", "off"].includes(input.mode)
      )
        throw new CoreError("invalid_argument", "Choose an available tool and permission mode.");
      await tx
        .update(integrations)
        .set({
          toolModes: { ...current.toolModes, [input.tool]: input.mode },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(integrations.id, current.integrationId),
            eq(integrations.userWorkosId, actor.userId),
          ),
        );
      if ((current.toolModes[input.tool] ?? "ask") !== input.mode) {
        await tx
          .update(customMcpAccounts)
          .set({ revision: randomUUID() })
          .where(owner(actor, name));
      }
    });
  }

  private async requireAccount(actor: Identity, name: string) {
    const account = await this.account(actor, name);
    if (!account)
      throw new CoreError(
        "conflict",
        "Connect your own account in Plugins to use this MCP server.",
      );
    return account;
  }
}

function owner(actor: Identity, name: string) {
  return and(
    eq(customMcpAccounts.workspaceId, actor.workspaceId),
    eq(customMcpAccounts.pluginName, name),
    eq(customMcpAccounts.userWorkosId, actor.userId),
  );
}
function requireRevision(account: CustomMcpAccount, revision: string) {
  if (account.revision !== revision) throw changed();
}
function changed() {
  return new CoreError(
    "conflict",
    "This connection changed. Refresh its tools before trying again.",
  );
}

async function lockIntegration(tx: DbLike, actor: Identity, name: string) {
  await tx
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      and(
        eq(integrations.userWorkosId, actor.userId),
        eq(integrations.provider, "custom_mcp"),
        eq(integrations.externalId, `${actor.workspaceId}:${name}`),
        isNull(integrations.workspaceId),
      ),
    )
    .for("update");
}
