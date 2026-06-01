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
  path: "agents/leo/leo.agent",
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
  bundleFiles: [
    {
      path: "agents/leo/memory.md",
      relativePath: "memory.md",
      content: "Private notes",
      sizeBytes: 13,
      contentHash: "hash_memory",
      githubCommitSha: "def456",
      githubSyncedAt: "2026-05-24T10:06:00.000Z",
      githubSyncStatus: "synced",
      githubSyncError: null,
      updatedAt: "2026-05-24T10:06:00.000Z",
    },
  ],
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
  workspaceAgents: [{ path: "agents/research/research.agent", name: "Research" }],
  mcp: {
    mcpEnabled: false,
    linearConfigured: false,
    slackConfigured: false,
  },
};

const fetchAgentMock = vi.mocked(fetchAgent);
const updateAgentMock = vi.mocked(updateAgent);

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

    renderWithProviders(<AgentDetail idOrPath="agents/leo/leo.agent" />, queryClient);

    expect(screen.getByRole("status", { name: /loading agent/i })).toBeInTheDocument();
    expect(screen.queryByText("@opencompany/web")).not.toBeInTheDocument();
    await waitFor(() => expect(fetchAgentMock).toHaveBeenCalledWith("agents/leo/leo.agent"));
  });

  it("mounts with highlighted mentions from full detail cache", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(agentQueryKeys.detail("wks_123", "agents/leo/leo.agent"), detailAgent);
    fetchAgentMock.mockResolvedValue(detailAgent);

    const { container } = renderWithProviders(
      <AgentDetail idOrPath="agents/leo/leo.agent" />,
      queryClient,
    );

    expect(await screen.findByText("@opencompany/web")).toBeInTheDocument();
    expect(container.querySelector(".agent-mention[data-kind='integration']")).toBeInTheDocument();
  });

  it("shows the agent folder in the detail inspector", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentDetail idOrPath="agents/leo/leo.agent" initialAgent={detailAgent} />);

    await user.click(screen.getByRole("button", { name: /expand agent details/i }));

    expect(await screen.findByText("Agent folder")).toBeInTheDocument();
    expect(screen.getByText("agents/leo/")).toBeInTheDocument();
    expect(screen.getByText("leo.agent")).toBeInTheDocument();
    expect(screen.getByText("memory.md")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Private notes")).not.toBeInTheDocument();
  });

  it("preserves a saved GitHub repository binding in the detail view", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <AgentDetail idOrPath="agents/leo/leo.agent" initialAgent={detailAgent} />,
    );

    expect(await screen.findByText("@opencompany/web")).toBeInTheDocument();
    expect(container.querySelector(".agent-mention[data-kind='integration']")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /expand agent details/i }));

    expect(container.querySelector("pre code")?.textContent).toContain("externalId: repo_123");
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
