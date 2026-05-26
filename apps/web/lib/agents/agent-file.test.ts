import { describe, expect, test } from "vitest";
import {
  buildAgentFile,
  parseAgentFile,
  serializeAgentFile,
  serializeAgentFrontmatter,
} from "./agent-file";
import { hashAgentSource } from "./hash";
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

  test("falls back to default config when mentions are removed", () => {
    const agent = buildAgentFile({
      title: "Clean room",
      body: "No deterministic mentions here.",
    });

    expect(agent.config.model.name).toBe("openai/gpt-5.4-mini");
    expect(agent.config.tools).toEqual([]);
    expect(agent.config.brain).toEqual([]);
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
      "  - docs/README.md",
      "  - product/",
      "---",
      "",
      "Use the mounted context.",
    ].join("\n");

    const parsed = parseAgentFile(source);

    expect(parsed.config.brain).toEqual([
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

  test("hashes serialized agent source deterministically", () => {
    const source = serializeAgentFile({
      title: "Research",
      body: "Find people with @exa.",
    });

    expect(hashAgentSource(source)).toBe(hashAgentSource(source));
    expect(hashAgentSource(source)).not.toBe(hashAgentSource(source.replace("@exa", "@deep")));
  });
});
