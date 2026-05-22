import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionEventStream } from "./useSessionEventStream";

class MockEventSource {
  static instances: MockEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readyState = MockEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (message: MessageEvent) => void>();

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (message: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  vi.useFakeTimers();
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  setVisibility("visible");
});

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  setVisibility("visible");
  vi.useRealTimers();
});

describe("useSessionEventStream", () => {
  it("does not show a stale stream warning while the page is hidden", () => {
    setVisibility("hidden");
    const { result } = renderHook(() =>
      useSessionEventStream({
        runnerUrl: "http://localhost:3040",
        streamToken: "token",
        sessionId: "ses_123",
        afterId: 10,
        knownEventIds: [],
        onEvent: vi.fn(),
      }),
    );

    act(() => {
      vi.runOnlyPendingTimers();
      MockEventSource.instances[0]?.onerror?.();
      vi.advanceTimersByTime(15_000);
    });

    expect(result.current.status).toBe("idle");

    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      vi.runOnlyPendingTimers();
    });

    expect(result.current.status).toBe("connecting");

    act(() => {
      const source = MockEventSource.instances[0];
      if (source) source.readyState = MockEventSource.OPEN;
      source?.onopen?.();
    });

    expect(result.current.status).toBe("open");
  });

  it("still escalates visible stream errors to stale", () => {
    const { result } = renderHook(() =>
      useSessionEventStream({
        runnerUrl: "http://localhost:3040",
        streamToken: "token",
        sessionId: "ses_123",
        afterId: 10,
        knownEventIds: [],
        onEvent: vi.fn(),
      }),
    );

    act(() => {
      vi.runOnlyPendingTimers();
      MockEventSource.instances[0]?.onerror?.();
    });

    expect(result.current.status).toBe("error");

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current.status).toBe("stale");
  });
});

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}
