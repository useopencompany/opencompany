import type { AgentConfig } from "@opencompany/db/schema";
import { describe, expect, it } from "vitest";
import { serializeRuntimeAgentFile } from "./agent-file";

describe("serializeRuntimeAgentFile", () => {
  it("serializes the full runtime agent source from stored config", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: 'Research "lead"',
      instructions: "Read @brain/product/ first.\r\nThen search with @exa.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4",
      },
      tools: [
        {
          id: "exa",
          type: "tool",
          label: "exa",
          description: "Deep research on the web and people.",
        },
      ],
      brain: [{ path: "product/", type: "folder" }],
    };

    expect(serializeRuntimeAgentFile(config)).toBe(
      [
        "---",
        'title: "Research \\"lead\\""',
        "model: openai/gpt-5.4",
        "tools:",
        "  - exa",
        "brain:",
        "  - product/",
        "---",
        "",
        "Read @brain/product/ first.\nThen search with @exa.",
      ].join("\n"),
    );
  });
});
