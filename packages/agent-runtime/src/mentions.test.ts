import { describe, expect, it } from "vitest";
import {
  agentMentionIdForPath,
  deriveAgentConfigFromBody,
  extractConfigFromMentions,
} from "./mentions";

const repositories = [
  { fullName: "opencompany/web", defaultBranch: "main" },
  { fullName: "opencompany/runner", defaultBranch: "develop" },
];
const agents = [
  { path: "agents/research/research.agent", name: "Research" },
  { path: "agents/writer/writer.agent", name: "Writer" },
];
const boundRepositories = [
  {
    fullName: "opencompany/web",
    defaultBranch: "main",
    binding: {
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
    },
  },
];

describe("extractConfigFromMentions", () => {
  it("leaves model-looking mentions out of derived config", () => {
    const config = extractConfigFromMentions(
      "Use @fast, then @deep, then @openai/gpt-5.4, then @xai/grok-4.3.",
    );

    expect(config).toMatchObject({
      tools: [],
      brain: [],
      agents: [],
    });
  });

  it("resolves tool ids and labels", () => {
    const config = extractConfigFromMentions(
      "Research with @exa, @x, @slack, and implement with @AMP.",
    );

    expect(config.tools).toEqual(["exa", "x", "slack", "amp"]);
  });

  it("normalizes Brain file and folder paths", () => {
    const config = extractConfigFromMentions(
      "Read @brain/docs/README.md and @brain/product//specs/.",
    );

    expect(config.brain).toEqual([
      { path: "docs/README.md", type: "file" },
      { path: "product/specs/", type: "folder" },
    ]);
  });

  it("ignores agent mentions without a workspace agent catalog", () => {
    const config = extractConfigFromMentions("Ask @agent/research to summarize the findings.");

    expect(config.agents).toEqual([]);
  });
});

describe("agentMentionIdForPath", () => {
  it("derives mention ids from bundle directory names", () => {
    expect(agentMentionIdForPath("agents/research/research.agent")).toBe("agent/research");
    expect(agentMentionIdForPath("agents/research/agent.agent")).toBe("agent/research");
    expect(agentMentionIdForPath("agents/research-2/research-2.agent")).toBe("agent/research-2");
    expect(agentMentionIdForPath("agents/customer-success/customer-success.agent")).toBe(
      "agent/customer-success",
    );
  });

  it("rejects direct single-file and mismatched bundle paths", () => {
    expect(agentMentionIdForPath("agents/research.agent")).toBeNull();
    expect(agentMentionIdForPath("agents/research/other.agent")).toBeNull();
    expect(agentMentionIdForPath("research.agent")).toBeNull();
  });
});

describe("deriveAgentConfigFromBody", () => {
  it("binds the last known GitHub owner/repo mention and ignores unknown repos", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Code agent",
      body: "Use @opencompany/missing first, then @opencompany/runner.",
      repositories,
    });

    expect(config.integrations.github.repositories).toEqual([
      { id: "opencompany-runner", fullName: "opencompany/runner", defaultBranch: "develop" },
    ]);
  });

  it("records the mentioned GitHub repository without binding it to Amp", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Code agent",
      body: "Use @amp in @opencompany/web.",
      repositories,
    });

    expect(config.tools).toEqual([expect.objectContaining({ id: "amp" })]);
    expect(config.tools[0]).not.toHaveProperty("repository");
    expect(config.integrations.github.repositories).toEqual([
      { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
    ]);
  });

  it("preserves connection and resource binding from the repository catalog", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Code agent",
      body: "Use @amp in @opencompany/web.",
      repositories: boundRepositories,
    });

    expect(config.integrations.github.repositories).toEqual([
      {
        id: "opencompany-web",
        fullName: "opencompany/web",
        defaultBranch: "main",
        binding: boundRepositories[0]!.binding,
      },
    ]);
  });

  it("keeps duplicate owner/repo mentions unbound without a concrete preferred binding", () => {
    const secondBinding = {
      ...boundRepositories[0]!.binding,
      externalId: "repo_456",
      connection: {
        ...boundRepositories[0]!.binding.connection,
        externalId: "install_456",
        label: "OpenCompany EU",
      },
    };

    const { config } = deriveAgentConfigFromBody({
      title: "Code agent",
      body: "Use @amp in @opencompany/web.",
      repositories: [
        boundRepositories[0]!,
        {
          fullName: "opencompany/web",
          defaultBranch: "main",
          binding: secondBinding,
        },
      ],
    });

    expect(config.integrations.github.repositories).toEqual([
      { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
    ]);
  });

  it("uses a preferred binding to resolve duplicate owner/repo mentions", () => {
    const secondRepository = {
      fullName: "opencompany/web",
      defaultBranch: "main",
      binding: {
        ...boundRepositories[0]!.binding,
        externalId: "repo_456",
        connection: {
          ...boundRepositories[0]!.binding.connection,
          externalId: "install_456",
          label: "OpenCompany EU",
        },
      },
    };

    const { config } = deriveAgentConfigFromBody({
      title: "Code agent",
      body: "Use @amp in @opencompany/web.",
      repositories: [boundRepositories[0]!, secondRepository],
      preferredRepositories: [secondRepository],
    });

    expect(config.integrations.github.repositories).toEqual([
      {
        id: "opencompany-web",
        fullName: "opencompany/web",
        defaultBranch: "main",
        binding: secondRepository.binding,
      },
    ]);
  });

  it("does not record an unknown repo mention", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Code agent",
      body: "Use @amp in @opencompany/missing.",
      repositories,
    });

    expect(config.tools).toEqual([expect.objectContaining({ id: "amp" })]);
    expect(config.tools[0]).not.toHaveProperty("repository");
    expect(config.integrations.github.repositories).toEqual([]);
  });

  it("preserves the save invariant when Tiptap content is stale", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Code agent",
      body: "hello world\n\n@amp\n@useopencompany/agent-engineering-radar",
      repositories: [{ fullName: "useopencompany/agent-engineering-radar", defaultBranch: "main" }],
    });

    expect(config.integrations.github.repositories).toEqual([
      expect.objectContaining({ id: "useopencompany-agent-engineering-radar" }),
    ]);
    expect(config.tools).toEqual([expect.objectContaining({ id: "amp" })]);
    expect(config.tools[0]).not.toHaveProperty("repository");
  });

  it("binds known workspace agent mentions and dedupes repeats", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Coordinator",
      body: "Ask @agent/research first, then @agent/writer. Ask @agent/research again.",
      repositories: [],
      agents,
    });

    expect(config.agents).toEqual([
      { path: "agents/research/research.agent", name: "Research" },
      { path: "agents/writer/writer.agent", name: "Writer" },
    ]);
  });

  it("binds collided workspace agent mentions by bundle directory", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Coordinator",
      body: "Ask @agent/research-2 for a second pass.",
      repositories: [],
      agents: [{ path: "agents/research-2/research-2.agent", name: "Research 2" }],
    });

    expect(config.agents).toEqual([
      { path: "agents/research-2/research-2.agent", name: "Research 2" },
    ]);
  });

  it("ignores unknown workspace agent mentions", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Coordinator",
      body: "Ask @agent/missing first, then @agent/research.",
      repositories: [],
      agents,
    });

    expect(config.agents).toEqual([{ path: "agents/research/research.agent", name: "Research" }]);
  });

  const skill = {
    id: "improve-codebase-architecture",
    name: "Improve Codebase Architecture",
    description: "Analyze codebases for architectural friction.",
    source: {
      type: "github" as const,
      url: "https://github.com/mattpocock/skills",
      ref: "main",
      path: "skills/improve-codebase-architecture",
    },
  };
  const workspaceSkill = {
    id: "brand-voice",
    name: "Brand Voice",
    description: "Use the company voice.",
    source: {
      type: "workspace" as const,
      path: "skills/brand-voice",
    },
  };

  it("attaches a resolved external skill referenced via @skill/<id>", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Architect",
      body: "Use @skill/improve-codebase-architecture when reviewing.",
      repositories: [],
      skills: [skill],
    });

    expect(config.skills).toEqual([skill]);
  });

  it("attaches a resolved workspace skill referenced via @skill/<id>", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Writer",
      body: "Use @skill/brand-voice when drafting copy.",
      repositories: [],
      skills: [workspaceSkill],
    });

    expect(config.skills).toEqual([workspaceSkill]);
  });

  it("drops an @skill mention with no matching resolved skill", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Architect",
      body: "Use @skill/not-resolved.",
      repositories: [],
      skills: [skill],
    });

    expect(config.skills).toBeUndefined();
  });

  it("does not persist skills when the body drops the mention", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Architect",
      body: "No skills mentioned here.",
      repositories: [],
      skills: [skill],
    });

    expect(config.skills).toBeUndefined();
  });

  describe("plain @github (all repositories)", () => {
    it("sets allRepositories without attaching repositories or triggers", () => {
      const { config } = deriveAgentConfigFromBody({
        title: "Code agent",
        body: "Use @github for anything code related.",
        repositories,
        triggers: [
          {
            id: "old-pr",
            type: "github.pull_request",
            repository: "old",
            events: ["opened"],
            branches: [],
            enabled: true,
          },
        ],
      });

      expect(config.integrations.github.allRepositories).toBe(true);
      expect(config.integrations.github.repositories).toEqual([]);
      // No activeRepository from @github → triggers are not re-synced to any repository.
      expect(config.triggers).toEqual([]);
    });

    it("is omitted when the body has no @github mention", () => {
      const { config } = deriveAgentConfigFromBody({
        title: "Code agent",
        body: "Use @opencompany/web.",
        repositories,
      });

      expect(config.integrations.github).not.toHaveProperty("allRepositories");
    });

    it("combines with explicit repository mentions", () => {
      const { config } = deriveAgentConfigFromBody({
        title: "Code agent",
        body: "Use @github broadly, but prefer @opencompany/web.",
        repositories,
      });

      expect(config.integrations.github.allRepositories).toBe(true);
      expect(config.integrations.github.repositories).toEqual([
        { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
      ]);
    });
  });

  describe("@github/owner/repo alias", () => {
    it("binds the same repository as @owner/repo", () => {
      const { config } = deriveAgentConfigFromBody({
        title: "Code agent",
        body: "Work in @github/opencompany/web.",
        repositories: boundRepositories,
      });

      expect(config.integrations.github).not.toHaveProperty("allRepositories");
      expect(config.integrations.github.repositories).toEqual([
        {
          id: "opencompany-web",
          fullName: "opencompany/web",
          defaultBranch: "main",
          binding: boundRepositories[0]!.binding,
        },
      ]);
    });

    it("ignores an alias for an unknown repository", () => {
      const { config } = deriveAgentConfigFromBody({
        title: "Code agent",
        body: "Work in @github/opencompany/missing.",
        repositories,
      });

      expect(config.integrations.github.repositories).toEqual([]);
      expect(config.integrations.github).not.toHaveProperty("allRepositories");
    });

    it("does not strip the prefix from a repository owned by a 'github' org", () => {
      const { config } = deriveAgentConfigFromBody({
        title: "Code agent",
        body: "Work in @github/docs.",
        repositories: [{ fullName: "github/docs", defaultBranch: "main" }],
      });

      expect(config.integrations.github.repositories).toEqual([
        { id: "github-docs", fullName: "github/docs", defaultBranch: "main" },
      ]);
    });
  });
});
