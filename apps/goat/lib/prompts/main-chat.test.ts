import { describe, expect, it } from "vitest";
import { createOpenCompanyChatSystemPrompt } from "@/lib/prompts/main-chat";

const CONNECTED_INTEGRATIONS = [
  { id: "slack", label: 'Slack workspace "Acme"' },
  { id: "gmail", label: "Gmail (louis@example.com)" },
  { id: "linear", label: "Linear workspace" },
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
    expect(prompt).toContain('slack (Slack workspace "Acme")');
    expect(prompt).toContain("gmail (Gmail (louis@example.com))");
    expect(prompt).toContain("all read-only");
    expect(prompt).toContain("Call list_actions to see the exact actions");
    expect(prompt).toContain("Use list_actions then use_action for quick read lookups");
    expect(prompt).toContain("you cannot post, edit, create, or delete anything");
    expect(prompt).toContain("Choose the lightest path");
    expect(prompt).toContain("start a task for deep, multi-step, or cross-source work");
    expect(prompt).toContain("If a use_action result has ok=false");
    // Integrations block stays small — a couple of lines, not an action index.
    const block = prompt.slice(prompt.indexOf("<integrations>"), prompt.indexOf("</integrations>"));
    expect(block.length).toBeLessThan(600);
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
