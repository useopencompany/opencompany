import { describe, expect, it } from "vitest";
import { agentGitHubRepositories, normalizeAgentConfig, resolveAgentRuntimeConfig } from "./config";
import type { AgentConfig } from "./types";

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
    expect(resolved.systemPrompt).toContain("Avoid launching more than eight tool calls");
    expect(resolved.systemPrompt).toContain("Use edit_file for targeted changes");
    expect(resolved.systemPrompt).toContain("Check the workspace and summarize risk.");
    expect(resolved.systemPrompt).toMatch(/Current date: \w+, \w+ \d{1,2}, \d{4}/);
    expect(resolved.tools).toContain("shell");
    expect(resolved.tools).toContain("edit_file");
    expect(resolved.tools).toContain("git_diff");
    expect(resolved.tools).toContain("tool_help");
    expect(resolved.tools).not.toContain("exa_search");
  });

  it("advertises attached GitHub repositories and exposes the gh tool", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Repo agent",
      instructions: "Work in the repo.",
      model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
      tools: [],
      brain: [],
      integrations: {
        github: {
          repositories: [
            { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
          ],
        },
      },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.tools).toContain("gh");
    expect(resolved.systemPrompt).toContain("Attached GitHub repositories: opencompany/web.");
    expect(resolved.systemPrompt).toContain("git and gh (GitHub CLI) access");
    expect(resolved.systemPrompt).toContain("gh commands default to the attached repository");
    expect(resolved.systemPrompt).toContain("Clone a repository into work/<repo> on demand");
    expect(resolved.systemPrompt).toContain("All session work must happen under work/");
  });

  it("requires explicit repo selection for multi-repo gh commands", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Repo agent",
      instructions: "Work across repos.",
      model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
      tools: [],
      brain: [],
      integrations: {
        github: {
          repositories: [
            { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
            { id: "opencompany-api", fullName: "opencompany/api", defaultBranch: "main" },
          ],
        },
      },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.systemPrompt).toContain(
      "Attached GitHub repositories: opencompany/web, opencompany/api.",
    );
    expect(resolved.systemPrompt).toContain("Use --repo owner/repo with gh commands");
    expect(resolved.systemPrompt).not.toContain("gh commands default to the attached repository");
  });

  it("omits GitHub repository context and the gh tool when no repository is attached", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "No repo agent",
      instructions: "Just chat.",
      model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
      tools: [],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.tools).not.toContain("gh");
    expect(resolved.systemPrompt).not.toContain("Attached GitHub repositories");
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
        "edit_file",
        "git_diff",
        "tool_help",
        "exa_search",
        "exa_contents",
        "exa_answer",
        "web_fetch",
      ]),
    );
  });

  it("keeps MCP tools separate from static runtime tools", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Linear agent",
      instructions: "Triage Linear.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
      tools: [
        {
          id: "linear",
          type: "mcp",
          server: "linear",
          label: "linear",
          description: "Use workspace-configured Linear MCP tools.",
        },
      ],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.tools).toContain("tool_help");
    expect(resolved.tools).not.toContain("exa_search");
    expect(resolved.mcpServers).toEqual([config.tools[0]]);
  });

  it("enables agent delegation when workspace agent references are configured", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Coordinator",
      instructions: "Delegate focused work.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
      tools: [],
      brain: [],
      agents: [{ path: "agents/research.agent", name: "Research" }],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.tools).toContain("delegate_to_agent");
    expect(resolved.systemPrompt).toContain("Delegatable workspace agents: Research");
    expect(resolved.systemPrompt).toContain("childSessionId");
    expect(resolved.systemPrompt).toContain("continue the same delegated session");
  });

  it("does not enable agent delegation without configured agent references", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Solo",
      instructions: "Work alone.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
      tools: [],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.tools).not.toContain("delegate_to_agent");
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
    expect(resolved.tools).not.toContain("exa_contents");
    expect(resolved.tools).not.toContain("exa_answer");
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
    "moonshotai/kimi-k2-turbo",
    "moonshotai/kimi-k2",
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
    "minimax/minimax-m3",
    "minimax/minimax-m2.7",
    "minimax/minimax-m2.7-highspeed",
    "minimax/minimax-m2.5",
    "minimax/minimax-m2.5-highspeed",
    "minimax/minimax-m2.1",
    "minimax/minimax-m2.1-lightning",
    "minimax/minimax-m2",
    "moonshotai/kimi-k2.6",
    "moonshotai/kimi-k2.5",
    "moonshotai/kimi-k2-thinking",
    "moonshotai/kimi-k2-thinking-turbo",
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

  it("applies OpenAI reasoning options to GPT 5.2 Codex", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Codex agent",
      instructions: "Work on code.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.2-codex",
      },
      tools: [],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.model).toEqual({
      provider: "vercel-ai-gateway",
      name: "openai/gpt-5.2-codex",
      supportsReasoning: true,
      providerOptions: {
        openai: {
          reasoningEffort: "medium",
          reasoningSummary: "concise",
        },
      },
      exposeReasoningSummary: true,
    });
  });
});

describe("normalizeAgentConfig", () => {
  it("fills arrays and GitHub integrations missing from legacy persisted configs", () => {
    const config = {
      schemaVersion: "agent.v1",
      title: "Legacy agent",
      instructions: "Use old persisted config.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
    } as unknown as AgentConfig;

    const normalized = normalizeAgentConfig(config);

    expect(normalized.tools).toEqual([]);
    expect(normalized.brain).toEqual([]);
    expect(normalized.agents).toEqual([]);
    expect(normalized.integrations.github.repositories).toEqual([]);
    expect(normalized.triggers).toEqual([]);
    expect(agentGitHubRepositories(config)).toEqual([]);
  });
});
