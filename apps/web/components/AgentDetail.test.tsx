import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ToastProvider";
import { WorkspaceProvider } from "@/components/WorkspaceContext";
import { runAgentScheduleNow } from "@/lib/agent-schedules/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import { updateAgent } from "@/lib/agents/actions";
import {
  type AgentDetailPayload,
  type AgentListItemPayload,
  agentQueryKeys,
  fetchAgent,
} from "@/lib/agents/payload";
import AgentDetail from "./AgentDetail";

const routerMocks = vi.hoisted(() => ({
  prefetch: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    prefetch: routerMocks.prefetch,
    push: routerMocks.push,
    replace: routerMocks.replace,
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

vi.mock("@/lib/agent-schedules/actions", () => ({
  runAgentScheduleNow: vi.fn(),
}));

// The editor's "Add skill" dialog imports this server action; stub it so the test doesn't
// pull the real auth/server import chain into the client render.
vi.mock("@/lib/skills/actions", () => ({
  saveSkill: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/payload", () => ({
  seedSessionQueries: vi.fn(),
}));

// Stub the collections so AgentDetail's optimistic delete works without mounting
// CollectionsProvider (which would pull the server-action import chain into the
// test). The delete returns a resolved tx so the detached reconcile is a no-op.
vi.mock("@/components/CollectionsProvider", () => ({
  useCollections: () => ({
    agents: { delete: vi.fn(() => ({ isPersisted: { promise: Promise.resolve() } })) },
  }),
}));

vi.mock("@/lib/agents/payload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/payload")>();
  return {
    ...actual,
    fetchAgent: vi.fn(),
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
  engine: "opencompany",
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

const externalSkill = {
  id: "frontend-design",
  name: "Frontend Design",
  description: "Create distinctive, production-grade frontend interfaces.",
  source: {
    type: "skills.sh" as const,
    url: "https://github.com/anthropics/skills",
    ref: "main",
    path: "skills/frontend-design",
  },
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
    linearConfigured: false,
    slackConfigured: false,
    posthogConfigured: false,
    betterstackConfigured: false,
    braintrustConfigured: false,
    notionConfigured: false,
  },
};

const fetchAgentMock = vi.mocked(fetchAgent);
const updateAgentMock = vi.mocked(updateAgent);
const runAgentScheduleNowMock = vi.mocked(runAgentScheduleNow);
const seedSessionQueriesMock = vi.mocked(seedSessionQueries);

function renderWithProviders(ui: ReactNode, queryClient = createQueryClient()) {
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceProvider workspaceId="wks_123" userId="usr_123">
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

  it("shows the loading skeleton until the detail query resolves", async () => {
    const queryClient = createQueryClient();
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

  it("mounts saved skill mentions before the workspace skill catalog loads", async () => {
    const user = userEvent.setup();
    const queryClient = createQueryClient();
    queryClient.setQueryData(["workspace-skills", "wks_123"], []);
    const skillAgent: AgentDetailPayload = {
      ...detailAgent,
      config: {
        ...detailAgent.config,
        instructions: "Use @skill/frontend-design for UI work.",
        skills: [externalSkill],
      },
      body: "Use @skill/frontend-design for UI work.",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Use @skill/frontend-design for UI work." }],
          },
        ],
      },
    };

    const { container } = renderWithProviders(
      <AgentDetail idOrPath="agents/leo/leo.agent" initialAgent={skillAgent} />,
      queryClient,
    );

    expect(await screen.findByText("@skill/frontend-design")).toBeInTheDocument();
    expect(container.querySelector(".agent-mention[data-kind='skill']")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /expand agent details/i }));
    const fullConfig = container.querySelector("pre code")?.textContent ?? "";
    expect(fullConfig).toContain("skills:");
    expect(fullConfig).toContain("frontend-design");
    expect(fullConfig).toContain("skills/frontend-design");
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

  it("runs a saved schedule from the inspector", async () => {
    const user = userEvent.setup();
    const scheduledAgent = {
      ...detailAgent,
      config: {
        ...detailAgent.config,
        triggers: [
          {
            id: "weekday-brief",
            type: "agent.schedule" as const,
            cron: "0 9 * * 1-5",
            timezone: "UTC",
            prompt: "Review priorities.",
            enabled: false,
          },
        ],
      },
    };
    const detail = {
      session: {
        id: "ses_schedule",
        source: "user",
      },
    };
    runAgentScheduleNowMock.mockResolvedValue({
      ok: true,
      session: { id: "ses_schedule" },
      detail,
    } as never);

    const { queryClient } = renderWithProviders(
      <AgentDetail idOrPath="agents/leo.agent" initialAgent={scheduledAgent} />,
    );

    await user.click(screen.getByRole("button", { name: /expand agent details/i }));
    await user.click(screen.getByRole("button", { name: /run now/i }));

    await waitFor(() =>
      expect(runAgentScheduleNowMock).toHaveBeenCalledWith("agt_123", "weekday-brief"),
    );
    expect(seedSessionQueriesMock).toHaveBeenCalledWith(queryClient, "wks_123", detail);
    expect(routerMocks.push).toHaveBeenCalledWith("/company/session/ses_schedule");
  });

  it("does not expose Run now for an unsaved schedule", async () => {
    const user = userEvent.setup();
    updateAgentMock.mockReturnValue(new Promise(() => {}) as never);

    renderWithProviders(<AgentDetail idOrPath="agents/leo.agent" initialAgent={detailAgent} />);

    await user.click(screen.getByRole("button", { name: /expand agent details/i }));
    await user.click(screen.getByRole("button", { name: /run every/i }));
    await user.clear(screen.getByLabelText(/timezone/i));
    await user.type(screen.getByLabelText(/timezone/i), "UTC");
    await user.type(screen.getByLabelText(/prompt/i), "Review priorities.");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(screen.queryByRole("button", { name: /run now/i })).not.toBeInTheDocument();
    expect(runAgentScheduleNowMock).not.toHaveBeenCalled();
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
