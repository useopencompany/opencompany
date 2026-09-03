"use client";

import type {
  PluginImportPreviewDto,
  PluginInstallationDto,
  PluginListItemDto,
} from "@opencompany/protocol";
import { Button, buttonVariants } from "@opencompany/ui/components/button";
import {
  BetterStackIcon,
  GitHubIcon,
  GoogleDriveIcon,
  LinearIcon,
  NeonIcon,
  SlackIcon,
} from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import {
  Archive,
  ChevronDown,
  ExternalLink,
  FileArchive,
  Link2,
  Loader2,
  PackageOpen,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { SettingsContent } from "@/components/SettingsChrome";
import {
  approveHeadlessPluginMcp,
  archiveHeadlessPlugin,
  deleteHeadlessPluginData,
  disableHeadlessPlugin,
  enableHeadlessPlugin,
  importHeadlessPlugin,
  previewHeadlessPluginImport,
  revokeHeadlessPluginMcp,
} from "@/lib/headless-knowledge-commands";
import {
  OFFICIAL_MCP_PLUGIN_METADATA,
  type OfficialMcpPluginMetadata,
  type OfficialMcpPluginName,
} from "@/lib/official-mcp-plugins";

type PluginSkillView = {
  name: string;
  path: string;
  bundleId: string;
  integrity: string;
  description: string;
};
type PluginServerView = {
  name: string;
  type: "stdio";
  command: string;
  args: string[];
  envKeys: string[];
  cwd?: string;
};
type PluginFileView = { path: string; executable: boolean; sizeBytes: number };
type PluginImportFileView = { path: string; sizeBytes: number };
type PluginSkillReportView =
  | { path: string; name: string; status: "valid"; integrity: string }
  | { path: string; name: string; status: "skipped"; reason: string };
type PluginMcpEntryView = {
  name: string;
  status: "selected" | "gateway-registered" | "unsupported" | "invalid";
  transport?: "stdio" | "streamable-http" | "sse";
  reason?: string;
};
type PluginCollisionView = {
  skillName: string;
  winner: { source: "standalone" } | { source: "plugin"; pluginName: string };
  hiddenPluginNames: string[];
};
type PluginReportView = {
  ignoredManifestFields: string[];
  skills: PluginSkillReportView[];
  mcp:
    | { status: "absent" }
    | { present: true; status: "disabled"; reason: string }
    | { present: true; status: "parsed"; reports: PluginMcpEntryView[] };
  capabilities?:
    | { status: "absent" }
    | { present: true; status: "ignored"; reason: string }
    | { present: true; status: "parsed"; issues: string[] };
  collisions: PluginCollisionView[];
};

export type OfficialMcpPluginConfig = OfficialMcpPluginMetadata & {
  Icon: typeof LinearIcon;
  iconClassName: string;
};

export const OFFICIAL_MCP_PLUGINS = {
  betterstack: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.betterstack,
    Icon: BetterStackIcon,
    iconClassName: "bg-[#1B1F23] text-white",
  },
  github: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.github,
    Icon: GitHubIcon,
    iconClassName: "bg-[#181717] text-white",
  },
  "google-drive": {
    ...OFFICIAL_MCP_PLUGIN_METADATA["google-drive"],
    Icon: GoogleDriveIcon,
    iconClassName: "bg-white text-[#1FA463]",
  },
  linear: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.linear,
    Icon: LinearIcon,
    iconClassName: "bg-[#5E6AD2] text-white",
  },
  neon: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.neon,
    Icon: NeonIcon,
    iconClassName: "bg-[#00E599] text-[#0B0F14]",
  },
  slack: {
    ...OFFICIAL_MCP_PLUGIN_METADATA.slack,
    Icon: SlackIcon,
    iconClassName: "bg-white text-[#4A154B]",
  },
} as const satisfies Record<OfficialMcpPluginName, OfficialMcpPluginConfig>;

export const GITHUB_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.github.name;
export const GITHUB_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.github.source;
export const GOOGLE_DRIVE_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS["google-drive"].name;
export const GOOGLE_DRIVE_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS["google-drive"].source;
export const LINEAR_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.linear.name;
export const LINEAR_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.linear.source;
export const NEON_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.neon.name;
export const NEON_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.neon.source;
export const BETTERSTACK_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.betterstack.name;
export const BETTERSTACK_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.betterstack.source;
export const SLACK_PLUGIN_NAME = OFFICIAL_MCP_PLUGINS.slack.name;
export const SLACK_PLUGIN_SOURCE = OFFICIAL_MCP_PLUGINS.slack.source;

export async function installOfficialMcpPlugin(
  config: OfficialMcpPluginConfig,
  preview?: PluginImportPreviewDto,
) {
  const confirmed = preview ?? (await previewHeadlessPluginImport({ url: config.source }));
  if (confirmed.manifest.name.toLocaleLowerCase() !== config.name) {
    throw new Error(
      `Expected the ${config.name} plugin, but this source contains ${confirmed.manifest.name}.`,
    );
  }
  const result = await importHeadlessPlugin({
    url: config.source,
    expectedResolvedCommit: confirmed.source.resolvedCommit,
    expectedIntegrity: confirmed.integrity,
  });
  return result.plugin;
}

export function installOfficialLinearPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.linear, preview);
}

export function installOfficialGitHubPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.github, preview);
}

export function installOfficialGoogleDrivePlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS["google-drive"], preview);
}

export function installOfficialNeonPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.neon, preview);
}

export function installOfficialBetterStackPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.betterstack, preview);
}

export function installOfficialSlackPlugin(preview?: PluginImportPreviewDto) {
  return installOfficialMcpPlugin(OFFICIAL_MCP_PLUGINS.slack, preview);
}

export function PluginsSettings({
  plugins,
  canEdit,
}: {
  plugins: PluginListItemDto[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [installError, setInstallError] = useState<string | null>(null);
  const [installingName, setInstallingName] = useState<OfficialMcpPluginName | null>(null);
  const [isInstalling, startInstall] = useTransition();
  const install = (config: OfficialMcpPluginConfig) => {
    if (isInstalling) return;
    setInstallError(null);
    setInstallingName(config.name);
    startInstall(async () => {
      try {
        const plugin = await installOfficialMcpPlugin(config);
        router.push(`/settings/plugins/${encodeURIComponent(plugin.name)}`);
      } catch (cause) {
        setInstallError(errorMessage(cause));
      } finally {
        setInstallingName(null);
      }
    });
  };

  return (
    <SettingsContent
      title="Plugins"
      description="Immutable Agent Plugin packages installed from public GitHub sources."
    >
      <div className="flex flex-col gap-3">
        {Object.values(OFFICIAL_MCP_PLUGINS).map((config) => {
          const plugin = plugins.find(
            (candidate) => candidate.name.toLocaleLowerCase() === config.name,
          );
          const installing = isInstalling && installingName === config.name;
          return (
            <div
              key={config.name}
              className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-3"
            >
              <Link
                href={`/settings/plugins/${config.name}`}
                prefetch
                className="group flex min-w-0 flex-1 items-center gap-3 rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
              >
                <span
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-lg",
                    config.iconClassName,
                  )}
                >
                  <config.Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-medium leading-tight text-ink">
                      {config.label}
                    </span>
                    {plugin ? (
                      <PluginStatus status={plugin.status} />
                    ) : (
                      <span className="inline-flex shrink-0 rounded-full bg-surface-muted px-1.5 py-px text-[10.5px] font-medium leading-4 text-ink-subtle">
                        Not installed
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[12.5px] leading-5 text-ink-subtle">
                    {plugin?.manifest.description || config.description}
                  </span>
                  <span className="mt-1 block text-[11.5px] leading-4 text-ink-subtle">
                    {plugin
                      ? `${plugin.skillCount} ${plugin.skillCount === 1 ? "skill" : "skills"} · updated ${formatRelativeTime(plugin.updatedAt)}`
                      : "Official package · ready to install"}
                  </span>
                </span>
              </Link>
              {plugin ? (
                <Link
                  href={`/settings/plugins/${config.name}`}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), "text-ink")}
                >
                  Manage
                </Link>
              ) : canEdit ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isInstalling}
                  onClick={() => install(config)}
                >
                  {installing ? <Loader2 className="animate-spin" /> : null}
                  {installing ? "Installing…" : "Install"}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
      {installError ? <p className="text-[12.5px] text-danger">{installError}</p> : null}
    </SettingsContent>
  );
}

export function PluginDetail({
  plugin,
  canEdit,
}: {
  plugin: PluginInstallationDto;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [confirmDataDelete, setConfirmDataDelete] = useState(false);
  const [isMutating, startMutation] = useTransition();

  const mutate = (operation: () => Promise<unknown>, done?: () => void) => {
    setError(null);
    startMutation(async () => {
      try {
        await operation();
        done?.();
        router.refresh();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  };

  return (
    <SettingsContent
      title={plugin.manifest.name}
      description="An immutable Agent Plugin package with passive Skills and separately approved MCP servers."
      backLink={{ href: "/settings/plugins", label: "Plugins" }}
    >
      {!canEdit ? (
        <p className="text-[13px] leading-5 text-ink-subtle">
          Only workspace admins can manage plugin installations.
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <SectionLabel>Status</SectionLabel>
        <PluginStatus status={plugin.status} />
      </section>

      <details className="group rounded-lg border border-border bg-surface-muted">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[12.5px] font-medium text-ink-muted">
          <Link2 size={14} className="shrink-0" />
          Advanced package details
          <ChevronDown className="ml-auto size-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-border px-3 py-2.5 text-[11.5px] leading-4">
          <dt className="text-ink-faint">Source</dt>
          <dd className="break-all text-ink">
            <a
              href={plugin.source.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline decoration-border underline-offset-2 hover:decoration-ink"
            >
              {plugin.source.url}
              <ExternalLink size={11} />
            </a>
          </dd>
          <dt className="text-ink-faint">Package path</dt>
          <dd className="break-all font-mono text-ink">
            {plugin.source.path || "Repository root"}
          </dd>
          <dt className="text-ink-faint">Requested ref</dt>
          <dd className="break-all font-mono text-ink">{plugin.source.ref}</dd>
          <dt className="text-ink-faint">Commit</dt>
          <dd className="break-all font-mono text-ink">{plugin.source.resolvedCommit}</dd>
          <dt className="text-ink-faint">Integrity</dt>
          <dd className="break-all font-mono text-ink">{plugin.integrity}</dd>
        </dl>
      </details>

      <section className="flex flex-col gap-2">
        <SectionLabel>Passive skills ({plugin.skills.length})</SectionLabel>
        <p className="text-[12.5px] leading-5 text-ink-subtle">
          These standard Agent Skills join the workspace catalog while this plugin is enabled. They
          do not execute a process.
        </p>
        {plugin.skills.length === 0 ? (
          <EmptyRow label="No valid skills were discovered." />
        ) : (
          <ul className="overflow-hidden rounded-lg border border-border bg-surface">
            {plugin.skills.map((skill: PluginSkillView) => (
              <li key={skill.name} className="border-b border-border px-3 py-2.5 last:border-b-0">
                <div className="flex items-center gap-2">
                  <Sparkles size={13} className="shrink-0 text-ink-subtle" />
                  <span className="font-medium text-[13px] text-ink">{skill.name}</span>
                  <span className="ml-auto font-mono text-[10.5px] text-ink-faint">
                    {skill.integrity.slice(0, 18)}…
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-4 text-ink-subtle">{skill.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <SectionLabel>Executable MCP servers ({plugin.stdioServers.length})</SectionLabel>
        <div
          className={`rounded-lg border px-3 py-2.5 text-[12.5px] leading-5 ${
            plugin.mcpApprovedIntegrity === plugin.integrity
              ? "border-success/30 bg-success/5 text-ink-subtle"
              : "border-warning/30 bg-warning/5 text-ink-subtle"
          }`}
        >
          <div className="flex items-start gap-2">
            {plugin.mcpApprovedIntegrity === plugin.integrity ? (
              <ShieldCheck size={15} className="mt-0.5 shrink-0 text-success" />
            ) : (
              <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warning" />
            )}
            <span className="min-w-0 flex-1">
              {plugin.mcpApprovedIntegrity === plugin.integrity
                ? "Approved for this exact package integrity. Its servers are available on the next coding turn while the plugin is enabled."
                : plugin.status === "disabled"
                  ? "This plugin is disabled. Enable it before approving this exact package integrity."
                  : "Installation alone never starts these processes. Review every declaration below before approving this exact package integrity."}
            </span>
            {canEdit &&
            plugin.stdioServers.length > 0 &&
            (plugin.status === "enabled" || plugin.mcpApprovedIntegrity === plugin.integrity) ? (
              <button
                type="button"
                disabled={isMutating}
                onClick={() =>
                  mutate(() =>
                    plugin.mcpApprovedIntegrity === plugin.integrity
                      ? revokeHeadlessPluginMcp(plugin.name)
                      : approveHeadlessPluginMcp(plugin.name, plugin.integrity),
                  )
                }
                className="h-8 shrink-0 rounded-md border border-border bg-surface px-2.5 text-[12px] font-medium text-ink hover:bg-surface-hover disabled:opacity-60"
              >
                {plugin.mcpApprovedIntegrity === plugin.integrity
                  ? "Revoke MCP"
                  : "Approve exact package"}
              </button>
            ) : null}
          </div>
        </div>
        {plugin.stdioServers.length === 0 ? (
          <EmptyRow label="No valid stdio MCP servers were declared." />
        ) : (
          <ul className="overflow-hidden rounded-lg border border-border bg-surface">
            {plugin.stdioServers.map((server: PluginServerView) => (
              <li key={server.name} className="border-b border-border px-3 py-3 last:border-b-0">
                <div className="flex items-center gap-2">
                  <ServerCog size={14} className="text-ink-subtle" />
                  <span className="text-[13px] font-medium text-ink">{server.name}</span>
                  <span className="rounded-full bg-surface-muted px-1.5 text-[10.5px] text-ink-subtle">
                    stdio
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-[76px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11.5px] leading-4">
                  <dt className="text-ink-faint">Command</dt>
                  <dd className="truncate font-mono text-ink">{server.command}</dd>
                  <dt className="text-ink-faint">Arguments</dt>
                  <dd className="break-all font-mono text-ink">
                    {server.args.length ? server.args.join(" ") : "None"}
                  </dd>
                  <dt className="text-ink-faint">Working dir</dt>
                  <dd className="truncate font-mono text-ink">{server.cwd || "Plugin root"}</dd>
                  <dt className="text-ink-faint">Environment</dt>
                  <dd className="break-all font-mono text-ink">
                    {server.envKeys.length ? server.envKeys.join(", ") : "None declared"}
                  </dd>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      <CollisionReport collisions={plugin.installReport.collisions} />
      <ValidationReport report={plugin.installReport} />

      <section className="flex flex-col gap-2">
        <SectionLabel>Package files ({plugin.files.length})</SectionLabel>
        <ul className="max-h-[300px] overflow-y-auto rounded-lg border border-border bg-surface">
          {plugin.files.map((file: PluginFileView) => (
            <li
              key={file.path}
              className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0 [content-visibility:auto]"
            >
              <FileArchive size={13} className="shrink-0 text-ink-subtle" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                {file.path}
              </span>
              {file.executable ? (
                <span className="text-[11px] text-ink-subtle">executable</span>
              ) : null}
              <span className="shrink-0 text-[11.5px] text-ink-subtle">
                {formatBytes(file.sizeBytes)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {error ? <p className="text-[12.5px] leading-5 text-warning">{error}</p> : null}

      {canEdit ? (
        <div className="flex flex-col gap-4 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isMutating}
              onClick={() =>
                mutate(() =>
                  plugin.status === "enabled"
                    ? disableHeadlessPlugin(plugin.name)
                    : enableHeadlessPlugin(plugin.name),
                )
              }
              className="inline-flex h-9 items-center rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-60"
            >
              {plugin.status === "enabled" ? "Disable" : "Enable"}
            </button>
            <button
              type="button"
              disabled={isMutating}
              onClick={() =>
                mutate(
                  () => archiveHeadlessPlugin(plugin.name),
                  () => router.push("/settings/plugins"),
                )
              }
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-60"
            >
              <Archive size={14} />
              Archive
            </button>
          </div>

          <div className="rounded-lg border border-warning/30 p-3">
            <div className="flex items-start gap-2">
              <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warning" />
              <div className="min-w-0 flex-1">
                <h3 className="text-[13px] font-medium text-ink">Persistent plugin data</h3>
                <p className="mt-0.5 text-[12px] leading-4 text-ink-subtle">
                  This is separate from archiving the immutable package. Deleting it cannot be
                  undone.
                </p>
              </div>
              {confirmDataDelete ? (
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    disabled={isMutating}
                    onClick={() => setConfirmDataDelete(false)}
                    className="h-8 rounded-md px-2.5 text-[12px] text-ink-muted hover:bg-surface-hover"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isMutating}
                    onClick={() =>
                      mutate(
                        () => deleteHeadlessPluginData(plugin.name),
                        () => setConfirmDataDelete(false),
                      )
                    }
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-warning px-2.5 text-[12px] font-medium text-white disabled:opacity-60"
                  >
                    {isMutating ? <Loader2 size={13} className="animate-spin" /> : null}
                    Confirm delete
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={isMutating}
                  onClick={() => setConfirmDataDelete(true)}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-warning/40 px-2.5 text-[12px] font-medium text-warning hover:bg-warning/5 disabled:opacity-60"
                >
                  <Trash2 size={13} />
                  Delete data
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </SettingsContent>
  );
}

export function InstallPluginDialog({
  onClose,
  onComplete,
  initialUrl = "",
  expectedName,
  lockSource = false,
}: {
  onClose: () => void;
  onComplete: (name: string) => void;
  initialUrl?: string;
  expectedName?: string;
  lockSource?: boolean;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [preview, setPreview] = useState<PluginImportPreviewDto | null>(null);
  const [installed, setInstalled] = useState<PluginInstallationDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isResolving, startResolving] = useTransition();
  const [isInstalling, startInstalling] = useTransition();

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const resolve = () => {
    const source = url.trim();
    if (!source) {
      setError("Provide a GitHub or skills.sh URL.");
      return;
    }
    setError(null);
    startResolving(async () => {
      try {
        const result = await previewHeadlessPluginImport({ url: source });
        if (expectedName && result.manifest.name.toLocaleLowerCase() !== expectedName) {
          setPreview(null);
          setError(
            `Expected the ${expectedName} plugin, but this source contains ${result.manifest.name}.`,
          );
          return;
        }
        setPreview(result);
      } catch (cause) {
        setPreview(null);
        setError(errorMessage(cause));
      }
    });
  };

  const install = () => {
    if (!preview) return;
    const source = url.trim();
    const confirmed = preview;
    setError(null);
    startInstalling(async () => {
      try {
        const result = await importHeadlessPlugin({
          url: source,
          expectedResolvedCommit: confirmed.source.resolvedCommit,
          expectedIntegrity: confirmed.integrity,
        });
        setInstalled(result.plugin);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    });
  };

  const pending = isResolving || isInstalling;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Install a plugin"
        className="shadow-ring-xl relative flex max-h-[88vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl bg-surface p-5"
      >
        <h2 className="text-[15px] font-semibold text-ink">Install a plugin</h2>
        <p className="mt-1 text-[12.5px] leading-5 text-ink-subtle">
          Preview validation and metadata, then install the exact commit and package integrity. File
          contents remain internal.
        </p>

        <div className="mt-4 flex flex-col gap-3 overflow-y-auto">
          {!installed ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink-subtle">URL</span>
              <div className="flex gap-2">
                {/* biome-ignore lint/a11y/noAutofocus: focus the URL field when the dialog opens */}
                <input
                  autoFocus
                  value={url}
                  disabled={pending}
                  readOnly={lockSource}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setPreview(null);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") resolve();
                  }}
                  placeholder="github.com/owner/repository"
                  className="h-9 flex-1 rounded-md border border-border bg-canvas px-2.5 text-[13px] text-ink outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
                />
                <button
                  type="button"
                  onClick={resolve}
                  disabled={pending}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-[13px] font-medium text-ink hover:bg-surface-hover disabled:opacity-60"
                >
                  {isResolving ? <Loader2 size={13} className="animate-spin" /> : null}
                  Preview
                </button>
              </div>
            </label>
          ) : null}

          {error ? <p className="text-[12.5px] leading-5 text-warning">{error}</p> : null}

          {preview && !installed ? (
            <>
              <div className="rounded-lg border border-border bg-canvas px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <PackageOpen size={14} className="text-ink-subtle" />
                  <span className="text-[13px] font-medium text-ink">{preview.manifest.name}</span>
                  {preview.manifest.version ? (
                    <span className="text-[11.5px] text-ink-subtle">
                      v{preview.manifest.version}
                    </span>
                  ) : null}
                </div>
                {preview.manifest.description ? (
                  <p className="mt-1 text-[12px] leading-4 text-ink-subtle">
                    {preview.manifest.description}
                  </p>
                ) : null}
                <p className="mt-2 font-mono text-[10.5px] text-ink-faint">{preview.integrity}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Metric value={preview.skills.length} label="valid skills" />
                <Metric value={preview.stdioServers.length} label="stdio servers" />
                <Metric value={preview.fileCount} label="package files" />
              </div>
              <ValidationReport report={{ ...preview.report, collisions: [] }} />
              <section className="flex flex-col gap-2">
                <SectionLabel>Files ({preview.files.length})</SectionLabel>
                <ul className="max-h-[170px] overflow-y-auto rounded-lg border border-border bg-canvas">
                  {preview.files.map((file: PluginImportFileView) => (
                    <li
                      key={file.path}
                      className="flex gap-3 border-b border-border px-3 py-2 last:border-b-0 [content-visibility:auto]"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">
                        {file.path}
                      </span>
                      <span className="text-[11px] text-ink-subtle">
                        {formatBytes(file.sizeBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-[11.5px] text-ink-subtle">
                  {formatBytes(preview.totalBytes)} total
                </p>
              </section>
            </>
          ) : null}

          {installed ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border border-success/30 bg-success/5 px-3 py-2.5">
                <h3 className="text-[13px] font-medium text-ink">{installed.name} installed</h3>
                <p className="mt-0.5 text-[12px] leading-4 text-ink-subtle">
                  {installed.skills.length} valid skills are stored. No MCP process was started.
                </p>
              </div>
              <CollisionReport collisions={installed.installReport.collisions} />
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md px-3 text-[13px] font-medium text-ink-muted hover:bg-surface-hover"
          >
            {installed ? "Close" : "Cancel"}
          </button>
          {preview && !installed ? (
            <button
              type="button"
              onClick={install}
              disabled={pending}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[13px] font-medium text-canvas disabled:opacity-60"
            >
              {isInstalling ? <Loader2 size={13} className="animate-spin" /> : null}
              Install plugin
            </button>
          ) : null}
          {installed ? (
            <button
              type="button"
              onClick={() => onComplete(installed.name)}
              className="h-8 rounded-md bg-ink px-3 text-[13px] font-medium text-canvas"
            >
              View plugin
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ValidationReport({ report }: { report: PluginReportView }) {
  const skipped = report.skills.filter(
    (
      skill: PluginSkillReportView,
    ): skill is Extract<PluginSkillReportView, { status: "skipped" }> => skill.status === "skipped",
  );
  const mcpIssues =
    report.mcp.status === "parsed"
      ? report.mcp.reports.filter(
          (entry: PluginMcpEntryView) =>
            entry.status !== "selected" && entry.status !== "gateway-registered",
        )
      : [];
  const capabilityIssues =
    report.capabilities?.status === "parsed" ? report.capabilities.issues : [];
  const hasMessages =
    report.ignoredManifestFields.length > 0 ||
    skipped.length > 0 ||
    report.mcp.status === "disabled" ||
    mcpIssues.length > 0 ||
    report.capabilities?.status === "ignored" ||
    capabilityIssues.length > 0;
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>Validation report</SectionLabel>
      {!hasMessages ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2.5 text-[12.5px] text-ink-subtle">
          Manifest and discovered components passed validation.
        </div>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-surface">
          {report.ignoredManifestFields.map((field: string) => (
            <ReportRow key={`field-${field}`} label={`Ignored unknown manifest field: ${field}`} />
          ))}
          {skipped.map((skill: Extract<PluginSkillReportView, { status: "skipped" }>) => (
            <ReportRow
              key={`skill-${skill.path}`}
              label={`Skipped ${skill.path}: ${skill.reason}`}
            />
          ))}
          {report.mcp.status === "disabled" ? (
            <ReportRow label={`MCP disabled: ${report.mcp.reason}`} />
          ) : null}
          {mcpIssues.map((entry: PluginMcpEntryView) => (
            <ReportRow
              key={`mcp-${entry.name}`}
              label={`${entry.name}: ${entry.reason || entry.status}`}
            />
          ))}
          {report.capabilities?.status === "ignored" ? (
            <ReportRow label={`Capabilities ignored: ${report.capabilities.reason}`} />
          ) : null}
          {capabilityIssues.map((issue) => (
            <ReportRow key={`capability-${issue}`} label={`Capabilities: ${issue}`} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CollisionReport({ collisions }: { collisions: PluginCollisionView[] }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>Skill collision report</SectionLabel>
      {collisions.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2.5 text-[12.5px] text-ink-subtle">
          No plugin skills are hidden by a higher-priority skill.
        </div>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-warning/30 bg-warning/5">
          {collisions.map((collision: PluginCollisionView) => (
            <li
              key={collision.skillName}
              className="border-b border-warning/20 px-3 py-2.5 text-[12px] leading-4 last:border-b-0"
            >
              <span className="font-medium text-ink">{collision.skillName}</span>
              <span className="text-ink-subtle">
                {" "}
                resolves to{" "}
                {collision.winner.source === "standalone"
                  ? "the standalone skill"
                  : `plugin ${collision.winner.pluginName}`}
                ; hidden: {collision.hiddenPluginNames.join(", ")}.
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PluginStatus({ status }: { status: PluginListItemDto["status"] }) {
  return status === "enabled" ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-1.5 py-px text-[10.5px] font-medium leading-4 text-success">
      <span className="h-1.5 w-1.5 rounded-full bg-success" /> Enabled
    </span>
  ) : (
    <span className="inline-flex shrink-0 rounded-full bg-surface-muted px-1.5 py-px text-[10.5px] font-medium leading-4 text-ink-subtle">
      {status === "archived" ? "Archived" : "Disabled"}
    </span>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[12px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
      {children}
    </h2>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5 text-[12.5px] text-ink-subtle">
      {label}
    </div>
  );
}

function ReportRow({ label }: { label: string }) {
  return (
    <li className="border-b border-border px-3 py-2 text-[12px] leading-4 text-ink-subtle last:border-b-0">
      {label}
    </li>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border border-border bg-canvas px-2 py-2">
      <div className="text-[14px] font-semibold text-ink">{value}</div>
      <div className="text-[10.5px] text-ink-subtle">{label}</div>
    </div>
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(value: Date | string) {
  const timestamp = typeof value === "string" ? new Date(value).getTime() : value.getTime();
  const elapsedMinutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (!Number.isFinite(timestamp) || elapsedMinutes < 1) return "just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7
    ? `${days}d ago`
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(timestamp);
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : "Something went wrong.";
}
