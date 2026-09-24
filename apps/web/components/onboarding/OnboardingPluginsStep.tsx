"use client";

import { type PluginConnections, PluginRow } from "@/components/onboarding/plugin-connections";
import { OFFICIAL_MCP_PLUGINS, type OfficialMcpPluginConfig } from "@/lib/official-plugin-catalog";

// GitHub leads: it is the one plugin that makes the coding sandboxes from the
// previous step immediately useful. The rest are the catalog's featured set.
const RECOMMENDED: OfficialMcpPluginConfig = OFFICIAL_MCP_PLUGINS.github;
const ALSO_POPULAR: OfficialMcpPluginConfig[] = [
  OFFICIAL_MCP_PLUGINS.linear,
  OFFICIAL_MCP_PLUGINS.gmail,
  OFFICIAL_MCP_PLUGINS.slack,
  OFFICIAL_MCP_PLUGINS.notion,
];

export function OnboardingPluginsStep({ plugins }: { plugins: PluginConnections }) {
  const { installed } = plugins;

  const row = (config: OfficialMcpPluginConfig, recommended = false) => (
    <PluginRow
      key={config.name}
      config={config}
      recommended={recommended}
      installed={installed.has(config.name)}
      connected={plugins.connected.has(config.connectionProvider)}
      connecting={plugins.connecting === config.name}
      disabled={plugins.disabled}
      onConnect={plugins.requestConnect}
    />
  );

  return (
    <div>
      <div className="mb-7 flex flex-col gap-2">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
          Give your agent some tools
        </h1>
        <p className="text-[14px] leading-6 text-ink-muted">
          Plugins let opencompany act in the tools you already use. Connect a few now, or add them
          later from Plugins in the sidebar.
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        {row(RECOMMENDED, true)}
        <p className="mt-3 text-[12px] font-medium text-ink-subtle">Also popular</p>
        {ALSO_POPULAR.map((config) => row(config))}
      </div>
    </div>
  );
}
