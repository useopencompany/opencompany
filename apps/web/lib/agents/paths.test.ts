import { describe, expect, test } from "vitest";
import { resolveAgentPath } from "./paths";

describe("resolveAgentPath", () => {
  test("changes the file path when a title rename changes the slug", () => {
    expect(
      resolveAgentPath({
        title: "New agent",
        currentPath: "agents/old-agent/agent.agent",
        existingPaths: ["agents/old-agent/agent.agent"],
      }),
    ).toBe("agents/new-agent/agent.agent");
  });

  test("keeps the current path when the title still maps to the same slug", () => {
    expect(
      resolveAgentPath({
        title: "Research!",
        currentPath: "agents/research/agent.agent",
        existingPaths: ["agents/research/agent.agent"],
      }),
    ).toBe("agents/research/agent.agent");
  });

  test("chooses the next suffix on collisions while ignoring the current agent", () => {
    expect(
      resolveAgentPath({
        title: "Research",
        currentPath: "agents/old/agent.agent",
        existingPaths: [
          "agents/research/agent.agent",
          "agents/research-2/agent.agent",
          "agents/old/agent.agent",
        ],
      }),
    ).toBe("agents/research-3/agent.agent");
  });
});
