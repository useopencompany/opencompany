import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHeadlessPlugin,
  getHeadlessSkill,
  listHeadlessWikiPages,
  listHeadlessWikis,
} from "./headless-knowledge-server";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

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

  it.each([
    ["wiki list", () => listHeadlessWikis()],
    ["wiki page list", () => listHeadlessWikiPages()],
  ])("rejects an invalid successful %s response at the API boundary", async (_label, read) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ meta: { requestId: "request_1" } })),
    );

    await expect(read()).rejects.toThrow();
  });
});
