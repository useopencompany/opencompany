import { describe, expect, it } from "vitest";
import { createOpenCompanyChatSystemPrompt } from "./main-chat";

const CONNECTED_INTEGRATIONS = [
  {
    id: "slack",
    label: 'Slack workspace "Acme"',
    description: "Read conversations, messages, threads, and workspace members.",
  },
  {
    id: "gmail",
    label: "Gmail (louis@example.com)",
    description: "Search and read messages and threads.",
  },
  {
    id: "linear",
    label: "Linear workspace",
    description: "Read issues, comments, projects, teams, members, and workflow statuses.",
  },
  {
    id: "google_calendar",
    label: "Google Calendar (louis@example.com)",
    description: "List calendar events in a bounded time window.",
  },
];

describe("createOpenCompanyChatSystemPrompt integrations", () => {
  it("produces an identical prompt when integrations are absent or empty", () => {
    const currentDate = "2026-07-18";
    const base = createOpenCompanyChatSystemPrompt({ currentDate });
    expect(createOpenCompanyChatSystemPrompt({ currentDate, connectedIntegrations: [] })).toBe(
      base,
    );
    expect(base).not.toContain("<action_sources>");
    expect(base).not.toContain("<brain_fill>");
    expect(base).not.toContain("list_actions");
    expect(base).not.toContain("use_action");
  });

  it("renders the integrations block and behavior lines when integrations are present", () => {
    const prompt = createOpenCompanyChatSystemPrompt({
      connectedIntegrations: CONNECTED_INTEGRATIONS,
    });
    expect(prompt).toContain("<action_sources>");
    expect(prompt).toContain(
      '- slack [connected integration] — Slack workspace "Acme": Read conversations, messages, threads, and workspace members.',
    );
    expect(prompt).toContain(
      "- gmail [connected integration] — Gmail (louis@example.com): Search and read messages and threads.",
    );
    expect(prompt).toContain(
      "- google_calendar [connected integration] — Google Calendar (louis@example.com): List calendar events in a bounded time window.",
    );
    expect(prompt).toContain("Action sources usable in chat");
    expect(prompt).toContain("Call list_actions with the exact source id");
    expect(prompt).toContain("call list_actions with the relevant source id");
    expect(prompt).toContain("Managed capabilities are read-only");
    expect(prompt).toContain("cannot post, edit, create, delete");
    expect(prompt).toContain("write action only when the user explicitly asked");
    expect(prompt).toContain("Never claim a write happened unless the action returned ok=true");
    expect(prompt).toContain("Choose the lightest path");
    expect(prompt).toContain("Multi-step and cross-source research may stay in chat");
    expect(prompt).toContain("summarize before the tool-step limit");
    expect(prompt).toContain("one quick bounded lookup");
    expect(prompt).toContain("If use_action returns invalid_params");
    expect(prompt).toContain("make at most one corrected call");
    expect(prompt).toContain("make at most one substantially simplified retry");
    expect(prompt).toContain("<brain_fill>");
    expect(prompt).toContain("Survey breadth before depth");
    expect(prompt).toContain("exception to normal task routing");
    expect(prompt).toContain("nextCursor or nextPageToken");
    expect(prompt).toContain("sourceRef plus integrationId");
    expect(prompt).toContain("summarize what you saved");
    // The block stays small: one routing line per integration, not an action index.
    const block = prompt.slice(
      prompt.indexOf("<action_sources>"),
      prompt.indexOf("</action_sources>"),
    );
    expect(block.length).toBeLessThan(800);
  });

  it("omits brain-fill guidance when chat capture is disabled", () => {
    const prompt = createOpenCompanyChatSystemPrompt({
      connectedIntegrations: CONNECTED_INTEGRATIONS,
      brainCaptureEnabled: false,
    });

    expect(prompt).toContain("<action_sources>");
    expect(prompt).not.toContain("<brain_fill>");
  });

  it("keeps multi-step action research in chat when task tools are disabled", () => {
    const prompt = createOpenCompanyChatSystemPrompt({
      connectedIntegrations: CONNECTED_INTEGRATIONS,
      taskToolsEnabled: false,
    });
    expect(prompt).toContain("Choose the lightest path");
    expect(prompt).toContain("Multi-step and cross-source research may stay in chat");
  });

  it("identifies managed capabilities as metered services rather than connected accounts", () => {
    const prompt = createOpenCompanyChatSystemPrompt({
      actionSources: [
        {
          id: "linkedin",
          kind: "managed",
          label: "LinkedIn",
          description: "Metered public LinkedIn research.",
        },
      ],
    });

    expect(prompt).toContain(
      "linkedin [managed capability] — LinkedIn: Metered public LinkedIn research.",
    );
    expect(prompt).toContain("metered third-party services, not connected user accounts");
    expect(prompt).toContain("never describe them as free");
  });
});
