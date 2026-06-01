import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ToastProvider";
import { WorkspaceProvider } from "@/components/WorkspaceContext";
import { updateAgent } from "@/lib/agents/actions";
import {
  type AgentDetailPayload,
  type AgentListItemPayload,
  agentQueryKeys,
  fetchAgent,
  fetchAgents,
} from "@/lib/agents/payload";
import AgentDetail from "./AgentDetail";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    prefetch: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock("next/link", () => ({
  default: (input: ComponentProps<"a"> & { prefetch?: boolean }) => {
    const { href, children, prefetch, ...props } = input;
    void prefetch;
    return (
      <a href={typeof href === "string" ? href : ""} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("@/lib/agents/actions", () => ({
  updateAgent: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/actions", () => ({
  createAgentSession: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/payload", () => ({
  seedSessionQueries: vi.fn(),
}));

vi.mock("@/lib/agents/payload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/payload")>();
  return {
    ...actual,
    fetchAgent: vi.fn(),
    fetchAgents: vi.fn(),
  };
});

const binding = {
  provider: "github" as const,
  resourceType: "repository" as const,
  externalId: "repo_123",
  displayName: "opencompany/web",
  connection: {
    externalId: "install_123",
    label: "OpenCompany",
    accountName: "opencompany",
    accountType: "Organization",
  },
};

const config: AgentConfig = {
  schemaVersion: "agent.v1",
  title: "Leo",
  instructions: "Use @opencompany/web for code changes.",
  model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
  tools: [],
  brain: [],
  integrations: {
    github: {
      repositories: [
        {
          id: "opencompany-web",
          fullName: "opencompany/web",
          defaultBranch: "main",
          binding,
        },
      ],
    },
  },
  triggers: [],
};

const listAgent: AgentListItemPayload = {
  id: "agt_123",
  workspaceId: "wks_123",
  path: "agents/leo.agent",
  name: "Leo",
  config,
  githubSyncStatus: "synced",
  githubSyncError: null,
  createdAt: "2026-05-24T10:00:00.000Z",
  updatedAt: "2026-05-24T10:10:00.000Z",
};

const detailAgent: AgentDetailPayload = {
  ...listAgent,
  body: "Use @opencompany/web for code changes.",
  content: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Use " },
          {
            type: "mention",
            attrs: {
              id: "integration:github:opencompany-web",
              label: "opencompany/web",
            },
          },
          { type: "text", text: " for code changes." },
        ],
      },
    ],
  },
  githubCommitSha: "abc123",
  githubSyncedAt: "2026-05-24T10:05:00.000Z",
  brainPaths: [],
  githubIntegrationRepositories: [
    {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "available",
      statusReason: null,
      connectionStatus: "connected",
      binding,
    },
  ],
  usableGitHubIntegrationRepositories: [
    {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "available",
      statusReason: null,
      connectionStatus: "connected",
      binding,
    },
  ],
  workspaceAgents: [{ path: "agents/research.agent", name: "Research" }],
  mcp: {
    mcpEnabled: false,
    linearConfigured: false,
    slackConfigured: false,
  },
};

const fetchAgentMock = vi.mocked(fetchAgent);
const fetchAgentsMock = vi.mocked(fetchAgents);
const updateAgentMock = vi.mocked(updateAgent);

const existingListAgent: AgentListItemPayload = {
  id: "agt_existing",
  workspaceId: "wks_123",
  path: "agents/research.agent",
  name: "Research",
  config,
  githubSyncStatus: "synced",
  githubSyncError: null,
  createdAt: "2026-05-20T10:00:00.000Z",
  updatedAt: "2026-05-20T10:10:00.000Z",
};

function renderWithProviders(ui: ReactNode, queryClient = createQueryClient()) {
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceProvider workspaceId="wks_123">
          <ToastProvider>{ui}</ToastProvider>
        </WorkspaceProvider>
      </QueryClientProvider>,
    ),
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

describe("AgentDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("does not mount the editor from list-cache data", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(agentQueryKeys.list("wks_123"), [listAgent]);
    fetchAgentMock.mockReturnValue(new Promise(() => {}) as Promise<AgentDetailPayload>);

    renderWithProviders(<AgentDetail idOrPath="agents/leo.agent" />, queryClient);

    expect(screen.getByRole("status", { name: /loading agent/i })).toBeInTheDocument();
    expect(screen.queryByText("@opencompany/web")).not.toBeInTheDocument();
    await waitFor(() => expect(fetchAgentMock).toHaveBeenCalledWith("agents/leo.agent"));
  });

  it("mounts with highlighted mentions from full detail cache", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(agentQueryKeys.detail("wks_123", "agents/leo.agent"), detailAgent);
    fetchAgentMock.mockResolvedValue(detailAgent);

    const { container } = renderWithProviders(
      <AgentDetail idOrPath="agents/leo.agent" />,
      queryClient,
    );

    expect(await screen.findByText("@opencompany/web")).toBeInTheDocument();
    expect(container.querySelector(".agent-mention[data-kind='integration']")).toBeInTheDocument();
  });

  it("preserves a saved GitHub repository binding in the detail view", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <AgentDetail idOrPath="agents/leo.agent" initialAgent={detailAgent} />,
    );

    expect(await screen.findByText("@opencompany/web")).toBeInTheDocument();
    expect(container.querySelector(".agent-mention[data-kind='integration']")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /expand agent details/i }));

    expect(container.querySelector("pre code")?.textContent).toContain("externalId: repo_123");
  });

  it("keeps pre-existing agents in the list after saving a freshly created agent (PRO-94)", async () => {
    // Reproduces PRO-94: after creating a new agent and editing it, the
    // detail page's list-cache update must not clobber the agents the user
    // hasn't loaded into the client cache yet. The new agent reaches the
    // detail view via a server redirect, so the client list query has not
    // been populated with it (and may not be populated at all). The server
    // (fetchAgents) remains the source of truth and still has every agent.
    const user = userEvent.setup();
    const queryClient = createQueryClient();

    // The server-side list always returns both the pre-existing agent and the
    // freshly created one. AgentsView reads it through this query.
    fetchAgentsMock.mockResolvedValue([detailAgent, existingListAgent]);

    updateAgentMock.mockResolvedValue({
      id: detailAgent.id,
      workspaceId: detailAgent.workspaceId,
      path: detailAgent.path ?? detailAgent.id,
      pathChanged: false,
      agent: { ...detailAgent, name: "Leo renamed" },
    });

    renderWithProviders(
      <AgentDetail idOrPath="agents/leo.agent" initialAgent={detailAgent} />,
      queryClient,
    );

    // Editing the freshly created agent's name and blurring triggers a save.
    const nameInput = await screen.findByPlaceholderText(/untitled agent/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Leo renamed");
    await user.tab();

    await waitFor(() => expect(updateAgentMock).toHaveBeenCalled());

    // After the save, the list query must not have been clobbered into a
    // single-item cache. AgentsView reads this list query while it is still
    // fresh (within staleTime), so a wrong optimistic value here is exactly
    // what makes the other agents disappear until a manual refresh. If the
    // save left the cache untouched/absent it must be marked stale so the
    // remount refetches the authoritative list.
    await waitFor(() => {
      const cached = queryClient.getQueryData<AgentListItemPayload[]>(
        agentQueryKeys.list("wks_123"),
      );
      const listState = queryClient.getQueryState(agentQueryKeys.list("wks_123"));

      if (cached) {
        // An optimistic cache is acceptable only if it still includes every
        // pre-existing agent.
        expect(cached.map((agent) => agent.id)).toContain(existingListAgent.id);
      } else {
        // No optimistic cache: the query must be invalidated so AgentsView
        // refetches the server list (which still has every agent) on remount.
        expect(listState?.isInvalidated ?? true).toBe(true);
      }
    });

    // Finally, resolve the list the way AgentsView's useQuery would once the
    // user navigates back: a fresh, non-stale read must surface every agent.
    const list = await queryClient.ensureQueryData({
      queryKey: agentQueryKeys.list("wks_123"),
      queryFn: fetchAgents,
      staleTime: 30_000,
    });

    expect(list.map((agent) => agent.id)).toContain(existingListAgent.id);
    expect(list.map((agent) => agent.id)).toContain(detailAgent.id);
  });

  it("saves a preset schedule from the inspector", async () => {
    const user = userEvent.setup();
    updateAgentMock.mockResolvedValue({
      id: detailAgent.id,
      workspaceId: detailAgent.workspaceId,
      path: "agents/leo.agent",
      agent: {
        ...detailAgent,
        config: {
          ...detailAgent.config,
          triggers: [
            {
              id: "review-priorities",
              type: "agent.schedule",
              cron: "0 9 * * 1-5",
              timezone: "UTC",
              prompt: "Review priorities.",
              enabled: true,
            },
          ],
        },
      },
      pathChanged: false,
    } satisfies Awaited<ReturnType<typeof updateAgent>>);

    renderWithProviders(<AgentDetail idOrPath="agents/leo.agent" initialAgent={detailAgent} />);

    await user.click(screen.getByRole("button", { name: /expand agent details/i }));
    await user.click(screen.getByRole("button", { name: /run every/i }));
    expect(screen.getByLabelText(/enabled/i)).toBeChecked();
    await user.selectOptions(screen.getByLabelText(/frequency/i), "daily");
    await user.selectOptions(screen.getByLabelText(/frequency/i), "weekdays");
    await user.clear(screen.getByLabelText(/timezone/i));
    await user.type(screen.getByLabelText(/timezone/i), "UTC");
    await user.type(screen.getByLabelText(/prompt/i), "Review priorities.");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(updateAgentMock).toHaveBeenCalledWith("agt_123", {
        config: {
          triggers: [
            {
              id: expect.stringMatching(/^review-priorities/),
              type: "agent.schedule",
              cron: "0 9 * * 1-5",
              timezone: "UTC",
              prompt: "Review priorities.",
              enabled: true,
            },
          ],
        },
      }),
    );
  });
});

describe("AgentDetail – rename behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("does not save an empty name when the name field is cleared mid-rename", async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<AgentDetail idOrPath="agents/leo.agent" initialAgent={detailAgent} />);

    const nameInput = await screen.findByPlaceholderText("Untitled agent");

    // Clear the field — mimics the user clearing the field before typing the new name.
    await user.clear(nameInput);

    expect(nameInput).toHaveValue("");

    // Blur triggers flush; the server should not receive an empty name.
    await user.tab();

    // updateAgent should not have been called with an empty/whitespace name.
    for (const [, patch] of updateAgentMock.mock.calls) {
      const name = (patch as { name?: string }).name;
      if (name !== undefined) {
        expect(name.trim()).not.toBe("");
      }
    }
  });

  it("saves the new name when the user renames an agent", async () => {
    const user = userEvent.setup({ delay: null });
    updateAgentMock.mockResolvedValue({
      id: "agt_123",
      workspaceId: "wks_123",
      path: "agents/louis.agent",
      pathChanged: true,
      agent: {
        ...detailAgent,
        name: "louis",
        path: "agents/louis.agent",
        config: { ...detailAgent.config, title: "louis" },
      },
    });

    renderWithProviders(<AgentDetail idOrPath="agents/leo.agent" initialAgent={detailAgent} />);

    const nameInput = await screen.findByPlaceholderText("Untitled agent");

    await user.clear(nameInput);
    await user.type(nameInput, "louis");
    await user.tab();

    await waitFor(() => expect(updateAgentMock).toHaveBeenCalled());
    const [, patch] = updateAgentMock.mock.calls[0]!;
    expect((patch as { name?: string }).name).toBe("louis");
  });
});
