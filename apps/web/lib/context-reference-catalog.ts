"use client";

import { createApiClient, PluginListEnvelopeSchema } from "@opencompany/protocol";
import type { ContextReference } from "./context-references";
import { fetchGitHubRepositoryAccess } from "./github-repository-access";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import {
  OFFICIAL_MANAGED_PLUGIN_METADATA,
  OFFICIAL_MCP_PLUGIN_METADATA,
  OFFICIAL_SKILL_PLUGIN_METADATA,
} from "./official-plugins";

const OFFICIAL_PLUGIN_METADATA = {
  ...OFFICIAL_MCP_PLUGIN_METADATA,
  ...OFFICIAL_SKILL_PLUGIN_METADATA,
  ...OFFICIAL_MANAGED_PLUGIN_METADATA,
};

export type ContextReferenceOption = ContextReference & { description: string };
export type ContextReferenceCatalog = { items: ContextReferenceOption[]; error: string | null };

export async function fetchContextReferenceCatalog(): Promise<ContextReferenceCatalog> {
  const baseUrl = headlessChatApiBaseUrl();
  const client = createApiClient(baseUrl, { fetch: createHeadlessChatApiFetch({ baseUrl }) });
  const [plugins, repositories] = await Promise.allSettled([
    client.v1.plugins.$get().then(async (response) => {
      if (!response.ok) throw new Error("Plugins could not be loaded");
      return PluginListEnvelopeSchema.parse(await response.json()).data;
    }),
    fetchGitHubRepositoryAccess({}),
  ]);
  const items: ContextReferenceOption[] = [];
  if (plugins.status === "fulfilled") {
    for (const plugin of plugins.value) {
      if (plugin.status === "archived") continue;
      const metadata =
        OFFICIAL_PLUGIN_METADATA[plugin.name as keyof typeof OFFICIAL_PLUGIN_METADATA];
      items.push({
        kind: "plugin",
        plugin: plugin.name,
        label: plugin.name === "github" ? "GitHub" : (metadata?.label ?? plugin.name),
        href: `/plugins/${plugin.name}`,
        description:
          plugin.status === "disabled"
            ? "Plugin · Disabled"
            : (metadata?.description ?? "Custom plugin"),
      });
    }
  }
  if (repositories.status === "fulfilled") {
    const seen = new Set<string>();
    for (const installation of repositories.value.installations) {
      if (installation.suspendedAt) continue;
      for (const repo of installation.repositories) {
        if (seen.has(repo.id)) continue;
        seen.add(repo.id);
        items.push({
          kind: "repository",
          plugin: "github",
          label: repo.fullName,
          href: `https://github.com/${repo.fullName}`,
          description: repo.private ? "GitHub repository · Private" : "GitHub repository",
        });
      }
    }
  }
  return {
    items,
    error:
      plugins.status === "rejected" || repositories.status === "rejected"
        ? "Some mentions could not be loaded. Close and reopen to retry."
        : null,
  };
}

export function filterContextReferences(items: ContextReferenceOption[], query: string) {
  const search = query.trim().toLowerCase();
  return items
    .filter((item) =>
      `${item.label} ${item.plugin} ${item.description}`.toLowerCase().includes(search),
    )
    .slice(0, 12);
}
