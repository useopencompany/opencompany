import { describe, expect, test } from "vitest";
import {
  agentBundleDir,
  agentPathForSlug,
  buildAgentFile,
  parseAgentFile,
  serializeAgentFile,
  serializeAgentFrontmatter,
  validateAgentFileSource,
} from "./agent-file";
import { extractConfigFromMentions } from "./mentions";

describe(".agent files", () => {
  test("builds bundle-backed agent paths from slugs", () => {
    expect(agentPathForSlug("research")).toBe("agents/research/research.agent");
    expect(agentPathForSlug("research-2")).toBe("agents/research-2/research-2.agent");
    expect(agentBundleDir("agents/research-2/research-2.agent")).toBe("agents/research-2");
  });

  test("round-trips deterministic frontmatter and markdown body", () => {
    const source = [
      "---",
      'title: "Fundraising copilot"',
      "model: openai/gpt-5.4",
      "tools:",
      "  - exa",
      "---",
      "",
      "Research investors with @exa.",
    ].join("\n");

    const parsed = parseAgentFile(source);

    expect(parsed.title).toBe("Fundraising copilot");
    expect(parsed.body).toBe("Research investors with @exa.");
    expect(parsed.config.model.name).toBe("openai/gpt-5.4");
    expect(parsed.config.tools.map((tool) => tool.id)).toEqual(["exa"]);
  });

  test("defaults missing engine to opencompany", () => {
    const parsed = parseAgentFile(
      ["---", 'title: "Ops"', "model: openai/gpt-5.4", "---", "", "Do the work."].join("\n"),
    );

    expect(parsed.config.engine).toBe("opencompany");
  });

  test("round-trips codex engine through serialized frontmatter", () => {
    const source = serializeAgentFile({
      title: "Codex agent",
      body: "Use Codex for implementation work.",
      engine: "codex",
    });

    expect(source).toContain("engine: codex");
    expect(parseAgentFile(source).config.engine).toBe("codex");
  });

  test("defaults invalid or missing model and tools", () => {
    const parsed = parseAgentFile(
      [
        "---",
        'title: "Ops"',
        "model: nope",
        "tools:",
        "  - exa",
        "  - nope",
        "---",
        "",
        "Do the work.",
      ].join("\n"),
    );

    expect(parsed.config.model.name).toBe("openai/gpt-5.4-mini");
    expect(parsed.config.tools.map((tool) => tool.id)).toEqual(["exa"]);
  });

  test.each([
    "google/gemini-3-flash",
    "minimax/minimax-m3",
    "moonshotai/kimi-k2-thinking",
  ] as const)("round-trips newly supported AI Gateway model %s", (model) => {
    const source = serializeAgentFile({
      title: "Gateway agent",
      body: "Use the selected gateway model.",
      model,
    });

    expect(source).toContain(`model: ${model}`);
    expect(parseAgentFile(source).config.model.name).toBe(model);
  });

  test("syncs tool and brain config from markdown mentions", () => {
    const config = extractConfigFromMentions(
      "Use @openai/gpt-5.4-mini first, then @openai/gpt-5.4 with @exa, @x, and @exa. Read @brain/docs/README.md and @brain/product/.",
    );

    expect(config.tools).toEqual(["exa", "x"]);
    expect(config.brain).toEqual([
      { path: "docs/README.md", type: "file" },
      { path: "product/", type: "folder" },
    ]);
  });

  test("syncs tool config from display-label mentions", () => {
    const config = extractConfigFromMentions("Use @AMP for code changes.");

    expect(config.tools).toEqual(["amp"]);
  });

  test("round-trips the @github all-repositories scope from the body", () => {
    const source = serializeAgentFile({
      title: "Code agent",
      body: "Use @github for anything code related.",
    });

    expect(source).toContain("allRepositories: true");
    const parsed = parseAgentFile(source);
    expect(parsed.config.integrations.github.allRepositories).toBe(true);
    expect(parsed.config.integrations.github.repositories).toEqual([]);

    // Re-serializing the parsed file must be stable.
    const reserialized = serializeAgentFile({
      title: parsed.title,
      body: parsed.body,
      model: parsed.config.model.name,
      tools: parsed.config.tools,
      brain: parsed.config.brain,
      integrations: parsed.config.integrations,
      triggers: parsed.config.triggers,
    });
    expect(parseAgentFile(reserialized).config.integrations.github.allRepositories).toBe(true);
  });

  test("drops the all-repositories scope when the body loses the @github mention", () => {
    // Self-edit style: stale persisted integrations still carry the flag, but the new body
    // no longer mentions @github — the body wins.
    const source = serializeAgentFile({
      title: "Code agent",
      body: "No GitHub access needed anymore.",
      integrations: {
        github: { repositories: [], allRepositories: true },
      },
    });

    expect(source).not.toContain("allRepositories");
    expect(parseAgentFile(source).config.integrations.github).not.toHaveProperty("allRepositories");
  });

  test("agent files without the allRepositories key parse without the flag", () => {
    const parsed = parseAgentFile(
      ["---", 'title: "Ops"', "model: openai/gpt-5.4", "---", "", "Do the work."].join("\n"),
    );

    expect(parsed.config.integrations.github).not.toHaveProperty("allRepositories");
  });

  test("syncs opencode tool config from a mention", () => {
    const config = extractConfigFromMentions("Use @opencode for code changes.");

    expect(config.tools).toEqual(["opencode"]);
  });

  test("syncs Codex coding tool config from a mention", () => {
    const config = extractConfigFromMentions("Use @codex for code changes.");

    expect(config.tools).toEqual(["codex"]);
  });

  test("round-trips Linear MCP tool config without secrets", () => {
    const source = serializeAgentFile({
      title: "Linear triage",
      body: "Triage issues with @linear.",
    });

    expect(source).toContain("id: linear");
    expect(source).toContain("type: mcp");
    expect(source).toContain("server: linear");
    expect(source).not.toContain("token");
    expect(parseAgentFile(source).config.tools).toEqual([
      {
        id: "linear",
        type: "mcp",
        server: "linear",
        label: "linear",
        description: "Use workspace-configured Linear MCP tools.",
      },
    ]);
  });

  test("round-trips Slack MCP tool config without secrets", () => {
    const source = serializeAgentFile({
      title: "Slack research",
      body: "Search workspace context with @slack.",
    });

    expect(source).toContain("id: slack");
    expect(source).toContain("type: mcp");
    expect(source).toContain("server: slack");
    expect(source).not.toContain("token");
    expect(parseAgentFile(source).config.tools).toEqual([
      {
        id: "slack",
        type: "mcp",
        server: "slack",
        label: "slack",
        description: "Use workspace-configured Slack MCP tools.",
      },
    ]);
  });

  test("round-trips Better Stack MCP tool config without secrets", () => {
    const source = serializeAgentFile({
      title: "Better Stack ops",
      body: "Investigate production telemetry with @betterstack.",
    });

    expect(source).toContain("id: betterstack");
    expect(source).toContain("type: mcp");
    expect(source).toContain("server: betterstack");
    expect(source).not.toContain("token");
    expect(parseAgentFile(source).config.tools).toEqual([
      {
        id: "betterstack",
        type: "mcp",
        server: "betterstack",
        label: "betterstack",
        description: "Use workspace-configured Better Stack MCP tools.",
      },
    ]);
  });

  test("round-trips Notion MCP tool config without secrets", () => {
    const source = serializeAgentFile({
      title: "Notion docs",
      body: "Search docs and create pages with @notion.",
    });

    expect(source).toContain("id: notion");
    expect(source).toContain("type: mcp");
    expect(source).toContain("server: notion");
    expect(source).not.toContain("token");
    expect(parseAgentFile(source).config.tools).toEqual([
      {
        id: "notion",
        type: "mcp",
        server: "notion",
        label: "notion",
        description: "Use workspace-configured Notion MCP tools.",
      },
    ]);
  });

  test("round-trips X hosted tool config without secrets", () => {
    const source = serializeAgentFile({
      title: "X research",
      body: "Research public conversations with @x.",
    });

    expect(source).toContain("id: x");
    expect(source).toContain("type: hosted_tool");
    expect(source).not.toContain("token");
    expect(parseAgentFile(source).config.tools).toEqual([
      {
        id: "x",
        type: "hosted_tool",
        label: "x",
        description: "Scrape public X posts, profiles, timelines, and discussions through Apify.",
      },
    ]);
  });

  test("syncs the root Brain folder from markdown mentions", () => {
    const config = extractConfigFromMentions("Use all shared context in @brain/.");

    expect(config.brain).toEqual([{ path: "/", type: "folder" }]);
  });

  test("falls back to default config when mentions are removed", () => {
    const agent = buildAgentFile({
      title: "Clean room",
      body: "No deterministic mentions here.",
    });

    expect(agent.config.model.name).toBe("openai/gpt-5.4-mini");
    expect(agent.config.tools).toEqual([]);
    expect(agent.config.brain).toEqual([]);
    expect(agent.config.afterSession).toBeUndefined();
  });

  test("extracts inline after-session prompt from the current paragraph", () => {
    const agent = buildAgentFile({
      title: "Memory",
      body: [
        "Help with onboarding. #after-session Update agent/memory.md with durable customer preferences.",
        "Keep this line in the same after-session paragraph.",
        "",
        "This paragraph is normal instructions.",
      ].join("\n"),
    });

    expect(agent.config.afterSession).toEqual({
      enabled: true,
      prompt:
        "Update agent/memory.md with durable customer preferences.\nKeep this line in the same after-session paragraph.",
      idleDelaySeconds: 180,
    });
  });

  test("leaves empty after-session markers disabled", () => {
    const agent = buildAgentFile({
      title: "Memory",
      body: "Help with onboarding.\n\n#after-session\n\nNo hook guidance.",
    });

    expect(agent.config.afterSession).toBeUndefined();
  });

  test("ignores after-session-like text inside words", () => {
    expect(
      buildAgentFile({
        title: "Memory",
        body: "Help with onboarding. #after-sessionsmoothly update memory.",
      }).config.afterSession,
    ).toBeUndefined();

    expect(
      buildAgentFile({
        title: "Memory",
        body: "Help with onboarding. pre#after-session update memory.",
      }).config.afterSession,
    ).toBeUndefined();
  });

  test("serializes body with rewritten frontmatter", () => {
    const source = serializeAgentFile({
      title: "Research",
      body: "Find people with @exa, use @deep, and read @brain/docs/README.md.",
    });

    expect(source).toContain("title: Research");
    expect(source).toContain("model: openai/gpt-5.4-mini");
    expect(source).toContain("id: exa");
    expect(source).toContain("brain:\n  - docs/README.md");
    expect(
      source.endsWith("Find people with @exa, use @deep, and read @brain/docs/README.md."),
    ).toBe(true);
  });

  test("round-trips after-session tags through serialization", () => {
    const source = serializeAgentFile({
      title: "Memory",
      body: "Help users. #after-session Save durable facts in agent/memory.md.",
    });

    expect(parseAgentFile(source).config.afterSession).toEqual({
      enabled: true,
      prompt: "Save durable facts in agent/memory.md.",
      idleDelaySeconds: 180,
    });
  });

  test("serializes frontmatter with the same shape as agent files", () => {
    const source = serializeAgentFile({
      title: "Research",
      body: "Find people with @exa, use @deep, and read @brain/docs/README.md.",
    });
    const parsed = parseAgentFile(source);
    const frontmatter = serializeAgentFrontmatter({
      title: parsed.title,
      model: parsed.config.model.name,
      tools: parsed.config.tools,
      brain: parsed.config.brain,
      integrations: parsed.config.integrations,
      triggers: parsed.config.triggers,
    });

    expect(source.startsWith(`${frontmatter}\n\n`)).toBe(true);
  });

  test("round-trips brain frontmatter", () => {
    const source = [
      "---",
      'title: "Brainy"',
      "model: openai/gpt-5.4-mini",
      "tools:",
      "brain:",
      "  - /",
      "  - docs/README.md",
      "  - product/",
      "---",
      "",
      "Use the mounted context.",
    ].join("\n");

    const parsed = parseAgentFile(source);

    expect(parsed.config.brain).toEqual([
      { path: "/", type: "folder" },
      { path: "docs/README.md", type: "file" },
      { path: "product/", type: "folder" },
    ]);
  });

  test("round-trips delegated agent frontmatter", () => {
    const source = serializeAgentFile({
      title: "Coordinator",
      body: "Delegate research to @agent/research.",
      agents: [{ path: "agents/research/research.agent", name: "Research" }],
    });
    const parsed = parseAgentFile(source);

    expect(source).toContain(
      "agents:\n  - path: agents/research/research.agent\n    name: Research",
    );
    expect(parsed.config.agents).toEqual([
      { path: "agents/research/research.agent", name: "Research" },
    ]);
  });

  test("canonicalizes legacy delegated agent frontmatter paths", () => {
    const parsed = parseAgentFile(
      [
        "---",
        'title: "Coordinator"',
        "agents:",
        "  - path: agents/research/agent.agent",
        "    name: Research",
        "---",
        "",
        "Delegate research to @agent/research.",
      ].join("\n"),
    );

    expect(parsed.config.agents).toEqual([
      { path: "agents/research/research.agent", name: "Research" },
    ]);
  });

  test("drops invalid delegated agent frontmatter entries", () => {
    const parsed = parseAgentFile(
      [
        "---",
        'title: "Coordinator"',
        "agents:",
        "  - path: agents/research/research.agent",
        "    name: Research",
        "  - path: ../secret.agent",
        "    name: Missing",
        "---",
        "",
        "Delegate work.",
      ].join("\n"),
    );

    expect(parsed.config.agents).toEqual([
      { path: "agents/research/research.agent", name: "Research" },
    ]);
  });

  test("does not derive unknown delegated agent mentions without a catalog", () => {
    const source = serializeAgentFile({
      title: "Coordinator",
      body: "Delegate research to @agent/research.",
    });

    expect(parseAgentFile(source).config.agents).toEqual([]);
  });

  test("serializes explicit model selection and ignores legacy model mentions", () => {
    const source = serializeAgentFile({
      title: "Research",
      body: "Find people with @exa and use @deep.",
      model: "anthropic/claude-sonnet-4.6",
    });

    expect(source).toContain("model: anthropic/claude-sonnet-4.6");
    expect(parseAgentFile(source).config.model.name).toBe("anthropic/claude-sonnet-4.6");
  });

  test("does not let empty explicit config suppress body mentions", () => {
    const source = serializeAgentFile({
      title: "Code",
      body: "Use @amp and read @brain/docs/README.md.",
      tools: [],
      brain: [],
    });
    const parsed = parseAgentFile(source);

    expect(parsed.config.tools).toEqual([expect.objectContaining({ id: "amp" })]);
    expect(parsed.config.brain).toEqual([{ path: "docs/README.md", type: "file" }]);
  });

  test("serializes Codex as a coding-agent tool config", () => {
    const source = serializeAgentFile({
      title: "Code",
      body: "Work with @codex.",
    });

    expect(source).toContain("id: codex");
    expect(source).toContain("type: coding_agent");
    expect(source).toContain("provider: codex");
    expect(source).toContain("label: Codex");
    expect(source).toContain("description: Delegate coding work to Codex inside an E2B sandbox.");
    expect(source).toContain("prCapable: true");
    expect(parseAgentFile(source).config.tools).toEqual([expect.objectContaining({ id: "codex" })]);
  });

  test("round-trips GitHub repository integrations through frontmatter", () => {
    const source = serializeAgentFile({
      title: "Code",
      body: "Work in @opencompany/web with @amp.",
      tools: [
        {
          id: "amp",
          type: "coding_agent",
          provider: "amp",
          label: "AMP",
          description: "Delegate coding work to Amp inside an E2B sandbox.",
          prCapable: true,
        },
      ],
      integrations: {
        github: {
          repositories: [
            { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
          ],
        },
      },
      triggers: [
        {
          id: "opencompany-web-pr",
          type: "github.pull_request",
          repository: "opencompany-web",
          events: ["opened", "synchronize"],
          branches: ["main"],
          enabled: true,
        },
      ],
    });
    const parsed = parseAgentFile(source);

    expect(parsed.config.integrations.github.repositories).toEqual([
      { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
    ]);
    expect(parsed.config.tools).toEqual([expect.objectContaining({ id: "amp" })]);
    expect(parsed.config.tools[0]).not.toHaveProperty("repository");
    expect(parsed.config.triggers).toEqual([
      expect.objectContaining({ id: "opencompany-web-pr", repository: "opencompany-web" }),
    ]);
  });

  test("round-trips supported schedule triggers through frontmatter", () => {
    const source = serializeAgentFile({
      title: "Briefing",
      body: "Prepare recurring status updates.",
      triggers: [
        {
          id: "weekday-brief",
          type: "agent.schedule",
          cron: "0 9 * * 1-5",
          timezone: "America/Los_Angeles",
          prompt: "Review open priorities and write a concise status brief.",
          enabled: true,
        },
      ],
    });
    const parsed = parseAgentFile(source);

    expect(source).toContain("type: agent.schedule");
    expect(source).toContain("cron: 0 9 * * 1-5");
    expect(parsed.config.triggers).toEqual([
      {
        id: "weekday-brief",
        type: "agent.schedule",
        cron: "0 9 * * 1-5",
        timezone: "America/Los_Angeles",
        prompt: "Review open priorities and write a concise status brief.",
        enabled: true,
      },
    ]);
  });

  test("drops unsupported schedule trigger shapes", () => {
    const parsed = parseAgentFile(
      [
        "---",
        'title: "Briefing"',
        "triggers:",
        "  - id: ok",
        "    type: agent.schedule",
        "    cron: '*/15 * * * *'",
        "    timezone: America/New_York",
        "    prompt: Run the briefing.",
        "    enabled: true",
        "  - id: arbitrary-cron",
        "    type: agent.schedule",
        "    cron: '13 9 1 * *'",
        "    timezone: America/New_York",
        "    prompt: Run the briefing.",
        "    enabled: true",
        "  - id: missing-prompt",
        "    type: agent.schedule",
        "    cron: '0 9 * * *'",
        "    timezone: America/New_York",
        "---",
        "",
        "Prepare recurring status updates.",
      ].join("\n"),
    );

    expect(parsed.config.triggers).toEqual([
      {
        id: "ok",
        type: "agent.schedule",
        cron: "*/15 * * * *",
        timezone: "America/New_York",
        prompt: "Run the briefing.",
        enabled: true,
      },
    ]);
  });

  test("ignores a legacy amp.repository field when parsing", () => {
    const parsed = parseAgentFile(
      [
        "---",
        'title: "Code"',
        "model: openai/gpt-5.4-mini",
        "tools:",
        "  - id: amp",
        "    type: coding_agent",
        "    provider: amp",
        "    repository: opencompany-web",
        "    prCapable: true",
        "integrations:",
        "  github:",
        "    repositories:",
        "      - id: opencompany-web",
        "        fullName: opencompany/web",
        "        defaultBranch: main",
        "---",
        "",
        "Work in @opencompany/web with @amp.",
      ].join("\n"),
    );

    expect(parsed.config.tools).toEqual([expect.objectContaining({ id: "amp" })]);
    expect(parsed.config.tools[0]).not.toHaveProperty("repository");
  });

  test("round-trips optional GitHub repository connection binding", () => {
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
    const source = serializeAgentFile({
      title: "Code",
      body: "Work in @opencompany/web with @amp.",
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
    });

    expect(parseAgentFile(source).config.integrations.github.repositories).toEqual([
      {
        id: "opencompany-web",
        fullName: "opencompany/web",
        defaultBranch: "main",
        binding,
      },
    ]);
  });

  test("round-trips optional Neon database connection binding without credentials", () => {
    const binding = {
      provider: "neon" as const,
      resourceType: "database" as const,
      externalId: "proj_1:br_1:neondb:neondb_owner",
      displayName: "Project/main/neondb",
      connection: {
        externalId: "proj_1",
        label: "Project",
        accountName: "Project",
        accountType: "Project",
      },
    };
    const source = serializeAgentFile({
      title: "Database",
      body: "Use @neon for database work.",
      tools: [{ id: "neon", type: "hosted_tool", label: "neon", description: "Neon." }],
      integrations: {
        github: { repositories: [] },
        neon: {
          databases: [
            {
              id: "proj-1-br-1-neondb",
              projectId: "proj_1",
              branchId: "br_1",
              databaseName: "neondb",
              roleName: "neondb_owner",
              displayName: "Project/main/neondb",
              binding,
            },
          ],
        },
      },
    });

    const parsed = parseAgentFile(source);

    expect(parsed.config.tools).toEqual([expect.objectContaining({ id: "neon" })]);
    expect(parsed.config.integrations.neon?.databases).toEqual([
      {
        id: "proj-1-br-1-neondb",
        projectId: "proj_1",
        branchId: "br_1",
        databaseName: "neondb",
        roleName: "neondb_owner",
        displayName: "Project/main/neondb",
        binding,
      },
    ]);
    expect(source).not.toContain("apiKey");
    expect(source).not.toContain("DATABASE_URL");
  });

  test("keeps legacy GitHub repository config valid without binding", () => {
    const parsed = parseAgentFile(
      [
        "---",
        'title: "Code"',
        "model: openai/gpt-5.4-mini",
        "tools:",
        "  - amp",
        "integrations:",
        "  github:",
        "    repositories:",
        "      - id: opencompany-web",
        "        fullName: opencompany/web",
        "        defaultBranch: main",
        "---",
        "",
        "Work in @opencompany/web.",
      ].join("\n"),
    );

    expect(parsed.config.integrations.github.repositories).toEqual([
      { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
    ]);
  });
});

describe("validateAgentFileSource", () => {
  const goodSource = serializeAgentFile({
    title: "Agent",
    body: "Help the user with @exa.",
    model: "openai/gpt-5.4",
  });

  test("accepts a well-formed source and returns the parsed file", () => {
    const result = validateAgentFileSource(goodSource);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed.title).toBe("Agent");
      expect(result.parsed.config.model.name).toBe("openai/gpt-5.4");
    }
  });

  test("rejects a missing frontmatter fence", () => {
    const result = validateAgentFileSource("Just a body, no frontmatter.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/frontmatter/i);
  });

  test("rejects an empty title", () => {
    const result = validateAgentFileSource('---\ntitle: ""\nmodel: openai/gpt-5.4\n---\n\nBody.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/title/i);
  });

  test("rejects an unknown model instead of silently defaulting", () => {
    const result = validateAgentFileSource(
      '---\ntitle: "Agent"\nmodel: openai/not-a-real-model\n---\n\nBody.',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/model/i);
  });

  test("rejects an unknown engine instead of silently defaulting", () => {
    const result = validateAgentFileSource(
      '---\ntitle: "Agent"\nengine: spaceship\nmodel: openai/gpt-5.4\n---\n\nBody.',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/engine/i);
  });

  test("rejects an empty body", () => {
    const result = validateAgentFileSource(
      '---\ntitle: "Agent"\nmodel: openai/gpt-5.4\n---\n\n   ',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/body/i);
  });

  test("rejects malformed frontmatter YAML", () => {
    const result = validateAgentFileSource(
      '---\ntitle: "Agent\nmodel: openai/gpt-5.4\n---\n\nBody.',
    );
    expect(result.ok).toBe(false);
  });

  test("round-trips an external skill through the self-edit guard", () => {
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
    const source = serializeAgentFile({
      title: "Agent",
      body: "Use @skill/improve-codebase-architecture.",
      model: "openai/gpt-5.4",
      skills: [skill],
    });
    const result = validateAgentFileSource(source);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed.config.skills).toEqual([skill]);
  });

  test("round-trips a workspace skill through the self-edit guard", () => {
    const skill = {
      id: "brand-voice",
      name: "Brand Voice",
      description: "Use the company voice.",
      source: {
        type: "workspace" as const,
        path: "skills/brand-voice",
      },
    };
    const source = serializeAgentFile({
      title: "Agent",
      body: "Use @skill/brand-voice.",
      model: "openai/gpt-5.4",
      skills: [skill],
    });
    const result = validateAgentFileSource(source);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed.config.skills).toEqual([skill]);
  });
});
