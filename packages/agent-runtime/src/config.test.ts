import { describe, expect, it } from "vitest";
import { agentGitHubRepositories, normalizeAgentConfig, resolveAgentRuntimeConfig } from "./config";
import {
  GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
  type ModelProviderOptions,
  mergeModelProviderOptions,
} from "./models";
import { policyMapKey } from "./permissions";
import type { AgentConfig } from "./types";

describe("mergeModelProviderOptions", () => {
  it("merges provider namespaces without dropping existing options", () => {
    const reasoning = {
      openai: {
        reasoningEffort: "medium",
        reasoningSummary: "concise",
      },
    } satisfies ModelProviderOptions;
    const cache = {
      openai: {
        promptCacheKey: "workspace-agent",
      },
      gateway: {
        caching: "auto",
      },
    } satisfies ModelProviderOptions;

    expect(mergeModelProviderOptions(reasoning, cache)).toEqual({
      openai: {
        reasoningEffort: "medium",
        reasoningSummary: "concise",
        promptCacheKey: "workspace-agent",
      },
      gateway: {
        caching: "auto",
      },
    });
  });
});

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
      userFirstName: "Ada",
      userLastName: "Lovelace",
    });

    expect(resolved.model).toEqual({
      provider: "vercel-ai-gateway",
      name: "openai/gpt-5.4",
      supportsReasoning: true,
      providerOptions: {
        ...GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
        openai: {
          reasoningEffort: "medium",
          reasoningSummary: "concise",
        },
      },
      reasoningExposure: "summary",
    });
    expect(resolved.systemPrompt).toContain("Workspace: Acme");
    expect(resolved.systemPrompt).toContain("User: Ada Lovelace");
    expect(resolved.systemPrompt).toContain("User first name: Ada");
    expect(resolved.systemPrompt).toContain("User last name: Lovelace");
    expect(resolved.systemPrompt).toContain("Avoid launching more than eight tool calls");
    expect(resolved.systemPrompt).toContain("make the tool call before answering");
    expect(resolved.systemPrompt).toContain("do not say or imply you checked a source");
    expect(resolved.systemPrompt).toContain("call ask_user_question");
    expect(resolved.systemPrompt).toContain(
      "whether any durable file or memory update is clearly intended",
    );
    expect(resolved.systemPrompt).toContain("Use edit_file for targeted changes");
    expect(resolved.systemPrompt).toContain("Check the workspace and summarize risk.");
    expect(resolved.systemPrompt).toMatch(/Current date: \w+, \w+ \d{1,2}, \d{4}/);
    expect(resolved.tools).toContain("shell");
    expect(resolved.tools).toContain("edit_file");
    expect(resolved.tools).toContain("git_diff");
    expect(resolved.tools).toContain("ask_user_question");
    expect(resolved.tools).toContain("tool_help");
    expect(resolved.tools).not.toContain("exa_search");
  });

  it("falls back to email for user context when WorkOS has not provided a name", () => {
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
      userEmail: "ada@example.com",
    });

    expect(resolved.systemPrompt).toContain("User: ada@example.com");
    expect(resolved.systemPrompt).not.toContain("User first name:");
    expect(resolved.systemPrompt).not.toContain("User last name:");
  });

  const profileConfig = (): AgentConfig => ({
    schemaVersion: "agent.v1",
    title: "Personal agent",
    instructions: "Help the user.",
    model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
    tools: [],
    brain: [],
    integrations: { github: { repositories: [] } },
    triggers: [],
  });

  it("injects the populated profile verbatim into the system prompt", () => {
    const resolved = resolveAgentRuntimeConfig({
      agent: profileConfig(),
      userMemory: "Goes by Lou. Prefers terse answers.",
    });

    expect(resolved.systemPrompt).toContain("## Your profile");
    expect(resolved.systemPrompt).toContain("Goes by Lou. Prefers terse answers.");
    // No invitation placeholder when the profile has content.
    expect(resolved.systemPrompt).not.toContain("(empty — populate this as you learn");
  });

  it("injects a labeled empty section inviting population when the profile is absent", () => {
    const resolved = resolveAgentRuntimeConfig({ agent: profileConfig() });

    expect(resolved.systemPrompt).toContain("## Your profile");
    expect(resolved.systemPrompt).toContain(
      "(empty — populate this as you learn who your user is)",
    );
  });

  it("requires internal source checks before claiming personal facts are unknown", () => {
    const resolved = resolveAgentRuntimeConfig({ agent: profileConfig(), personalAgent: true });

    expect(resolved.tools).toContain("memory");
    expect(resolved.systemPrompt).toContain("Before saying you do not know");
    expect(resolved.systemPrompt).toContain("query memory for durable facts");
    expect(resolved.systemPrompt).toContain("use file tools on personal-brain/");
    expect(resolved.systemPrompt).toContain("Ask the user only after those checks fail");
  });

  it("uses mounted brain refs, not personal-brain paths, for workspace source checks", () => {
    const resolved = resolveAgentRuntimeConfig({ agent: profileConfig(), personalAgent: false });

    expect(resolved.systemPrompt).toContain("use file tools on mounted brain/ refs");
    expect(resolved.systemPrompt).not.toContain("use file tools on personal-brain/");
  });

  it("truncates an oversized profile with a marker and bounds its length", () => {
    const big = "x".repeat(10_000);
    const resolved = resolveAgentRuntimeConfig({
      agent: profileConfig(),
      userMemory: big,
    });

    expect(resolved.systemPrompt).toContain("[truncated");
    expect(resolved.systemPrompt).not.toContain(big);
    // The injected profile body must not exceed the cap. The bound covers the truncated ~3KB body
    // plus the section's fixed header/intro prose and the truncation marker.
    const section = resolved.systemPrompt.slice(resolved.systemPrompt.indexOf("## Your profile"));
    expect(Buffer.byteLength(section, "utf8")).toBeLessThan(3800);
  });

  it("nudges the agent to read the self-edit skill before update_agent_file", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Ops agent",
      instructions: "Do the work.",
      model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
      tools: [],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.systemPrompt).toContain("You can evolve your own definition.");
    expect(resolved.systemPrompt).toContain("skills/agent-self-edit/SKILL.md");
    expect(resolved.systemPrompt).toContain("before calling update_agent_file");
    // update_agent_file is deferred: the guidance must point at the find_tools/use_tool discovery
    // flow rather than implying a directly preloaded tool.
    expect(resolved.systemPrompt).toContain('find_tools({ query: "update_agent_file" })');
    expect(resolved.systemPrompt).toContain('use_tool({ tool: "update_agent_file", arguments })');
    expect(resolved.tools).toContain("update_agent_file");
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
    expect(resolved.systemPrompt).toContain("gh (GitHub CLI) access");
    expect(resolved.systemPrompt).toContain("Use shell for local sandbox commands");
    expect(resolved.systemPrompt).toContain(
      "Core tools (read_file, write_file, edit_file, list_files, git_diff, shell, read_skill, gh) are available directly.",
    );
    expect(resolved.systemPrompt).toContain("gh commands default to the attached repository");
    expect(resolved.systemPrompt).toContain(
      "--repo is not needed when targeting this attached repository",
    );
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
    expect(resolved.systemPrompt).toContain(
      "Core tools (read_file, write_file, edit_file, list_files, git_diff, shell, read_skill) are available directly.",
    );
    expect(resolved.systemPrompt).not.toContain("read_skill, gh");
  });

  it("explains opencode can target public GitHub repositories without an attached repository", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "opencode agent",
      instructions: "@opencode",
      model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
      tools: [
        {
          id: "opencode",
          type: "coding_agent",
          provider: "opencode",
          label: "opencode",
          description: "Delegate coding work to opencode inside an E2B sandbox.",
          prCapable: true,
        },
      ],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.tools).toContain("opencode_coder");
    expect(resolved.systemPrompt).toContain(
      "opencode can work without an attached GitHub repository when the user provides a public GitHub owner/repo",
    );
    expect(resolved.systemPrompt).toContain(
      "Public repositories are cloned without workspace GitHub credentials",
    );
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
        "read_skill",
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

  it("renders a Tools index of capabilities without leaking deferred tool schemas", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Research agent",
      instructions: "Research things.",
      model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
      tools: [
        { id: "exa", type: "hosted_tool", label: "exa", description: "Web research." },
        { id: "instagram", type: "hosted_tool", label: "instagram", description: "Read IG." },
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

    // Capability-level spine, both surfaces present.
    expect(resolved.systemPrompt).toContain("## Tools");
    expect(resolved.systemPrompt).toContain("- exa —");
    expect(resolved.systemPrompt).toContain("- instagram —");
    expect(resolved.systemPrompt).toContain("find_tools");
    expect(resolved.systemPrompt).toContain("use_tool");
    expect(resolved.systemPrompt).toContain("Linear");
    expect(resolved.systemPrompt).toContain("linear__search_tools");
    expect(resolved.systemPrompt).toContain("find_tools does not list the core tools above");

    // Deferred runtime tools are enabled, but their per-tool names/schemas are not in the prompt.
    expect(resolved.tools).toContain("exa_search");
    expect(resolved.tools).toContain("instagram_get_profile");
    expect(resolved.systemPrompt).not.toContain("exa_search");
    expect(resolved.systemPrompt).not.toContain("instagram_get_profile");
  });

  it("renders personal file-root guidance without generic brain or memory file access", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Personal agent",
      instructions: "Help the user.",
      model: { provider: "vercel-ai-gateway", name: "openai/gpt-5.4-mini" },
      tools: [],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config, personalAgent: true });

    expect(resolved.systemPrompt).toContain("personal-brain/");
    expect(resolved.systemPrompt).toContain("create or update personal-brain/ only when");
    expect(resolved.systemPrompt).toContain(
      "If you are unsure whether the user wants a persistent file",
    );
    expect(resolved.systemPrompt).toContain("do not infer memory from casual wording");
    expect(resolved.systemPrompt).not.toContain("When unsure, prefer personal-brain");
    expect(resolved.systemPrompt).toContain(
      "File tools require paths prefixed with work/, personal-brain/, or agent/.",
    );
    expect(resolved.systemPrompt).not.toContain("work/, brain/, or agent/");
    expect(resolved.systemPrompt).not.toContain("./brain is shared company knowledge");
    expect(resolved.systemPrompt).toContain("Manage it ONLY through the `memory` tool");
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

  it("includes workspace tool policy guidance for enabled MCP providers", () => {
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

    const resolved = resolveAgentRuntimeConfig({
      agent: config,
      toolPolicy: {
        policy: new Map([
          [policyMapKey("linear", "read"), "ask"],
          [policyMapKey("linear", "post"), "deny"],
          [policyMapKey("linear", "modify"), "deny"],
          [policyMapKey("linear", "admin"), "deny"],
        ]),
        suspendable: true,
      },
    });

    expect(resolved.systemPrompt).toContain("Workspace tool permissions:");
    expect(resolved.systemPrompt).toContain("Denied permissions must not be attempted");
    expect(resolved.systemPrompt).toContain(
      "Linear: Read=ask first, Post=deny, Modify=deny, Admin=deny.",
    );
  });

  it("includes workspace tool policy guidance for Neon hosted tools", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Database agent",
      instructions: "Inspect Neon.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
      tools: [
        {
          id: "neon",
          type: "hosted_tool",
          label: "neon",
          description: "Inspect and administer Neon databases.",
        },
      ],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({
      agent: config,
      toolPolicy: {
        policy: new Map([[policyMapKey("neon", "admin"), "deny"]]),
        suspendable: true,
      },
    });

    expect(resolved.tools).toContain("neon_run_sql");
    expect(resolved.systemPrompt).toContain("- neon —");
    expect(resolved.systemPrompt).toContain("Neon: Read=allow, Modify=ask first, Admin=deny.");
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
      agents: [{ path: "agents/research/research.agent", name: "Research" }],
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
      providerOptions: GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
      reasoningExposure: "hidden",
    });
  });

  it.each([
    "google/gemini-3-flash",
    "google/gemini-3.1-flash-lite-preview",
    "deepseek/deepseek-v4-flash",
    "mistral/mistral-medium-3.5",
    "moonshotai/kimi-k2-turbo",
    "moonshotai/kimi-k2",
    "xai/grok-4.1-fast-non-reasoning",
    "xai/grok-4.20-non-reasoning",
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
      providerOptions: GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
      reasoningExposure: "hidden",
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
    "xai/grok-4.3",
    "xai/grok-4.20-reasoning",
    "xai/grok-4.1-fast-reasoning",
    "xai/grok-build-0.1",
    "zai/glm-5.1",
    "zai/glm-5-turbo",
    "zai/glm-5v-turbo",
    "openrouter/fusion",
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
      providerOptions: GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
      reasoningExposure: "hidden",
    });
  });

  it.each([
    "moonshotai/kimi-k2.6",
    "moonshotai/kimi-k2.5",
    "moonshotai/kimi-k2-thinking",
    "moonshotai/kimi-k2-thinking-turbo",
  ] as const)("exposes raw reasoning content for %s", (modelName) => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Kimi agent",
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
      providerOptions: GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
      reasoningExposure: "raw",
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
        ...GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
        openai: {
          reasoningEffort: "medium",
          reasoningSummary: "concise",
        },
      },
      reasoningExposure: "summary",
    });
  });

  it("uses a valid modelOverride in place of the agent default", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Override agent",
      instructions: "Do the work.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
      tools: [],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({
      agent: config,
      modelOverride: "anthropic/claude-opus-4.8",
    });

    expect(resolved.model.name).toBe("anthropic/claude-opus-4.8");
    // The agent's saved default is never mutated by an override.
    expect(config.model.name).toBe("openai/gpt-5.4-mini");
  });

  it("falls back to the agent default when modelOverride is unknown", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Override agent",
      instructions: "Do the work.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
      tools: [],
      brain: [],
      integrations: { github: { repositories: [] } },
      triggers: [],
    };

    const resolved = resolveAgentRuntimeConfig({
      agent: config,
      modelOverride: "not-a-real/model",
    });

    expect(resolved.model.name).toBe("openai/gpt-5.4-mini");
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
