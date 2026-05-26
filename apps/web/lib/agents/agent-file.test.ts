import { describe, expect, test } from "vitest";
import {
  buildAgentFile,
  extractConfigFromMentions,
  parseAgentFile,
  serializeAgentFile,
} from "./agent-file";
import { hashAgentSource } from "./hash";

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
      body: "Find people with @exa and use @deep.",
    });

    expect(source).toContain("title: Research");
    expect(source).toContain("model: openai/gpt-5.4");
    expect(source).toContain("id: exa");
    expect(source).toContain("brain:");
    expect(source.endsWith("Find people with @exa and use @deep.")).toBe(true);
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

  test("hashes serialized agent source deterministically", () => {
    const source = serializeAgentFile({
      title: "Research",
      body: "Find people with @exa.",
    });

    expect(hashAgentSource(source)).toBe(hashAgentSource(source));
    expect(hashAgentSource(source)).not.toBe(hashAgentSource(source.replace("@exa", "@deep")));
  });
});
