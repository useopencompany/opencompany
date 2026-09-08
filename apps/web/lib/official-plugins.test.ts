import { OFFICIAL_PLUGIN_SOURCES } from "@opencompany/agent-runtime/official-plugin-catalog";
import { describe, expect, it } from "vitest";
import { OFFICIAL_MCP_PLUGIN_METADATA, OFFICIAL_SKILL_PLUGIN_METADATA } from "./official-plugins";

describe("official plugin catalog", () => {
  it("offers exactly the release's official pins", () => {
    const plugins = { ...OFFICIAL_MCP_PLUGIN_METADATA, ...OFFICIAL_SKILL_PLUGIN_METADATA };
    expect(
      Object.fromEntries(Object.entries(plugins).map(([name, plugin]) => [name, plugin.source])),
    ).toEqual(OFFICIAL_PLUGIN_SOURCES);
  });
});
