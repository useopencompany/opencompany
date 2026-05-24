import { isObservabilityEnabled, setExceptionReporter } from "@opencompany/observability";
import * as Sentry from "@sentry/nextjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "./instrumentation";

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
  },
  scope: {
    setContext: vi.fn(),
    setTag: vi.fn(),
    setUser: vi.fn(),
  },
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => mocks.logger),
  isObservabilityEnabled: vi.fn(),
  setExceptionReporter: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
  init: vi.fn(),
  withScope: vi.fn((run: (scope: typeof mocks.scope) => void) => run(mocks.scope)),
}));

const isObservabilityEnabledMock = vi.mocked(isObservabilityEnabled);
const setExceptionReporterMock = vi.mocked(setExceptionReporter);
const sentryInitMock = vi.mocked(Sentry.init);

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.BETTER_STACK_ERRORS_DSN;
  delete process.env.NEXT_PUBLIC_BETTER_STACK_ERRORS_DSN;
  process.env.NEXT_RUNTIME = "nodejs";
  isObservabilityEnabledMock.mockReturnValue(true);
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = originalEnv;
});

describe("server observability instrumentation", () => {
  it("logs when the server reporter is registered", async () => {
    process.env.BETTER_STACK_ERRORS_DSN = "https://server.example/123";

    await register();

    expect(sentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://server.example/123",
        tracesSampleRate: 0,
      }),
    );
    expect(setExceptionReporterMock).toHaveBeenCalledOnce();
    expect(mocks.logger.info).toHaveBeenCalledWith("Registered server observability reporter", {
      event: "opencompany.observability_reporter_registered",
      next_runtime: "nodejs",
      has_server_dsn: true,
      has_public_dsn: false,
    });
  });

  it("logs a skipped registration when observability is disabled", async () => {
    process.env.BETTER_STACK_ERRORS_DSN = "https://server.example/123";
    isObservabilityEnabledMock.mockReturnValue(false);

    await register();

    expect(sentryInitMock).not.toHaveBeenCalled();
    expect(setExceptionReporterMock).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "Skipped server observability reporter registration",
      {
        event: "opencompany.observability_reporter_skipped",
        reason: "observability_disabled",
        next_runtime: "nodejs",
        has_server_dsn: true,
        has_public_dsn: false,
      },
    );
  });

  it("logs a skipped registration when no DSN is configured", async () => {
    await register();

    expect(sentryInitMock).not.toHaveBeenCalled();
    expect(setExceptionReporterMock).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "Skipped server observability reporter registration",
      {
        event: "opencompany.observability_reporter_skipped",
        reason: "missing_dsn",
        next_runtime: "nodejs",
        has_server_dsn: false,
        has_public_dsn: false,
      },
    );
  });

  it("logs a skipped registration outside the node runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    process.env.BETTER_STACK_ERRORS_DSN = "https://server.example/123";

    await register();

    expect(sentryInitMock).not.toHaveBeenCalled();
    expect(setExceptionReporterMock).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "Skipped server observability reporter registration",
      {
        event: "opencompany.observability_reporter_skipped",
        reason: "non_node_runtime",
        next_runtime: "edge",
        has_server_dsn: true,
        has_public_dsn: false,
      },
    );
  });
});
