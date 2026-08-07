import { getWorkspacePlan } from "@opencompany/db/billing";
import {
  createWorkspaceForUser,
  hasOwnedHobbyWorkspace,
  listAccessibleBrains,
  listWorkspaceMembers,
  listWorkspacesForUser,
  newWorkspaceId,
} from "@opencompany/db/workspaces";
import { switchToOrganization } from "@workos-inc/authkit-nextjs";
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentUser } from "@/lib/auth";
import { getWorkOSClient } from "@/lib/workos-client";
import {
  createWorkspaceAction,
  inviteToWorkspaceAction,
  switchWorkspaceAction,
} from "./workspace-actions";

const cookieStore = vi.hoisted(() => ({
  set: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/db/billing", () => ({
  getWorkspacePlan: vi.fn().mockResolvedValue("hobby"),
  workspaceMemberCap: (plan: string) => (plan === "pro" ? 10 : 1),
}));

vi.mock("@opencompany/db/workspaces", () => ({
  createBrain: vi.fn(),
  createWorkspaceForUser: vi.fn(),
  DEFAULT_BRAIN_SLUG: "general",
  getBrainAccess: vi.fn(),
  hasOwnedHobbyWorkspace: vi.fn().mockResolvedValue(false),
  listAccessibleBrains: vi.fn(),
  listBrainMemberIds: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  newWorkspaceId: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  replaceBrainMembers: vi.fn(),
  updateBrainEnrichmentEnabled: vi.fn(),
  updateBrainIntelligence: vi.fn(),
  updateBrainVisibility: vi.fn(),
  updateWorkspaceName: vi.fn(),
}));

vi.mock("@workos-inc/authkit-nextjs", () => ({
  switchToOrganization: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
}));

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(),
  ACTIVE_BRAIN_COOKIE: "goat-active-brain",
  ACTIVE_WORKSPACE_COOKIE: "goat-active-workspace",
}));

vi.mock("@/lib/billing/seats", () => ({
  syncStripeSeatQuantityForWorkspace: vi.fn().mockResolvedValue({ ok: true, changed: false }),
}));

vi.mock("@/lib/workos-client", () => ({
  getWorkOSClient: vi.fn(),
}));

const createWorkspaceForUserMock = vi.mocked(createWorkspaceForUser);
const getWorkspacePlanMock = vi.mocked(getWorkspacePlan);
const hasOwnedHobbyWorkspaceMock = vi.mocked(hasOwnedHobbyWorkspace);
const currentUserMock = vi.mocked(currentUser);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);
const listAccessibleBrainsMock = vi.mocked(listAccessibleBrains);
const listWorkspacesForUserMock = vi.mocked(listWorkspacesForUser);
const listWorkspaceMembersMock = vi.mocked(listWorkspaceMembers);
const newWorkspaceIdMock = vi.mocked(newWorkspaceId);
const revalidatePathMock = vi.mocked(revalidatePath);
const switchToOrganizationMock = vi.mocked(switchToOrganization);

const context = {
  role: "admin",
  authUser: { id: "user_123" },
  user: { workosUserId: "user_123" },
  workspace: {
    id: "goat_ws_current",
    workosOrganizationId: "org_current",
    name: "Current Organization",
  },
};

const workos = {
  organizations: {
    createOrganization: vi.fn(async () => ({
      id: "org_new",
      name: "Analytical Co",
    })),
    deleteOrganization: vi.fn(async () => undefined),
  },
  userManagement: {
    createOrganizationMembership: vi.fn(async () => ({ id: "om_new" })),
    listInvitations: vi.fn(async () => ({ data: [] })),
    sendInvitation: vi.fn(async () => ({ id: "inv_new" })),
  },
};

describe("createWorkspaceAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUserMock.mockResolvedValue(context as never);
    getWorkOSClientMock.mockReturnValue(workos as never);
    newWorkspaceIdMock.mockReturnValue("goat_ws_new");
    hasOwnedHobbyWorkspaceMock.mockResolvedValue(false);
    createWorkspaceForUserMock.mockResolvedValue({
      workspace: {
        id: "goat_ws_new",
        workosOrganizationId: "org_new",
        name: "Analytical Co",
      },
      brain: { id: "general-new" },
    } as never);
    switchToOrganizationMock.mockResolvedValue({} as never);
  });

  it("validates the organization name before calling WorkOS", async () => {
    await expect(createWorkspaceAction("   ")).resolves.toEqual({
      ok: false,
      error: "Name cannot be empty.",
    });
    await expect(createWorkspaceAction(null)).resolves.toEqual({
      ok: false,
      error: "Name cannot be empty.",
    });
    await expect(createWorkspaceAction("x".repeat(81))).resolves.toEqual({
      ok: false,
      error: "Name is too long (max 80 chars).",
    });

    expect(currentUserMock).not.toHaveBeenCalled();
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
  });

  it("creates a WorkOS organization and membership, persists workspace resources, and activates it", async () => {
    const result = await createWorkspaceAction("  Analytical Co  ");

    expect(result).toEqual({ ok: true, workspaceId: "goat_ws_new" });
    expect(workos.organizations.createOrganization).toHaveBeenCalledWith(
      {
        name: "Analytical Co",
        externalId: "goat_ws_new",
        metadata: { goat_workspace_id: "goat_ws_new" },
      },
      { idempotencyKey: "goat_ws_new" },
    );
    expect(workos.userManagement.createOrganizationMembership).toHaveBeenCalledWith({
      organizationId: "org_new",
      userId: "user_123",
      roleSlug: "admin",
    });
    expect(createWorkspaceForUserMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_new",
      workosOrganizationId: "org_new",
      userWorkosId: "user_123",
      name: "Analytical Co",
    });
    expect(switchToOrganizationMock).toHaveBeenCalledWith("org_new", {
      revalidationStrategy: "none",
    });
    expect(cookieStore.set).toHaveBeenCalledWith(
      "goat-active-workspace",
      "goat_ws_new",
      expect.objectContaining({ path: "/", sameSite: "lax" }),
    );
    expect(cookieStore.set).toHaveBeenCalledWith(
      "goat-active-brain",
      "general-new",
      expect.objectContaining({ path: "/", sameSite: "lax" }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("keeps each owner to one Hobby workspace", async () => {
    hasOwnedHobbyWorkspaceMock.mockResolvedValue(true);

    await expect(createWorkspaceAction("Another workspace")).resolves.toEqual({
      ok: false,
      error: "Hobby includes one workspace. Upgrade your Hobby workspace to Pro to create another.",
    });
    expect(workos.organizations.createOrganization).not.toHaveBeenCalled();
  });

  it("deletes a newly created WorkOS organization when local persistence fails", async () => {
    createWorkspaceForUserMock.mockRejectedValue(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createWorkspaceAction("Analytical Co")).resolves.toEqual({
      ok: false,
      error: "Could not create the organization. Please try again.",
    });

    expect(workos.organizations.deleteOrganization).toHaveBeenCalledWith("org_new");
    expect(switchToOrganizationMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps persisted resources when activating the new organization fails", async () => {
    switchToOrganizationMock.mockRejectedValue(new Error("session refresh unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createWorkspaceAction("Analytical Co")).resolves.toEqual({
      ok: false,
      error:
        "The organization was created, but could not be activated. Please try switching to it.",
    });

    expect(createWorkspaceForUserMock).toHaveBeenCalledOnce();
    expect(workos.organizations.deleteOrganization).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
    consoleError.mockRestore();
  });
});

describe("switchWorkspaceAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUserMock.mockResolvedValue(context as never);
    switchToOrganizationMock.mockResolvedValue({} as never);
    listWorkspacesForUserMock.mockResolvedValue([
      {
        workspace: {
          id: "goat_ws_next",
          workosOrganizationId: "org_next",
          name: "Research Labs",
        },
        role: "member",
      },
    ] as never);
    listAccessibleBrainsMock.mockResolvedValue([{ id: "general-next", slug: "general" }] as never);
  });

  it("switches the WorkOS session before updating the app's active cookies", async () => {
    await expect(switchWorkspaceAction("goat_ws_next")).resolves.toEqual({ ok: true });

    expect(switchToOrganizationMock).toHaveBeenCalledWith("org_next", {
      revalidationStrategy: "none",
    });
    expect(switchToOrganizationMock.mock.invocationCallOrder[0]).toBeLessThan(
      cookieStore.set.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(cookieStore.set).toHaveBeenCalledWith(
      "goat-active-workspace",
      "goat_ws_next",
      expect.objectContaining({ path: "/", sameSite: "lax" }),
    );
    expect(cookieStore.set).toHaveBeenCalledWith(
      "goat-active-brain",
      "general-next",
      expect.objectContaining({ path: "/", sameSite: "lax" }),
    );
  });

  it("rejects a workspace that is not one of the user's memberships", async () => {
    listWorkspacesForUserMock.mockResolvedValue([]);

    await expect(switchWorkspaceAction("goat_ws_other")).resolves.toEqual({
      ok: false,
      error: "You do not have access to that workspace.",
    });

    expect(switchToOrganizationMock).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("returns a stable error when the WorkOS session cannot switch organizations", async () => {
    switchToOrganizationMock.mockRejectedValue(new Error("session refresh unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(switchWorkspaceAction("goat_ws_next")).resolves.toEqual({
      ok: false,
      error: "Could not switch organizations. Please try again.",
    });

    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("preserves AuthKit redirects for organization-specific authentication", async () => {
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;https://authkit.example.test/authorize;307;",
    });
    switchToOrganizationMock.mockRejectedValue(redirectError);

    await expect(switchWorkspaceAction("goat_ws_next")).rejects.toBe(redirectError);

    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("inviteToWorkspaceAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUserMock.mockResolvedValue(context as never);
    getWorkOSClientMock.mockReturnValue(workos as never);
    listWorkspaceMembersMock.mockResolvedValue([
      { member: { role: "admin" }, user: { workosUserId: "user_123" } },
    ] as never);
  });

  it("keeps Hobby to its owner-only member cap", async () => {
    getWorkspacePlanMock.mockResolvedValue("hobby");

    await expect(inviteToWorkspaceAction("teammate@example.com")).resolves.toEqual({
      ok: false,
      error: "Hobby includes one member. Upgrade to Pro to invite teammates.",
    });
    expect(workos.userManagement.sendInvitation).not.toHaveBeenCalled();
  });

  it("allows a Pro admin to invite within the small-team cap", async () => {
    getWorkspacePlanMock.mockResolvedValue("pro");

    await expect(inviteToWorkspaceAction("teammate@example.com")).resolves.toEqual({
      ok: true,
    });
    expect(workos.userManagement.sendInvitation).toHaveBeenCalledWith({
      email: "teammate@example.com",
      organizationId: "org_current",
      inviterUserId: "user_123",
      roleSlug: "member",
    });
  });
});
