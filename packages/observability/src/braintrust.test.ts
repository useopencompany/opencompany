import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const braintrust = vi.hoisted(() => ({
  currentSpan: vi.fn(() => ({ log: vi.fn() })),
  flush: vi.fn(async () => {}),
  initLogger: vi.fn(),
  traced: vi.fn(async (callback: (span: { log: (fields: unknown) => void }) => unknown) =>
    callback({ log: vi.fn() }),
  ),
  wrapAISDK: vi.fn((aiSDK: object) => ({ ...aiSDK, wrapped: true })),
}));

vi.mock("braintrust", () => braintrust);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  braintrust.initLogger.mockReturnValue({
    traced: vi.fn(async (callback: (span: { log: (fields: unknown) => void }) => unknown) =>
      callback({ log: vi.fn() }),
    ),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Braintrust tracing", () => {
  it("stays disabled when the API key is missing", async () => {
    vi.stubEnv("BRAINTRUST_ENABLED", "true");
    vi.stubEnv("BRAINTRUST_API_KEY", "");
    const { getBraintrustAISDK, getBraintrustLogger, isBraintrustTracingEnabled } = await import(
      "./braintrust"
    );
    const aiSDK = { streamText: vi.fn() };

    expect(isBraintrustTracingEnabled()).toBe(false);
    expect(getBraintrustLogger()).toBeNull();
    expect(getBraintrustAISDK(aiSDK)).toBe(aiSDK);
    expect(braintrust.initLogger).not.toHaveBeenCalled();
    expect(braintrust.wrapAISDK).not.toHaveBeenCalled();
  });

  it("initializes once and wraps the AI SDK when enabled", async () => {
    vi.stubEnv("BRAINTRUST_ENABLED", "true");
    vi.stubEnv("BRAINTRUST_API_KEY", "bt_test");
    vi.stubEnv("BRAINTRUST_PROJECT_ID", "");
    vi.stubEnv("BRAINTRUST_PROJECT_NAME", "Runner Tests");
    const { getBraintrustAISDK, getBraintrustLogger } = await import("./braintrust");
    const aiSDK = { streamText: vi.fn() };

    const firstLogger = getBraintrustLogger();
    const secondLogger = getBraintrustLogger();
    const firstWrapped = getBraintrustAISDK(aiSDK);
    const secondWrapped = getBraintrustAISDK(aiSDK);

    expect(firstLogger).toBe(secondLogger);
    expect(braintrust.initLogger).toHaveBeenCalledTimes(1);
    expect(braintrust.initLogger).toHaveBeenCalledWith({
      projectName: "Runner Tests",
      apiKey: "bt_test",
      setCurrent: false,
    });
    expect(braintrust.wrapAISDK).toHaveBeenCalledTimes(1);
    expect(firstWrapped).toEqual(expect.objectContaining({ wrapped: true }));
    expect(secondWrapped).toBe(firstWrapped);
  });

  it("prefers project id over project name", async () => {
    vi.stubEnv("BRAINTRUST_ENABLED", "true");
    vi.stubEnv("BRAINTRUST_API_KEY", "bt_test");
    vi.stubEnv("BRAINTRUST_PROJECT_ID", "project_123");
    vi.stubEnv("BRAINTRUST_PROJECT_NAME", "Runner Tests");
    const { getBraintrustLogger } = await import("./braintrust");

    getBraintrustLogger();

    expect(braintrust.initLogger).toHaveBeenCalledWith({
      projectId: "project_123",
      apiKey: "bt_test",
      setCurrent: false,
    });
  });
});
