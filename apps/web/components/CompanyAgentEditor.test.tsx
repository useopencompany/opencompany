import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import {
  type AgentDraft,
  agentDraftWithPatch,
  CompanyAgentEditor,
} from "@/components/CompanyAgentEditor";

const routerMock = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const agentActionsMock = vi.hoisted(() => ({
  update: vi.fn(async () => ({ version: 8 })),
  archive: vi.fn(async () => ({ workflowId: "agent_1", version: 8 })),
  runNow: vi.fn(async () => ({ task: { displayId: "TASK-42" } })),
  uploadPhoto: vi.fn(async () => "https://app.test/agents/photo.png"),
}));

vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));
vi.mock("@/lib/company-agent-commands", () => ({
  updateCompanyAgent: agentActionsMock.update,
  archiveCompanyAgent: agentActionsMock.archive,
  runCompanyAgentNow: agentActionsMock.runNow,
  uploadCompanyAgentPhoto: agentActionsMock.uploadPhoto,
}));
vi.mock("@/components/WorkflowEditor", () => ({
  SectionLabel: ({ children }: PropsWithChildren) => <div>{children}</div>,
  SlackAvatarField: () => <div />,
  StepCard: () => <div />,
  TriggerSection: () => <div />,
  workflowTriggerInput: (trigger: unknown) => trigger,
}));

beforeEach(() => {
  vi.useFakeTimers();
  routerMock.push.mockReset();
  routerMock.refresh.mockReset();
  agentActionsMock.update.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CompanyAgentEditor", () => {
  it("refreshes the route cache after an autosave", async () => {
    render(
      <CompanyAgentEditor
        agent={{
          id: "agent_1",
          slug: "pr-reviewer",
          name: "PR Reviewer",
          description: "Reviews pull requests.",
          instructions: "Review the diff.",
          photoUrl: "",
          model: "kimi-k2.6",
          status: "active",
          ownerUserId: "user_1",
          ownerActive: true,
          slackEnabled: false,
          triggers: [],
          lastRunAt: null,
          version: 7,
          createdAt: "2026-09-18T10:00:00.000Z",
          updatedAt: "2026-09-18T10:00:00.000Z",
        }}
        canEdit
        ownerName="Louis"
        skillCatalog={[]}
        eventProviders={[]}
        slackBotSettings={{
          isAdmin: true,
          configured: true,
          installed: true,
          status: "connected",
          needsScopeUpgrade: false,
          canCustomizeIdentity: true,
          teamName: "OpenCompany",
          statusReason: null,
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Agent name"), {
      target: { value: "Staff PR Reviewer" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });

    expect(agentActionsMock.update).toHaveBeenCalledWith(
      "agent_1",
      expect.objectContaining({ expectedVersion: 7, name: "Staff PR Reviewer" }),
    );
    expect(routerMock.refresh).toHaveBeenCalledOnce();
  });
});

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
