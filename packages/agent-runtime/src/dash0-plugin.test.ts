import { describe, expect, it } from "vitest";
import { createOfficialPluginFetcher } from "./official-plugin-artifacts";
import { OFFICIAL_PLUGIN_SOURCES } from "./official-plugin-catalog";
import { resolvePlugin } from "./plugin-resolver";

describe("Dash0 official package", () => {
  it("imports the pinned package with conservative permissions and no credentials", async () => {
    const url = OFFICIAL_PLUGIN_SOURCES.dash0;
    const fetcher = await createOfficialPluginFetcher({ url });
    expect(fetcher).not.toBeNull();
    const plugin = await resolvePlugin({
      url,
      fetcher: fetcher!,
      trustedCapabilitySources: ["useopencompany/plugins"],
    });
    expect(plugin.manifest.name).toBe("dash0");
    expect(plugin.remoteServers).toEqual([
      {
        name: "dash0",
        type: "streamable-http",
        url: "https://api.eu-west-1.aws.dash0.com/mcp",
        headers: {},
      },
    ]);
    expect(plugin.capabilities).toEqual([
      {
        id: "query",
        label: "Inspect observability data",
        defaultMode: "ask",
        tools: ["listDatasets", "getMetricQuery", "getLogRecords", "getFailedChecks"],
      },
      {
        id: "read",
        label: "Read Agent0 investigations",
        defaultMode: "ask",
        tools: [
          "waitForTask",
          "getAgent0ThreadStatus",
          "getAgent0ThreadContent",
          "listAgent0Threads",
        ],
      },
      {
        id: "write",
        label: "Run paid Agent0 investigations",
        defaultMode: "off",
        tools: ["runTask"],
      },
    ]);
    expect(plugin.report.capabilities).toMatchObject({ status: "parsed", issues: [] });
  });
});
