import {
  getOnboarding,
  hasOwnedHobbyWorkspace,
  isWorkspaceSlugAvailable,
  updateWorkspaceNameAndSlug,
  upsertOnboarding,
} from "@opencompany/db/workspaces";
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentIdentity, currentUser } from "@/lib/auth";
import { createBrainFolderForUser, deleteBrainFolderForUser } from "@/lib/brain";
import { enrollOwnerInOnboardingEmails } from "@/lib/email/onboarding-emails";
import { getWorkOSClient } from "@/lib/workos-client";
import { provisionWorkspace } from "@/lib/workspace-provisioning";
import { activateWorkspace } from "@/lib/workspace-session";
import {
  checkWorkspaceSlugAction,
  saveOnboardingProfileAction,
  saveOnboardingWorkspaceAction,
} from "./onboarding-actions";

vi.mock("@opencompany/db/workspaces", () => ({
  getOnboarding: vi.fn(),
  hasOwnedHobbyWorkspace: vi.fn(),
  isWorkspaceSlugAvailable: vi.fn(),
  markUserOnboarded: vi.fn(),
  updateWorkspaceNameAndSlug: vi.fn(),
  upsertOnboarding: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  currentIdentity: vi.fn(),
  currentUser: vi.fn(),
}));

vi.mock("@/lib/brain", () => ({
  createBrainFolderForUser: vi.fn(),
  deleteBrainFolderForUser: vi.fn(),
}));

vi.mock("@/lib/email/onboarding-emails", () => ({
  enrollOwnerInOnboardingEmails: vi.fn(),
}));

vi.mock("@/lib/workos-client", () => ({
  getWorkOSClient: vi.fn(),
}));

vi.mock("@/lib/workos-organizations", () => ({
  ensureWorkspaceOrganization: vi.fn(),
}));

vi.mock("@/lib/workspace-provisioning", () => ({
  WorkspaceProvisioningError: class extends Error {},
  provisionWorkspace: vi.fn(),
}));

vi.mock("@/lib/workspace-session", () => ({
  activateWorkspace: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  unstable_rethrow: vi.fn(),
}));

const currentIdentityMock = vi.mocked(currentIdentity);
const currentUserMock = vi.mocked(currentUser);
const createBrainFolderForUserMock = vi.mocked(createBrainFolderForUser);
const deleteBrainFolderForUserMock = vi.mocked(deleteBrainFolderForUser);
const enrollOwnerInOnboardingEmailsMock = vi.mocked(enrollOwnerInOnboardingEmails);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);
const getOnboardingMock = vi.mocked(getOnboarding);
const hasOwnedHobbyWorkspaceMock = vi.mocked(hasOwnedHobbyWorkspace);
const isWorkspaceSlugAvailableMock = vi.mocked(isWorkspaceSlugAvailable);
const provisionWorkspaceMock = vi.mocked(provisionWorkspace);
const activateWorkspaceMock = vi.mocked(activateWorkspace);
const updateWorkspaceNameAndSlugMock = vi.mocked(updateWorkspaceNameAndSlug);
const upsertOnboardingMock = vi.mocked(upsertOnboarding);
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

describe("opencompany owner onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentIdentityMock.mockResolvedValue(identity as never);
    currentUserMock.mockResolvedValue(null as never);
    getOnboardingMock.mockResolvedValue({ role: "founder" } as never);
    isWorkspaceSlugAvailableMock.mockResolvedValue(true);
    hasOwnedHobbyWorkspaceMock.mockResolvedValue(false);
    provisionWorkspaceMock.mockResolvedValue(created as never);
    enrollOwnerInOnboardingEmailsMock.mockResolvedValue(undefined);
    activateWorkspaceMock.mockResolvedValue(undefined);
    getWorkOSClientMock.mockReturnValue({
      organizations: { updateOrganization },
    } as never);
  });

  it("checks workspace slugs without requiring a pre-existing workspace", async () => {
    await expect(checkWorkspaceSlugAction("  Analytical Co  ")).resolves.toEqual({
      slug: "analytical-co",
      available: true,
    });

    expect(currentIdentityMock).toHaveBeenCalledOnce();
    expect(isWorkspaceSlugAvailableMock).toHaveBeenCalledWith({
      slug: "analytical-co",
    });
  });

  it("persists the profile before the owner has created a workspace", async () => {
    await expect(
      saveOnboardingProfileAction({
        role: "founder",
        companyUrl: "opencompany.ai",
      }),
    ).resolves.toEqual({ ok: true });

    expect(upsertOnboardingMock).toHaveBeenCalledWith({
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
      saveOnboardingWorkspaceAction({
        name: "  Analytical Co  ",
        slug: "analytical-co",
      }),
    ).resolves.toEqual({
      ok: true,
      workspaceId: "goat_ws_new",
      brainRef: "brain_general",
    });

    expect(provisionWorkspaceMock).toHaveBeenCalledWith({
      authUserId: "user_123",
      userWorkosId: "user_123",
      name: "Analytical Co",
      slug: "analytical-co",
    });
    expect(upsertOnboardingMock).toHaveBeenCalledWith({
      userWorkosId: "user_123",
      workspaceId: "goat_ws_new",
    });
    expect(deleteBrainFolderForUserMock).toHaveBeenCalledWith({
      brainRef: "brain_general",
      userWorkosId: "user_123",
      folderPath: "concepts",
    });
    expect(createBrainFolderForUserMock).toHaveBeenCalledWith({
      brainRef: "brain_general",
      userWorkosId: "user_123",
      folderPath: "fundraising",
    });
    expect(enrollOwnerInOnboardingEmailsMock).toHaveBeenCalledWith({
      workosUserId: "user_123",
    });
    expect(activateWorkspaceMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_new",
      workosOrganizationId: "org_new",
      brainId: "brain_general",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("resumes a durably created onboarding workspace instead of creating another", async () => {
    currentUserMock.mockResolvedValue({
      ...identity,
      role: "admin",
      workspace: created.workspace,
      workspaces: [{ workspace: created.workspace, role: "admin" }],
      brains: [created.brain],
      activeBrain: created.brain,
    } as never);

    await expect(
      saveOnboardingWorkspaceAction({
        name: "Analytical Co",
        slug: "analytical-co",
      }),
    ).resolves.toEqual({
      ok: true,
      workspaceId: "goat_ws_new",
      brainRef: "brain_general",
    });

    expect(provisionWorkspaceMock).not.toHaveBeenCalled();
    expect(updateOrganization).toHaveBeenCalledWith({
      organization: "org_new",
      name: "Analytical Co",
    });
    expect(updateWorkspaceNameAndSlugMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_new",
      name: "Analytical Co",
      slug: "analytical-co",
    });
    expect(activateWorkspaceMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_new",
      workosOrganizationId: "org_new",
      brainId: "brain_general",
    });
  });
});
