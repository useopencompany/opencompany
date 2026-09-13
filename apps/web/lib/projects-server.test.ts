import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProjectName } from "./projects-server";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

const meta = { apiVersion: "v1", protocolVersion: "1.0.0" };
const project = {
  id: "project_1",
  name: "product",
  conversationIds: [],
  createdAt: "2026-09-01T10:00:00.000Z",
};

describe("loadProjectName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_API_ORIGIN", "https://api.example.test");
    vi.mocked(headers).mockResolvedValue(new Headers({ Cookie: "wos-session=session" }) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("resolves the name of a project the reader owns", async () => {
    let upstream: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        upstream = input instanceof Request ? input : new Request(input, init);
        return Response.json({ data: [project], meta });
      }),
    );

    await expect(loadProjectName(" project_1 ")).resolves.toBe("product");
    expect(new URL((upstream as unknown as Request).url).pathname).toBe("/v1/projects");
  });

  it("returns null for an unknown project without failing the page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [project], meta })),
    );

    await expect(loadProjectName("project_missing")).resolves.toBeNull();
  });

  it("returns null when Projects are not enabled for the reader", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: { message: "Projects are not enabled." } }, { status: 404 }),
      ),
    );

    await expect(loadProjectName("project_1")).resolves.toBeNull();
  });

  it("skips the request when no project was requested", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadProjectName("   ")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected API failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: "boom" } }, { status: 500 })),
    );

    await expect(loadProjectName("project_1")).rejects.toThrow("boom");
  });
});
