import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchGoatChatStop } from "./chat-streams";

const redisMocks = vi.hoisted(() => ({
  get: vi.fn<() => Promise<string | null>>(),
  connect: vi.fn(async () => undefined),
}));

vi.mock("next/server", () => ({
  after: vi.fn(),
}));

vi.mock("redis", () => ({
  createClient: vi.fn(() => ({
    get: redisMocks.get,
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
    on: vi.fn(),
    connect: redisMocks.connect,
  })),
}));

describe("watchGoatChatStop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("REDIS_URL", "redis://goat.test");
    redisMocks.get.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps accepting explicit Stop requests throughout a long chat turn", async () => {
    const onStop = vi.fn();
    const cleanup = watchGoatChatStop("goat_chat_stream_1", onStop);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    redisMocks.get.mockResolvedValue("1");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onStop).toHaveBeenCalledOnce();
    cleanup();
  });
});
