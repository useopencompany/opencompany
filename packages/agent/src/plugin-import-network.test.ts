import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePluginImport } from "./plugin-import";

afterEach(() => vi.unstubAllGlobals());

describe("custom public plugin imports", () => {
  it("still resolves unbundled packages through public GitHub", async () => {
    const commit = "a".repeat(40);
    const manifest = JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "custom-plugin",
    });
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://api.github.com/repos/example/plugins/commits/main")
        return Response.json({ sha: commit });
      if (url === `https://api.github.com/repos/example/plugins/git/trees/${commit}?recursive=1`)
        return Response.json({
          tree: [
            { path: "custom/plugin.json", type: "blob", mode: "100644", size: manifest.length },
          ],
          truncated: false,
        });
      if (url === `https://raw.githubusercontent.com/example/plugins/${commit}/custom/plugin.json`)
        return new Response(manifest);
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const plugin = await resolvePluginImport({
      url: "https://github.com/example/plugins/tree/main/custom",
    });
    expect(plugin.manifest.name).toBe("custom-plugin");
    expect(plugin.source).toMatchObject({ path: "custom", ref: "main", resolvedCommit: commit });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps GitHub rate-limit diagnostics for unbundled sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      ),
    );
    await expect(
      resolvePluginImport({ url: "https://github.com/example/plugins/tree/main/custom" }),
    ).rejects.toMatchObject({
      code: "unavailable",
      cause: { failureKind: "rate_limit", upstreamStatus: 403 },
    });
  });
});
