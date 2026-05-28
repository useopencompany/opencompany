import { describe, expect, it } from "vitest";
import { resolveAgentProposalTarget } from "./workspace-config-tools";

describe("resolveAgentProposalTarget", () => {
  it("canonicalizes create proposal paths from the parsed agent title", () => {
    expect(
      resolveAgentProposalTarget({
        operation: "create",
        id: null,
        path: "agents/product-cofounder.agent",
        title: "Product co-founder",
        existingAgents: [],
      }),
    ).toMatchObject({
      operation: "create",
      existing: null,
      path: "agents/product-co-founder.agent",
    });
  });

  it("normalizes a create proposal to an update when the canonical agent path exists", () => {
    const existing = agent({
      id: "agt_product",
      path: "agents/product-co-founder.agent",
      name: "Product co-founder",
    });

    expect(
      resolveAgentProposalTarget({
        operation: "create",
        id: null,
        path: "agents/product-cofounder.agent",
        title: "Product co-founder",
        existingAgents: [existing],
      }),
    ).toMatchObject({
      operation: "update",
      existing,
      path: "agents/product-co-founder.agent",
    });
  });

  it("normalizes a create proposal to an update when exactly one existing title matches", () => {
    const existing = agent({
      id: "agt_product",
      path: "agents/custom-product-agent.agent",
      name: "Product co-founder",
    });

    expect(
      resolveAgentProposalTarget({
        operation: "create",
        id: null,
        path: null,
        title: "Product co-founder",
        existingAgents: [existing],
      }),
    ).toMatchObject({
      operation: "update",
      existing,
    });
  });

  it("requires an explicit id or path when multiple agents have the same title", () => {
    expect(() =>
      resolveAgentProposalTarget({
        operation: "create",
        id: null,
        path: null,
        title: "Product co-founder",
        existingAgents: [
          agent({ id: "agt_one", path: "agents/one.agent", name: "Product co-founder" }),
          agent({ id: "agt_two", path: "agents/two.agent", name: "Product co-founder" }),
        ],
      }),
    ).toThrow("Multiple agents have this title.");
  });
});

function agent(input: { id: string; path: string; name: string }) {
  return {
    ...input,
    contentHash: `${input.id}_hash`,
    version: 1,
  };
}
