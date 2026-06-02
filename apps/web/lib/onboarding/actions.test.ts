import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startSeededAgentSession } from "@/lib/agent-sessions/start-session";
import { currentWorkspace } from "@/lib/auth";
import { ensureUserOnboardingScaffold } from "@/lib/onboarding/scaffold";
import { completeOnboarding, type OnboardingActionState } from "./actions";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

vi.mock("@/lib/onboarding/scaffold", () => ({
  ensureUserOnboardingScaffold: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/start-session", () => ({
  startSeededAgentSession: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);
const captureServerEventMock = vi.mocked(captureServerEvent);
const currentWorkspaceMock = vi.mocked(currentWorkspace);
const ensureUserOnboardingScaffoldMock = vi.mocked(ensureUserOnboardingScaffold);
const startSeededAgentSessionMock = vi.mocked(startSeededAgentSession);

const previousState: OnboardingActionState = {
  errors: {},
  values: {
    heardFrom: "",
    heardFromDetail: "",
    role: "",
    teamSize: "",
    companyUrl: "",
    agentExperience: "",
    helpAreas: [],
  },
};

function validFormData() {
  const formData = new FormData();
  formData.set("heardFrom", "linkedin");
  formData.set("role", "Founder");
  formData.set("teamSize", "2_10");
  formData.set("companyUrl", "opencompany.ai");
  formData.set("agentExperience", "medium");
  formData.append("helpAreas", "product_building");
  formData.append("helpAreas", "operations");
  return formData;
}

function createDbMock() {
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const onConflictDoUpdate = vi.fn();
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));

  return {
    db: { update, insert },
    update,
    insert,
  };
}

describe("completeOnboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureUserOnboardingScaffoldMock.mockResolvedValue({
      created: true,
      agentId: "agt_123",
      path: "agents/leo/leo.agent",
    });
    startSeededAgentSessionMock.mockResolvedValue("ses_123");
  });

  it("scaffolds, starts the onboarding session, and redirects into it on first onboarding", async () => {
    const { db } = createDbMock();
    getDbMock.mockReturnValue(db as never);
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);

    await expect(completeOnboarding(previousState, validFormData())).rejects.toThrow(
      "redirect:/session/ses_123",
    );

    expect(ensureUserOnboardingScaffoldMock).toHaveBeenCalledWith({
      userId: "usr_123",
      workspaceId: "wks_123",
    });
    expect(startSeededAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agt_123",
        userId: "usr_123",
        workspaceId: "wks_123",
        source: "onboarding",
        prompt: expect.stringContaining("set up OpenCompany"),
      }),
    );
    expect(captureServerEventMock).toHaveBeenCalledWith("onboarding_completed", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      heard_from: "linkedin",
      team_size: "2_10",
      agent_experience: "medium",
      help_areas: ["product_building", "operations"],
      help_area_count: 2,
    });
  });

  it("does not start a session and redirects home when leo already exists", async () => {
    const { db } = createDbMock();
    getDbMock.mockReturnValue(db as never);
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    ensureUserOnboardingScaffoldMock.mockResolvedValue({
      created: false,
      agentId: "agt_existing",
      path: "agents/leo/leo.agent",
    });

    await expect(completeOnboarding(previousState, validFormData())).rejects.toThrow("redirect:/");

    expect(startSeededAgentSessionMock).not.toHaveBeenCalled();
  });

  it("does not scaffold when onboarding values are invalid", async () => {
    const result = await completeOnboarding(previousState, new FormData());

    expect(result.errors).toMatchObject({
      heardFrom: "Choose where you heard about opencompany.",
      role: "Enter your role.",
      teamSize: "Choose your team size.",
      agentExperience: "Choose your experience level.",
      helpAreas: "Choose at least one area.",
    });
    expect(getDbMock).not.toHaveBeenCalled();
    expect(ensureUserOnboardingScaffoldMock).not.toHaveBeenCalled();
  });
});
