import type { AgentConfig } from "@opencompany/agent-runtime/types";
import type { Agent } from "@opencompany/db/schema";
import { describe, expect, it } from "vitest";
import { agentDetailToListItem, serializeAgentDetail, serializeAgentListItem } from "./payload";

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
    const payload = serializeAgentDetail(
      agent,
      ["product/brief.md"],
      [{ fullName: "opencompany/web", defaultBranch: "main" }],
    );

    expect(payload).toMatchObject({
      body: "Use @opencompany/web and @brain/product/brief.md.",
      content: expect.objectContaining({ type: "doc" }),
      brainPaths: ["product/brief.md"],
      githubIntegrationRepositories: [{ fullName: "opencompany/web", defaultBranch: "main" }],
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
