import { describe, expect, it } from "vitest";
import { type AgentDraft, agentDraftWithPatch } from "@/components/CompanyAgentEditor";

// Coding agents need a connected engine, so this branch is not reachable from the editor in a
// sandbox. It is also the branch that matters: leaving a stale `runtimeModel` behind after a
// switch back to a plain model would run the agent on a runtime the owner no longer chose.
describe("agentDraftWithPatch", () => {
  it("adopts a cloud runtime and its reasoning effort", () => {
    const next = agentDraftWithPatch(draft(), {
      model: "codex",
      runtimeModel: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(next).toMatchObject({
      model: "codex",
      runtimeModel: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });

  it("drops the runtime fields when switching back to a plain model", () => {
    const cloud = agentDraftWithPatch(draft(), {
      model: "codex",
      runtimeModel: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    const plain = agentDraftWithPatch(cloud, {
      model: "kimi-k2.6",
      runtimeModel: undefined,
      reasoningEffort: undefined,
    });
    expect(plain.model).toBe("kimi-k2.6");
    expect("runtimeModel" in plain).toBe(false);
    expect("reasoningEffort" in plain).toBe(false);
  });

  it("leaves the rest of the agent alone when only instructions change", () => {
    const next = agentDraftWithPatch(draft(), { instructions: "Review the diff." });
    expect(next).toMatchObject({
      instructions: "Review the diff.",
      name: "PR Reviewer",
      status: "active",
      slackEnabled: true,
    });
    expect(next.triggers).toHaveLength(1);
  });
});

function draft(): AgentDraft {
  return {
    name: "PR Reviewer",
    description: "Reviews pull requests.",
    instructions: "Review.",
    photoUrl: "",
    model: "kimi-k2.6",
    status: "active",
    slackEnabled: true,
    triggers: [
      {
        id: "trigger_1",
        type: "schedule",
        cron: "0 9 * * 1-5",
        timezone: "Europe/Berlin",
        prompt: "Sweep open pull requests.",
        enabled: true,
      },
    ],
  };
}
