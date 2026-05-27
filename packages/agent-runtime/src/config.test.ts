import type { AgentConfig } from "@opencompany/db/schema";
import { describe, expect, it } from "vitest";
import { resolveAgentRuntimeConfig } from "./config";

describe("resolveAgentRuntimeConfig", () => {
  it("builds the system prompt and keeps the configured Vercel AI Gateway model", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Ops agent",
      instructions: "Check the workspace and summarize risk.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4",
      },
      tools: [],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({
      agent: config,
      workspaceName: "Acme",
      sessionTitle: "Risk review",
      userName: "Ada Lovelace",
    });

    expect(resolved.model).toEqual({
      provider: "vercel-ai-gateway",
      name: "openai/gpt-5.4",
      supportsReasoning: true,
      providerOptions: {
        openai: {
          reasoningEffort: "medium",
          reasoningSummary: "concise",
        },
      },
      exposeReasoningSummary: true,
    });
    expect(resolved.systemPrompt).toContain("Workspace: Acme");
    expect(resolved.systemPrompt).toContain("User: Ada Lovelace");
    expect(resolved.systemPrompt).toContain("Check the workspace and summarize risk.");
    expect(resolved.tools).toContain("shell");
    expect(resolved.tools).toContain("git_diff");
    expect(resolved.tools).toContain("tool_help");
    expect(resolved.tools).not.toContain("exa_search");
  });

  it("enables hosted runtime tools from selected agent config tools", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Research agent",
      instructions: "Research the web.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
      tools: [
        {
          id: "exa",
          type: "tool",
          label: "exa",
          description: "Deep research on the web and people.",
        },
      ],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.tools).toEqual(
      expect.arrayContaining([
        "shell",
        "read_file",
        "git_diff",
        "tool_help",
        "exa_search",
        "web_fetch",
      ]),
    );
  });

  it("formats the root Brain mount clearly in the system prompt", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Research agent",
      instructions: "Use shared context.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
      tools: [],
      brain: [{ path: "/", type: "folder" }],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.systemPrompt).toContain("Brain files are mounted under ./brain");
    expect(resolved.systemPrompt).toContain("brain/");
    expect(resolved.systemPrompt).not.toContain(": /.");
  });

  it("ignores stale unknown config tools", () => {
    const config = {
      schemaVersion: "agent.v1",
      title: "Legacy agent",
      instructions: "Use old tools.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
      tools: [{ id: "unknown_tool", type: "tool", label: "old", description: "old" }],
    } as unknown as AgentConfig;

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.tools).toContain("tool_help");
    expect(resolved.tools).not.toContain("exa_search");
    expect(resolved.tools).not.toContain("web_fetch");
  });

  it("does not add reasoning provider options for non-reasoning models", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Fast agent",
      instructions: "Summarize the thread.",
      model: {
        provider: "vercel-ai-gateway",
        name: "anthropic/claude-haiku-4.5",
      },
      tools: [],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.model).toEqual({
      provider: "vercel-ai-gateway",
      name: "anthropic/claude-haiku-4.5",
      supportsReasoning: false,
      exposeReasoningSummary: false,
    });
  });

  it.each([
    "google/gemini-3-flash",
    "google/gemini-3.1-flash-lite-preview",
    "deepseek/deepseek-v4-flash",
    "mistral/mistral-medium-3.5",
  ] as const)("keeps %s on AI Gateway without provider-specific options", (modelName) => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Gateway agent",
      instructions: "Do the work.",
      model: {
        provider: "vercel-ai-gateway",
        name: modelName,
      },
      tools: [],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.model).toEqual({
      provider: "vercel-ai-gateway",
      name: modelName,
      supportsReasoning: false,
      exposeReasoningSummary: false,
    });
  });

  it.each([
    "moonshotai/kimi-k2.6",
    "zai/glm-5.1",
    "zai/glm-5-turbo",
    "zai/glm-5v-turbo",
  ] as const)("marks %s as reasoning-capable without custom provider options", (modelName) => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Reasoning agent",
      instructions: "Plan carefully.",
      model: {
        provider: "vercel-ai-gateway",
        name: modelName,
      },
      tools: [],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.model).toEqual({
      provider: "vercel-ai-gateway",
      name: modelName,
      supportsReasoning: true,
      exposeReasoningSummary: false,
    });
  });
});
