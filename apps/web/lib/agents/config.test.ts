import { describe, expect, it } from "vitest";
import { deriveAgentConfigFromContent } from "./config";
import type { TiptapDoc } from "./types";

const repositories = [
  { fullName: "opencompany/web", defaultBranch: "main" },
  { fullName: "opencompany/runner", defaultBranch: "develop" },
];

describe("deriveAgentConfigFromContent", () => {
  it("binds AMP to the mentioned GitHub work repository", () => {
    const { body, config } = deriveAgentConfigFromContent({
      title: "Code agent",
      content: doc([
        mention("tool:amp", "AMP"),
        text(" in "),
        mention("integration:github:opencompany-web", "opencompany/web"),
      ]),
      repositories,
    });

    expect(body).toBe("@AMP in @opencompany/web");
    expect(config.tools).toEqual([
      expect.objectContaining({ id: "amp", repository: "opencompany-web" }),
    ]);
    expect(config.integrations.github.repositories).toEqual([
      { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
    ]);
  });

  it("keeps AMP selected without exposing a repository when no repo is mentioned", () => {
    const { config } = deriveAgentConfigFromContent({
      title: "Code agent",
      content: doc([mention("tool:amp", "AMP")]),
      repositories,
    });

    expect(config.tools).toEqual([expect.objectContaining({ id: "amp", repository: null })]);
    expect(config.integrations.github.repositories).toEqual([]);
  });

  it("removes the GitHub integration when the repo mention is removed", () => {
    const { config } = deriveAgentConfigFromContent({
      title: "Code agent",
      content: doc([mention("tool:exa", "exa")]),
      repositories,
    });

    expect(config.tools).toEqual([expect.objectContaining({ id: "exa" })]);
    expect(config.integrations.github.repositories).toEqual([]);
  });

  it("uses the last repository mention when multiple repos are present", () => {
    const { config } = deriveAgentConfigFromContent({
      title: "Code agent",
      content: doc([
        mention("tool:amp", "AMP"),
        text(" first "),
        mention("integration:github:opencompany-web", "opencompany/web"),
        text(" then "),
        mention("integration:github:opencompany-runner", "opencompany/runner"),
      ]),
      repositories,
    });

    expect(config.tools).toEqual([
      expect.objectContaining({ id: "amp", repository: "opencompany-runner" }),
    ]);
    expect(config.integrations.github.repositories).toEqual([
      { id: "opencompany-runner", fullName: "opencompany/runner", defaultBranch: "develop" },
    ]);
  });

  it("preserves unavailable repo mentions in body but does not bind AMP", () => {
    const { body, config } = deriveAgentConfigFromContent({
      title: "Code agent",
      content: doc([
        mention("tool:amp", "AMP"),
        text(" in "),
        mention("integration:github:opencompany-missing", "opencompany/missing"),
      ]),
      repositories,
    });

    expect(body).toBe("@AMP in @opencompany/missing");
    expect(config.tools).toEqual([expect.objectContaining({ id: "amp", repository: null })]);
    expect(config.integrations.github.repositories).toEqual([]);
  });
});

function doc(content: NonNullable<TiptapDoc["content"]>[number]["content"]): TiptapDoc {
  return {
    type: "doc",
    content: [{ type: "paragraph", content }],
  };
}

function mention(id: string, label: string) {
  return {
    type: "mention",
    attrs: { id, label, mentionSuggestionChar: "@" },
  };
}

function text(value: string) {
  return { type: "text", text: value };
}
