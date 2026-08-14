import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRepoEnvAction,
  deleteRepoConfigAction,
  listRepoConfigsAction,
  saveRepoEnvAction,
} from "./repo-config-actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

const configDto = {
  repositoryExternalId: "123",
  repositoryFullName: "opencompany/App",
  envKeys: ["API_TOKEN"],
  setupInstructions: "",
  updatedAt: "2026-08-12T10:00:00.000Z",
};

function stubApi(response: () => Response) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init));
      return response();
    }),
  );
  return requests;
}

describe("repository config API actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOAT_API_ORIGIN", "https://api.example.test");
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        Cookie: "wos-session=sealed",
        Origin: "https://my.opencompany.chat",
      }) as never,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("lists repositories and revives config timestamps", async () => {
    const requests = stubApi(() =>
      Response.json({
        data: {
          repositories: [
            { repositoryExternalId: "123", repositoryFullName: "opencompany/App", private: true },
          ],
          configs: [configDto],
        },
        meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
      }),
    );

    const result = await listRepoConfigsAction();
    expect(new URL((requests[0] as Request).url).pathname).toBe("/v1/repo-configs");
    expect(result.repositories).toHaveLength(1);
    expect(result.configs[0]).toMatchObject({
      repositoryExternalId: "123",
      envKeys: ["API_TOKEN"],
      updatedAt: new Date("2026-08-12T10:00:00.000Z"),
    });
  });

  it("saves the env through the PUT command and revalidates the settings page", async () => {
    const requests = stubApi(() =>
      Response.json({ data: configDto, meta: { apiVersion: "v1", protocolVersion: "1.0.0" } }),
    );

    const result = await saveRepoEnvAction({
      repositoryExternalId: "123",
      envContent: "API_TOKEN=secret-value",
    });

    const request = requests[0] as Request;
    expect(request.method).toBe("PUT");
    expect(new URL(request.url).pathname).toBe("/v1/repo-configs/123/env");
    await expect(request.json()).resolves.toEqual({ content: "API_TOKEN=secret-value" });
    expect(request.headers.get("cookie")).toBe("wos-session=sealed");
    expect(request.headers.get("origin")).toBe("https://my.opencompany.chat");
    expect(result).toEqual({
      ok: true,
      config: { ...configDto, updatedAt: new Date(configDto.updatedAt) },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/settings/repositories");
  });

  it("clears the env by sending a null content payload", async () => {
    const requests = stubApi(() =>
      Response.json({ data: configDto, meta: { apiVersion: "v1", protocolVersion: "1.0.0" } }),
    );

    await clearRepoEnvAction({ repositoryExternalId: "123" });
    await expect((requests[0] as Request).json()).resolves.toEqual({ content: null });
  });

  it("rejects invalid repository ids locally with the retired action's messages", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      saveRepoEnvAction({ repositoryExternalId: "repo_123", envContent: "KEY=value" }),
    ).resolves.toEqual({ ok: false, message: "Invalid repository environment." });
    await expect(deleteRepoConfigAction({ repositoryExternalId: "" })).resolves.toEqual({
      ok: false,
      message: "Invalid repository.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("surfaces the protocol error message without failing the mutation flow", async () => {
    stubApi(() =>
      Response.json(
        {
          error: {
            code: "forbidden",
            message: "Only workspace admins can configure repository environments.",
            requestId: "request_1",
            retryable: false,
          },
          meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
        },
        { status: 403 },
      ),
    );

    await expect(
      saveRepoEnvAction({ repositoryExternalId: "123", envContent: "KEY=value" }),
    ).resolves.toEqual({
      ok: false,
      message: "Only workspace admins can configure repository environments.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("deletes configurations and reports the removed repository id", async () => {
    const requests = stubApi(() =>
      Response.json({
        data: { repositoryExternalId: "123", deleted: true },
        meta: { apiVersion: "v1", protocolVersion: "1.0.0" },
      }),
    );

    await expect(deleteRepoConfigAction({ repositoryExternalId: "123" })).resolves.toEqual({
      ok: true,
      repositoryExternalId: "123",
    });
    const request = requests[0] as Request;
    expect(request.method).toBe("DELETE");
    expect(new URL(request.url).pathname).toBe("/v1/repo-configs/123");
    expect(revalidatePath).toHaveBeenCalledWith("/settings/repositories");
  });
});
