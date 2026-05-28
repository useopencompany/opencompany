import { describe, expect, test } from "vitest";
import { AGENT_MODELS, buildAgentMentionItems, buildBrainMentionItems, findModel } from "./tools";

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
      "openai/gpt-5.4-mini",
      "openai/gpt-5.4-nano",
      "openai/gpt-5.4",
      "openai/gpt-5.2-codex",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-opus-4.7",
      "google/gemini-3-flash",
      "google/gemini-3.1-flash-lite-preview",
      "deepseek/deepseek-v4-flash",
      "mistral/mistral-medium-3.5",
      "moonshotai/kimi-k2.6",
      "zai/glm-5.1",
      "zai/glm-5-turbo",
      "zai/glm-5v-turbo",
    ]);
    expect(findModel("model:google/gemini-3-flash")).toMatchObject({
      id: "google/gemini-3-flash",
      displayLabel: "google/gemini-3-flash",
    });
  });

  test("only exposes Linear MCP when MCP tools are enabled for the workspace", () => {
    expect(buildAgentMentionItems([], []).some((item) => item.mentionId === "tool:linear")).toBe(
      false,
    );
    expect(
      buildAgentMentionItems([], [], { includeMcpTools: true }).some(
        (item) => item.mentionId === "tool:linear",
      ),
    ).toBe(true);
  });
});
