import { captureServerEvent } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPersonalOnboardingSession } from "@/lib/agent-sessions/actions";
import { currentWorkspace } from "@/lib/auth";
import { ONBOARDING_FIRST_SESSION_PROMPT } from "@/lib/onboarding/first-session";
import { ensurePersonalAgent } from "@/lib/personal/scaffold";
import { dispatchSlackSupportChannelRequested } from "@/lib/slack/events";
import { completeOnboarding, type OnboardingActionState } from "./actions";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => loggerMock),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("@/lib/auth", () => ({
  currentWorkspace: vi.fn(),
}));

vi.mock("@/lib/personal/scaffold", () => ({
  ensurePersonalAgent: vi.fn(),
}));

vi.mock("@/lib/agent-sessions/actions", () => ({
  createPersonalOnboardingSession: vi.fn(),
}));

vi.mock("@/lib/slack/events", () => ({
  dispatchSlackSupportChannelRequested: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);
const captureServerEventMock = vi.mocked(captureServerEvent);
const currentWorkspaceMock = vi.mocked(currentWorkspace);
const ensurePersonalAgentMock = vi.mocked(ensurePersonalAgent);
const createPersonalOnboardingSessionMock = vi.mocked(createPersonalOnboardingSession);
const dispatchSlackSupportChannelRequestedMock = vi.mocked(dispatchSlackSupportChannelRequested);

const previousState: OnboardingActionState = {
  errors: {},
  values: {
    heardFrom: "",
    heardFromDetail: "",
    role: "",
    teamSize: "",
    companyUrl: "",
    agentExperience: "",
    goal: "",
    personalBrainFolders: [],
    personalIntegrations: [],
  },
};

function validFormData(options: { forceOnboarding?: boolean } = {}) {
  const formData = new FormData();
  formData.set("heardFrom", "linkedin");
  formData.set("role", "Founder");
  formData.set("teamSize", "2_10");
  formData.set("companyUrl", "opencompany.ai");
  formData.set("agentExperience", "medium");
  formData.set("goal", "Win back my time");
  formData.append("personalBrainFolders", "meetings");
  formData.append("personalBrainFolders", "projects");
  formData.append("personalIntegrations", "github");
  formData.append("personalIntegrations", "gmail");
  if (options.forceOnboarding) {
    formData.set("forceOnboarding", "1");
  }
  return formData;
}

function createDbMock() {
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const returning = vi.fn(async () => [{ userId: "usr_123" }]);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));

  return {
    db: { update, insert },
    update,
    insert,
    returning,
  };
}

describe("completeOnboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensurePersonalAgentMock.mockResolvedValue({
      id: "agt_personal",
      name: "Leo",
      defaultModel: "moonshotai/kimi-k2.6",
      path: "agents/personal/personal.agent",
      config: {} as never,
      body: "",
      content: { type: "doc", content: [] },
    });
    createPersonalOnboardingSessionMock.mockResolvedValue({
      ok: true,
      session: { id: "ses_123" },
    } as never);
    dispatchSlackSupportChannelRequestedMock.mockResolvedValue(undefined);
  });

  it("creates the personal agent, starts the first session, and redirects into it", async () => {
    const { db } = createDbMock();
    getDbMock.mockReturnValue(db as never);
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123", email: "ada@example.com", firstName: "Ada" },
      workspace: { id: "wks_123" },
    } as never);

    await expect(completeOnboarding(previousState, validFormData())).rejects.toThrow(
      "redirect:/personal/session/ses_123",
    );

    expect(ensurePersonalAgentMock).toHaveBeenCalledWith({
      userId: "usr_123",
      workspaceId: "wks_123",
      userName: "Ada",
      personalBrainFolders: ["meetings", "projects"],
    });
    expect(createPersonalOnboardingSessionMock).toHaveBeenCalledWith(
      "agt_personal",
      {
        name: "Ada",
        website: "https://opencompany.ai/",
        role: "Founder",
        teamSize: "2_10",
        agentExperience: "medium",
      },
      ONBOARDING_FIRST_SESSION_PROMPT,
      {
        integrations: ["github", "gmail"],
        skipBillingCheck: true,
        survey: {
          heardFrom: "linkedin",
          heardFromDetail: "",
        },
      },
    );
    expect(dispatchSlackSupportChannelRequestedMock).toHaveBeenCalledWith({
      workspaceId: "wks_123",
      userId: "usr_123",
      customerEmail: "ada@example.com",
      firstName: "Ada",
    });
    expect(captureServerEventMock).toHaveBeenCalledWith("onboarding_completed", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      heard_from: "linkedin",
      team_size: "2_10",
      agent_experience: "medium",
      goal_provided: true,
    });
  });

  it("redirects home when first-session creation returns an error", async () => {
    const { db } = createDbMock();
    getDbMock.mockReturnValue(db as never);
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    createPersonalOnboardingSessionMock.mockResolvedValue({
      ok: false,
      error: "Agent not found.",
    });

    await expect(completeOnboarding(previousState, validFormData())).rejects.toThrow("redirect:/");

    expect(createPersonalOnboardingSessionMock).toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith("Onboarding first session was not created", {
      event: "opencompany.onboarding_first_session_missing",
      workspace_id: "wks_123",
      user_id: "usr_123",
      agent_id: "agt_personal",
      error: "Agent not found.",
    });
  });

  it("skips setup when onboarding was already completed by a concurrent submit", async () => {
    const { db, update, returning } = createDbMock();
    returning.mockResolvedValue([]);
    getDbMock.mockReturnValue(db as never);
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);

    await expect(completeOnboarding(previousState, validFormData())).rejects.toThrow("redirect:/");

    expect(update).not.toHaveBeenCalled();
    expect(ensurePersonalAgentMock).not.toHaveBeenCalled();
    expect(createPersonalOnboardingSessionMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).not.toHaveBeenCalledWith(
      "onboarding_completed",
      expect.anything(),
      expect.anything(),
    );
    expect(loggerMock.info).toHaveBeenCalledWith("Skipping duplicate onboarding completion", {
      event: "opencompany.onboarding_completion_duplicate",
      workspace_id: "wks_123",
      user_id: "usr_123",
    });
  });

  it("starts the first session for a forced onboarding retry when the survey row already exists", async () => {
    const { db, returning } = createDbMock();
    returning.mockResolvedValue([]);
    getDbMock.mockReturnValue(db as never);
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123", email: "ada@example.com", firstName: "Ada" },
      workspace: { id: "wks_123" },
    } as never);

    await expect(
      completeOnboarding(previousState, validFormData({ forceOnboarding: true })),
    ).rejects.toThrow("redirect:/personal/session/ses_123");

    expect(ensurePersonalAgentMock).toHaveBeenCalled();
    expect(createPersonalOnboardingSessionMock).toHaveBeenCalledWith(
      "agt_personal",
      expect.any(Object),
      ONBOARDING_FIRST_SESSION_PROMPT,
      expect.objectContaining({ skipBillingCheck: true }),
    );
    expect(loggerMock.info).toHaveBeenCalledWith("Retrying duplicate onboarding completion", {
      event: "opencompany.onboarding_completion_duplicate_retry",
      workspace_id: "wks_123",
      user_id: "usr_123",
    });
  });

  it("redirects home when first-session startup throws", async () => {
    const { db } = createDbMock();
    getDbMock.mockReturnValue(db as never);
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
    createPersonalOnboardingSessionMock.mockRejectedValue(new Error("session failed"));

    await expect(completeOnboarding(previousState, validFormData())).rejects.toThrow("redirect:/");

    expect(createPersonalOnboardingSessionMock).toHaveBeenCalled();
  });

  it("does not scaffold when onboarding values are invalid", async () => {
    const result = await completeOnboarding(previousState, new FormData());

    expect(result.errors).toMatchObject({
      heardFrom: "Choose where you heard about opencompany.",
      role: "Enter your role.",
      teamSize: "Choose your team size.",
      agentExperience: "Choose your experience level.",
    });
    expect(getDbMock).not.toHaveBeenCalled();
    expect(ensurePersonalAgentMock).not.toHaveBeenCalled();
    expect(createPersonalOnboardingSessionMock).not.toHaveBeenCalled();
  });
});
