import { describe, expect, it } from "vitest";
import { deriveAgentConfigFromBody, extractConfigFromMentions } from "./mentions";

const repositories = [
  { fullName: "opencompany/web", defaultBranch: "main" },
  { fullName: "opencompany/runner", defaultBranch: "develop" },
];
const agents = [
  { path: "agents/research.agent", name: "Research" },
  { path: "agents/writer.agent", name: "Writer" },
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
      "Research with @exa, @slack, and implement with @AMP.",
    );

    expect(config.tools).toEqual(["exa", "slack", "amp"]);
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
      { path: "agents/research.agent", name: "Research" },
      { path: "agents/writer.agent", name: "Writer" },
    ]);
  });

  it("ignores unknown workspace agent mentions", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Coordinator",
      body: "Ask @agent/missing first, then @agent/research.",
      repositories: [],
      agents,
    });

    expect(config.agents).toEqual([{ path: "agents/research.agent", name: "Research" }]);
  });
});
