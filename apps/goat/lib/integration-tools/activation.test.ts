import { describe, expect, it } from "vitest";
import {
  activateIntegrationProviders,
  INTEGRATION_ACTIVATION_VERSION,
} from "@/lib/integration-tools/activation";

const BOTH = ["linear", "github"] as const;

describe("activateIntegrationProviders", () => {
  it("activates Linear on an explicit alias", () => {
    const result = activateIntegrationProviders({
      message: "Search Linear for the onboarding revamp issue",
      connectedProviders: BOTH,
    });
    expect(result.activated).toContain("linear");
    expect(result.matches.some((match) => match.rule === "alias")).toBe(true);
  });

  it("activates Linear on an issue key like ENG-123", () => {
    const result = activateIntegrationProviders({
      message: "what's the status of ENG-123?",
      connectedProviders: BOTH,
    });
    expect(result.activated).toEqual(["linear"]);
    expect(result.matches[0]?.matchedText).toBe("ENG-123");
  });

  it("activates GitHub on pull-request vocabulary", () => {
    const result = activateIntegrationProviders({
      message: "list the open pull requests",
      connectedProviders: BOTH,
    });
    expect(result.activated).toEqual(["github"]);
  });

  it("activates both providers on a multi-integration request", () => {
    const result = activateIntegrationProviders({
      message: "List the open ENG Linear issues and find related GitHub PRs",
      connectedProviders: BOTH,
    });
    expect(result.activated).toEqual(expect.arrayContaining(["linear", "github"]));
    expect(result.capped).toBe(false);
  });

  it("activates on weak-term combinations", () => {
    const result = activateIntegrationProviders({
      message: "triage the backlog for this cycle",
      connectedProviders: BOTH,
    });
    expect(result.activated).toContain("linear");
  });

  it("never activates a disconnected provider", () => {
    const result = activateIntegrationProviders({
      message: "check GitHub for open pull requests",
      connectedProviders: ["linear"],
    });
    expect(result.activated).toEqual([]);
  });

  it("treats bare 'issues' as unambiguous when only one tracker is connected", () => {
    const github = activateIntegrationProviders({
      message: "list the open issues",
      connectedProviders: ["github"],
    });
    expect(github.activated).toEqual(["github"]);

    const ambiguous = activateIntegrationProviders({
      message: "list the open issues",
      connectedProviders: BOTH,
    });
    expect(ambiguous.activated).toEqual([]);
  });

  it("does not activate for prompts without integration intent", () => {
    const result = activateIntegrationProviders({
      message: "write a haiku about spring and summarize my day",
      connectedProviders: BOTH,
    });
    expect(result.activated).toEqual([]);
    expect(result.matches).toEqual([]);
  });

  it("carries the previous turn's activation for short anaphoric follow-ups", () => {
    const result = activateIntegrationProviders({
      message: "and the comments on that one?",
      previousUserMessage: "show my Linear issues for this sprint",
      connectedProviders: BOTH,
    });
    expect(result.activated).toEqual(["linear"]);
    expect(result.matches.some((match) => match.rule === "continuity")).toBe(true);
  });

  it("ignores continuity when the current turn matches on its own", () => {
    const result = activateIntegrationProviders({
      message: "now list that repo's pull requests",
      previousUserMessage: "show my Linear issues",
      connectedProviders: BOTH,
    });
    expect(result.activated).toEqual(["github"]);
    expect(result.matches.some((match) => match.rule === "continuity")).toBe(false);
  });

  it("falls back to deterministic vocabulary overlap when lexical rules miss", () => {
    const result = activateIntegrationProviders({
      message: "who reviewed the latest merged changes in our codebase",
      connectedProviders: BOTH,
    });
    expect(result.activated).toEqual(["github"]);
    expect(result.matches.some((match) => match.rule === "semantic-fallback")).toBe(true);
  });

  it("records version, matches, and elapsed time", () => {
    const result = activateIntegrationProviders({
      message: "look at ENG-1",
      connectedProviders: BOTH,
    });
    expect(result.version).toBe(INTEGRATION_ACTIVATION_VERSION);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    for (const match of result.matches) {
      expect(match.provider).toBeDefined();
      expect(match.rule).toBeDefined();
      expect(match.score).toBeGreaterThan(0);
    }
  });

  it("is deterministic for identical inputs", () => {
    const run = () =>
      activateIntegrationProviders({
        message: "compare the Linear backlog with open GitHub PRs",
        connectedProviders: BOTH,
      });
    const first = run();
    const second = run();
    expect(second.activated).toEqual(first.activated);
    expect(second.matches).toEqual(first.matches);
  });
});
