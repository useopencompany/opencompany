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
        'model: "openai/gpt-5.4"',
        "tools:",
        '  - "exa"',
        "brain:",
        '  - "product/"',
        "---",
        "",
        "Read @brain/product/ first.\nThen search with @exa.",
      ].join("\n"),
    );
  });

  it("serializes empty tool and brain arrays explicitly", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Plain agent",
      instructions: "Help.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
      tools: [],
      brain: [],
    };

    expect(serializeRuntimeAgentFile(config)).toContain(
      ["tools: []", "brain: []", "---", "", "Help."].join("\n"),
    );
  });

  it("escapes YAML strings with newlines and special characters", () => {
    const config = {
      schemaVersion: "agent.v1",
      title: "Line 1\nLine 2\u0001",
      instructions: "Help.",
      model: {
        provider: "vercel-ai-gateway",
        name: "provider/model:latest",
      },
      tools: [
        {
          id: "tool:search",
          type: "tool",
          label: "search",
          description: "Search.",
        },
      ],
      brain: [{ path: "- odd:path", type: "file" }],
    } as unknown as AgentConfig;

    expect(serializeRuntimeAgentFile(config)).toBe(
      [
        "---",
        'title: "Line 1\\nLine 2\\u0001"',
        'model: "provider/model:latest"',
        "tools:",
        '  - "tool:search"',
        "brain:",
        '  - "- odd:path"',
        "---",
        "",
        "Help.",
      ].join("\n"),
    );
  });
});
