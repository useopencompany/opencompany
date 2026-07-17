import { describe, expect, it } from "vitest";
import {
  createOpenCompanyChatSystemPrompt,
  formatIntegrationsBlock,
  OPENCOMPANY_CHAT_CONNECTED_ACCOUNT_TASK_LINE_WITH_INTEGRATIONS,
  OPENCOMPANY_CHAT_INTEGRATION_TOOLS_BEHAVIOR_LINES,
} from "@/lib/prompts";

const INTEGRATION_ENTRIES = [
  {
    provider: "linear",
    label: "Linear",
    summary: "read issues, projects, and teams in the connected workspace",
  },
  {
    provider: "gmail",
    label: "Gmail",
    summary: "search and read email in the connected account(s)",
    accounts: ["louis@acta.so"],
  },
];

describe("createOpenCompanyChatSystemPrompt integrations", () => {
  it("stays byte-identical to the no-integrations prompt when none are passed", () => {
    const baseline = createOpenCompanyChatSystemPrompt({ currentDate: "2026-07-17" });
    expect(createOpenCompanyChatSystemPrompt({ currentDate: "2026-07-17", integrations: [] })).toBe(
      baseline,
    );
    expect(baseline).not.toContain("<integrations>");
    expect(baseline).not.toContain("search_integration_tools");
    expect(baseline).toContain(
      "Requests to check, read, summarize, triage, or monitor the user's latest emails",
    );
  });

  it("adds the integrations block, behavior lines, and task-routing carve-out", () => {
    const prompt = createOpenCompanyChatSystemPrompt({
      currentDate: "2026-07-17",
      integrations: INTEGRATION_ENTRIES,
    });
    expect(prompt).toContain(formatIntegrationsBlock(INTEGRATION_ENTRIES));
    expect(prompt).toContain(
      '- Gmail — search and read email in the connected account(s). Connected: "louis@acta.so".',
    );
    for (const line of OPENCOMPANY_CHAT_INTEGRATION_TOOLS_BEHAVIOR_LINES) {
      expect(prompt).toContain(line);
    }
    expect(prompt).toContain(OPENCOMPANY_CHAT_CONNECTED_ACCOUNT_TASK_LINE_WITH_INTEGRATIONS);
    expect(prompt).not.toContain(
      "Requests to check, read, summarize, triage, or monitor the user's latest emails",
    );
  });

  it("keeps the integrations block ahead of the behavior block", () => {
    const prompt = createOpenCompanyChatSystemPrompt({ integrations: INTEGRATION_ENTRIES });
    expect(prompt.indexOf("<integrations>")).toBeGreaterThan(prompt.indexOf("</user_context>"));
    expect(prompt.indexOf("</integrations>")).toBeLessThan(prompt.indexOf("<behavior>"));
  });

  it("drops integration guidance when task tools are disabled but keeps the block", () => {
    const prompt = createOpenCompanyChatSystemPrompt({
      integrations: INTEGRATION_ENTRIES,
      taskToolsEnabled: false,
    });
    expect(prompt).toContain("<integrations>");
    expect(prompt).not.toContain(OPENCOMPANY_CHAT_CONNECTED_ACCOUNT_TASK_LINE_WITH_INTEGRATIONS);
  });
});
