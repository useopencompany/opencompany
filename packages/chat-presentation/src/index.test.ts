import type { PresentationDeltaFrameDto } from "@opencompany/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_PRESENTATION_STREAM_MAX_LENGTH,
  CHAT_PRESENTATION_STREAM_TTL_SECONDS,
  RedisChatPresentationStream,
} from "./index";

describe("Redis Chat presentation stream", () => {
  it("publishes with an exact length cap and a refreshed TTL", async () => {
    const xAdd = vi.fn();
    const expire = vi.fn();
    const exec = vi.fn(async () => []);
    const client = fakeClient({ xAdd, expire, exec });
    const stream = new RedisChatPresentationStream({
      url: "redis://test",
      createClient: () => client,
    });

    stream.publish(frame({ delta: "Hello", endOffset: 5 }));
    await eventually(() => expect(exec).toHaveBeenCalledOnce());

    expect(xAdd).toHaveBeenCalledWith(
      expect.stringMatching(/^opencompany:chat:presentation:v1:/u),
      "*",
      { frame: expect.stringContaining('"delta":"Hello"') },
      {
        TRIM: {
          strategy: "MAXLEN",
          strategyModifier: "=",
          threshold: CHAT_PRESENTATION_STREAM_MAX_LENGTH,
        },
      },
    );
    expect(expire).toHaveBeenCalledWith(expect.any(String), CHAT_PRESENTATION_STREAM_TTL_SECONDS);
    await stream.close();
  });

  it("degrades without throwing when Redis is unavailable at startup", async () => {
    const onError = vi.fn();
    const client = fakeClient({ connect: vi.fn(async () => Promise.reject(new Error("offline"))) });
    const stream = new RedisChatPresentationStream({
      url: "redis://offline",
      createClient: () => client,
      onError,
    });

    expect(() => stream.publish(frame())).not.toThrow();
    await eventually(() => expect(onError).toHaveBeenCalledOnce());
    await expect(stream.read({ runId: "run_1" })).resolves.toMatchObject({
      status: "unavailable",
      entries: [],
    });
    await stream.close();
  });

  it("coalesces queued deltas and recovers after a mid-stream failure", async () => {
    let clock = 0;
    const onError = vi.fn();
    const failing = fakeClient({
      exec: vi.fn(async () => Promise.reject(new Error("connection reset"))),
    });
    const healthyXAdd = vi.fn();
    const healthy = fakeClient({ xAdd: healthyXAdd });
    const createClient = vi.fn(() => (createClient.mock.calls.length === 1 ? failing : healthy));
    const stream = new RedisChatPresentationStream({
      url: "redis://test",
      createClient,
      now: () => clock,
      retryDelayMs: 10,
      onError,
    });

    stream.publish(frame({ delta: "A", endOffset: 1 }));
    await eventually(() => expect(onError).toHaveBeenCalledOnce());
    stream.publish(frame({ delta: "B", startOffset: 1, endOffset: 2 }));
    clock = 11;
    stream.publish(frame({ delta: "BC", startOffset: 1, endOffset: 3 }));
    await eventually(() => expect(createClient).toHaveBeenCalledTimes(2));
    await eventually(() =>
      expect(healthyXAdd).toHaveBeenCalledWith(
        expect.any(String),
        "*",
        { frame: expect.stringContaining('"delta":"BC"') },
        expect.any(Object),
      ),
    );
    await stream.close();
  });

  it("fails open when a connected Redis command stops responding", async () => {
    const onError = vi.fn();
    const stream = new RedisChatPresentationStream({
      url: "redis://stalled",
      createClient: () =>
        fakeClient({
          xRange: vi.fn(async () => new Promise<never>(() => undefined)),
        }),
      commandTimeoutMs: 5,
      onError,
    });

    await expect(stream.read({ runId: "run_1" })).resolves.toMatchObject({
      status: "unavailable",
      entries: [],
    });
    expect(onError).toHaveBeenCalledOnce();
    await stream.close();
  });

  it("does not let an invalid presentation frame fail the durable turn", async () => {
    const onError = vi.fn();
    const stream = new RedisChatPresentationStream({ url: "redis://test", onError });

    expect(() =>
      stream.publish(frame({ delta: "bad", startOffset: 0, endOffset: 2 })),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ operation: "publish" }));
    await stream.close();
  });
});

function frame(
  overrides: Partial<PresentationDeltaFrameDto["payload"]> = {},
): PresentationDeltaFrameDto {
  return {
    runId: "run_1",
    attemptNumber: 1,
    schemaVersion: 1,
    occurredAt: "2026-08-11T10:00:00.000Z",
    type: "message.presentation_delta",
    payload: {
      messageId: "message_1",
      startOffset: 0,
      endOffset: 1,
      delta: "A",
      ...overrides,
    },
  };
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  const transaction = {
    xAdd: vi.fn(),
    expire: vi.fn(),
    exec: vi.fn(async () => []),
  };
  return {
    on: vi.fn(),
    connect: vi.fn(async () => undefined),
    destroy: vi.fn(),
    multi: vi.fn(() => ({ ...transaction, ...overrides })),
    xRead: vi.fn(async () => null),
    xRange: vi.fn(async () => []),
    ...overrides,
  } as never;
}

async function eventually(assertion: () => void) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  assertion();
}
