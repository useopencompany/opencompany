import { OFFICIAL_PLUGIN_SOURCES } from "@opencompany/agent-runtime/official-plugin-catalog";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_MCP_PLUGIN_METADATA,
  OFFICIAL_SKILL_PLUGIN_METADATA,
  officialPluginUpdateAvailable,
} from "./official-plugins";

describe("official plugin catalog", () => {
  it("offers exactly the release's official pins", () => {
    const plugins = { ...OFFICIAL_MCP_PLUGIN_METADATA, ...OFFICIAL_SKILL_PLUGIN_METADATA };
    expect(
      Object.fromEntries(Object.entries(plugins).map(([name, plugin]) => [name, plugin.source])),
    ).toEqual(OFFICIAL_PLUGIN_SOURCES);
  });

  it("detects an update from the release's pinned commit", () => {
    const source = OFFICIAL_MCP_PLUGIN_METADATA.linear.source;
    const currentCommit = source.match(/\/tree\/([0-9a-f]{40})\//u)?.[1];

    expect(currentCommit).toBeDefined();
    expect(officialPluginUpdateAvailable(currentCommit!, source)).toBe(false);
    expect(officialPluginUpdateAvailable("a".repeat(40), source)).toBe(true);
    expect(officialPluginUpdateAvailable("a".repeat(40), "https://example.com/plugin")).toBe(false);
  });
});
