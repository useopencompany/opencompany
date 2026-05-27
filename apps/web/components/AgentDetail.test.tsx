import type { AgentConfig } from "@opencompany/agent-runtime/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ToastProvider";
import { WorkspaceProvider } from "@/components/WorkspaceContext";
import type { AgentPayload } from "@/lib/agents/payload";
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

const agent: AgentPayload = {
  id: "agt_123",
  workspaceId: "wks_123",
  path: "agents/leo.agent",
  name: "Leo",
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
  config,
  githubCommitSha: "abc123",
  githubSyncedAt: "2026-05-24T10:05:00.000Z",
  githubSyncStatus: "synced",
  githubSyncError: null,
  createdAt: "2026-05-24T10:00:00.000Z",
  updatedAt: "2026-05-24T10:10:00.000Z",
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
};

function renderWithProviders(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceProvider workspaceId="wks_123">
        <ToastProvider>{ui}</ToastProvider>
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
}

describe("AgentDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("preserves a saved GitHub repository binding in the detail view", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <AgentDetail idOrPath="agents/leo.agent" initialAgent={agent} />,
    );

    expect(await screen.findByText("@opencompany/web")).toBeInTheDocument();
    expect(container.querySelector(".agent-mention[data-kind='integration']")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /expand agent details/i }));

    expect(container.querySelector("pre code")?.textContent).toContain("externalId: repo_123");
  });
});
