import { act, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDataProvider, type AppInitialData, useAppData } from "@/components/AppDataProvider";
import {
  addOptimisticChatSummary,
  clearAllOptimisticChatSummaries,
} from "@/lib/optimistic-chat-summaries";

const mocks = vi.hoisted(() => {
  const liveQueryResult: { data: unknown[]; isLoading: boolean } = {
    data: [],
    isLoading: true,
  };
  return {
    liveQueryResult,
    getHeadlessChatConversations: vi.fn(() => ({})),
    preloadHeadlessChatMessages: vi.fn(async (conversationId: string) => {
      void conversationId;
    }),
    getHeadlessIntegrationAccounts: vi.fn(() => ({})),
    getHeadlessTaskSchedules: vi.fn(() => ({})),
    getHeadlessTasks: vi.fn(() => ({})),
    listLegacyTaskCompatibility: vi.fn(async () => []),
    useLiveQuery: vi.fn(() => liveQueryResult),
  };
});

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: mocks.useLiveQuery,
}));

vi.mock("@/lib/headless-chat-collections", () => ({
  getHeadlessChatConversations: mocks.getHeadlessChatConversations,
  preloadHeadlessChatMessages: mocks.preloadHeadlessChatMessages,
}));

vi.mock("@/lib/headless-integration-collections", () => ({
  getHeadlessIntegrationAccounts: mocks.getHeadlessIntegrationAccounts,
}));

vi.mock("@/lib/headless-automation-collections", () => ({
  getHeadlessTaskSchedules: mocks.getHeadlessTaskSchedules,
}));

vi.mock("@/lib/headless-task-collections", () => ({
  getHeadlessTasks: mocks.getHeadlessTasks,
  legacyTaskDtoToRow: vi.fn((task) => task),
  taskReadModelToRow: vi.fn((task) => task),
}));

vi.mock("@/lib/headless-task-commands", () => ({
  listLegacyTaskCompatibility: mocks.listLegacyTaskCompatibility,
}));

describe("AppDataProvider", () => {
  beforeEach(() => {
    mocks.getHeadlessTasks.mockClear();
    mocks.getHeadlessTaskSchedules.mockClear();
    mocks.getHeadlessIntegrationAccounts.mockClear();
    mocks.preloadHeadlessChatMessages.mockClear();
    mocks.listLegacyTaskCompatibility.mockClear();
    mocks.useLiveQuery.mockReset();
    mocks.useLiveQuery.mockImplementation(() => mocks.liveQueryResult);
  });

  afterEach(() => {
    clearAllOptimisticChatSummaries();
  });

  it("server-renders from initial data without starting live queries", () => {
    const html = renderToString(
      <AppDataProvider initialData={initialData()}>
        <DataProbe />
      </AppDataProvider>,
    );

    expect(html).toContain("louis@example.com:0");
    expect(mocks.useLiveQuery).not.toHaveBeenCalled();
  });

  it("starts live queries in the browser", () => {
    render(
      <AppDataProvider initialData={initialData()}>
        <DataProbe />
      </AppDataProvider>,
    );

    expect(mocks.useLiveQuery).toHaveBeenCalled();
    expect(mocks.getHeadlessTaskSchedules).not.toHaveBeenCalled();
  });

  it("preloads only the first eight sidebar transcripts after live conversations are ready", async () => {
    const now = Date.now();
    const chatRows = Array.from({ length: 10 }, (_, index) => ({
      id: `chat_preload_${index}`,
      title: `Chat ${index}`,
      model: "anthropic/claude-sonnet-5",
      engine: "opencompany" as const,
      archivedAt: null,
      pinnedAt: null,
      lastSeenAt: null,
      activityState: "idle" as const,
      hasUnseen: false,
      createdAt: new Date(now - index * 1_000).toISOString(),
      updatedAt: new Date(now - index * 1_000).toISOString(),
    }));
    const perCollection = [
      { data: [], isLoading: true },
      { data: [], isLoading: true },
      { data: chatRows, isLoading: false },
      { data: [], isLoading: true },
    ];
    let call = 0;
    mocks.useLiveQuery.mockImplementation(() => {
      const result = perCollection[call % perCollection.length]!;
      call += 1;
      return result;
    });

    const data = initialData();
    data.workspace = {
      id: "workspace_preload",
      name: "Preload",
      role: "admin",
    };
    render(
      <AppDataProvider initialData={data}>
        <DataProbe />
      </AppDataProvider>,
    );

    await waitFor(() => expect(mocks.preloadHeadlessChatMessages).toHaveBeenCalledTimes(8));
    expect(mocks.preloadHeadlessChatMessages.mock.calls.map(([chatId]) => chatId)).toEqual(
      chatRows.slice(0, 8).map((chat) => chat.id),
    );
  });

  it("does not fan out transcript preloads from the server fallback", () => {
    const data = initialData();
    data.recentChats = [
      {
        id: "chat_server_fallback",
        title: "Server fallback",
        model: "anthropic/claude-sonnet-5",
        engine: "opencompany",
        codexComposerSettings: null,
        codexRuntime: null,
        preview: "Fallback",
        updatedAt: new Date().toISOString(),
        lastSeenAt: null,
        pinnedAt: null,
      },
    ];

    render(
      <AppDataProvider initialData={data}>
        <DataProbe />
      </AppDataProvider>,
    );

    expect(mocks.preloadHeadlessChatMessages).not.toHaveBeenCalled();
  });

  it("resubscribes Task reads when the active workspace changes", async () => {
    const first = initialData();
    first.featureFlags.taskSpawning = true;
    const { rerender } = render(
      <AppDataProvider initialData={first}>
        <DataProbe />
      </AppDataProvider>,
    );

    expect(mocks.getHeadlessTasks).toHaveBeenCalledWith("workspace_1");
    expect(mocks.getHeadlessTaskSchedules).toHaveBeenCalledWith("workspace_1");
    expect(mocks.getHeadlessIntegrationAccounts).toHaveBeenCalledWith("workspace_1");
    await waitFor(() => expect(mocks.listLegacyTaskCompatibility).toHaveBeenCalledTimes(1));

    rerender(
      <AppDataProvider
        initialData={{
          ...first,
          workspace: { id: "workspace_2", name: "Beta", role: "member" },
        }}
      >
        <DataProbe />
      </AppDataProvider>,
    );

    expect(mocks.getHeadlessTasks).toHaveBeenCalledWith("workspace_2");
    expect(mocks.getHeadlessTaskSchedules).toHaveBeenCalledWith("workspace_2");
    expect(mocks.getHeadlessIntegrationAccounts).toHaveBeenCalledWith("workspace_2");
    await waitFor(() => expect(mocks.listLegacyTaskCompatibility).toHaveBeenCalledTimes(2));
  });

  it("publishes a newly submitted background chat before its persisted row arrives", () => {
    render(
      <AppDataProvider initialData={initialData()}>
        <RecentChatTitleProbe onRender={() => {}} />
      </AppDataProvider>,
    );

    expect(screen.getByTestId("recent").textContent).toBe("empty");

    act(() => {
      addOptimisticChatSummary({
        workspaceId: "workspace_1",
        sessionId: "goat_chat_123e4567-e89b-42d3-a456-426614174000",
        prompt: "Research Q3 launch options",
        model: "anthropic/claude-sonnet-5",
        engine: "opencompany",
      });
    });

    expect(screen.getByTestId("recent").textContent).toBe("Research Q3 launch options");
  });

  it("uses the unified Conversation projection for Claude Code sidebar state", () => {
    const now = new Date().toISOString();
    const chatRow = {
      id: "goat_chat_claude_1",
      title: "Claude task",
      model: "anthropic/claude-sonnet-5",
      engine: "claude_code" as const,
      archivedAt: null,
      pinnedAt: null,
      lastSeenAt: now,
      activityState: "idle" as const,
      hasUnseen: false,
      createdAt: now,
      updatedAt: now,
    };
    // useLiveQuery is called once per collection per render, in a fixed order:
    // tasks, schedules, conversations, integrations. Only the Conversation
    // collection carries live data here; the rest stay loading so their memos
    // fall back to (empty) initial data instead of dereferencing it.
    const perCollection = [
      { data: [], isLoading: true },
      { data: [], isLoading: true },
      { data: [chatRow], isLoading: false },
      { data: [], isLoading: true },
    ];
    let call = 0;
    mocks.useLiveQuery.mockImplementation(() => {
      const result = perCollection[call % perCollection.length] ?? { data: [], isLoading: true };
      call += 1;
      return result;
    });

    render(
      <AppDataProvider initialData={initialData()}>
        <RecentChatsProbe />
      </AppDataProvider>,
    );

    expect(screen.getByTestId("recent").textContent).toBe("claude_code:idle:false");
    expect(screen.getByTestId("recent").getAttribute("data-chat-id")).toBe("goat_chat_claude_1");
  });

  it("keeps API-projected working chats in the recent list without a second live query", () => {
    const old = "2026-07-01T10:00:00.000Z";
    const chatRow = {
      id: "goat_chat_active_turn",
      title: "Lagging runtime",
      model: "anthropic/claude-sonnet-5",
      engine: "opencompany" as const,
      archivedAt: null,
      pinnedAt: null,
      lastSeenAt: "2026-07-01T09:59:00.000Z",
      activityState: "working" as const,
      hasUnseen: false,
      createdAt: old,
      updatedAt: old,
    };
    const perCollection = [
      { data: [], isLoading: false },
      { data: [], isLoading: false },
      { data: [chatRow], isLoading: false },
      { data: [], isLoading: true },
    ];
    let call = 0;
    mocks.useLiveQuery.mockImplementation(() => {
      const result = perCollection[call % perCollection.length] ?? { data: [], isLoading: false };
      call += 1;
      return result;
    });

    render(
      <AppDataProvider initialData={initialData()}>
        <RecentChatStateProbe />
      </AppDataProvider>,
    );

    expect(screen.getByTestId("recent").textContent).toBe("Lagging runtime:working");
    expect(screen.getByTestId("recent").getAttribute("data-chat-id")).toBe("goat_chat_active_turn");
  });

  it("keeps same-workspace live data during a server data refresh", () => {
    const now = new Date().toISOString();
    const chatRow = {
      id: "goat_chat_live",
      title: "Live chat",
      model: "anthropic/claude-sonnet-5",
      engine: "opencompany" as const,
      archivedAt: null,
      pinnedAt: null,
      lastSeenAt: now,
      activityState: "idle" as const,
      hasUnseen: false,
      createdAt: now,
      updatedAt: now,
    };
    const perCollection = [
      { data: [], isLoading: false },
      { data: [], isLoading: false },
      { data: [chatRow], isLoading: false },
      { data: [], isLoading: true },
    ];
    let call = 0;
    mocks.useLiveQuery.mockImplementation(() => {
      const result = perCollection[call % perCollection.length] ?? { data: [], isLoading: false };
      call += 1;
      return result;
    });

    const observations: string[] = [];
    const { rerender } = render(
      <AppDataProvider initialData={initialData()}>
        <RecentChatTitleProbe onRender={(value) => observations.push(value)} />
      </AppDataProvider>,
    );

    expect(screen.getByTestId("recent").textContent).toBe("Live chat");
    observations.length = 0;

    rerender(
      <AppDataProvider
        initialData={{
          ...initialData(),
          recentChats: [
            {
              id: "goat_chat_server",
              title: "Server refresh",
              model: "anthropic/claude-sonnet-5",
              engine: "opencompany",
              codexComposerSettings: null,
              codexRuntime: null,
              preview: "Stale server snapshot",
              updatedAt: now,
              lastSeenAt: now,
              pinnedAt: null,
            },
          ],
        }}
      >
        <RecentChatTitleProbe onRender={(value) => observations.push(value)} />
      </AppDataProvider>,
    );

    expect(screen.getByTestId("recent").textContent).toBe("Live chat");
    expect(observations).not.toContain("Server refresh");
  });
});

function RecentChatsProbe() {
  const data = useAppData();
  const chat = data.recentChats[0];
  return (
    <div data-testid="recent" data-chat-id={chat?.id}>
      {chat ? `${chat.engine}:${chat.activityState}:${String(chat.hasUnseen)}` : "empty"}
    </div>
  );
}

function RecentChatTitleProbe({ onRender }: { onRender: (value: string) => void }) {
  const data = useAppData();
  const title = data.recentChats[0]?.title ?? "empty";
  onRender(title);
  return <div data-testid="recent">{title}</div>;
}

function RecentChatStateProbe() {
  const data = useAppData();
  const chat = data.recentChats[0];
  return (
    <div data-testid="recent" data-chat-id={chat?.id}>
      {chat ? `${chat.title}:${chat.activityState}` : "empty"}
    </div>
  );
}

function DataProbe() {
  const data = useAppData();
  return <div>{`${data.user.email}:${data.archivedChats.length}`}</div>;
}

function initialData(): AppInitialData {
  return {
    user: {
      workosUserId: "user_1",
      email: "louis@example.com",
      firstName: "Louis",
      lastName: null,
      avatarUrl: null,
    },
    workspace: { id: "workspace_1", name: "Acme", role: "admin" },
    plan: "hobby",
    workspaces: [],
    workspaceMembers: [],
    brains: [],
    activeBrain: null,
    tasks: [],
    schedules: [],
    recentChats: [],
    integrations: {} as AppInitialData["integrations"],
    featureFlags: { taskSpawning: false, autoModelRouting: false, imessage: false, wiki: false },
    codexConnected: false,
    claudeCodeConnected: false,
    mcpSetup: { preferredClient: null, completedAt: null },
  };
}
