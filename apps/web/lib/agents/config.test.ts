import { describe, expect, it } from "vitest";
import { derivePreviewConfigFromTiptapDoc } from "./config";
import { deriveAgentConfigFromBody } from "./mentions";
import type { TiptapDoc } from "./types";

const repositories = [
  { fullName: "opencompany/web", defaultBranch: "main" },
  { fullName: "opencompany/runner", defaultBranch: "develop" },
];

describe("derivePreviewConfigFromTiptapDoc", () => {
  it("binds amp to the mentioned GitHub work repository", () => {
    const { body, config } = derivePreviewConfigFromTiptapDoc({
      title: "Code agent",
      content: doc([
        mention("tool:amp", "amp"),
        text(" in "),
        mention("integration:github:opencompany-web", "opencompany/web"),
      ]),
      repositories,
    });

    expect(body).toBe("@amp in @opencompany/web");
    expect(config.tools).toEqual([
      expect.objectContaining({ id: "amp", repository: "opencompany-web" }),
    ]);
    expect(config.integrations.github.repositories).toEqual([
      { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
    ]);
  });

  it("keeps amp selected without exposing a repository when no repo is mentioned", () => {
    const { config } = derivePreviewConfigFromTiptapDoc({
      title: "Code agent",
      content: doc([mention("tool:amp", "amp")]),
      repositories,
    });

    expect(config.tools).toEqual([expect.objectContaining({ id: "amp", repository: null })]);
    expect(config.integrations.github.repositories).toEqual([]);
  });

  it("removes the GitHub integration when the repo mention is removed", () => {
    const { config } = derivePreviewConfigFromTiptapDoc({
      title: "Code agent",
      content: doc([mention("tool:exa", "exa")]),
      repositories,
    });

    expect(config.tools).toEqual([expect.objectContaining({ id: "exa" })]);
    expect(config.integrations.github.repositories).toEqual([]);
  });

  it("keeps all repository mentions and binds amp to the last repository mention", () => {
    const { config } = derivePreviewConfigFromTiptapDoc({
      title: "Code agent",
      content: doc([
        mention("tool:amp", "amp"),
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
      { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
      { id: "opencompany-runner", fullName: "opencompany/runner", defaultBranch: "develop" },
    ]);
  });

  it("preserves unavailable repo mentions in body but does not bind amp", () => {
    const { body, config } = derivePreviewConfigFromTiptapDoc({
      title: "Code agent",
      content: doc([
        mention("tool:amp", "amp"),
        text(" in "),
        mention("integration:github:opencompany-missing", "opencompany/missing"),
      ]),
      repositories,
    });

    expect(body).toBe("@amp in @opencompany/missing");
    expect(config.tools).toEqual([expect.objectContaining({ id: "amp", repository: null })]);
    expect(config.integrations.github.repositories).toEqual([]);
  });

  it("drops attrless mention nodes instead of saving bare at signs", () => {
    const { body, config } = derivePreviewConfigFromTiptapDoc({
      title: "Broken mentions",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Use " },
              { type: "mention" },
              { type: "text", text: " then " },
              { type: "mention", attrs: { id: null, label: null } },
            ],
          },
        ],
      },
      repositories,
    });

    expect(body).toBe("Use  then");
    expect(config.tools).toEqual([]);
    expect(config.brain).toEqual([]);
  });

  it("renders namespace-only mention ids as valid body mentions", () => {
    const { body, config } = derivePreviewConfigFromTiptapDoc({
      title: "Missing labels",
      content: doc([mention("tool:amp")]),
      repositories,
    });

    expect(body).toBe("@amp");
    expect(config.tools).toEqual([expect.objectContaining({ id: "amp" })]);
  });

  it("renders typed mention ids instead of stale display labels", () => {
    const { body, config } = derivePreviewConfigFromTiptapDoc({
      title: "Canonical labels",
      content: doc([mention("tool:amp", "AMP")]),
      repositories,
    });

    expect(body).toBe("@amp");
    expect(config.tools).toEqual([expect.objectContaining({ id: "amp" })]);
  });

  it("binds label-only mention nodes when the label is supported", () => {
    const { body, config } = derivePreviewConfigFromTiptapDoc({
      title: "Label only",
      content: doc([
        { type: "mention", attrs: { label: "AMP", mentionSuggestionChar: "@" } },
        text(" with "),
        { type: "mention", attrs: { label: "GPT 5.4", mentionSuggestionChar: "@" } },
      ]),
      repositories,
    });

    expect(body).toBe("@amp with @openai/gpt-5.4");
    expect(config.tools).toEqual([expect.objectContaining({ id: "amp" })]);
    expect(config.model.name).toBe("openai/gpt-5.4");
  });
});

describe("deriveAgentConfigFromBody", () => {
  it("binds amp to the mentioned GitHub repository from plain body text", () => {
    const { body, config } = deriveAgentConfigFromBody({
      title: "Code agent",
      body: "hello world\n@brain/new-folder/ \n\n@amp\n@useopencompany/agent-engineering-radar",
      repositories: [{ fullName: "useopencompany/agent-engineering-radar", defaultBranch: "main" }],
    });

    expect(body).toBe(
      "hello world\n@brain/new-folder/ \n\n@amp\n@useopencompany/agent-engineering-radar",
    );
    expect(config.brain).toEqual([{ path: "new-folder/", type: "folder" }]);
    expect(config.integrations.github.repositories).toEqual([
      {
        id: "useopencompany-agent-engineering-radar",
        fullName: "useopencompany/agent-engineering-radar",
        defaultBranch: "main",
      },
    ]);
    expect(config.tools).toEqual([
      expect.objectContaining({
        id: "amp",
        repository: "useopencompany-agent-engineering-radar",
      }),
    ]);
  });

  it("documents the save invariant: body-derived config wins over stale Tiptap content", () => {
    const staleContentResult = derivePreviewConfigFromTiptapDoc({
      title: "Code agent",
      content: doc([text("hello world")]),
      repositories: [{ fullName: "useopencompany/agent-engineering-radar", defaultBranch: "main" }],
    });
    const bodyResult = deriveAgentConfigFromBody({
      title: "Code agent",
      body: "hello world\n\n@amp\n@useopencompany/agent-engineering-radar",
      repositories: [{ fullName: "useopencompany/agent-engineering-radar", defaultBranch: "main" }],
    });

    expect(staleContentResult.config.integrations.github.repositories).toEqual([]);
    expect(bodyResult.config.integrations.github.repositories).toEqual([
      expect.objectContaining({ id: "useopencompany-agent-engineering-radar" }),
    ]);
    expect(bodyResult.config.tools).toEqual([
      expect.objectContaining({
        id: "amp",
        repository: "useopencompany-agent-engineering-radar",
      }),
    ]);
  });
});

function doc(content: NonNullable<TiptapDoc["content"]>[number]["content"]): TiptapDoc {
  return {
    type: "doc",
    content: [{ type: "paragraph", content }],
  };
}

function mention(id: string, label?: string) {
  return {
    type: "mention",
    attrs: { id, ...(label ? { label } : {}), mentionSuggestionChar: "@" },
  };
}

function text(value: string) {
  return { type: "text", text: value };
}
