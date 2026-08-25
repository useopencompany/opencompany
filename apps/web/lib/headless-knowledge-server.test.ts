import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHeadlessBrainSnapshot,
  getHeadlessPlugin,
  getHeadlessSkill,
  listHeadlessPlugins,
  listHeadlessSkillCatalog,
  listHeadlessWikiPages,
} from "./headless-knowledge-server";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };

describe("server knowledge reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.example.test");
    vi.mocked(headers).mockResolvedValue(
      new Headers({ Cookie: "wos-session=session", Authorization: "Bearer token" }) as never,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards actor credentials and disables caching for typed Brain reads", async () => {
    let upstream: { request: Request; init?: RequestInit } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        upstream = {
          request: input instanceof Request ? input : new Request(input, init),
          ...(init ? { init } : {}),
        };
        return Response.json({ data: { folders: [], documents: [] }, meta });
      }),
    );

    await expect(getHeadlessBrainSnapshot("brain_alpha")).resolves.toEqual({
      folders: [],
      documents: [],
    });

    const sent = (upstream as unknown as { request: Request; init?: RequestInit }).request;
    expect(new URL(sent.url).pathname).toBe("/v1/brains/brain_alpha");
    expect(sent.headers.get("cookie")).toBe("wos-session=session");
    expect(sent.headers.get("authorization")).toBe("Bearer token");
    expect((upstream as unknown as { init?: RequestInit }).init?.cache).toBe("no-store");
  });

  it("loads Wiki pages, the Skill catalog, and Plugins from canonical resources", async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        paths.push(new URL(request.url).pathname);
        return Response.json({ data: [], meta });
      }),
    );

    await listHeadlessWikiPages();
    await listHeadlessSkillCatalog();
    await listHeadlessPlugins();

    expect(paths).toEqual(["/v1/wiki/pages", "/v1/skills/catalog", "/v1/plugins"]);
  });

  it("returns null only for a canonical missing Skill", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(getHeadlessSkill("missing-skill")).resolves.toBeNull();
    await expect(getHeadlessPlugin("missing-plugin")).resolves.toBeNull();
  });

  it("rejects an unsafe API origin before issuing a request", async () => {
    const unsafeOrigin = new URL("https://api.example.test");
    unsafeOrigin.username = "test-user";
    unsafeOrigin.password = "test-password";
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", unsafeOrigin.href);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(listHeadlessWikiPages()).rejects.toThrow("canonical API origin is invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
