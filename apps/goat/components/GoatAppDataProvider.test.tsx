import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GoatAppDataProvider,
  type GoatAppInitialData,
  useGoatAppData,
} from "@/components/GoatAppDataProvider";

const mocks = vi.hoisted(() => {
  const liveQueryResult: { data: unknown[]; isLoading: boolean } = {
    data: [],
    isLoading: true,
  };
  return {
    useLiveQuery: vi.fn(() => liveQueryResult),
  };
});

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: mocks.useLiveQuery,
}));

vi.mock("@/lib/task-collections", () => ({
  createGoatCollections: () => ({
    tasks: {},
    taskSchedules: {},
    chatSessions: {},
    codexChatSessions: {},
    integrations: {},
  }),
}));

describe("GoatAppDataProvider", () => {
  beforeEach(() => {
    mocks.useLiveQuery.mockClear();
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
    workspaces: [],
    workspaceMembers: [],
    brains: [],
    activeBrain: null,
    tasks: [],
    schedules: [],
    recentChats: [],
    integrations: {} as GoatAppInitialData["integrations"],
    featureFlags: { taskSpawning: false },
    codexConnected: false,
    claudeCodeConnected: false,
    chatResumeEnabled: false,
    mcpSetup: { preferredClient: null, completedAt: null },
  };
}
