import { afterEach, describe, expect, it, vi } from "vitest";
import { computeArtifactIntegrity } from "./artifact-integrity";
import { createOfficialPluginFetcher } from "./official-plugin-artifacts";
import { OFFICIAL_PLUGIN_ARTIFACTS } from "./official-plugin-artifacts/index";
import { OFFICIAL_PLUGIN_SOURCES } from "./official-plugin-catalog";
import { resolvePlugin } from "./plugin-resolver";
import { parseSkillUrl } from "./skill-resolver";

afterEach(() => vi.unstubAllGlobals());

describe("official plugin release artifacts", () => {
  it("ships exactly the catalog's reviewed package pins", () => {
    expect(Object.keys(OFFICIAL_PLUGIN_ARTIFACTS).sort()).toEqual(
      Object.keys(OFFICIAL_PLUGIN_SOURCES).sort(),
    );
  });

  it.each(Object.entries(OFFICIAL_PLUGIN_SOURCES))(
    "validates %s without any network access",
    async (name, url) => {
      const fetch = vi.fn(() => {
        throw new Error("Network unavailable");
      });
      vi.stubGlobal("fetch", fetch);
      const pin = parseSkillUrl(url);
      expect(pin).toMatchObject({ owner: "useopencompany", repo: "plugins", subpath: name });
      expect(pin.ref).toMatch(/^[0-9a-f]{40}$/u);
      const fetcher = await createOfficialPluginFetcher({ url });
      expect(fetcher).not.toBeNull();
      const plugin = await resolvePlugin({
        url,
        fetcher: fetcher!,
        trustedCapabilitySources: ["useopencompany/plugins"],
      });
      expect(plugin.manifest.name).toBe(name);
      expect(plugin.source.path).toBe(name);
      expect(plugin.resolvedCommit).toBe(pin.ref);
      expect(plugin.integrity).toBe(
        OFFICIAL_PLUGIN_ARTIFACTS[name as keyof typeof OFFICIAL_PLUGIN_ARTIFACTS].integrity,
      );
      expect(plugin.report.skills.every((skill) => skill.status === "valid")).toBe(true);
      expect(new Set(plugin.files.map((file) => file.path)).size).toBe(plugin.files.length);
      if (name === "yc-advise") {
        expect(plugin.skills.length).toBeGreaterThan(0);
      } else {
        expect(plugin.remoteServers.length).toBeGreaterThan(0);
        expect(plugin.capabilities.length).toBeGreaterThan(0);
        expect(plugin.report.mcp).toMatchObject({ status: "parsed" });
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("recognizes equivalent pinned URLs and an explicit selected directory", async () => {
    const commit = parseSkillUrl(OFFICIAL_PLUGIN_SOURCES.hubspot).ref!;
    for (const input of [
      {
        url: `https://github.com/${"useopencompany/plugins".toUpperCase()}/tree/${commit.toUpperCase()}/hubspot/`,
      },
      { url: `useopencompany/plugins/hubspot#${commit}` },
      { url: `https://github.com/useopencompany/plugins/tree/${commit}`, selectedPath: "hubspot" },
    ]) {
      expect(await createOfficialPluginFetcher(input)).not.toBeNull();
    }
  });

  it.each([
    { url: "https://github.com/example/plugins/tree/main/hubspot" },
    { url: "https://github.com/useopencompany/plugins/tree/main/hubspot" },
    {
      url: OFFICIAL_PLUGIN_SOURCES.hubspot.replace(
        "6b4e00b71f7d1b388fe5aa225aa86c8d35ba2578",
        "a".repeat(40),
      ),
    },
    { url: OFFICIAL_PLUGIN_SOURCES.hubspot, selectedPath: "attio" },
    { url: OFFICIAL_PLUGIN_SOURCES.hubspot, selectedPath: "../hubspot" },
    { url: OFFICIAL_PLUGIN_SOURCES.hubspot.replace("github.com", "example.com") },
  ])(
    "does not substitute a catalog artifact for a different source: $url $selectedPath",
    async (input) => {
      if (input.url.includes("example.com")) {
        await expect(createOfficialPluginFetcher(input)).rejects.toThrow("Only public github.com");
      } else {
        expect(await createOfficialPluginFetcher(input)).toBeNull();
      }
    },
  );

  it("cannot reuse bundled bytes with another repository or commit", async () => {
    const url = OFFICIAL_PLUGIN_SOURCES.hubspot;
    const fetcher = (await createOfficialPluginFetcher({ url }))!;
    const commit = parseSkillUrl(url).ref!;
    await expect(fetcher.resolveCommit("example", "plugins", commit)).rejects.toThrow(
      "different source",
    );
    await expect(fetcher.fetchTree("useopencompany", "other", commit)).rejects.toThrow(
      "different source",
    );
    await expect(
      fetcher.fetchBlob("useopencompany", "plugins", "a".repeat(40), "hubspot/plugin.json"),
    ).rejects.toThrow("different source");
  });

  it("rejects a packaged source that drifts from the catalog without fetching GitHub", async () => {
    const artifact = OFFICIAL_PLUGIN_ARTIFACTS.hubspot;
    const source = artifact.source;
    artifact.source = OFFICIAL_PLUGIN_SOURCES.attio;
    try {
      await expect(createOfficialPluginFetcher({ url: source })).rejects.toThrow(
        "does not match its catalog pin",
      );
    } finally {
      artifact.source = source;
    }
  });

  it.each(["content", "path", "executable"] as const)(
    "rejects changed artifact %s",
    async (field) => {
      const file = OFFICIAL_PLUGIN_ARTIFACTS.hubspot.files[0]!;
      const original = { ...file };
      if (field === "content") file.contentBase64 = Buffer.from("{}").toString("base64");
      if (field === "path") file.path = "other.json";
      if (field === "executable") file.executable = !file.executable;
      try {
        await expect(
          createOfficialPluginFetcher({ url: OFFICIAL_PLUGIN_SOURCES.hubspot }),
        ).rejects.toThrow("integrity mismatch");
      } finally {
        Object.assign(file, original);
      }
    },
  );

  it("still validates bundled manifests after checking integrity", async () => {
    const artifact = OFFICIAL_PLUGIN_ARTIFACTS.hubspot;
    const manifest = artifact.files.find((file) => file.path === "plugin.json")!;
    const originalContent = manifest.contentBase64;
    const originalIntegrity = artifact.integrity;
    manifest.contentBase64 = Buffer.from('{"name":"INVALID NAME"}').toString("base64");
    artifact.integrity = await computeArtifactIntegrity(
      artifact.files.map((file) => ({
        ...file,
        content: Buffer.from(file.contentBase64, "base64"),
      })),
    );
    try {
      const url = OFFICIAL_PLUGIN_SOURCES.hubspot;
      const fetcher = await createOfficialPluginFetcher({ url });
      await expect(resolvePlugin({ url, fetcher: fetcher! })).rejects.toThrow();
    } finally {
      manifest.contentBase64 = originalContent;
      artifact.integrity = originalIntegrity;
    }
  });
});
