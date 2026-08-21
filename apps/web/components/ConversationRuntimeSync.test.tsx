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
  getEngineSession: vi.fn(),
  getRuntimeStatus: vi.fn(async () => null),
}));

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: vi.fn(() => mocks.liveQuery),
}));

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => mocks.hydrated,
}));

vi.mock("@/lib/headless-chat-collections", () => ({
  getHeadlessChatEngineSession: mocks.getEngineSession,
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
    mocks.getEngineSession.mockReturnValue(mocks.collection);
  });

  it("live-syncs only the viewed Conversation runtime through completion", async () => {
    const setRuntime = vi.fn();
    const setSandboxStatus = vi.fn();
    const lastSyncedRuntime = () => {
      const update = setRuntime.mock.lastCall?.[0];
      return typeof update === "function" ? update(null) : update;
    };
    mocks.liveQuery.data = [
      {
        conversationId: "conversation_1",
        engine: "codex",
        status: "running",
        activeRunId: "run_1",
        error: null,
        updatedAt: "2026-08-19T10:00:00.000Z",
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

    await waitFor(() =>
      expect(lastSyncedRuntime()).toEqual({
        status: "running",
        activeRunId: "run_1",
        hasError: false,
        updatedAt: "2026-08-19T10:00:00.000Z",
      }),
    );
    expect(mocks.getEngineSession).toHaveBeenCalledWith("conversation_1");

    mocks.liveQuery.data = [
      {
        conversationId: "conversation_1",
        engine: "codex",
        status: "failed",
        activeRunId: null,
        error: "sandbox lease lost",
        updatedAt: "2026-08-19T10:01:00.000Z",
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

    await waitFor(() =>
      expect(lastSyncedRuntime()).toEqual({
        status: "failed",
        activeRunId: null,
        hasError: true,
        updatedAt: "2026-08-19T10:01:00.000Z",
      }),
    );
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
