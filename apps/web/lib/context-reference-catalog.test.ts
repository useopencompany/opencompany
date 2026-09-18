import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchContextReferenceCatalog, filterContextReferences } from "./context-reference-catalog";

const github = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./github-repository-access", () => ({ fetchGitHubRepositoryAccess: github.fetch }));
vi.mock("./headless-chat-api", () => ({
  headlessChatApiBaseUrl: () => "https://app.test",
  createHeadlessChatApiFetch: () => globalThis.fetch,
}));
afterEach(() => {
  vi.unstubAllGlobals();
});
const timestamp = "2026-09-16T12:00:00.000Z";
function plugin(name: string, status = "enabled") {
  return {
    id: `plugin_${name}`,
    name,
    status,
    manifest: { name },
    source: {
      type: "github",
      url: "https://github.com/example/plugins",
      ref: "main",
      path: name,
      resolvedCommit: "a".repeat(40),
    },
    integrity: `sha256:${"b".repeat(64)}`,
    installReport: {
      ignoredManifestFields: [],
      skills: [],
      mcp: { status: "absent" },
      collisions: [],
    },
    events: [],
    pricing: null,
    eventModes: {},
    mcpApprovedIntegrity: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    fileCount: 1,
    skillCount: 0,
    stdioServerCount: 0,
  };
}
function mockPlugins(data: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ data, meta: { apiVersion: "v1", protocolVersion: "1.0.0" } }),
    ),
  );
}
describe("mention catalog", () => {
  it("lists installed plugins and deduplicates accessible repositories", async () => {
    mockPlugins([plugin("slack"), plugin("linear", "disabled"), plugin("gmail", "archived")]);
    const repo = { id: "1", fullName: "team/product", private: true };
    github.fetch.mockResolvedValue({
      installations: [
        { suspendedAt: null, repositories: [repo, repo] },
        {
          suspendedAt: timestamp,
          repositories: [{ ...repo, id: "2", fullName: "team/suspended" }],
        },
      ],
    });
    const result = await fetchContextReferenceCatalog();
    expect(result.error).toBeNull();
    expect(result.items.map((item) => item.label)).toEqual(["Slack", "Linear", "team/product"]);
    expect(result.items[1]?.description).toContain("Disabled");
    expect(filterContextReferences(result.items, "team/")).toEqual([result.items[2]]);
  });
  it("retains plugins when GitHub fails, and reports partial availability", async () => {
    mockPlugins([plugin("slack")]);
    github.fetch.mockRejectedValue(new Error("offline"));
    const result = await fetchContextReferenceCatalog();
    expect(result.items).toHaveLength(1);
    expect(result.error).toContain("could not be loaded");
  });
  it("rejects malformed plugin data while retaining valid repository results", async () => {
    mockPlugins([{ name: "incomplete" }]);
    github.fetch.mockResolvedValue({
      installations: [
        {
          suspendedAt: null,
          repositories: [{ id: "1", fullName: "team/product", private: false }],
        },
      ],
    });
    const result = await fetchContextReferenceCatalog();
    expect(result.items.map((item) => item.kind)).toEqual(["repository"]);
    expect(result.error).not.toBeNull();
  });
});
