import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHeadlessChatTranscript } from "./useHeadlessChatTranscript";

const mocks = vi.hoisted(() => {
  const listeners = {
    messages: null as (() => void) | null,
    runs: null as (() => void) | null,
  };
  const messagesCollection = {
    status: "ready",
    rows: [] as unknown[],
    startSyncImmediate: vi.fn(),
    subscribeChanges: vi.fn((listener: () => void) => {
      listeners.messages = listener;
      return { unsubscribe: vi.fn() };
    }),
    values() {
      return this.rows.values();
    },
  };
  const runsCollection = {
    status: "ready",
    rows: [] as unknown[],
    startSyncImmediate: vi.fn(),
    subscribeChanges: vi.fn((listener: () => void) => {
      listeners.runs = listener;
      return { unsubscribe: vi.fn() };
    }),
    values() {
      return this.rows.values();
    },
  };
  return {
    hydrated: true,
    listeners,
    messagesCollection,
    runsCollection,
    getHeadlessChatMessages: vi.fn(() => messagesCollection),
    getHeadlessChatRuns: vi.fn(() => runsCollection),
  };
});

vi.mock("@/components/useHydrated", () => ({
  useHydrated: () => mocks.hydrated,
}));

vi.mock("@/lib/headless-chat-collections", () => ({
  getHeadlessChatMessages: mocks.getHeadlessChatMessages,
  getHeadlessChatRuns: mocks.getHeadlessChatRuns,
}));

describe("useHeadlessChatTranscript", () => {
  beforeEach(() => {
    mocks.hydrated = true;
    mocks.messagesCollection.status = "ready";
    mocks.messagesCollection.rows = [];
    mocks.runsCollection.status = "ready";
    mocks.runsCollection.rows = [];
    mocks.listeners.messages = null;
    mocks.listeners.runs = null;
    vi.clearAllMocks();
  });

  it("returns rows from an already-ready collection on the first render", () => {
    mocks.messagesCollection.rows = [
      {
        id: "message_2",
        conversationId: "chat_1",
        role: "assistant",
        content: "Ready immediately",
        taskId: null,
        presentation: null,
        attachments: null,
        createdAt: "2026-08-19T10:00:01.000Z",
        updatedAt: "2026-08-19T10:00:01.000Z",
      },
      {
        id: "message_1",
        conversationId: "chat_1",
        role: "user",
        content: "Open this chat",
        taskId: null,
        presentation: null,
        attachments: null,
        createdAt: "2026-08-19T10:00:00.000Z",
        updatedAt: "2026-08-19T10:00:00.000Z",
      },
    ];
    mocks.runsCollection.rows = [
      {
        id: "run_1",
        conversationId: "chat_1",
        triggerMessageId: "message_1",
        assistantMessageId: "message_2",
        status: "completed",
        engine: "opencompany",
        model: "anthropic/claude-sonnet-5",
        attemptCount: 1,
        error: null,
        createdAt: "2026-08-19T10:00:00.500Z",
        updatedAt: "2026-08-19T10:00:01.000Z",
      },
    ];

    const { result } = renderHook(() => useHeadlessChatTranscript("chat_1"));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.messages.map((message) => message.id)).toEqual([
      "message_1",
      "message_2",
    ]);
    expect(result.current.messages[1]?.metadata).toMatchObject({
      runId: "run_1",
      model: "anthropic/claude-sonnet-5",
    });
    expect(result.current.runsById.get("run_1")).toMatchObject({
      status: "completed",
      assistantMessageId: "message_2",
    });
  });

  it("does not create Electric collections before hydration", () => {
    mocks.hydrated = false;

    const { result } = renderHook(() => useHeadlessChatTranscript("chat_1"));

    expect(result.current.isLoading).toBe(true);
    expect(mocks.getHeadlessChatMessages).not.toHaveBeenCalled();
    expect(mocks.getHeadlessChatRuns).not.toHaveBeenCalled();
  });

  it("publishes a cold collection as soon as its first snapshot is ready", () => {
    mocks.messagesCollection.status = "loading";
    const { result } = renderHook(() => useHeadlessChatTranscript("chat_1"));

    expect(result.current.isLoading).toBe(true);

    act(() => {
      mocks.messagesCollection.status = "ready";
      mocks.messagesCollection.rows = [
        {
          id: "message_1",
          conversationId: "chat_1",
          role: "user",
          content: "Loaded",
          taskId: null,
          presentation: null,
          attachments: null,
          createdAt: "2026-08-19T10:00:00.000Z",
          updatedAt: "2026-08-19T10:00:00.000Z",
        },
      ];
      mocks.listeners.messages?.();
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.messages[0]?.parts).toEqual([{ type: "text", text: "Loaded" }]);
  });

  it("keeps the last resolved transcript while the collection reloads", () => {
    mocks.messagesCollection.rows = [
      {
        id: "message_1",
        conversationId: "chat_1",
        role: "assistant",
        content: "Existing answer",
        taskId: null,
        presentation: null,
        attachments: null,
        createdAt: "2026-08-19T10:00:00.000Z",
        updatedAt: "2026-08-19T10:00:00.000Z",
      },
    ];
    const { result } = renderHook(() => useHeadlessChatTranscript("chat_1"));

    expect(result.current.messages[0]?.parts).toEqual([{ type: "text", text: "Existing answer" }]);

    act(() => {
      mocks.messagesCollection.status = "loading";
      mocks.messagesCollection.rows = [];
      mocks.listeners.messages?.();
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.messages[0]?.parts).toEqual([{ type: "text", text: "Existing answer" }]);

    act(() => {
      mocks.messagesCollection.status = "ready";
      mocks.messagesCollection.rows = [
        {
          id: "message_1",
          conversationId: "chat_1",
          role: "assistant",
          content: "Existing answer",
          taskId: null,
          presentation: null,
          attachments: null,
          createdAt: "2026-08-19T10:00:00.000Z",
          updatedAt: "2026-08-19T10:00:00.000Z",
        },
        {
          id: "message_2",
          conversationId: "chat_1",
          role: "user",
          content: "Follow up",
          taskId: null,
          presentation: null,
          attachments: null,
          createdAt: "2026-08-19T10:00:01.000Z",
          updatedAt: "2026-08-19T10:00:01.000Z",
        },
      ];
      mocks.listeners.messages?.();
    });

    expect(result.current.messages.map((message) => message.id)).toEqual([
      "message_1",
      "message_2",
    ]);
  });

  it("provides a stable empty snapshot during server rendering", () => {
    mocks.hydrated = false;

    function TranscriptProbe() {
      const transcript = useHeadlessChatTranscript("chat_1");
      return <div>{transcript.messages.length}</div>;
    }

    expect(renderToString(<TranscriptProbe />)).toContain(">0<");
  });
});
