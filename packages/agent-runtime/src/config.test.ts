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
  });
});
