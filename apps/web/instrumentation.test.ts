import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureRequestError: vi.fn(),
  flush: vi.fn(async () => true),
  loggerError: vi.fn(),
  scope: {
    setContext: vi.fn(),
    setTag: vi.fn(),
  },
}));

vi.mock("@opencompany/observability", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.loggerError,
  }),
}));
vi.mock("@opencompany/telemetry/next", () => ({ registerNextObservability: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  captureRequestError: mocks.captureRequestError,
  flush: mocks.flush,
  withScope: (run: (scope: typeof mocks.scope) => void) => run(mocks.scope),
}));

import { onRequestError } from "./instrumentation";

describe("Next.js request error instrumentation", () => {
  beforeEach(() => {
    mocks.captureRequestError.mockReset();
    mocks.flush.mockClear();
    mocks.loggerError.mockReset();
    mocks.scope.setContext.mockReset();
    mocks.scope.setTag.mockReset();
  });

  it("records render context, digest, and a safe production probe id", async () => {
    const error = Object.assign(new Error("render failed"), { digest: "3642332288" });
    const request = {
      path: "/internal/observability/server-error",
      method: "GET",
      headers: { "x-opencompany-observability-probe-id": "probe_20260821" },
    };
    const context = {
      routerKind: "App Router" as const,
      routePath: "/internal/observability/server-error",
      routeType: "render" as const,
      renderSource: "server-rendering" as const,
      revalidateReason: undefined,
    };

    await onRequestError(error, request, context);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Next.js request failed",
      expect.objectContaining({
        event: "opencompany.web_request_failed",
        error_digest: "3642332288",
        observability_probe_id: "probe_20260821",
        route_path: "/internal/observability/server-error",
        route_type: "render",
      }),
    );
    expect(mocks.scope.setTag).toHaveBeenCalledWith("observability_probe_id", "probe_20260821");
    expect(mocks.scope.setContext).toHaveBeenCalledWith("nextjs_error", {
      digest: "3642332288",
    });
    expect(mocks.captureRequestError).toHaveBeenCalledWith(error, request, context);
    expect(mocks.flush).toHaveBeenCalledWith(2_000);
  });
});
