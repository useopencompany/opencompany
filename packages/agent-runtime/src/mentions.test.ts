import { describe, expect, it } from "vitest";
import { deriveAgentConfigFromBody, extractConfigFromMentions } from "./mentions";

const repositories = [
  { fullName: "opencompany/web", defaultBranch: "main" },
  { fullName: "opencompany/runner", defaultBranch: "develop" },
];

describe("extractConfigFromMentions", () => {
  it("resolves model aliases and lets the last model win", () => {
    const config = extractConfigFromMentions("Use @fast, then switch to @deep.");

    expect(config.model).toBe("openai/gpt-5.4");
  });

  it("resolves supported AI Gateway model mentions", () => {
    const config = extractConfigFromMentions(
      "Use @google/gemini-3-flash first, then @deepseek/deepseek-v4-flash.",
    );

    expect(config.model).toBe("deepseek/deepseek-v4-flash");
  });

  it("resolves Kimi and GLM model mentions", () => {
    const config = extractConfigFromMentions("Use @moonshotai/kimi-k2.6 first, then @zai/glm-5.1.");

    expect(config.model).toBe("zai/glm-5.1");
  });

  it("resolves tool ids and labels", () => {
    const config = extractConfigFromMentions("Research with @exa and implement with @AMP.");

    expect(config.tools).toEqual(["exa", "amp"]);
  });

  it("resolves skill mentions", () => {
    const config = extractConfigFromMentions("Use @opencompany to propose agent changes.");

    expect(config.skills).toEqual(["opencompany"]);
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

  it("binds Amp to the mentioned GitHub repository", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Code agent",
      body: "Use @opencompany and @amp in @opencompany/web.",
      repositories,
    });

    expect(config.skills).toEqual(["opencompany"]);
    expect(config.tools).toEqual([
      expect.objectContaining({ id: "amp", repository: "opencompany-web" }),
    ]);
    expect(config.integrations.github.repositories).toEqual([
      { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
    ]);
  });

  it("keeps Amp unbound when the repo mention is unknown", () => {
    const { config } = deriveAgentConfigFromBody({
      title: "Code agent",
      body: "Use @amp in @opencompany/missing.",
      repositories,
    });

    expect(config.tools).toEqual([expect.objectContaining({ id: "amp", repository: null })]);
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
    expect(config.tools).toEqual([
      expect.objectContaining({
        id: "amp",
        repository: "useopencompany-agent-engineering-radar",
      }),
    ]);
  });
});
