import {
  type Actor,
  actorHasPermission,
  SKILL_READ_PERMISSION,
  SKILL_WRITE_PERMISSION,
} from "./actor";
import { CoreError } from "./chat";
import type {
  PluginGatewayDiscoveredTool,
  PluginInstallation,
  PluginRepository,
  ResolvedPluginPackage,
} from "./plugin-import";

export type CustomMcpDefinition = { label: string; url: string };
export type CustomMcpCredentials = { headers: Record<string, string> };
export type CustomMcpToolMode = "on" | "ask" | "off";
export type CustomMcpProbe = { tools: PluginGatewayDiscoveredTool[]; fingerprint: string };
export type CustomMcpAccount = {
  integrationId: string;
  revision: string;
  connected: boolean;
  tools: PluginGatewayDiscoveredTool[];
  toolModes: Record<string, CustomMcpToolMode>;
  checkedAt: Date;
  error: string | null;
};
export type CustomMcpStatus = {
  label: string;
  url: string;
  enabled: boolean;
  account: CustomMcpAccount | null;
};

export interface CustomMcpRepository {
  account(
    actor: Pick<Actor, "userId" | "workspaceId">,
    name: string,
  ): Promise<CustomMcpAccount | null>;
  save(
    actor: Actor,
    name: string,
    input: CustomMcpCredentials & CustomMcpProbe,
  ): Promise<CustomMcpAccount>;
  refresh(
    actor: Actor,
    name: string,
    revision: string,
    probe: CustomMcpProbe | { error: string },
  ): Promise<CustomMcpAccount>;
  credentials(
    actor: Pick<Actor, "userId" | "workspaceId">,
    name: string,
    revision: string,
  ): Promise<CustomMcpCredentials>;
  disconnect(actor: Actor, name: string): Promise<void>;
  setToolMode(
    actor: Actor,
    name: string,
    input: { tool: string; mode: CustomMcpToolMode; revision: string },
  ): Promise<void>;
}

export interface CustomMcpTransport {
  validate(
    definition: CustomMcpDefinition,
    credentials: CustomMcpCredentials,
  ): CustomMcpDefinition & CustomMcpCredentials;
  probe(url: string, credentials: CustomMcpCredentials): Promise<CustomMcpProbe>;
  package(definition: CustomMcpDefinition, name: string): Promise<ResolvedPluginPackage>;
  name(actor: Actor, idempotencyKey: string): string;
  error(error: unknown): string;
}

export class CustomMcpApplicationService {
  constructor(
    private readonly plugins: PluginRepository,
    private readonly accounts: CustomMcpRepository,
    private readonly transport: CustomMcpTransport,
  ) {}

  async preview(actor: Actor, input: CustomMcpDefinition & CustomMcpCredentials) {
    requireWrite(actor);
    const validated = this.transport.validate(input, input);
    return this.transport.probe(validated.url, validated);
  }

  async create(
    actor: Actor,
    input: CustomMcpDefinition &
      CustomMcpCredentials & { idempotencyKey: string; fingerprint: string },
  ) {
    requireWrite(actor);
    const validated = this.transport.validate(input, input);
    const probe = await this.transport.probe(validated.url, validated);
    if (probe.fingerprint !== input.fingerprint)
      throw new CoreError(
        "conflict",
        "The server's tools changed. Test the connection again before connecting.",
      );
    const name = this.transport.name(actor, input.idempotencyKey);
    const plugin = await this.transport.package(validated, name);
    const installed = await this.plugins.install({
      actor,
      idempotencyKey: input.idempotencyKey,
      plugin,
    });
    if (installed.plugin.status !== "enabled")
      throw new CoreError(
        "conflict",
        "This installation is no longer enabled. Start a new connection.",
      );
    if (!installed.idempotentReplay)
      await this.accounts.save(actor, name, { headers: validated.headers, ...probe });
    return installed;
  }

  async status(actor: Actor, name: string): Promise<CustomMcpStatus> {
    const plugin = await this.definition(actor, name);
    return {
      label: plugin.manifest.description ?? plugin.name,
      url: plugin.source.url,
      enabled: plugin.status === "enabled",
      account: await this.accounts.account(actor, name),
    };
  }

  async connect(actor: Actor, name: string, input: CustomMcpCredentials) {
    const plugin = await this.definition(actor, name);
    requireEnabled(plugin);
    const validated = this.transport.validate(
      { label: plugin.manifest.description ?? plugin.name, url: plugin.source.url },
      input,
    );
    const probe = await this.transport.probe(validated.url, validated);
    await this.accounts.save(actor, name, { headers: validated.headers, ...probe });
    return this.status(actor, name);
  }

  async refresh(actor: Actor, name: string) {
    const plugin = await this.definition(actor, name);
    requireEnabled(plugin);
    const account = await this.accounts.account(actor, name);
    if (!account)
      throw new CoreError("conflict", "Connect your account before refreshing its tools.");
    try {
      const credentials = await this.accounts.credentials(actor, name, account.revision);
      const probe = await this.transport.probe(plugin.source.url, credentials);
      await this.accounts.refresh(actor, name, account.revision, probe);
    } catch (error) {
      if (error instanceof CoreError && error.code === "conflict") throw error;
      await this.accounts.refresh(actor, name, account.revision, {
        error: this.transport.error(error),
      });
    }
    return this.status(actor, name);
  }

  async disconnect(actor: Actor, name: string) {
    await this.definition(actor, name);
    await this.accounts.disconnect(actor, name);
  }

  async setToolMode(
    actor: Actor,
    name: string,
    input: { tool: string; mode: CustomMcpToolMode; revision: string },
  ) {
    await this.definition(actor, name);
    await this.accounts.setToolMode(actor, name, input);
  }

  private async definition(actor: Actor, name: string) {
    if (!actorHasPermission(actor, SKILL_READ_PERMISSION))
      throw new CoreError("forbidden", "Plugin access is required.");
    const plugin = await this.plugins.get({ actor, name });
    if (!plugin || plugin.source.type !== "custom_mcp")
      throw new CoreError("not_found", "Custom MCP plugin not found.");
    return plugin;
  }
}

function requireWrite(actor: Actor) {
  if (actor.role !== "admin" || !actorHasPermission(actor, SKILL_WRITE_PERMISSION))
    throw new CoreError("forbidden", "Only workspace admins can install plugins.");
}
function requireEnabled(plugin: PluginInstallation) {
  if (plugin.status !== "enabled")
    throw new CoreError("conflict", "Enable this plugin before connecting or checking its tools.");
}
