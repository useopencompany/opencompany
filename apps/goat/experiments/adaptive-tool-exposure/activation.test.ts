import { describe, expect, it } from "vitest";
import { analyzeAdaptiveToolQuery, splitAdaptiveQuery } from "./activation";
import {
  ADAPTIVE_TOOL_REGISTRY,
  adaptiveRegistryToolCount,
  adaptiveToolByPointer,
} from "./registry";

describe("adaptive tool exposure", () => {
  it("activates each integration mentioned in a multi-step request", () => {
    const snapshot = analyzeAdaptiveToolQuery(
      "Find the latest email from Ada about launch readiness, then post a summary to Slack #launch.",
    );

    expect(snapshot.clauses).toEqual([
      "Find the latest email from Ada about launch readiness,",
      "post a summary to Slack #launch",
    ]);
    expect(new Set(snapshot.integrations.map((integration) => integration.id))).toEqual(
      new Set(["slack", "gmail"]),
    );
    expect(toolNames(snapshot, "gmail")).toContain("search_emails");
    expect(
      snapshot.integrations.find((integration) => integration.id === "gmail")?.tools[0]?.name,
    ).toBe("search_emails");
    expect(toolNames(snapshot, "slack")).toContain("send_message");
    expect(
      snapshot.integrations
        .find((integration) => integration.id === "slack")
        ?.tools.every((tool) => tool.matchedClauses.every((clause) => clause === 1)),
    ).toBe(true);
    expect(snapshot.estimatedAdaptiveTokens).toBeLessThan(snapshot.estimatedFlatTokens);
  });

  it("uses operation intent to rank the right short card", () => {
    const snapshot = analyzeAdaptiveToolQuery("List open Linear issues for team ENG.");

    expect(snapshot.integrations).toHaveLength(1);
    expect(snapshot.integrations[0]?.id).toBe("linear");
    expect(snapshot.integrations[0]?.tools[0]?.name).toBe("list_issues");
    expect(snapshot.integrations[0]?.tools.length).toBeLessThanOrEqual(4);
  });

  it("detects an integration from deterministic patterns without its name", () => {
    const snapshot = analyzeAdaptiveToolQuery(
      "Find a 30 minute opening with ada@example.com tomorrow afternoon and create a meeting.",
    );

    expect(snapshot.integrations.map((integration) => integration.id)).toEqual(["calendar"]);
    expect(toolNames(snapshot, "calendar")).toEqual(
      expect.arrayContaining(["find_availability", "create_event"]),
    );
  });

  it("keeps every collapsed card backed by a resolvable lossless pointer", () => {
    expect(ADAPTIVE_TOOL_REGISTRY).toHaveLength(6);
    expect(adaptiveRegistryToolCount()).toBe(48);

    for (const integration of ADAPTIVE_TOOL_REGISTRY) {
      expect(integration.pointer).toBe(`integration://${integration.id}`);
      for (const tool of integration.tools) {
        expect(adaptiveToolByPointer(tool.pointer)).toEqual({ integration, tool });
        expect(tool.inputSchema).toMatchObject({ type: "object" });
        expect(tool.example).toBeTruthy();
      }
    }
  });

  it("bounds the deterministic candidate surface", () => {
    const snapshot = analyzeAdaptiveToolQuery(
      "Search Slack and Gmail, list Linear issues and GitHub pull requests, find a Notion page, then create a Calendar event.",
    );

    expect(snapshot.integrations).toHaveLength(6);
    expect(snapshot.integrations.flatMap((integration) => integration.tools)).toHaveLength(24);
    expect(snapshot.integrations.every((integration) => integration.tools.length <= 4)).toBe(true);
  });
});

function toolNames(snapshot: ReturnType<typeof analyzeAdaptiveToolQuery>, integrationId: string) {
  return snapshot.integrations
    .find((integration) => integration.id === integrationId)
    ?.tools.map((tool) => tool.name);
}

describe("splitAdaptiveQuery", () => {
  it("keeps ordinary conjunctions inside one operation", () => {
    expect(splitAdaptiveQuery("Find messages from Ada and Grace in Slack")).toEqual([
      "Find messages from Ada and Grace in Slack",
    ]);
  });

  it("does not split periods inside email addresses", () => {
    expect(
      splitAdaptiveQuery("Find an opening with ada@example.com tomorrow and create a meeting."),
    ).toEqual(["Find an opening with ada@example.com tomorrow", "create a meeting"]);
  });
});
