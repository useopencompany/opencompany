import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

class FakeBroadcastChannel extends EventTarget {
  static instances: FakeBroadcastChannel[] = [];
  readonly posted: unknown[] = [];

  constructor(readonly name: string) {
    super();
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(message: unknown) {
    this.posted.push(message);
  }

  close() {}
}

beforeAll(() => {
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
});

describe("cross-tab opencompany chat session state", () => {
  it("shows remote work as active, then falls back when that work finishes", async () => {
    const { clearAllLocalChatStates, setLocalChatState, useLocalChatStates } = await import(
      "@/lib/chat-session-state"
    );

    function Probe() {
      const states = useLocalChatStates();
      return <div data-testid="state">{states.get("goat_chat_1") ?? "done_unseen"}</div>;
    }

    render(<Probe />);
    const channel = FakeBroadcastChannel.instances.at(-1);
    expect(channel?.name).toBe("opencompany-goat-chat-session-state");
    expect(channel?.posted).toContainEqual(expect.objectContaining({ type: "request" }));

    act(() => {
      channel?.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "working",
            sourceId: "another-tab",
            sessionId: "goat_chat_1",
            active: true,
          },
        }),
      );
    });
    expect(screen.getByTestId("state")).toHaveTextContent("working");

    act(() => {
      channel?.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "working",
            sourceId: "third-tab",
            sessionId: "goat_chat_1",
            active: true,
          },
        }),
      );
    });

    act(() => {
      channel?.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "working",
            sourceId: "another-tab",
            sessionId: "goat_chat_1",
            active: false,
          },
        }),
      );
    });
    expect(screen.getByTestId("state")).toHaveTextContent("working");

    act(() => {
      channel?.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "working",
            sourceId: "third-tab",
            sessionId: "goat_chat_1",
            active: false,
          },
        }),
      );
    });
    expect(screen.getByTestId("state")).toHaveTextContent("done_unseen");

    setLocalChatState("goat_chat_2", "working");
    act(() => {
      channel?.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "request", sourceId: "new-tab" },
        }),
      );
    });
    expect(channel?.posted).toContainEqual({
      type: "working",
      sourceId: expect.any(String),
      sessionId: "goat_chat_2",
      active: true,
    });
    clearAllLocalChatStates();
  });
});
