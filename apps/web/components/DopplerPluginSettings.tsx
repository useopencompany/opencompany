"use client";

import { Badge } from "@opencompany/ui/components/badge";
import { useEffect, useState } from "react";
import { DopplerPluginConnectionForm } from "@/components/DopplerPluginConnectionForm";
import {
  PluginHeaderSection,
  type PluginLoadState,
  type PluginPreviewState,
  SkillsSection,
} from "@/components/OfficialMcpPluginSettings";
import { OFFICIAL_SKILL_PLUGINS } from "@/components/PluginSettings";
import { SettingsContent } from "@/components/SettingsChrome";
import type { DopplerAuthSettings } from "@/lib/doppler-auth";
import { previewHeadlessPluginImport } from "@/lib/headless-knowledge-commands";
import { officialPluginUpdateAvailable } from "@/lib/official-plugins";

export function DopplerPluginDetail({
  pluginState,
  settings,
}: {
  pluginState: PluginLoadState;
  settings: DopplerAuthSettings;
}) {
  const config = OFFICIAL_SKILL_PLUGINS.doppler;
  const plugin = pluginState.status === "ready" ? pluginState.plugin : null;
  const shouldPreview = pluginState.status === "ready" && !plugin;
  const [previewState, setPreviewState] = useState<PluginPreviewState>({ status: "loading" });

  useEffect(() => {
    if (!shouldPreview) return;
    let active = true;
    void previewHeadlessPluginImport({ url: config.source })
      .then((preview) => {
        if (active) setPreviewState({ status: "ready", preview });
      })
      .catch((error) => {
        if (active)
          setPreviewState({
            status: "error",
            message:
              error instanceof Error ? error.message : "Doppler package could not be loaded.",
          });
      });
    return () => {
      active = false;
    };
  }, [config.source, shouldPreview]);

  const connected = settings.status === "connected";
  const enabled = plugin?.status === "enabled";
  const Icon = config.Icon;
  return (
    <SettingsContent
      title={config.label}
      description={config.description}
      backLink={{ href: "/settings/plugins", label: "Plugins" }}
      icon={
        <span
          aria-hidden="true"
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${config.iconClassName}`}
        >
          <Icon className="size-5" />
        </span>
      }
      badge={
        pluginState.status === "ready" ? (
          <Badge variant={!enabled ? "outline" : connected ? "success" : "warning"}>
            {!plugin
              ? "Not installed"
              : !enabled
                ? "Disabled"
                : connected
                  ? "Connected"
                  : settings.status === "needs_reauth"
                    ? "Reconnect needed"
                    : "Requires connection"}
          </Badge>
        ) : undefined
      }
    >
      {enabled ? <DopplerPluginConnectionForm settings={settings} enabled /> : null}
      <PluginHeaderSection
        config={config}
        state={pluginState}
        previewState={previewState}
        updateAvailable={Boolean(
          plugin && officialPluginUpdateAvailable(plugin.source.resolvedCommit, config.source),
        )}
        canEdit
      />
      {plugin && !enabled ? (
        <DopplerPluginConnectionForm settings={settings} enabled={false} />
      ) : null}
      <SkillsSection
        config={config}
        state={pluginState}
        previewState={previewState}
        description="Guidance for using Doppler in your coding sandbox."
      />
    </SettingsContent>
  );
}
