import { describe, expect, test } from "vitest";
import {
  buildAgentFile,
  extractConfigFromMentions,
  parseAgentFile,
  repositoryIdForFullName,
  serializeAgentFile,
} from "./agent-file";
import { hashAgentSource } from "./hash";

describe(".agent files", () => {
  test("parses version 2 structured frontmatter", () => {
    const source = [
      "---",
      "version: 2",
      'title: "AMP code agent"',
      "model: openai/gpt-5.4",
      "tools:",
      "  - id: amp",
      "    type: coding_agent",
      "    provider: amp",
      "    repository: web-app",
      "    prCapable: true",
      "  - id: exa",
      "    type: hosted_tool",
      "integrations:",
      "  github:",
      "    repositories:",
      "      - id: web-app",
      "        fullName: opencompany/opencompany",
      "        defaultBranch: main",
      "triggers:",
      "  - id: pr-work",
      "    type: github.pull_request",
      "    repository: web-app",
      "    events: [opened, reopened, synchronize, ready_for_review]",
      "    branches: [main]",
      "    enabled: false",
      "---",
      "",
      "Use @amp for code changes in @web-app.",
    ].join("\n");

    const parsed = parseAgentFile(source);

    expect(parsed.config.version).toBe(2);
    expect(parsed.title).toBe("AMP code agent");
    expect(parsed.body).toBe("Use @amp for code changes in @web-app.");
    expect(parsed.config.model.name).toBe("openai/gpt-5.4");
    expect(parsed.config.integrations.github.repositories).toEqual([
      { id: "web-app", fullName: "opencompany/opencompany", defaultBranch: "main" },
    ]);
    expect(parsed.config.tools).toEqual([
      expect.objectContaining({
        id: "amp",
        type: "coding_agent",
        provider: "amp",
        repository: "web-app",
        prCapable: true,
      }),
      expect.objectContaining({ id: "exa", type: "hosted_tool" }),
    ]);
    expect(parsed.config.triggers).toEqual([
      {
        id: "pr-work",
        type: "github.pull_request",
        repository: "web-app",
        events: ["opened", "reopened", "synchronize", "ready_for_review"],
        branches: ["main"],
        enabled: false,
      },
    ]);
  });

  test("drops invalid repository references without refusing to load", () => {
    const parsed = parseAgentFile(
      [
        "---",
        "version: 2",
        'title: "Ops"',
        "model: nope",
        "tools:",
        "  - id: amp",
        "    type: coding_agent",
        "    provider: amp",
        "    repository: missing",
        "  - id: nope",
        "integrations:",
        "  github:",
        "    repositories:",
        "      - id: web",
        "        fullName: invalid",
        "triggers:",
        "  - id: bad",
        "    type: github.pull_request",
        "    repository: missing",
        "---",
        "",
        "Do the work.",
      ].join("\n"),
    );

    expect(parsed.config.model.name).toBe("openai/gpt-5.4-mini");
    expect(parsed.config.integrations.github.repositories).toEqual([]);
    expect(parsed.config.tools).toEqual([expect.objectContaining({ id: "amp", repository: null })]);
    expect(parsed.config.triggers).toEqual([]);
  });

  test("mentions are editor hints, not structured tool config", () => {
    const config = extractConfigFromMentions(
      "Use @openai/gpt-5.4-mini first, then @openai/gpt-5.4 with @exa and @amp.",
    );
    const agent = buildAgentFile({
      title: "Clean room",
      body: "Use @exa and @amp in prose only.",
    });

    expect(config.model).toBe("openai/gpt-5.4");
    expect(config.tools).toEqual(["exa", "amp"]);
    expect(agent.config.tools).toEqual([]);
  });

  test("serializes explicit structured config", () => {
    const source = serializeAgentFile({
      title: "Research",
      body: "Find people and make a PR.",
      model: "anthropic/claude-sonnet-4.6",
      tools: [
        {
          id: "amp",
          type: "coding_agent",
          provider: "amp",
          label: "AMP",
          description: "Delegate coding work to Amp inside an E2B sandbox.",
          repository: "web",
          prCapable: true,
        },
      ],
      integrations: {
        github: {
          repositories: [{ id: "web", fullName: "opencompany/opencompany", defaultBranch: "main" }],
        },
      },
      triggers: [
        {
          id: "web-pr",
          type: "github.pull_request",
          repository: "web",
          events: ["opened", "synchronize"],
          branches: ["main"],
          enabled: false,
        },
      ],
    });

    expect(source).toContain("version: 2");
    expect(source).toContain("model: anthropic/claude-sonnet-4.6");
    expect(source).toContain("id: amp");
    expect(source.endsWith("Find people and make a PR.")).toBe(true);
    expect(parseAgentFile(source).config.tools).toEqual([
      expect.objectContaining({ id: "amp", repository: "web" }),
    ]);
  });

  test("hashes serialized agent source deterministically", () => {
    const source = serializeAgentFile({
      title: "Research",
      body: "Find people.",
    });

    expect(repositoryIdForFullName("opencompany/opencompany")).toBe("opencompany-opencompany");
    expect(hashAgentSource(source)).toBe(hashAgentSource(source));
    expect(hashAgentSource(source)).not.toBe(hashAgentSource(source.replace("Find", "Locate")));
  });
});
