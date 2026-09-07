import {
  type Actor,
  actorHasPermission,
  SKILL_READ_PERMISSION,
  SKILL_WRITE_PERMISSION,
} from "./actor";
import { CoreError } from "./chat";
import type {
  ResolvedSkillBundle,
  SkillBundleFileInput,
  SkillBundleFileMetadata,
} from "./skill-import";

export type PluginSource = {
  type: "github" | "skills.sh";
  url: string;
  ref: string;
  path: string;
  resolvedCommit: string;
};

export type PluginAuthor = { name?: string; email?: string; url?: string };

export type PluginManifest = {
  name: string;
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions?: Record<string, unknown>;
};

export type PluginStdioServer = {
  name: string;
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
};

export type PluginStdioServerSummary = Omit<PluginStdioServer, "env"> & { envKeys: string[] };

export type PluginRemoteServer = {
  name: string;
  type: "streamable-http" | "sse";
  url: string;
  headers: Record<string, string>;
};

export type PluginCapabilityId = "read" | "query" | "draft" | "write";
export type PluginCapabilityBucket = "read" | "write";
export type PluginCapabilityMode = "on" | "ask" | "off";

export type PluginCapabilityDefinition = {
  id: PluginCapabilityId;
  label: string;
  defaultMode: PluginCapabilityMode;
  tools: string[];
};

export type PluginGatewayDiscoveredTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  classification: {
    capabilityId: PluginCapabilityId;
    capabilityLabel: string;
    defaultMode: PluginCapabilityMode;
    bucket: PluginCapabilityBucket;
    curated: boolean;
  };
};

export type PluginRemoteMcpDiscoveryStatus = "pending" | "ready" | "stale" | "error";

export type PluginRemoteMcpDiscoveredTool = Pick<
  PluginGatewayDiscoveredTool,
  "name" | "description" | "classification"
>;

export type PluginRemoteMcpServer = {
  name: string;
  type: "streamable-http" | "sse";
  connectionProvider: string;
  capabilities: PluginCapabilityDefinition[];
  tools: PluginRemoteMcpDiscoveredTool[];
  discoveryStatus: PluginRemoteMcpDiscoveryStatus;
  discoveredAt: Date | null;
  refreshAfter: Date;
  lastDiscoveryError: string | null;
};

export type PluginRemoteMcpPreviewServer = Pick<
  PluginRemoteMcpServer,
  "name" | "type" | "connectionProvider" | "capabilities"
>;

export type PluginMcpServerReport = {
  name: string;
  // `unsupported` is retained for reports stored by the pre-gateway loader.
  status: "selected" | "gateway-registered" | "unsupported" | "invalid";
  transport?: "stdio" | "streamable-http" | "sse";
  reason?: string;
};

export type PluginCapabilitiesReport =
  | { status: "absent" }
  | { present: true; status: "ignored"; reason: string }
  | { present: true; status: "parsed"; issues: string[] };

export type PluginEventFilterDefinition = {
  id: string;
  label: string;
  kind: "integration_resource";
  resourceType: string;
  required: boolean;
};

export type PluginEventDefinition = {
  id: string;
  label: string;
  description: string;
  delivery: "webhook";
  filters: PluginEventFilterDefinition[];
};

export type PluginEventsReport =
  | { status: "absent" }
  | { present: true; status: "ignored"; reason: string }
  | { present: true; status: "parsed"; issues: string[] };

export type PluginSkillReport =
  | { path: string; name: string; status: "valid"; integrity: string }
  | { path: string; name: string; status: "skipped"; reason: string };

export type PluginMcpReport =
  | { status: "absent" }
  | { present: true; status: "disabled"; reason: string }
  | { present: true; status: "parsed"; reports: PluginMcpServerReport[] };

export type PluginSkillCollision = {
  skillName: string;
  winner: { source: "standalone" } | { source: "plugin"; pluginName: string };
  hiddenPluginNames: string[];
};

export type PluginInstallReport = {
  ignoredManifestFields: string[];
  skills: PluginSkillReport[];
  mcp: PluginMcpReport;
  // Optional for compatibility with installations created before capability extensions shipped.
  capabilities?: PluginCapabilitiesReport;
  events?: PluginEventsReport;
  collisions: PluginSkillCollision[];
};

export type ResolvedPluginSkill = {
  path: string;
  bundle: ResolvedSkillBundle;
};

export type ResolvedPluginPackage = {
  manifest: PluginManifest;
  source: PluginSource;
  integrity: string;
  files: SkillBundleFileInput[];
  fileCount: number;
  totalBytes: number;
  skills: ResolvedPluginSkill[];
  stdioServers: PluginStdioServer[];
  remoteServers: PluginRemoteServer[];
  capabilities: PluginCapabilityDefinition[];
  events: PluginEventDefinition[];
  report: Omit<PluginInstallReport, "collisions">;
};

export type PluginSkillSummary = {
  name: string;
  path: string;
  bundleId: string;
  integrity: string;
  description: string;
};

export type PluginStatus = "enabled" | "disabled" | "archived";

export type PluginInstallation = {
  id: string;
  name: string;
  status: PluginStatus;
  manifest: PluginManifest;
  source: PluginSource;
  integrity: string;
  files: SkillBundleFileMetadata[];
  skills: PluginSkillSummary[];
  stdioServers: PluginStdioServer[];
  remoteMcpServers: PluginRemoteMcpServer[];
  installReport: PluginInstallReport;
  events: PluginEventDefinition[];
  eventModes: Record<string, boolean>;
  mcpApprovedIntegrity: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type PluginInstallationListItem = Omit<
  PluginInstallation,
  "files" | "skills" | "stdioServers" | "remoteMcpServers"
> & {
  fileCount: number;
  skillCount: number;
  stdioServerCount: number;
};

export type PluginImportPreview = {
  manifest: PluginManifest;
  source: PluginSource;
  integrity: string;
  files: Array<{ path: string; sizeBytes: number }>;
  fileCount: number;
  totalBytes: number;
  skills: Array<{
    path: string;
    name: string;
    description: string;
    integrity: string;
    fileCount: number;
    totalBytes: number;
  }>;
  stdioServers: PluginStdioServerSummary[];
  remoteMcpServers: PluginRemoteMcpPreviewServer[];
  events: PluginEventDefinition[];
  report: Omit<PluginInstallReport, "collisions">;
};

export interface PluginImportResolver {
  resolve(input: { url: string; selectedPath?: string }): Promise<ResolvedPluginPackage>;
}

export interface PluginGatewayLifecycle {
  refresh(input: {
    actor: Actor;
    pluginName: string;
    reason: "install" | "enable" | "explicit";
  }): Promise<void>;
}

export interface PluginRepository {
  install(input: {
    actor: Actor;
    idempotencyKey: string;
    plugin: ResolvedPluginPackage;
  }): Promise<{ plugin: PluginInstallation; idempotentReplay: boolean }>;
  list(input: { actor: Actor }): Promise<PluginInstallationListItem[]>;
  get(input: { actor: Actor; name: string }): Promise<PluginInstallation | null>;
  setStatus(input: {
    actor: Actor;
    name: string;
    status: "enabled" | "disabled";
  }): Promise<PluginInstallation>;
  setEventEnabled(input: {
    actor: Actor;
    name: string;
    eventId: string;
    enabled: boolean;
  }): Promise<PluginInstallation>;
  approveMcp(input: { actor: Actor; name: string; integrity: string }): Promise<PluginInstallation>;
  revokeMcp(input: { actor: Actor; name: string }): Promise<PluginInstallation>;
  archive(input: { actor: Actor; name: string }): Promise<void>;
  deleteData(input: { actor: Actor; name: string }): Promise<{ deleted: boolean }>;
}

export class PluginImportApplicationService {
  constructor(
    private readonly repository: PluginRepository,
    private readonly resolver: PluginImportResolver,
    private readonly gatewayLifecycle?: PluginGatewayLifecycle,
  ) {}

  async preview(
    actor: Actor,
    input: { url: string; selectedPath?: string },
  ): Promise<PluginImportPreview> {
    requirePluginWrite(actor);
    return publicPreview(await this.resolve(input));
  }

  async install(
    actor: Actor,
    input: {
      idempotencyKey: string;
      url: string;
      selectedPath?: string;
      expectedResolvedCommit: string;
      expectedIntegrity: string;
    },
  ) {
    requirePluginWrite(actor);
    const expectedCommit = input.expectedResolvedCommit.trim().toLowerCase();
    const expectedIntegrity = input.expectedIntegrity.trim().toLowerCase();
    if (
      !/^[0-9a-f]{40}$/u.test(expectedCommit) ||
      !/^sha256:[0-9a-f]{64}$/u.test(expectedIntegrity)
    ) {
      throw new CoreError("invalid_argument", "Preview this plugin again before installing it.");
    }
    const plugin = await this.resolve(input);
    if (
      plugin.source.resolvedCommit.toLowerCase() !== expectedCommit ||
      plugin.integrity.toLowerCase() !== expectedIntegrity
    ) {
      throw new CoreError(
        "conflict",
        "This plugin changed since the preview. Preview it again before installing.",
      );
    }
    const result = await this.repository.install({
      actor,
      idempotencyKey: idempotencyKey(input.idempotencyKey),
      plugin,
    });
    await this.gatewayLifecycle?.refresh({
      actor,
      pluginName: result.plugin.name,
      reason: "install",
    });
    return result;
  }

  list(actor: Actor) {
    requirePluginRead(actor);
    return this.repository.list({ actor });
  }

  async inspect(actor: Actor, nameValue: string) {
    requirePluginRead(actor);
    const plugin = await this.repository.get({ actor, name: pluginName(nameValue) });
    if (!plugin) throw new CoreError("not_found", "Plugin not found.");
    return plugin;
  }

  async setEnabled(actor: Actor, nameValue: string, enabled: boolean) {
    requirePluginWrite(actor);
    const plugin = await this.repository.setStatus({
      actor,
      name: pluginName(nameValue),
      status: enabled ? "enabled" : "disabled",
    });
    if (enabled) {
      await this.gatewayLifecycle?.refresh({ actor, pluginName: plugin.name, reason: "enable" });
    }
    return plugin;
  }

  setEventEnabled(actor: Actor, nameValue: string, eventIdValue: string, enabled: boolean) {
    requirePluginWrite(actor);
    return this.repository.setEventEnabled({
      actor,
      name: pluginName(nameValue),
      eventId: bounded(eventIdValue, 128, "eventId"),
      enabled,
    });
  }

  async refreshMcp(actor: Actor, nameValue: string) {
    requirePluginWrite(actor);
    const name = pluginName(nameValue);
    const plugin = await this.repository.get({ actor, name });
    if (!plugin) throw new CoreError("not_found", "Plugin not found.");
    if (plugin.status !== "enabled") {
      throw new CoreError("conflict", "Enable the Plugin before refreshing MCP discovery.");
    }
    if (!this.gatewayLifecycle) {
      throw new CoreError("unavailable", "Plugin MCP discovery is not available in this runtime.");
    }
    await this.gatewayLifecycle.refresh({ actor, pluginName: name, reason: "explicit" });
    return this.repository.get({ actor, name });
  }

  approveMcp(actor: Actor, nameValue: string, integrityValue: string) {
    requirePluginWrite(actor);
    return this.repository.approveMcp({
      actor,
      name: pluginName(nameValue),
      integrity: pluginIntegrity(integrityValue),
    });
  }

  revokeMcp(actor: Actor, nameValue: string) {
    requirePluginWrite(actor);
    return this.repository.revokeMcp({ actor, name: pluginName(nameValue) });
  }

  archive(actor: Actor, nameValue: string) {
    requirePluginWrite(actor);
    return this.repository.archive({ actor, name: pluginName(nameValue) });
  }

  deleteData(actor: Actor, nameValue: string) {
    requirePluginWrite(actor);
    return this.repository.deleteData({ actor, name: pluginName(nameValue) });
  }

  private resolve(input: { url: string; selectedPath?: string }) {
    return this.resolver.resolve({
      url: bounded(input.url, 2_048, "url"),
      ...(input.selectedPath !== undefined
        ? { selectedPath: boundedRaw(input.selectedPath, 512, "selectedPath") }
        : {}),
    });
  }
}

export function publicPluginInstallation(
  plugin: PluginInstallation,
): Omit<PluginInstallation, "stdioServers"> & { stdioServers: PluginStdioServerSummary[] } {
  return { ...plugin, stdioServers: plugin.stdioServers.map(publicStdioServer) };
}

function publicPreview(plugin: ResolvedPluginPackage): PluginImportPreview {
  return {
    manifest: plugin.manifest,
    source: plugin.source,
    integrity: plugin.integrity,
    files: plugin.files.map((file) => ({ path: file.path, sizeBytes: file.content.length })),
    fileCount: plugin.fileCount,
    totalBytes: plugin.totalBytes,
    skills: plugin.skills.map(({ path, bundle }) => ({
      path,
      name: bundle.name,
      description: bundle.description,
      integrity: bundle.integrity,
      fileCount: bundle.fileCount,
      totalBytes: bundle.totalBytes,
    })),
    stdioServers: plugin.stdioServers.map(publicStdioServer),
    remoteMcpServers: plugin.remoteServers.map((server) => ({
      name: server.name,
      type: server.type,
      connectionProvider: plugin.manifest.name,
      capabilities: plugin.capabilities,
    })),
    events: plugin.events,
    report: plugin.report,
  };
}

function publicStdioServer(server: PluginStdioServer): PluginStdioServerSummary {
  return {
    name: server.name,
    type: server.type,
    command: server.command,
    args: server.args,
    envKeys: Object.keys(server.env).sort(),
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
  };
}

function requirePluginRead(actor: Actor) {
  if (!actorHasPermission(actor, SKILL_READ_PERMISSION)) {
    throw new CoreError("forbidden", "Plugin read permission is required.");
  }
}

function requirePluginWrite(actor: Actor) {
  if (!actorHasPermission(actor, SKILL_WRITE_PERMISSION)) {
    throw new CoreError("forbidden", "Plugin write permission is required.");
  }
}

function pluginName(value: string) {
  const name = bounded(value, 64, "name");
  if (
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(name) ||
    name.includes("--") ||
    name.includes("..")
  ) {
    throw new CoreError("invalid_argument", "Plugin name is invalid.");
  }
  return name;
}

function idempotencyKey(value: string) {
  return bounded(value, 200, "Idempotency-Key");
}

function pluginIntegrity(value: string) {
  const integrity = bounded(value, 80, "integrity").toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/u.test(integrity)) {
    throw new CoreError("invalid_argument", "Plugin integrity is invalid.");
  }
  return integrity;
}

function bounded(value: string, maxLength: number, field: string) {
  const trimmed = boundedRaw(value, maxLength, field).trim();
  if (!trimmed) throw new CoreError("invalid_argument", `${field} is required.`);
  return trimmed;
}

function boundedRaw(value: string, maxLength: number, field: string) {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new CoreError("invalid_argument", `${field} is invalid.`);
  }
  return value;
}
