import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentIdentity } from "@/lib/auth";
import { enrollOwnerInOnboardingEmails } from "@/lib/email/onboarding-emails";
import { serverApiErrorMessage } from "@/lib/server-api-client";
import { activateWorkspace } from "@/lib/workspace-session";
import {
  checkWorkspaceSlugAction,
  finishOnboardingAction,
  getOnboardingState,
  saveOnboardingProfileAction,
  saveOnboardingWorkspaceAction,
} from "./onboarding-actions";

const mocks = vi.hoisted(() => ({
  checkSlug: vi.fn(),
  finish: vi.fn(),
  getState: vi.fn(),
  saveProfile: vi.fn(),
  saveWorkspace: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000123"),
}));

vi.mock("@/lib/auth", () => ({ currentIdentity: vi.fn() }));
vi.mock("@/lib/email/onboarding-emails", () => ({
  enrollOwnerInOnboardingEmails: vi.fn(),
}));
vi.mock("@/lib/server-api-client", () => ({
  serverApiClient: vi.fn(async () => ({
    v1: {
      onboarding: {
        $get: mocks.getState,
        complete: { $post: mocks.finish },
        profile: { $put: mocks.saveProfile },
        workspace: { $put: mocks.saveWorkspace },
        "workspace-slug": { check: { $post: mocks.checkSlug } },
      },
    },
  })),
  serverApiError: vi.fn(async (_response: Response, fallback: string) => new Error(fallback)),
  serverApiErrorMessage: vi.fn(async (_response: Response, fallback: string) => fallback),
}));
vi.mock("@/lib/workspace-session", () => ({ activateWorkspace: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  unstable_rethrow(error: unknown) {
    if (error instanceof Error && "digest" in error) throw error;
  },
}));

const currentIdentityMock = vi.mocked(currentIdentity);
const enrollOwnerInOnboardingEmailsMock = vi.mocked(enrollOwnerInOnboardingEmails);
const activateWorkspaceMock = vi.mocked(activateWorkspace);
const revalidatePathMock = vi.mocked(revalidatePath);
const serverApiErrorMessageMock = vi.mocked(serverApiErrorMessage);

const activation = {
  workspaceId: "goat_ws_new",
  organizationId: "org_new",
  brainId: "brain_general",
  createdByCaller: true,
};

describe("opencompany onboarding API adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentIdentityMock.mockResolvedValue({
      user: { workosUserId: "user_123", email: "ada@example.com" },
    } as never);
    enrollOwnerInOnboardingEmailsMock.mockResolvedValue(undefined);
    activateWorkspaceMock.mockResolvedValue(undefined);
    mocks.checkSlug.mockResolvedValue(
      Response.json({ data: { slug: "analytical-co", available: true } }),
    );
    mocks.saveProfile.mockResolvedValue(Response.json({ data: { completed: true } }));
    mocks.saveWorkspace.mockResolvedValue(Response.json({ data: activation }));
    mocks.finish.mockResolvedValue(Response.json({ data: { completed: true } }));
  });

  it("reads onboarding state through the identity-tier resource", async () => {
    const state = {
      onboarding: null,
      workspace: null,
      activeBrainId: null,
    };
    mocks.getState.mockResolvedValue(Response.json({ data: state }));
    await expect(getOnboardingState()).resolves.toEqual(state);
    expect(mocks.getState).toHaveBeenCalledOnce();
  });

  it("normalizes and checks workspace slugs through /v1", async () => {
    await expect(checkWorkspaceSlugAction("  Analytical Co  ")).resolves.toEqual({
      slug: "analytical-co",
      available: true,
    });
    expect(mocks.checkSlug).toHaveBeenCalledWith({ json: { slug: "analytical-co" } });

    await expect(checkWorkspaceSlugAction("---")).resolves.toEqual({
      slug: "",
      available: false,
    });
    expect(mocks.checkSlug).toHaveBeenCalledOnce();
  });

  it("normalizes the profile before sending the canonical command", async () => {
    await expect(
      saveOnboardingProfileAction({ role: "founder", companyUrl: "opencompany.ai" }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.saveProfile).toHaveBeenCalledWith({
      json: { role: "founder", companyUrl: "https://opencompany.ai/" },
    });
  });

  it("creates through /v1, retains web email enrollment, and activates AuthKit", async () => {
    await expect(
      saveOnboardingWorkspaceAction({ name: "  Analytical Co  ", slug: "analytical-co" }),
    ).resolves.toEqual({
      ok: true,
      workspaceId: "goat_ws_new",
      brainRef: "brain_general",
    });
    expect(mocks.saveWorkspace).toHaveBeenCalledWith({
      json: {
        workspaceId: "goat_ws_00000000-0000-4000-8000-000000000123",
        name: "Analytical Co",
        slug: "analytical-co",
      },
    });
    expect(enrollOwnerInOnboardingEmailsMock).toHaveBeenCalledWith({ workosUserId: "user_123" });
    expect(activateWorkspaceMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_new",
      workosOrganizationId: "org_new",
      brainId: "brain_general",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("does not enroll an invited member in owner welcome emails", async () => {
    mocks.saveWorkspace.mockResolvedValueOnce(
      Response.json({ data: { ...activation, createdByCaller: false } }),
    );
    await saveOnboardingWorkspaceAction({ name: "Analytical Co", slug: "analytical-co" });
    expect(currentIdentityMock).not.toHaveBeenCalled();
    expect(enrollOwnerInOnboardingEmailsMock).not.toHaveBeenCalled();
  });

  it("preserves API errors without activating a workspace", async () => {
    mocks.saveWorkspace.mockResolvedValueOnce(Response.json({}, { status: 409 }));
    serverApiErrorMessageMock.mockResolvedValueOnce("That workspace URL is taken.");
    await expect(
      saveOnboardingWorkspaceAction({ name: "Analytical Co", slug: "analytical-co" }),
    ).resolves.toEqual({ ok: false, error: "That workspace URL is taken." });
    expect(activateWorkspaceMock).not.toHaveBeenCalled();
  });

  it("completes through the identity tier and revalidates the app shell", async () => {
    await expect(finishOnboardingAction({ referralSource: "  friend  " })).resolves.toEqual({
      ok: true,
    });
    expect(mocks.finish).toHaveBeenCalledWith({ json: { referralSource: "friend" } });
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });
});
