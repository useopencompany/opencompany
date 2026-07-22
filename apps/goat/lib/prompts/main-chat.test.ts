import { describe, expect, it } from "vitest";
import { createOpenCompanyChatSystemPrompt } from "@/lib/prompts/main-chat";

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
    expect(base).not.toContain("<integrations>");
    expect(base).not.toContain("list_actions");
    expect(base).not.toContain("use_action");
  });

  it("renders the integrations block and behavior lines when integrations are present", () => {
    const prompt = createOpenCompanyChatSystemPrompt({
      connectedIntegrations: CONNECTED_INTEGRATIONS,
    });
    expect(prompt).toContain("<integrations>");
    expect(prompt).toContain(
      '- slack — Slack workspace "Acme": Read conversations, messages, threads, and workspace members.',
    );
    expect(prompt).toContain(
      "- gmail — Gmail (louis@example.com): Search and read messages and threads.",
    );
    expect(prompt).toContain(
      "- google_calendar — Google Calendar (louis@example.com): List calendar events in a bounded time window.",
    );
    expect(prompt).toContain("Connected read-only integrations");
    expect(prompt).toContain("Call list_actions with the exact integration id");
    expect(prompt).toContain("call list_actions with the relevant integration id");
    expect(prompt).toContain("you cannot post, edit, create, or delete anything");
    expect(prompt).toContain("Choose the lightest path");
    expect(prompt).toContain("start a task for deep, multi-step, or cross-source work");
    expect(prompt).toContain("one quick bounded lookup");
    expect(prompt).toContain("If a use_action result has ok=false");
    // The block stays small: one routing line per integration, not an action index.
    const block = prompt.slice(prompt.indexOf("<integrations>"), prompt.indexOf("</integrations>"));
    expect(block.length).toBeLessThan(800);
  });

  it("drops the start-a-task routing when task tools are disabled", () => {
    const prompt = createOpenCompanyChatSystemPrompt({
      connectedIntegrations: CONNECTED_INTEGRATIONS,
      taskToolsEnabled: false,
    });
    expect(prompt).toContain("Choose the lightest path");
    expect(prompt).not.toContain("start a task for deep, multi-step, or cross-source work");
  });
});
