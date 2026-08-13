import { getGoatWorkspacePlan } from "@opencompany/db/goat-billing";
import {
  createGoatWorkspaceForUser,
  hasOwnedGoatHobbyWorkspace,
  listAccessibleGoatBrains,
  listGoatWorkspaceMembers,
  listGoatWorkspacesForUser,
  newGoatWorkspaceId,
} from "@opencompany/db/goat-workspaces";
import { switchToOrganization } from "@workos-inc/authkit-nextjs";
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { getWorkOSClient } from "@/lib/workos-client";
import {
  createGoatWorkspaceAction,
  inviteToGoatWorkspaceAction,
  switchGoatWorkspaceAction,
} from "./workspace-actions";

const cookieStore = vi.hoisted(() => ({
  set: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/db/goat-billing", () => ({
  getGoatWorkspacePlan: vi.fn().mockResolvedValue("hobby"),
  goatWorkspaceMemberCap: (plan: string) => (plan === "pro" ? 10 : 1),
}));

vi.mock("@opencompany/db/goat-workspaces", () => ({
  createGoatBrain: vi.fn(),
  createGoatWorkspaceForUser: vi.fn(),
  DEFAULT_GOAT_BRAIN_SLUG: "general",
  getGoatBrainAccess: vi.fn(),
  hasOwnedGoatHobbyWorkspace: vi.fn().mockResolvedValue(false),
  listAccessibleGoatBrains: vi.fn(),
  listGoatBrainMemberIds: vi.fn(),
  listGoatWorkspaceMembers: vi.fn(),
  listGoatWorkspacesForUser: vi.fn(),
  newGoatWorkspaceId: vi.fn(),
  removeGoatWorkspaceMember: vi.fn(),
  replaceGoatBrainMembers: vi.fn(),
  updateGoatBrainEnrichmentEnabled: vi.fn(),
  updateGoatBrainIntelligence: vi.fn(),
  updateGoatBrainVisibility: vi.fn(),
  updateGoatWorkspaceName: vi.fn(),
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
  currentGoatUser: vi.fn(),
  GOAT_ACTIVE_BRAIN_COOKIE: "goat-active-brain",
  GOAT_ACTIVE_WORKSPACE_COOKIE: "goat-active-workspace",
}));

vi.mock("@/lib/billing/seats", () => ({
  syncGoatStripeSeatQuantityForWorkspace: vi.fn().mockResolvedValue({ ok: true, changed: false }),
}));

vi.mock("@/lib/workos-client", () => ({
  getWorkOSClient: vi.fn(),
}));

const createGoatWorkspaceForUserMock = vi.mocked(createGoatWorkspaceForUser);
const getGoatWorkspacePlanMock = vi.mocked(getGoatWorkspacePlan);
const hasOwnedGoatHobbyWorkspaceMock = vi.mocked(hasOwnedGoatHobbyWorkspace);
const currentGoatUserMock = vi.mocked(currentGoatUser);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);
const listAccessibleGoatBrainsMock = vi.mocked(listAccessibleGoatBrains);
const listGoatWorkspacesForUserMock = vi.mocked(listGoatWorkspacesForUser);
const listGoatWorkspaceMembersMock = vi.mocked(listGoatWorkspaceMembers);
const newGoatWorkspaceIdMock = vi.mocked(newGoatWorkspaceId);
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

describe("createGoatWorkspaceAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentGoatUserMock.mockResolvedValue(context as never);
    getWorkOSClientMock.mockReturnValue(workos as never);
    newGoatWorkspaceIdMock.mockReturnValue("goat_ws_new");
    hasOwnedGoatHobbyWorkspaceMock.mockResolvedValue(false);
    createGoatWorkspaceForUserMock.mockResolvedValue({
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
    await expect(createGoatWorkspaceAction("   ")).resolves.toEqual({
      ok: false,
      error: "Name cannot be empty.",
    });
    await expect(createGoatWorkspaceAction(null)).resolves.toEqual({
      ok: false,
      error: "Name cannot be empty.",
    });
    await expect(createGoatWorkspaceAction("x".repeat(81))).resolves.toEqual({
      ok: false,
      error: "Name is too long (max 80 chars).",
    });

    expect(currentGoatUserMock).not.toHaveBeenCalled();
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
  });

  it("creates a WorkOS organization and membership, persists Goat resources, and activates it", async () => {
    const result = await createGoatWorkspaceAction("  Analytical Co  ");

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
    expect(createGoatWorkspaceForUserMock).toHaveBeenCalledWith(
      {
        workspaceId: "goat_ws_new",
        workosOrganizationId: "org_new",
        userWorkosId: "user_123",
        name: "Analytical Co",
        slug: null,
      },
      { db: undefined },
    );
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
    hasOwnedGoatHobbyWorkspaceMock.mockResolvedValue(true);

    await expect(createGoatWorkspaceAction("Another workspace")).resolves.toEqual({
      ok: false,
      error: "Hobby includes one workspace. Upgrade your Hobby workspace to Pro to create another.",
    });
    expect(workos.organizations.createOrganization).not.toHaveBeenCalled();
  });

  it("deletes a newly created WorkOS organization when local persistence fails", async () => {
    createGoatWorkspaceForUserMock.mockRejectedValue(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createGoatWorkspaceAction("Analytical Co")).resolves.toEqual({
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

    await expect(createGoatWorkspaceAction("Analytical Co")).resolves.toEqual({
      ok: false,
      error:
        "The organization was created, but could not be activated. Please try switching to it.",
    });

    expect(createGoatWorkspaceForUserMock).toHaveBeenCalledOnce();
    expect(workos.organizations.deleteOrganization).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
    consoleError.mockRestore();
  });
});

describe("switchGoatWorkspaceAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentGoatUserMock.mockResolvedValue(context as never);
    switchToOrganizationMock.mockResolvedValue({} as never);
    listGoatWorkspacesForUserMock.mockResolvedValue([
      {
        workspace: {
          id: "goat_ws_next",
          workosOrganizationId: "org_next",
          name: "Research Labs",
        },
        role: "member",
      },
    ] as never);
    listAccessibleGoatBrainsMock.mockResolvedValue([
      { id: "general-next", slug: "general" },
    ] as never);
  });

  it("switches the WorkOS session before updating Goat's active cookies", async () => {
    await expect(switchGoatWorkspaceAction("goat_ws_next")).resolves.toEqual({ ok: true });

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
    listGoatWorkspacesForUserMock.mockResolvedValue([]);

    await expect(switchGoatWorkspaceAction("goat_ws_other")).resolves.toEqual({
      ok: false,
      error: "You do not have access to that workspace.",
    });

    expect(switchToOrganizationMock).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("returns a stable error when the WorkOS session cannot switch organizations", async () => {
    switchToOrganizationMock.mockRejectedValue(new Error("session refresh unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(switchGoatWorkspaceAction("goat_ws_next")).resolves.toEqual({
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

    await expect(switchGoatWorkspaceAction("goat_ws_next")).rejects.toBe(redirectError);

    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});

describe("inviteToGoatWorkspaceAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentGoatUserMock.mockResolvedValue(context as never);
    getWorkOSClientMock.mockReturnValue(workos as never);
    listGoatWorkspaceMembersMock.mockResolvedValue([
      { member: { role: "admin" }, user: { workosUserId: "user_123" } },
    ] as never);
  });

  it("keeps Hobby to its owner-only member cap", async () => {
    getGoatWorkspacePlanMock.mockResolvedValue("hobby");

    await expect(inviteToGoatWorkspaceAction("teammate@example.com")).resolves.toEqual({
      ok: false,
      error: "Hobby includes one member. Upgrade to Pro to invite teammates.",
    });
    expect(workos.userManagement.sendInvitation).not.toHaveBeenCalled();
  });

  it("allows a Pro admin to invite within the small-team cap", async () => {
    getGoatWorkspacePlanMock.mockResolvedValue("pro");

    await expect(inviteToGoatWorkspaceAction("teammate@example.com")).resolves.toEqual({
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
