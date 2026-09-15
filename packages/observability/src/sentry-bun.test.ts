import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureException, setExceptionReporter } from ".";
import { installBunExceptionReporter } from "./sentry-bun";

const sentry = vi.hoisted(() => {
  const scope = {
    setUser: vi.fn(),
    setContext: vi.fn(),
    setTag: vi.fn(),
  };
  return {
    scope,
    init: vi.fn(),
    withScope: vi.fn((run: (activeScope: object) => void) => run(scope)),
    captureException: vi.fn(),
    flush: vi.fn(async () => true),
  };
});

vi.mock("@sentry/bun", () => ({
  init: sentry.init,
  withScope: sentry.withScope,
  captureException: sentry.captureException,
  flush: sentry.flush,
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.BETTER_STACK_ERRORS_DSN;
  delete process.env.OBSERVABILITY_ENABLED;
  process.env.OBSERVABILITY_ENV = "test";
  process.env.OBSERVABILITY_RELEASE = "release-1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setExceptionReporter(undefined);
  vi.clearAllMocks();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("installBunExceptionReporter", () => {
  it("keeps the local fallback and logs once when no DSN is configured", () => {
    const installed = installBunExceptionReporter({ serviceName: "opencompany-api" });

    expect(installed).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("opencompany.error_reporting_disabled"),
    );

    captureException(new Error("boom"));
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"observability_reporter":"local"'),
    );
  });

  it("does nothing when observability is switched off", () => {
    process.env.OBSERVABILITY_ENABLED = "false";
    process.env.BETTER_STACK_ERRORS_DSN = "https://key@errors.example/1";

    expect(installBunExceptionReporter({ serviceName: "opencompany-api" })).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("initializes Sentry with the service identity and routes captured exceptions to it", () => {
    process.env.BETTER_STACK_ERRORS_DSN = " https://key@errors.example/1 ";

    const installed = installBunExceptionReporter({ serviceName: "opencompany-api" });

    expect(installed).toBe(true);
    expect(sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://key@errors.example/1",
        environment: "test",
        release: "release-1",
        serverName: "opencompany-api",
        initialScope: { tags: { service: "opencompany-api" } },
        sendDefaultPii: false,
        tracesSampleRate: 0,
      }),
    );

    const error = new Error("boom");
    captureException(error, {
      event: "opencompany.api_request_failed",
      user_id: "user_1",
      status: 500,
      api_key: "must-not-leak",
    });

    expect(sentry.captureException).toHaveBeenCalledWith(error);
    expect(sentry.scope.setUser).toHaveBeenCalledWith({ id: "user_1" });
    expect(sentry.scope.setTag).toHaveBeenCalledWith("event", "opencompany.api_request_failed");
    expect(sentry.scope.setTag).toHaveBeenCalledWith("status", "500");
    expect(sentry.scope.setTag).toHaveBeenCalledWith("api_key", "[redacted]");
    expect(sentry.scope.setContext).toHaveBeenCalledWith(
      "opencompany",
      expect.objectContaining({ api_key: "[redacted]", user_id: "user_1" }),
    );
  });

  it("sanitizes database exceptions before Sentry transports the event", () => {
    process.env.BETTER_STACK_ERRORS_DSN = "https://key@errors.example/1";
    installBunExceptionReporter({ serviceName: "opencompany-api" });
    const databaseError = Object.assign(
      new Error('duplicate key value violates unique constraint "tasks_pkey"'),
      {
        code: "23505",
        severity: "ERROR",
        schema: "goat",
        table: "tasks",
        constraint: "tasks_pkey",
        routine: "_bt_check_unique",
        detail: "Key (id)=(sensitive_task_id) already exists.",
        query: "SELECT secret FROM private_table",
        parameters: ["secret-value"],
      },
    );
    const error = new Error(
      "Failed query: SELECT secret FROM private_table WHERE id = $1\nparams: secret-value",
      { cause: databaseError },
    );

    const initOptions = sentry.init.mock.calls[0]?.[0];
    const event = initOptions?.beforeSend?.(
      {
        message: error.message,
        exception: {
          values: [
            { type: "Error", value: databaseError.message },
            {
              type: "Error",
              value: error.message,
              stacktrace: { frames: [{ filename: "repository.ts", vars: { parameters: [] } }] },
            },
          ],
        },
        extra: { query: databaseError.query, parameters: databaseError.parameters },
      },
      { originalException: error },
    );

    expect(event).toMatchObject({
      exception: { values: [{ type: "Error", value: "Database query failed" }] },
      contexts: {
        opencompany_error: {
          message: "Database query failed",
          cause: {
            code: "23505",
            severity: "ERROR",
            schema: "goat",
            table: "tasks",
            constraint: "tasks_pkey",
            routine: "_bt_check_unique",
          },
        },
      },
    });
    expect(event?.exception?.values?.[0]?.stacktrace?.frames?.[0]).not.toHaveProperty("vars");
    expect(JSON.stringify(event)).not.toMatch(
      /SELECT secret|sensitive_task_id|private_table|secret-value|detail|parameters/u,
    );
  });

  it("leaves process errors to the application without creating a second capture path", () => {
    process.env.BETTER_STACK_ERRORS_DSN = "https://key@errors.example/1";
    installBunExceptionReporter({
      serviceName: "opencompany-runner-goat",
      applicationOwnsProcessErrors: true,
    });

    const initOptions = sentry.init.mock.calls[0]?.[0];
    const integrations = initOptions?.integrations?.([
      { name: "Http" },
      { name: "OnUncaughtException" },
      { name: "OnUnhandledRejection" },
    ]);
    expect(integrations?.map((integration: { name: string }) => integration.name)).toEqual([
      "Http",
    ]);

    captureException(new Error("one process failure"), {
      event: "opencompany.runner_unhandled_rejection",
    });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
