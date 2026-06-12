import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStream } from "@/components/useSessionStream";
import type { SessionRuntimeState } from "@/lib/agent-sessions/runtime-events";
import type { SessionStreamStatus } from "@/lib/agent-sessions/session-stream";

// Verifies the hook's dead-stream recovery: a subscription that reports "error"
// (the consumer-level death signal from subscribeSessionStream) is torn down and
// re-opened — with a full replay, never seedFromEnd — when the tab regains
// visibility. A healthy subscription is never recycled by those signals.

type Handlers = {
  onState: (state: SessionRuntimeState) => void;
  onStatus?: (status: SessionStreamStatus) => void;
};

const subscribeMock = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; handlers: Handlers; options?: { seedFromEnd?: boolean } }>,
  unsubscribes: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock("@/lib/agent-sessions/session-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-sessions/session-stream")>();
  return {
    ...actual,
    subscribeSessionStream: (
      url: string,
      handlers: Handlers,
      options?: { seedFromEnd?: boolean },
    ) => {
      const call = { url, handlers, ...(options ? { options } : {}) };
      subscribeMock.calls.push(call);
      const unsubscribe = vi.fn();
      subscribeMock.unsubscribes.push(unsubscribe);
      return unsubscribe;
    },
  };
});

function lastHandlers(): Handlers {
  const call = subscribeMock.calls.at(-1);
  if (!call) throw new Error("subscribeSessionStream was never called");
  return call.handlers;
}

function fireVisibilityChange() {
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  subscribeMock.calls = [];
  subscribeMock.unsubscribes = [];
});

describe("useSessionStream — dead-stream recovery", () => {
  it("re-subscribes with a full replay when the tab becomes visible after the stream died", () => {
    const { result } = renderHook(() => useSessionStream("sess_1", { seedFromEnd: true }));
    expect(subscribeMock.calls).toHaveLength(1);
    expect(subscribeMock.calls[0]?.options?.seedFromEnd).toBe(true);

    // The subscription dies (e.g. the hidden-tab pause/resume race).
    act(() => lastHandlers().onStatus?.("error"));
    expect(result.current.status).toBe("error");

    // Tab regains visibility (jsdom is always "visible") → recovery kicks in.
    fireVisibilityChange();

    expect(subscribeMock.unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(subscribeMock.calls).toHaveLength(2);
    // Recovery must replay from "-1": the overlay was reset and the snapshot floor
    // may be stale, so tailing from the end would lose the missed turn.
    expect(subscribeMock.calls[1]?.options?.seedFromEnd).toBe(false);
    expect(result.current.status).toBe("connecting");
    // The overlay was reset — no leftovers from the dead subscription.
    expect(result.current.state.messages).toEqual([]);
    expect(result.current.state.events).toEqual([]);
  });

  it("does not recycle a healthy subscription on visibility changes", () => {
    renderHook(() => useSessionStream("sess_1", { seedFromEnd: true }));
    act(() => lastHandlers().onStatus?.("live"));

    fireVisibilityChange();

    expect(subscribeMock.calls).toHaveLength(1);
    expect(subscribeMock.unsubscribes[0]).not.toHaveBeenCalled();
  });

  it("recovers via window focus and online signals too", () => {
    const { result } = renderHook(() => useSessionStream("sess_1", {}));
    act(() => lastHandlers().onStatus?.("error"));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(subscribeMock.calls).toHaveLength(2);
    expect(result.current.status).toBe("connecting");

    // Still connecting (not error) — a second signal must not thrash.
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(subscribeMock.calls).toHaveLength(2);
  });

  it("resets the recovery generation when the session changes", () => {
    const { rerender } = renderHook(({ sessionId }) => useSessionStream(sessionId, {}), {
      initialProps: { sessionId: "sess_1" },
    });
    act(() => lastHandlers().onStatus?.("error"));
    fireVisibilityChange();
    expect(subscribeMock.calls).toHaveLength(2);

    rerender({ sessionId: "sess_2" });
    expect(subscribeMock.calls).toHaveLength(3);
    expect(subscribeMock.calls[2]?.url).toContain("sess_2");
  });
});
