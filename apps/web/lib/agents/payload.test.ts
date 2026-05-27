import type { AgentConfig } from "@opencompany/agent-runtime/types";
import type { Agent } from "@opencompany/db/schema";
import { describe, expect, it } from "vitest";
import {
  agentDetailToListItem,
  buildGitHubRepositoryCatalogs,
  type GitHubIntegrationRepositoryPayload,
  serializeAgentDetail,
  serializeAgentListItem,
} from "./payload";

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
  instructions: "Use @opencompany/web and @brain/product/brief.md.",
  model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
  tools: [],
  brain: [],
  integrations: { github: { repositories: [] } },
  triggers: [],
};

const agent = {
  id: "agt_123",
  workspaceId: "wks_123",
  path: "agents/leo.agent",
  name: "Leo",
  body: "Use @opencompany/web and @brain/product/brief.md.",
  content: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Use @opencompany/web and @brain/product/brief.md." }],
      },
    ],
  },
  config,
  githubCommitSha: "abc123",
  githubSyncedAt: new Date("2026-05-24T10:05:00.000Z"),
  githubSyncStatus: "synced",
  githubSyncError: null,
  createdAt: new Date("2026-05-24T10:00:00.000Z"),
  updatedAt: new Date("2026-05-24T10:10:00.000Z"),
} as unknown as Agent;

describe("agent payload serializers", () => {
  it("keeps list payloads free of detail-only editor fields", () => {
    const payload = serializeAgentListItem(agent);

    expect(payload).toMatchObject({
      id: "agt_123",
      path: "agents/leo.agent",
      githubSyncStatus: "synced",
      updatedAt: "2026-05-24T10:10:00.000Z",
    });
    expect(payload).not.toHaveProperty("body");
    expect(payload).not.toHaveProperty("content");
    expect(payload).not.toHaveProperty("brainPaths");
    expect(payload).not.toHaveProperty("githubIntegrationRepositories");
  });

  it("includes mention vocabulary on detail payloads", () => {
    const repository: GitHubIntegrationRepositoryPayload = {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "available",
      statusReason: null,
      connectionStatus: "connected",
      binding,
    };
    const payload = serializeAgentDetail(agent, ["product/brief.md"], [repository], [repository]);

    expect(payload).toMatchObject({
      body: "Use @opencompany/web and @brain/product/brief.md.",
      content: expect.objectContaining({ type: "doc" }),
      brainPaths: ["product/brief.md"],
      githubIntegrationRepositories: [repository],
      usableGitHubIntegrationRepositories: [repository],
    });
  });

  it("projects detail payloads back to list payloads without carrying editor fields", () => {
    const detail = serializeAgentDetail(
      agent,
      ["product/brief.md"],
      [{ fullName: "opencompany/web", defaultBranch: "main" }],
    );
    const listItem = agentDetailToListItem(detail);

    expect(listItem).toMatchObject({
      id: "agt_123",
      name: "Leo",
      updatedAt: "2026-05-24T10:10:00.000Z",
    });
    expect(listItem).not.toHaveProperty("body");
    expect(listItem).not.toHaveProperty("content");
    expect(listItem).not.toHaveProperty("brainPaths");
    expect(listItem).not.toHaveProperty("githubIntegrationRepositories");
  });
});

describe("buildGitHubRepositoryCatalogs", () => {
  it("keeps unavailable resources out of the usable mention catalog", () => {
    const unavailableRepository: GitHubIntegrationRepositoryPayload = {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "permission_lost",
      statusReason: "Repository is no longer visible.",
      connectionStatus: "connected",
      binding,
    };

    const catalogs = buildGitHubRepositoryCatalogs({
      repositories: [unavailableRepository],
    });

    expect(catalogs.usableRepositories).toEqual([]);
    expect(catalogs.derivationRepositories).toEqual([]);
  });

  it("preserves a saved stale repository for derivation but not new mentions", () => {
    const catalogs = buildGitHubRepositoryCatalogs({
      repositories: [],
      savedRepositories: [
        {
          id: "opencompany-web",
          fullName: "opencompany/web",
          defaultBranch: "main",
          binding,
        },
      ],
    });

    expect(catalogs.usableRepositories).toEqual([]);
    expect(catalogs.derivationRepositories).toEqual([
      {
        fullName: "opencompany/web",
        defaultBranch: "main",
        binding,
      },
    ]);
  });

  it("uses available connected resources for both catalogs", () => {
    const availableRepository: GitHubIntegrationRepositoryPayload = {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "available",
      statusReason: null,
      connectionStatus: "connected",
      binding,
    };

    const catalogs = buildGitHubRepositoryCatalogs({
      repositories: [availableRepository],
    });

    expect(catalogs.usableRepositories).toEqual([availableRepository]);
    expect(catalogs.derivationRepositories).toEqual([availableRepository]);
  });

  it("keeps legacy saved references separate from fresh usable bindings", () => {
    const availableRepository: GitHubIntegrationRepositoryPayload = {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "available",
      statusReason: null,
      connectionStatus: "connected",
      binding,
    };

    const catalogs = buildGitHubRepositoryCatalogs({
      repositories: [availableRepository],
      savedRepositories: [
        {
          id: "opencompany-web",
          fullName: "opencompany/web",
          defaultBranch: "main",
        },
      ],
    });

    expect(catalogs.derivationRepositories).toEqual([
      availableRepository,
      {
        fullName: "opencompany/web",
        defaultBranch: "main",
      },
    ]);
  });

  it("keeps same-name repositories from different GitHub connections by binding identity", () => {
    const secondBinding = {
      ...binding,
      externalId: "repo_456",
      connection: {
        ...binding.connection,
        externalId: "install_456",
        label: "OpenCompany EU",
      },
    };
    const firstRepository: GitHubIntegrationRepositoryPayload = {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "available",
      statusReason: null,
      connectionStatus: "connected",
      binding,
    };
    const secondRepository: GitHubIntegrationRepositoryPayload = {
      fullName: "opencompany/web",
      defaultBranch: "main",
      status: "available",
      statusReason: null,
      connectionStatus: "connected",
      binding: secondBinding,
    };

    const catalogs = buildGitHubRepositoryCatalogs({
      repositories: [firstRepository, secondRepository],
      savedRepositories: [
        {
          id: "opencompany-web",
          fullName: "opencompany/web",
          defaultBranch: "main",
        },
      ],
    });

    expect(catalogs.usableRepositories).toEqual([firstRepository, secondRepository]);
    expect(catalogs.derivationRepositories).toEqual([
      firstRepository,
      secondRepository,
      {
        fullName: "opencompany/web",
        defaultBranch: "main",
      },
    ]);
  });
});
