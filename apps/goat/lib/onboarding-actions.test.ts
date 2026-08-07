import {
  hasOwnedGoatHobbyWorkspace,
  isGoatWorkspaceSlugAvailable,
  updateGoatWorkspaceNameAndSlug,
  upsertGoatOnboarding,
} from "@opencompany/db/goat-workspaces";
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatIdentity, currentGoatUser } from "@/lib/auth";
import { enrollOwnerInOnboardingEmails } from "@/lib/email/onboarding-emails";
import { getWorkOSClient } from "@/lib/workos-client";
import { provisionGoatWorkspace } from "@/lib/workspace-provisioning";
import { activateGoatWorkspace } from "@/lib/workspace-session";
import {
  checkGoatWorkspaceSlugAction,
  saveGoatOnboardingProfileAction,
  saveGoatOnboardingWorkspaceAction,
} from "./onboarding-actions";

vi.mock("@opencompany/db/goat-workspaces", () => ({
  hasOwnedGoatHobbyWorkspace: vi.fn(),
  isGoatWorkspaceSlugAvailable: vi.fn(),
  markGoatUserOnboarded: vi.fn(),
  updateGoatWorkspaceNameAndSlug: vi.fn(),
  upsertGoatOnboarding: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentGoatIdentity: vi.fn(),
  currentGoatUser: vi.fn(),
}));

vi.mock("@/lib/brain", () => ({
  createGoatBrainFolderForUser: vi.fn(),
  deleteGoatBrainFolderForUser: vi.fn(),
}));

vi.mock("@/lib/email/onboarding-emails", () => ({
  enrollOwnerInOnboardingEmails: vi.fn(),
}));

vi.mock("@/lib/workos-client", () => ({
  getWorkOSClient: vi.fn(),
}));

vi.mock("@/lib/workos-organizations", () => ({
  ensureGoatWorkspaceOrganization: vi.fn(),
}));

vi.mock("@/lib/workspace-provisioning", () => ({
  GoatWorkspaceProvisioningError: class extends Error {},
  provisionGoatWorkspace: vi.fn(),
}));

vi.mock("@/lib/workspace-session", () => ({
  activateGoatWorkspace: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  unstable_rethrow: vi.fn(),
}));

const currentGoatIdentityMock = vi.mocked(currentGoatIdentity);
const currentGoatUserMock = vi.mocked(currentGoatUser);
const enrollOwnerInOnboardingEmailsMock = vi.mocked(enrollOwnerInOnboardingEmails);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);
const hasOwnedGoatHobbyWorkspaceMock = vi.mocked(hasOwnedGoatHobbyWorkspace);
const isGoatWorkspaceSlugAvailableMock = vi.mocked(isGoatWorkspaceSlugAvailable);
const provisionGoatWorkspaceMock = vi.mocked(provisionGoatWorkspace);
const activateGoatWorkspaceMock = vi.mocked(activateGoatWorkspace);
const updateGoatWorkspaceNameAndSlugMock = vi.mocked(updateGoatWorkspaceNameAndSlug);
const upsertGoatOnboardingMock = vi.mocked(upsertGoatOnboarding);
const revalidatePathMock = vi.mocked(revalidatePath);

const identity = {
  authUser: { id: "user_123" },
  organizationId: null,
  user: {
    workosUserId: "user_123",
    email: "ada@example.com",
  },
  workspaces: [],
};

const created = {
  workspace: {
    id: "goat_ws_new",
    workosOrganizationId: "org_new",
    name: "Analytical Co",
    slug: "analytical-co",
  },
  brain: { id: "brain_general" },
};

const updateOrganization = vi.fn();

describe("Goat owner onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentGoatIdentityMock.mockResolvedValue(identity as never);
    currentGoatUserMock.mockResolvedValue(null as never);
    isGoatWorkspaceSlugAvailableMock.mockResolvedValue(true);
    hasOwnedGoatHobbyWorkspaceMock.mockResolvedValue(false);
    provisionGoatWorkspaceMock.mockResolvedValue(created as never);
    enrollOwnerInOnboardingEmailsMock.mockResolvedValue(undefined);
    activateGoatWorkspaceMock.mockResolvedValue(undefined);
    getWorkOSClientMock.mockReturnValue({
      organizations: { updateOrganization },
    } as never);
  });

  it("checks workspace slugs without requiring a pre-existing workspace", async () => {
    await expect(checkGoatWorkspaceSlugAction("  Analytical Co  ")).resolves.toEqual({
      slug: "analytical-co",
      available: true,
    });

    expect(currentGoatIdentityMock).toHaveBeenCalledOnce();
    expect(isGoatWorkspaceSlugAvailableMock).toHaveBeenCalledWith({
      slug: "analytical-co",
    });
  });

  it("persists the profile before the owner has created a workspace", async () => {
    await expect(
      saveGoatOnboardingProfileAction({
        role: "founder",
        companyUrl: "opencompany.ai",
      }),
    ).resolves.toEqual({ ok: true });

    expect(upsertGoatOnboardingMock).toHaveBeenCalledWith({
      userWorkosId: "user_123",
      workspaceId: null,
      role: "founder",
      building: null,
      companyDomain: "opencompany.ai",
      contextUrls: ["https://opencompany.ai/"],
    });
  });

  it("creates and activates the first workspace at the onboarding workspace step", async () => {
    await expect(
      saveGoatOnboardingWorkspaceAction({
        name: "  Analytical Co  ",
        slug: "analytical-co",
      }),
    ).resolves.toEqual({
      ok: true,
      workspaceId: "goat_ws_new",
      brainRef: "brain_general",
    });

    expect(provisionGoatWorkspaceMock).toHaveBeenCalledWith({
      authUserId: "user_123",
      userWorkosId: "user_123",
      name: "Analytical Co",
      slug: "analytical-co",
    });
    expect(upsertGoatOnboardingMock).toHaveBeenCalledWith({
      userWorkosId: "user_123",
      workspaceId: "goat_ws_new",
    });
    expect(enrollOwnerInOnboardingEmailsMock).toHaveBeenCalledWith({
      workosUserId: "user_123",
    });
    expect(activateGoatWorkspaceMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_new",
      workosOrganizationId: "org_new",
      brainId: "brain_general",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("resumes a durably created onboarding workspace instead of creating another", async () => {
    currentGoatUserMock.mockResolvedValue({
      ...identity,
      role: "admin",
      workspace: created.workspace,
      workspaces: [{ workspace: created.workspace, role: "admin" }],
      brains: [created.brain],
      activeBrain: created.brain,
    } as never);

    await expect(
      saveGoatOnboardingWorkspaceAction({
        name: "Analytical Co",
        slug: "analytical-co",
      }),
    ).resolves.toEqual({
      ok: true,
      workspaceId: "goat_ws_new",
      brainRef: "brain_general",
    });

    expect(provisionGoatWorkspaceMock).not.toHaveBeenCalled();
    expect(updateOrganization).toHaveBeenCalledWith({
      organization: "org_new",
      name: "Analytical Co",
    });
    expect(updateGoatWorkspaceNameAndSlugMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_new",
      name: "Analytical Co",
      slug: "analytical-co",
    });
    expect(activateGoatWorkspaceMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_new",
      workosOrganizationId: "org_new",
      brainId: "brain_general",
    });
  });
});
