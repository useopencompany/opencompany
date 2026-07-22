import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GoatAppDataProvider,
  type GoatAppInitialData,
  useGoatAppData,
} from "@/components/GoatAppDataProvider";

const mocks = vi.hoisted(() => {
  const liveQueryResult = { data: [], isLoading: true };
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
});

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
    featureFlags: { taskSpawning: false, localCodexBridge: false },
    codexConnected: false,
    chatResumeEnabled: false,
    mcpSetup: { preferredClient: null, completedAt: null },
  };
}
