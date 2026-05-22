import { describe, expect, it } from "vitest";
import {
  applyRuntimeEventToState,
  type RuntimeEvent,
  type SessionRuntimeState,
} from "./runtime-events";

function initialState(): SessionRuntimeState {
  return {
    events: [],
    messages: [{ id: "msg_user", role: "user", content: "Hi", status: "completed" }],
    currentStatus: "running",
    lastError: null,
  };
}

describe("applyRuntimeEventToState", () => {
  it("applies assistant message lifecycle events", () => {
    let state = initialState();

    state = applyRuntimeEventToState(state, event(1, "message.created", {
      messageId: "msg_assistant",
      role: "assistant",
    }));
    state = applyRuntimeEventToState(state, event(2, "message.delta", {
      messageId: "msg_assistant",
      delta: "Hello",
    }));
    state = applyRuntimeEventToState(state, event(3, "message.delta", {
      messageId: "msg_assistant",
      delta: " there",
    }));
    state = applyRuntimeEventToState(state, event(4, "message.completed", {
      messageId: "msg_assistant",
    }));

    expect(state.messages).toContainEqual({
      id: "msg_assistant",
      role: "assistant",
      content: "Hello there",
      status: "completed",
    });
  });

  it("does not apply duplicate event ids twice", () => {
    let state = initialState();
    state = applyRuntimeEventToState(state, event(1, "message.created", {
      messageId: "msg_assistant",
      role: "assistant",
    }));

    const delta = event(2, "message.delta", {
      messageId: "msg_assistant",
      delta: "A",
    });
    state = applyRuntimeEventToState(state, delta);
    state = applyRuntimeEventToState(state, delta);

    expect(state.messages.find((message) => message.id === "msg_assistant")?.content).toBe("A");
    expect(state.events.map((item) => item.id)).toEqual([1, 2]);
  });

  it("updates session status and error state", () => {
    let state = initialState();
    state = applyRuntimeEventToState(state, event(1, "session.error", { message: "Gateway down" }));
    expect(state.currentStatus).toBe("failed");
    expect(state.lastError).toBe("Gateway down");

    state = applyRuntimeEventToState(state, event(2, "session.status", { status: "running" }));
    expect(state.currentStatus).toBe("running");
    expect(state.lastError).toBeNull();
  });
});

function event(id: number, type: string, payload: Record<string, unknown>): RuntimeEvent {
  return { id, type, payload, messageId: null };
}
