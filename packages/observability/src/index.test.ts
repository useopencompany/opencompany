import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureException,
  createLogger,
  endTimingTrace,
  errorToLogFields,
  flushObservability,
  sanitizeLogFields,
  setExceptionReporter,
  setObservabilityContext,
  startTimingTrace,
  timeAsync,
} from ".";

const originalEnv = { ...process.env };
const serverReleaseEnvKeys = [
  "VERCEL_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "RELEASE_SHA",
  "GITHUB_SHA",
  "OBSERVABILITY_RELEASE",
] as const;

beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of serverReleaseEnvKeys) {
    delete process.env[key];
  }
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setObservabilityContext(undefined);
  setExceptionReporter(undefined);
  process.env = originalEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createLogger", () => {
  it("emits structured JSON with required fields", () => {
    process.env.OBSERVABILITY_ENV = "test";
    process.env.OBSERVABILITY_RELEASE = "sha123";
    const logger = createLogger({ service: "opencompany-test", runtime: "server" });

    logger.info("Hello", { workspace_id: "wsp_123" });

    const line = vi.mocked(console.info).mock.calls[0]?.[0];
    expect(typeof line).toBe("string");
    const record = JSON.parse(line as string);
    expect(record).toMatchObject({
      level: "info",
      message: "Hello",
      "service.name": "opencompany-test",
      runtime: "server",
      environment: "test",
      release: "sha123",
      workspace_id: "wsp_123",
    });
    expect(record.timestamp).toEqual(expect.any(String));
  });

  it("filters logs below the configured level", () => {
    process.env.OBSERVABILITY_LOG_LEVEL = "warn";
    const logger = createLogger({ service: "opencompany-test" });

    logger.info("skip");
    logger.warn("keep");

    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("uses public observability env values in browser runtimes", () => {
    vi.stubGlobal("window", {});
    process.env.NEXT_PUBLIC_OBSERVABILITY_ENV = "preview";
    process.env.NEXT_PUBLIC_OBSERVABILITY_RELEASE = "client-sha";
    const logger = createLogger({ service: "opencompany-test", runtime: "browser" });

    logger.info("Hello from browser");

    const record = JSON.parse(vi.mocked(console.info).mock.calls[0]?.[0] as string);
    expect(record).toMatchObject({
      environment: "preview",
      release: "client-sha",
      runtime: "browser",
    });
  });

  it("prefers platform release metadata over explicit server release overrides", () => {
    process.env.OBSERVABILITY_RELEASE = "manual";
    process.env.VERCEL_GIT_COMMIT_SHA = "vercel-sha";
    const logger = createLogger({ service: "opencompany-test", runtime: "server" });

    logger.info("Hello from server");

    const record = JSON.parse(vi.mocked(console.info).mock.calls[0]?.[0] as string);
    expect(record).toMatchObject({
      release: "vercel-sha",
      runtime: "server",
    });
  });

  it("adds Render correlation fields to server logs", () => {
    process.env.RENDER_GIT_COMMIT = "render-sha";
    process.env.RENDER_SERVICE_ID = "srv_123";
    process.env.RENDER_INSTANCE_ID = "inst_123";
    const logger = createLogger({ service: "opencompany-test", runtime: "server" });

    logger.info("Hello from Render", { session_id: "ses_123" });

    const record = JSON.parse(vi.mocked(console.info).mock.calls[0]?.[0] as string);
    expect(record).toMatchObject({
      render_git_commit: "render-sha",
      render_service_id: "srv_123",
      render_instance_id: "inst_123",
      session_id: "ses_123",
    });
  });

  it("does not add Render correlation fields to browser logs", () => {
    vi.stubGlobal("window", {});
    process.env.RENDER_SERVICE_ID = "srv_123";
    const logger = createLogger({ service: "opencompany-test", runtime: "browser" });

    logger.info("Hello from browser");

    const record = JSON.parse(vi.mocked(console.info).mock.calls[0]?.[0] as string);
    expect(record).not.toHaveProperty("render_service_id");
  });
});

describe("sanitizeLogFields", () => {
  it("preserves canonical fields and redacts sensitive keys", () => {
    const fields = sanitizeLogFields({
      trace_id: "trc_123",
      session_id: "ses_123",
      apiKey: "secret",
      authorization: "Bearer secret",
      cookie: "session=secret",
      privateKey: "private",
      dsn: "https://token@example.com/1",
      nested: { streamTokenSecret: "secret" },
    });

    expect(fields).toEqual({
      trace_id: "trc_123",
      session_id: "ses_123",
      apiKey: "[redacted]",
      authorization: "[redacted]",
      cookie: "[redacted]",
      privateKey: "[redacted]",
      dsn: "[redacted]",
      nested: { streamTokenSecret: "[redacted]" },
    });
  });

  it("serializes errors and omits undefined values", () => {
    const error = new Error("boom");
    const fields = sanitizeLogFields({ error, keep: true, drop: undefined });

    expect(fields).toMatchObject({
      error: { name: "Error", message: "boom", stack: expect.any(String) },
      keep: true,
    });
    expect(fields).not.toHaveProperty("drop");
    expect(errorToLogFields(error)).toMatchObject({
      error: { name: "Error", message: "boom", stack: expect.any(String) },
    });
  });

  it("caps depth, arrays, and long strings", () => {
    const fields = sanitizeLogFields({
      nested: { a: { b: { c: { d: { e: "too deep" } } } } },
      items: Array.from({ length: 22 }, (_, index) => index),
      long: "x".repeat(2_010),
    });

    expect(fields.nested).toEqual({ a: { b: { c: { d: "[truncated]" } } } });
    expect(fields.items).toEqual([
      ...Array.from({ length: 20 }, (_, index) => index),
      "[... 2 more items]",
    ]);
    expect(fields.long).toEqual(expect.stringContaining("[truncated 10 chars]"));
  });
});

describe("timing helpers", () => {
  it("does not emit timing logs by default", () => {
    startTimingTrace("test.trace");

    expect(console.info).not.toHaveBeenCalled();
  });

  it("emits timing logs when enabled", async () => {
    process.env.OBSERVABILITY_TIMING = "1";
    const logger = createLogger({ service: "opencompany-test" });
    const trace = startTimingTrace("test.trace", { session_id: "ses_123" }, { logger });

    await timeAsync(trace, "step", async () => "ok");
    endTimingTrace(trace, { status: "done" });

    expect(console.info).toHaveBeenCalledTimes(3);
    const first = JSON.parse(vi.mocked(console.info).mock.calls[0]?.[0] as string);
    expect(first).toMatchObject({
      message: "Timing trace",
      event: "opencompany.timing",
      trace: "test.trace",
      step: "start",
      session_id: "ses_123",
      "service.name": "opencompany-test",
    });
  });
});

describe("captureException", () => {
  it("passes sanitized fields to the configured reporter", () => {
    const reporter = {
      captureException: vi.fn(),
    };
    setExceptionReporter(reporter);

    const error = new Error("boom");
    captureException(error, {
      session_id: "ses_123",
      apiKey: "secret",
    });

    expect(reporter.captureException).toHaveBeenCalledWith(error, {
      session_id: "ses_123",
      apiKey: "[redacted]",
    });
  });

  it("adds browser observability context to captures", () => {
    vi.stubGlobal("window", {});
    const reporter = {
      captureException: vi.fn(),
    };
    setExceptionReporter(reporter);
    setObservabilityContext({
      user_id: "usr_123",
      workspace_id: "wks_123",
      apiKey: "secret",
    });

    captureException(new Error("boom"), { event: "opencompany.test" });

    expect(reporter.captureException).toHaveBeenCalledWith(expect.any(Error), {
      user_id: "usr_123",
      workspace_id: "wks_123",
      apiKey: "[redacted]",
      event: "opencompany.test",
    });
  });

  it("lets explicit fields override browser observability context", () => {
    vi.stubGlobal("window", {});
    const reporter = {
      captureException: vi.fn(),
    };
    setExceptionReporter(reporter);
    setObservabilityContext({ user_id: "usr_123", workspace_id: "wks_123" });

    captureException(new Error("boom"), { workspace_id: "wks_override" });

    expect(reporter.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        user_id: "usr_123",
        workspace_id: "wks_override",
      }),
    );
  });

  it("falls back to structured logging when disabled", () => {
    process.env.OBSERVABILITY_ENABLED = "false";
    const reporter = {
      captureException: vi.fn(),
    };
    setExceptionReporter(reporter);

    captureException(new Error("boom"), { session_id: "ses_123" });

    expect(reporter.captureException).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
    const record = JSON.parse(vi.mocked(console.error).mock.calls[0]?.[0] as string);
    expect(record).toMatchObject({
      message: "Captured exception",
      session_id: "ses_123",
      observability_reporter: "local",
      error: { name: "Error", message: "boom" },
    });
  });

  it("does not throw when the reporter throws", () => {
    const reporter = {
      captureException: vi.fn(() => {
        throw new Error("reporter failed");
      }),
    };
    setExceptionReporter(reporter);

    expect(() => captureException(new Error("boom"))).not.toThrow();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("flushes the configured reporter", async () => {
    const reporter = {
      captureException: vi.fn(),
      flush: vi.fn(async () => true),
    };
    setExceptionReporter(reporter);

    await flushObservability();

    expect(reporter.flush).toHaveBeenCalledTimes(1);
  });
});
