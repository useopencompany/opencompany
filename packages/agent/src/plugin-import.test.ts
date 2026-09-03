import { describe, expect, it, vi } from "vitest";
import { resolvePluginImport } from "./plugin-import";

const resolvePluginMock = vi.hoisted(() => vi.fn());

vi.mock("@opencompany/agent-runtime", async () => {
  const actual = await vi.importActual<typeof import("@opencompany/agent-runtime")>(
    "@opencompany/agent-runtime",
  );
  return {
    ...actual,
    resolvePlugin: resolvePluginMock,
    createGitHubPluginFetcher: () => ({}) as never,
  };
});

describe("resolvePluginImport", () => {
  it("retains sanitized GitHub diagnostics as the unavailable error cause", async () => {
    const { GitHubArtifactFetchError } = await vi.importActual<
      typeof import("@opencompany/agent-runtime")
    >("@opencompany/agent-runtime");
    const upstreamError = new GitHubArtifactFetchError({
      operation: "resolve_commit",
      failureKind: "rate_limit",
      durationMs: 9,
      status: 403,
      rateLimitRemaining: 0,
    });
    resolvePluginMock.mockRejectedValueOnce(upstreamError);

    const error = await resolvePluginImport({ url: "https://github.com/o/r" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "unavailable",
      message: "Couldn't read that plugin right now. Check the URL and try again.",
      cause: upstreamError,
    });
  });

  it("does not retain arbitrary upstream errors that could contain secrets", async () => {
    resolvePluginMock.mockRejectedValueOnce(new Error("upstream token=do-not-expose"));

    const error = await resolvePluginImport({ url: "https://github.com/o/r" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "unavailable",
      message: "Couldn't read that plugin right now. Check the URL and try again.",
    });
    expect(error).not.toHaveProperty("cause");
  });
});
