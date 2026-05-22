import type { AgentConfig } from "@opencompany/db/schema";
import { describe, expect, it } from "vitest";
import { resolveAgentRuntimeConfig } from "./config";

describe("resolveAgentRuntimeConfig", () => {
  it("builds the system prompt and keeps the configured Vercel AI Gateway model", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Ops agent",
      instructions: "Check the workspace and summarize risk.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4",
      },
      tools: [],
    };

    const resolved = resolveAgentRuntimeConfig({
      agent: config,
      workspaceName: "Acme",
      sessionTitle: "Risk review",
    });

    expect(resolved.model).toEqual({
      provider: "vercel-ai-gateway",
      name: "openai/gpt-5.4",
    });
    expect(resolved.systemPrompt).toContain("Workspace: Acme");
    expect(resolved.systemPrompt).toContain("Check the workspace and summarize risk.");
    expect(resolved.tools).toContain("shell");
    expect(resolved.tools).toContain("git_diff");
    expect(resolved.tools).toContain("tool_help");
    expect(resolved.tools).not.toContain("exa_search");
  });

  it("enables hosted runtime tools from selected agent config tools", () => {
    const config: AgentConfig = {
      schemaVersion: "agent.v1",
      title: "Research agent",
      instructions: "Research the web.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
      tools: [
        {
          id: "exa",
          type: "tool",
          label: "exa",
          description: "Deep research on the web and people.",
        },
      ],
    };

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.tools).toEqual(
      expect.arrayContaining(["shell", "read_file", "git_diff", "tool_help", "exa_search"]),
    );
  });

  it("ignores stale unknown config tools", () => {
    const config = {
      schemaVersion: "agent.v1",
      title: "Legacy agent",
      instructions: "Use old tools.",
      model: {
        provider: "vercel-ai-gateway",
        name: "openai/gpt-5.4-mini",
      },
      tools: [{ id: "unknown_tool", type: "tool", label: "old", description: "old" }],
    } as unknown as AgentConfig;

    const resolved = resolveAgentRuntimeConfig({ agent: config });

    expect(resolved.tools).toContain("tool_help");
    expect(resolved.tools).not.toContain("exa_search");
  });
});
