import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationRuntimeSync } from "./ConversationRuntimeSync";

const mocks = vi.hoisted(() => ({
  hydrated: true,
  liveQuery: {
    data: [] as unknown[],
    isLoading: false,
    isError: false,
  },
  collection: {},
  getConversation: vi.fn(),
  getRuntimeStatus: vi.fn(async () => null),
}));

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: vi.fn(() => mocks.liveQuery),
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => mocks.hydrated,
}));

vi.mock("@/lib/headless-chat-collections", () => ({
  getHeadlessChatConversation: mocks.getConversation,
}));

vi.mock("@/lib/headless-chat-commands", () => ({
  getEngineRuntimeStatus: mocks.getRuntimeStatus,
}));

describe("ConversationRuntimeSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hydrated = true;
    mocks.liveQuery.data = [];
    mocks.liveQuery.isLoading = false;
    mocks.liveQuery.isError = false;
    mocks.getConversation.mockReturnValue(mocks.collection);
  });

  it("live-syncs only the viewed Conversation runtime through completion", async () => {
    const setRuntime = vi.fn();
    const setSandboxStatus = vi.fn();
    const running = {
      status: "running" as const,
      activeRunId: "run_1",
      hasError: false,
      updatedAt: "2026-08-19T10:00:00.000Z",
    };
    mocks.liveQuery.data = [
      {
        id: "conversation_1",
        runtime: running,
      },
    ];

    const { rerender } = render(
      <ConversationRuntimeSync
        conversationId="conversation_1"
        setRuntime={setRuntime}
        setSandboxStatus={setSandboxStatus}
        pollSandbox={false}
      />,
    );

    await waitFor(() => expect(setRuntime).toHaveBeenLastCalledWith(running));
    expect(mocks.getConversation).toHaveBeenCalledWith("conversation_1");

    const completed = {
      status: "idle" as const,
      activeRunId: null,
      hasError: false,
      updatedAt: "2026-08-19T10:01:00.000Z",
    };
    mocks.liveQuery.data = [
      {
        id: "conversation_1",
        runtime: completed,
      },
    ];
    rerender(
      <ConversationRuntimeSync
        conversationId="conversation_1"
        setRuntime={setRuntime}
        setSandboxStatus={setSandboxStatus}
        pollSandbox={false}
      />,
    );

    await waitFor(() => expect(setRuntime).toHaveBeenLastCalledWith(completed));
  });

  it("preserves the server runtime snapshot when detail sync is unavailable", () => {
    mocks.liveQuery.isError = true;
    const setRuntime = vi.fn();

    render(
      <ConversationRuntimeSync
        conversationId="conversation_1"
        setRuntime={setRuntime}
        setSandboxStatus={vi.fn()}
        pollSandbox={false}
      />,
    );

    expect(setRuntime).not.toHaveBeenCalled();
  });
});
