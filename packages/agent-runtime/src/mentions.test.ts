import { describe, expect, it } from "vitest";
import {
  agentMentionIdForPath,
  buildConfigMentionResolver,
  deriveAgentConfigFromBody,
  extractConfigFromMentions,
  extractMentionIds,
  lintAgentBodyMentions,
  unwrapBacktickWrappedMentions,
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

  it("attaches a resolved external skill referenced via @skill/<id>", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Architect",
      body: "Use @skill/improve-codebase-architecture when reviewing.",
      repositories: [],
      skills: [skill],
    });

    expect(config.skills).toEqual([skill]);
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
});

// A resolver backed by a real derived config so tool/brain round-trip guards
// behave exactly as they do in production.
const resolver = buildConfigMentionResolver(
  deriveAgentConfigFromBody({
    title: "Reviewer",
    body: "Use @opencode and @exa and @brain/wiki/",
    repositories: [],
  }).config,
);

describe("extractMentionIds with backtick-wrapped mentions", () => {
  it("recognizes a mention wrapped in inline-code backticks", () => {
    expect(extractMentionIds("Use `@opencode` to do the work")).toEqual(["opencode"]);
    expect(extractMentionIds("Reference `@brain/`")).toEqual(["brain/"]);
  });

  it("enables the tool when the only mention is backtick-wrapped", () => {
    expect(extractConfigFromMentions("Delegate to `@opencode` for coding.").tools).toEqual([
      "opencode",
    ]);
  });
});

describe("unwrapBacktickWrappedMentions", () => {
  it("unwraps a resolvable backtick-wrapped mention", () => {
    expect(unwrapBacktickWrappedMentions("Use `@opencode` to fetch diffs", resolver)).toBe(
      "Use @opencode to fetch diffs",
    );
    expect(unwrapBacktickWrappedMentions("Reference `@brain/wiki/` for context", resolver)).toBe(
      "Reference @brain/wiki/ for context",
    );
  });

  it("leaves unresolvable, double-backtick, and spaced spans untouched", () => {
    expect(unwrapBacktickWrappedMentions("Set the `@param` value", resolver)).toBe(
      "Set the `@param` value",
    );
    expect(unwrapBacktickWrappedMentions("Use ``@opencode`` here", resolver)).toBe(
      "Use ``@opencode`` here",
    );
    expect(unwrapBacktickWrappedMentions("Use ` @opencode ` here", resolver)).toBe(
      "Use ` @opencode ` here",
    );
  });

  it("does not merge into an adjacent word", () => {
    expect(unwrapBacktickWrappedMentions("`@opencode`extra", resolver)).toBe("`@opencode`extra");
  });

  it("is idempotent", () => {
    const once = unwrapBacktickWrappedMentions("Use `@opencode` now", resolver);
    expect(unwrapBacktickWrappedMentions(once, resolver)).toBe(once);
  });

  it("leaves a bare mention unchanged", () => {
    expect(unwrapBacktickWrappedMentions("Use @opencode now", resolver)).toBe("Use @opencode now");
  });
});

describe("lintAgentBodyMentions", () => {
  it("warns about a backtick-wrapped resolvable mention", () => {
    const warnings = lintAgentBodyMentions("Use `@opencode` for coding", resolver);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@opencode");
    expect(warnings[0]).toContain("backticks");
  });

  it("warns about a namespaced mention that does not resolve", () => {
    const warnings = lintAgentBodyMentions("Enable @skill/does-not-exist please", resolver);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@skill/does-not-exist");
    expect(warnings[0]).toContain("could not be resolved");
  });

  it("does not warn on prose @, emails, or resolved bare mentions", () => {
    expect(lintAgentBodyMentions("Email me at louis@acta.so or ping @someone", resolver)).toEqual(
      [],
    );
    expect(lintAgentBodyMentions("Use @opencode and @brain/wiki/ as usual", resolver)).toEqual([]);
  });
});
