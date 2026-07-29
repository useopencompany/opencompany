import { Atom, Blocks, Brain, Code2, Feather, ListTodo, Sparkles } from "lucide-react";
import { describe, expect, test } from "vitest";
import {
  AGENT_MODELS,
  buildAgentMentionItems,
  buildBrainMentionItems,
  buildWorkspaceAgentMentionItems,
  findModel,
  skillIconFor,
} from "./tools";

describe("agent editor mention tools", () => {
  test("includes the root Brain folder before nested Brain paths", () => {
    const items = buildBrainMentionItems(["docs/README.md", "product/notes.md"]);

    expect(items.map((item) => item.mentionId)).toEqual([
      "brain/",
      "brain/docs/",
      "brain/docs/README.md",
      "brain/product/",
      "brain/product/notes.md",
    ]);
    expect(items[0]).toMatchObject({
      kind: "brain",
      path: "/",
      label: "brain/",
      description: "Brain root folder",
    });
  });

  test("exposes the curated common Vercel AI Gateway language models", () => {
    expect(AGENT_MODELS.map((model) => model.id)).toEqual([
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.5",
      "openai/gpt-5.4-mini",
      "openai/gpt-5.4-nano",
      "openai/gpt-5.4",
      "openai/gpt-5.2-codex",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-4.7",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-fable-5",
      "google/gemini-3-flash",
      "google/gemini-3.1-flash-lite-preview",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "mistral/mistral-medium-3.5",
      "minimax/minimax-m3",
      "minimax/minimax-m2.7",
      "minimax/minimax-m2.7-highspeed",
      "minimax/minimax-m2.5",
      "minimax/minimax-m2.5-highspeed",
      "minimax/minimax-m2.1",
      "minimax/minimax-m2.1-lightning",
      "minimax/minimax-m2",
      "moonshotai/kimi-k3",
      "moonshotai/kimi-k2.6",
      "moonshotai/kimi-k2.5",
      "moonshotai/kimi-k2-thinking",
      "moonshotai/kimi-k2-thinking-turbo",
      "moonshotai/kimi-k2-turbo",
      "moonshotai/kimi-k2",
      "xai/grok-4.3",
      "xai/grok-4.20-reasoning",
      "xai/grok-4.20-non-reasoning",
      "xai/grok-4.1-fast-reasoning",
      "xai/grok-4.1-fast-non-reasoning",
      "xai/grok-build-0.1",
      "zai/glm-5.1",
      "zai/glm-5.2",
      "zai/glm-5-turbo",
      "zai/glm-5v-turbo",
      "openrouter/fusion",
    ]);
    expect(findModel("model:google/gemini-3-flash")).toMatchObject({
      id: "google/gemini-3-flash",
      displayLabel: "google/gemini-3-flash",
    });
    expect(findModel("model:minimax/minimax-m3")).toMatchObject({
      id: "minimax/minimax-m3",
      displayLabel: "minimax/minimax-m3",
    });
    expect(findModel("model:openrouter/fusion")).toMatchObject({
      id: "openrouter/fusion",
      displayLabel: "openrouter/fusion",
    });
  });

  test("does not include models in the mention suggestion menu", () => {
    const items = buildAgentMentionItems();
    expect(items.every((item) => item.kind !== "model")).toBe(true);
    expect(items.some((item) => item.mentionId.startsWith("model:"))).toBe(false);
  });

  test("includes the X hosted tool in the mention suggestion menu", () => {
    expect(buildAgentMentionItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "x",
          kind: "tool",
          mentionId: "tool:x",
          displayLabel: "x",
        }),
      ]),
    );
  });

  test("includes the TikTok and Instagram hosted tools in the mention suggestion menu", () => {
    expect(buildAgentMentionItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tiktok",
          kind: "tool",
          mentionId: "tool:tiktok",
          displayLabel: "tiktok",
        }),
        expect.objectContaining({
          id: "instagram",
          kind: "tool",
          mentionId: "tool:instagram",
          displayLabel: "instagram",
        }),
      ]),
    );
  });

  test("exposes schedule creation as an action mention", () => {
    expect(buildAgentMentionItems()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "schedule",
          mentionId: "schedule:run-every",
          displayLabel: "Run every...",
        }),
      ]),
    );
  });

  test("always exposes MCP tools for the workspace", () => {
    expect(buildAgentMentionItems([], []).some((item) => item.mentionId === "tool:linear")).toBe(
      true,
    );
    expect(buildAgentMentionItems([], []).some((item) => item.mentionId === "tool:slack")).toBe(
      true,
    );
    expect(
      buildAgentMentionItems([], []).some((item) => item.mentionId === "tool:betterstack"),
    ).toBe(true);
    expect(buildAgentMentionItems([], []).some((item) => item.mentionId === "tool:notion")).toBe(
      true,
    );
  });

  test("shows not-connected MCP tools with a needs-setup badge", () => {
    const items = buildAgentMentionItems([], [], {
      enabledMcpToolIds: ["linear"],
    });
    const linear = items.find((item) => item.mentionId === "tool:linear");
    const slack = items.find((item) => item.mentionId === "tool:slack");
    const betterstack = items.find((item) => item.mentionId === "tool:betterstack");
    const notion = items.find((item) => item.mentionId === "tool:notion");

    // Connected provider behaves normally.
    expect(linear).toBeDefined();
    expect(linear?.needsSetup).toBeFalsy();

    // Not-connected provider stays selectable but is flagged + linkable.
    expect(slack).toBeDefined();
    expect(slack?.needsSetup).toBe(true);
    expect(slack?.connectUrl).toBe("/api/mcp/slack/start?returnTo=%2Fcompany%2Fintegrations");
    expect(betterstack).toBeDefined();
    expect(betterstack?.needsSetup).toBe(true);
    expect(betterstack?.connectUrl).toBe(
      "/api/mcp/betterstack/start?returnTo=%2Fcompany%2Fintegrations",
    );
    expect(notion).toBeDefined();
    expect(notion?.needsSetup).toBe(true);
    expect(notion?.connectUrl).toBe("/api/mcp/notion/start?returnTo=%2Fcompany%2Fintegrations");
  });

  test("offers the addable built-in first-principles skill in the mention menu", () => {
    const items = buildAgentMentionItems();
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skill",
          mentionId: "skill/first-principles",
          label: "skill/first-principles",
          displayLabel: "First-principles thinking",
        }),
      ]),
    );
  });

  test("offers the addable built-in Y Combinator knowledge skill in the mention menu", () => {
    const items = buildAgentMentionItems();
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skill",
          mentionId: "skill/y-combinator-knowledge",
          label: "skill/y-combinator-knowledge",
          displayLabel: "Y Combinator knowledge",
        }),
      ]),
    );
  });

  test("offers the addable built-in CTO PR review skill in the mention menu", () => {
    const items = buildAgentMentionItems();
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skill",
          mentionId: "skill/cto-pr-review",
          label: "skill/cto-pr-review",
          displayLabel: "CTO PR review",
        }),
      ]),
    );
  });

  test("offers the addable built-in implementer skill in the mention menu", () => {
    const items = buildAgentMentionItems();
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skill",
          mentionId: "skill/implementer",
          label: "skill/implementer",
          displayLabel: "Implementer",
        }),
      ]),
    );
  });

  test("gives built-in skills distinct icons and external skills a neutral fallback", () => {
    expect(skillIconFor("first-principles")).toBe(Atom);
    expect(skillIconFor("humanizer")).toBe(Feather);
    expect(skillIconFor("memory")).toBe(Brain);
    expect(skillIconFor("cto-pr-review")).toBe(ListTodo);
    expect(skillIconFor("implementer")).toBe(Code2);
    // Unknown / external skill ids fall back to a neutral glyph rather than the
    // old shared Sparkles placeholder.
    expect(skillIconFor("some-external-github-skill")).toBe(Blocks);
    expect(skillIconFor("first-principles")).not.toBe(Sparkles);
  });

  test("exposes workspace agents as stable agent slug mentions", () => {
    const items = buildWorkspaceAgentMentionItems([
      { path: "agents/research/research.agent", name: "Research" },
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        id: "agent/research",
        mentionId: "agent/research",
        kind: "agent",
        label: "agent/research",
        displayLabel: "Research",
        description: "agents/research/research.agent",
      }),
    ]);
    expect(
      buildAgentMentionItems([], [], {
        agents: [{ path: "agents/research/research.agent", name: "Research" }],
      }).some((item) => item.mentionId === "agent/research"),
    ).toBe(true);
  });
});
