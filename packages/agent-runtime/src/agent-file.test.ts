import { describe, expect, test } from "vitest";
import {
  buildAgentFile,
  parseAgentFile,
  serializeAgentFile,
  serializeAgentFrontmatter,
} from "./agent-file";
import { extractConfigFromMentions } from "./mentions";

describe(".agent files", () => {
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

  test("round-trips newly supported AI Gateway models", () => {
    const source = serializeAgentFile({
      title: "Gemini agent",
      body: "Use the selected gateway model.",
      model: "google/gemini-3-flash",
    });

    expect(source).toContain("model: google/gemini-3-flash");
    expect(parseAgentFile(source).config.model.name).toBe("google/gemini-3-flash");
  });

  test("syncs config from markdown mentions", () => {
    const config = extractConfigFromMentions(
      "Use @openai/gpt-5.4-mini first, then @openai/gpt-5.4 with @exa and @exa. Read @brain/docs/README.md and @brain/product/.",
    );

    expect(config.model).toBe("openai/gpt-5.4");
    expect(config.tools).toEqual(["exa"]);
    expect(config.brain).toEqual([
      { path: "docs/README.md", type: "file" },
      { path: "product/", type: "folder" },
    ]);
  });

  test("syncs tool config from display-label mentions", () => {
    const config = extractConfigFromMentions("Use @AMP for code changes.");

    expect(config.tools).toEqual(["amp"]);
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
        "Help with onboarding. #after-session Update @brain/memory.md with durable customer preferences.",
        "Keep this line in the same after-session paragraph.",
        "",
        "This paragraph is normal instructions.",
      ].join("\n"),
    });

    expect(agent.config.afterSession).toEqual({
      enabled: true,
      prompt:
        "Update @brain/memory.md with durable customer preferences.\nKeep this line in the same after-session paragraph.",
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
    expect(source).toContain("model: openai/gpt-5.4");
    expect(source).toContain("id: exa");
    expect(source).toContain("brain:\n  - docs/README.md");
    expect(
      source.endsWith("Find people with @exa, use @deep, and read @brain/docs/README.md."),
    ).toBe(true);
  });

  test("round-trips after-session tags through serialization", () => {
    const source = serializeAgentFile({
      title: "Memory",
      body: "Help users. #after-session Save durable facts in @brain/memory.md.",
    });

    expect(parseAgentFile(source).config.afterSession).toEqual({
      enabled: true,
      prompt: "Save durable facts in @brain/memory.md.",
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

  test("serializes explicit model selection ahead of legacy model mentions", () => {
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
          repository: "opencompany-web",
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
    expect(parsed.config.tools).toEqual([
      expect.objectContaining({ id: "amp", repository: "opencompany-web" }),
    ]);
    expect(parsed.config.triggers).toEqual([
      expect.objectContaining({ id: "opencompany-web-pr", repository: "opencompany-web" }),
    ]);
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
