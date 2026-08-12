import { act, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GoatAppDataProvider,
  type GoatAppInitialData,
  useGoatAppData,
} from "@/components/GoatAppDataProvider";
import {
  addOptimisticGoatChatSummary,
  clearAllOptimisticGoatChatSummaries,
} from "@/lib/optimistic-chat-summaries";

const mocks = vi.hoisted(() => {
  const liveQueryResult: { data: unknown[]; isLoading: boolean } = {
    data: [],
    isLoading: true,
  };
  return {
    getHeadlessTaskSchedules: vi.fn(() => ({})),
    getHeadlessTasks: vi.fn(() => ({})),
    listLegacyTaskCompatibility: vi.fn(async () => []),
    useLiveQuery: vi.fn(() => liveQueryResult),
  };
});

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: mocks.useLiveQuery,
}));

vi.mock("@/lib/task-collections", () => ({
  createGoatCollections: () => ({
    tasks: {},
    chatSessions: {},
    codexChatSessions: {},
    integrations: {},
  }),
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

describe("GoatAppDataProvider", () => {
  beforeEach(() => {
    mocks.getHeadlessTasks.mockClear();
    mocks.getHeadlessTaskSchedules.mockClear();
    mocks.listLegacyTaskCompatibility.mockClear();
    mocks.useLiveQuery.mockClear();
  });

  afterEach(() => {
    clearAllOptimisticGoatChatSummaries();
  });

  it("server-renders from initial data without starting live queries", () => {
    const html = renderToString(
      <GoatAppDataProvider initialData={initialData()}>
        <DataProbe />
      </GoatAppDataProvider>,
    );

    expect(html).toContain("louis@example.com:0");
    expect(mocks.useLiveQuery).not.toHaveBeenCalled();
  });

  it("starts live queries in the browser", () => {
    render(
      <GoatAppDataProvider initialData={initialData()}>
        <DataProbe />
      </GoatAppDataProvider>,
    );

    expect(mocks.useLiveQuery).toHaveBeenCalled();
    expect(mocks.getHeadlessTaskSchedules).not.toHaveBeenCalled();
  });

  it("resubscribes Task reads when the active workspace changes", async () => {
    const first = initialData();
    first.featureFlags.taskSpawning = true;
    const { rerender } = render(
      <GoatAppDataProvider initialData={first}>
        <DataProbe />
      </GoatAppDataProvider>,
    );

    expect(mocks.getHeadlessTasks).toHaveBeenCalledWith("workspace_1");
    expect(mocks.getHeadlessTaskSchedules).toHaveBeenCalledWith("workspace_1");
    await waitFor(() => expect(mocks.listLegacyTaskCompatibility).toHaveBeenCalledTimes(1));

    rerender(
      <GoatAppDataProvider
        initialData={{
          ...first,
          workspace: { id: "workspace_2", name: "Beta", role: "member" },
        }}
      >
        <DataProbe />
      </GoatAppDataProvider>,
    );

    expect(mocks.getHeadlessTasks).toHaveBeenCalledWith("workspace_2");
    expect(mocks.getHeadlessTaskSchedules).toHaveBeenCalledWith("workspace_2");
    await waitFor(() => expect(mocks.listLegacyTaskCompatibility).toHaveBeenCalledTimes(2));
  });

  it("publishes a newly submitted background chat before its persisted row arrives", () => {
    render(
      <GoatAppDataProvider initialData={initialData()}>
        <RecentChatTitleProbe onRender={() => {}} />
      </GoatAppDataProvider>,
    );

    expect(screen.getByTestId("recent").textContent).toBe("empty");

    act(() => {
      addOptimisticGoatChatSummary({
        workspaceId: "workspace_1",
        sessionId: "goat_chat_123e4567-e89b-42d3-a456-426614174000",
        prompt: "Research Q3 launch options",
        model: "anthropic/claude-sonnet-5",
        engine: "opencompany",
      });
    });

    expect(screen.getByTestId("recent").textContent).toBe("Research Q3 launch options");
  });

  it("attaches codex_chat runtime to Claude Code chats so the home card is not stuck 'Connecting'", () => {
    const now = new Date().toISOString();
    const chatRow = {
      id: "goat_chat_claude_1",
      user_workos_id: "user_1",
      title: "Claude task",
      model: "anthropic/claude-sonnet-5",
      engine: "claude_code" as const,
      closed_at: null,
      pinned_at: null,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    };
    const runtimeRow = {
      id: "goat_codex_chat_1",
      user_workos_id: "user_1",
      chat_session_id: "goat_chat_claude_1",
      model: "claude-sonnet-5",
      sandbox_id: "sbx_1",
      codex_thread_id: null,
      active_turn_id: null,
      status: "idle" as const,
      error: null,
      created_at: now,
      updated_at: now,
    };
    // useLiveQuery is called once per collection per render, in a fixed order:
    // tasks, schedules, chatSessions, codexChatSessions, integrations. Only the
    // chat collections carry live data here; the rest stay loading so their memos
    // fall back to (empty) initial data instead of dereferencing it.
    const perCollection = [
      { data: [], isLoading: true },
      { data: [], isLoading: true },
      { data: [chatRow], isLoading: false },
      { data: [runtimeRow], isLoading: false },
      { data: [], isLoading: true },
    ];
    let call = 0;
    mocks.useLiveQuery.mockImplementation(() => {
      const result = perCollection[call % perCollection.length] ?? { data: [], isLoading: true };
      call += 1;
      return result;
    });

    render(
      <GoatAppDataProvider initialData={initialData()}>
        <RecentChatsProbe />
      </GoatAppDataProvider>,
    );

    // Before the fix this read "claude_code:null" (runtime dropped for non-codex
    // engines) which rendered as the null-runtime "Connecting" label.
    expect(screen.getByTestId("recent").textContent).toBe("claude_code:idle");
  });

  it("keeps active-turn runtimes in recent chats as working when status lags", () => {
    const now = new Date().toISOString();
    const old = "2026-07-01T10:00:00.000Z";
    const chatRow = {
      id: "goat_chat_active_turn",
      user_workos_id: "user_1",
      title: "Lagging runtime",
      model: "anthropic/claude-sonnet-5",
      engine: "opencompany" as const,
      kind: "chat" as const,
      closed_at: null,
      pinned_at: null,
      last_seen_at: "2026-07-01T09:59:00.000Z",
      created_at: old,
      updated_at: old,
    };
    const runtimeRow = {
      id: "goat_codex_chat_1",
      user_workos_id: "user_1",
      chat_session_id: "goat_chat_active_turn",
      model: "gpt-5.5",
      active_turn_id: "goat_codex_chat_turn_1",
      status: "idle" as const,
      error: null,
      created_at: now,
      updated_at: now,
    };
    const perCollection = [
      { data: [], isLoading: false },
      { data: [], isLoading: false },
      { data: [chatRow], isLoading: false },
      { data: [runtimeRow], isLoading: false },
      { data: [], isLoading: true },
    ];
    let call = 0;
    mocks.useLiveQuery.mockImplementation(() => {
      const result = perCollection[call % perCollection.length] ?? { data: [], isLoading: false };
      call += 1;
      return result;
    });

    render(
      <GoatAppDataProvider initialData={initialData()}>
        <RecentChatStateProbe />
      </GoatAppDataProvider>,
    );

    expect(screen.getByTestId("recent").textContent).toBe("Lagging runtime:working");
  });

  it("keeps same-workspace live data during a server data refresh", () => {
    const now = new Date().toISOString();
    const chatRow = {
      id: "goat_chat_live",
      user_workos_id: "user_1",
      title: "Live chat",
      model: "anthropic/claude-sonnet-5",
      engine: "opencompany" as const,
      kind: "chat" as const,
      closed_at: null,
      pinned_at: null,
      last_seen_at: now,
      created_at: now,
      updated_at: now,
    };
    const perCollection = [
      { data: [], isLoading: false },
      { data: [], isLoading: false },
      { data: [chatRow], isLoading: false },
      { data: [], isLoading: false },
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
      <GoatAppDataProvider initialData={initialData()}>
        <RecentChatTitleProbe onRender={(value) => observations.push(value)} />
      </GoatAppDataProvider>,
    );

    expect(screen.getByTestId("recent").textContent).toBe("Live chat");
    observations.length = 0;

    rerender(
      <GoatAppDataProvider
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
      </GoatAppDataProvider>,
    );

    expect(screen.getByTestId("recent").textContent).toBe("Live chat");
    expect(observations).not.toContain("Server refresh");
  });
});

function RecentChatsProbe() {
  const data = useGoatAppData();
  const chat = data.recentChats[0];
  return (
    <div data-testid="recent">
      {chat ? `${chat.engine}:${chat.codexRuntime?.status ?? "null"}` : "empty"}
    </div>
  );
}

function RecentChatTitleProbe({ onRender }: { onRender: (value: string) => void }) {
  const data = useGoatAppData();
  const title = data.recentChats[0]?.title ?? "empty";
  onRender(title);
  return <div data-testid="recent">{title}</div>;
}

function RecentChatStateProbe() {
  const data = useGoatAppData();
  const chat = data.recentChats[0];
  return <div data-testid="recent">{chat ? `${chat.title}:${chat.state}` : "empty"}</div>;
}

function DataProbe() {
  const data = useGoatAppData();
  return <div>{`${data.user.email}:${data.archivedChats.length}`}</div>;
}

function initialData(): GoatAppInitialData {
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
    integrations: {} as GoatAppInitialData["integrations"],
    featureFlags: { taskSpawning: false, autoModelRouting: false, imessage: false, wiki: false },
    codexConnected: false,
    claudeCodeConnected: false,
    chatResumeEnabled: false,
    mcpSetup: { preferredClient: null, completedAt: null },
  };
}
