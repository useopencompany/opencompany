import { syncGoatStripeSeatQuantityForWorkspace } from "@opencompany/billing/seats";
import type { Actor } from "@opencompany/core";
import { getGoatWorkspacePlan } from "@opencompany/db/goat-billing";
import {
  hasOwnedGoatHobbyWorkspace,
  listAccessibleGoatBrains,
  listGoatWorkspaceMembers,
  listGoatWorkspacesForUser,
  removeGoatWorkspaceMember,
  updateGoatWorkspaceName,
} from "@opencompany/db/goat-workspaces";
import { ensureGoatWorkspaceOrganization } from "@opencompany/goat-agent/workspaces/organizations";
import { provisionGoatWorkspace } from "@opencompany/goat-agent/workspaces/provisioning";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceControlService } from "./workspace-control";

vi.mock("@opencompany/billing/seats", () => ({
  syncGoatStripeSeatQuantityForWorkspace: vi.fn(async () => ({ ok: true, changed: true })),
}));

vi.mock("@opencompany/db/goat-billing", () => ({
  getGoatWorkspacePlan: vi.fn(async () => "pro"),
  goatWorkspaceMemberCap: (plan: string) => (plan === "pro" ? 10 : 1),
}));

vi.mock("@opencompany/db/goat-workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasOwnedGoatHobbyWorkspace: vi.fn(async () => false),
  listAccessibleGoatBrains: vi.fn(async () => [{ id: "brain_general", slug: "general" }]),
  listGoatWorkspaceMembers: vi.fn(),
  listGoatWorkspacesForUser: vi.fn(),
  removeGoatWorkspaceMember: vi.fn(async () => undefined),
  updateGoatWorkspaceName: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/goat-agent/workspaces/organizations", () => ({
  ensureGoatWorkspaceOrganization: vi.fn(async () => "org_current"),
}));

vi.mock("@opencompany/goat-agent/workspaces/provisioning", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  provisionGoatWorkspace: vi.fn(),
}));

const admin: Actor = {
  userId: "user_1",
  workspaceId: "goat_ws_current",
  role: "admin",
  permissions: [],
  authenticationMethod: "session",
};
const member: Actor = { ...admin, role: "member" };

const workspace = {
  id: "goat_ws_current",
  name: "Current Organization",
  workosOrganizationId: "org_current",
};

const workos = {
  organizations: {
    updateOrganization: vi.fn(async () => ({ id: "org_current" })),
  },
  userManagement: {
    deleteOrganizationMembership: vi.fn(async () => undefined),
    listInvitations: vi.fn(async () => ({ data: [] })),
    listOrganizationMemberships: vi.fn(async () => ({ data: [] })),
    revokeInvitation: vi.fn(async () => undefined),
    sendInvitation: vi.fn(async () => ({ id: "inv_new" })),
  },
};

describe("workspace control service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoatWorkspacePlan).mockResolvedValue("pro");
    vi.mocked(hasOwnedGoatHobbyWorkspace).mockResolvedValue(false);
    vi.mocked(listGoatWorkspaceMembers).mockResolvedValue(workspaceMembers() as never);
    vi.mocked(listGoatWorkspacesForUser).mockResolvedValue([{ workspace, role: "admin" }] as never);
    vi.mocked(listAccessibleGoatBrains).mockResolvedValue([
      { id: "brain_general", slug: "general" },
    ] as never);
    vi.mocked(provisionGoatWorkspace).mockResolvedValue({
      workspace: { ...workspace, id: "goat_ws_new", workosOrganizationId: "org_new" },
      brain: { id: "brain_new" },
    } as never);
    workos.userManagement.listInvitations.mockResolvedValue({ data: [] });
    workos.userManagement.listOrganizationMemberships.mockResolvedValue({ data: [] });
  });

  it("returns an authorized settings DTO and degrades only invitation reads", async () => {
    const service = createWorkspaceControlService({
      db: dbWithWorkspace(),
      workos: workos as never,
    });
    workos.userManagement.listInvitations.mockRejectedValueOnce(new Error("WorkOS unavailable"));
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(service.getSettings(admin)).resolves.toEqual({
      workspace: { id: "goat_ws_current", name: "Current Organization" },
      role: "admin",
      plan: "pro",
      memberCap: 10,
      members: [
        {
          id: "user_1",
          email: "owner@example.com",
          name: "Ada Lovelace",
          firstName: "Ada",
          lastName: "Lovelace",
          avatarUrl: null,
          role: "admin",
        },
        {
          id: "user_2",
          email: "member@example.com",
          name: "member@example.com",
          firstName: null,
          lastName: null,
          avatarUrl: null,
          role: "member",
        },
      ],
      invitations: [],
    });
    logger.mockRestore();
  });

  it("requires an active-workspace admin for membership and rename commands", async () => {
    const service = createWorkspaceControlService({
      db: dbWithWorkspace(),
      workos: workos as never,
    });
    await expect(service.invite(member, "teammate@example.com")).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.rename(member, "Renamed")).rejects.toMatchObject({ status: 403 });
    expect(workos.userManagement.sendInvitation).not.toHaveBeenCalled();
    expect(updateGoatWorkspaceName).not.toHaveBeenCalled();
  });

  it("verifies invitation and member ownership before destructive WorkOS calls", async () => {
    const service = createWorkspaceControlService({
      db: dbWithWorkspace(),
      workos: workos as never,
    });
    workos.userManagement.listInvitations.mockResolvedValueOnce({
      data: [invitation({ id: "inv_other" })] as never,
    });
    await expect(service.revokeInvitation(admin, "inv_foreign")).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.removeMember(admin, "user_foreign")).rejects.toMatchObject({
      status: 404,
    });
    expect(workos.userManagement.revokeInvitation).not.toHaveBeenCalled();
    expect(workos.userManagement.listOrganizationMemberships).not.toHaveBeenCalled();
  });

  it("removes a local member, then performs per-event Stripe seat sync", async () => {
    const service = createWorkspaceControlService({
      db: dbWithWorkspace(),
      workos: workos as never,
    });
    workos.userManagement.listOrganizationMemberships.mockResolvedValueOnce({
      data: [{ id: "om_2" }] as never,
    });

    await service.removeMember(admin, "user_2");

    expect(workos.userManagement.deleteOrganizationMembership).toHaveBeenCalledWith("om_2");
    expect(removeGoatWorkspaceMember).toHaveBeenCalledWith(
      { workspaceId: "goat_ws_current", userWorkosId: "user_2" },
      { db: expect.anything() },
    );
    expect(syncGoatStripeSeatQuantityForWorkspace).toHaveBeenCalledWith("goat_ws_current", {
      db: expect.anything(),
    });
  });

  it("provisions with the caller workspace id and returns activation data", async () => {
    const db = dbWithWorkspace();
    const service = createWorkspaceControlService({ db, workos: workos as never });

    await expect(
      service.create(admin, { workspaceId: "goat_ws_new", name: " New Organization " }),
    ).resolves.toEqual({
      workspaceId: "goat_ws_new",
      organizationId: "org_new",
      brainId: "brain_new",
    });
    expect(provisionGoatWorkspace).toHaveBeenCalledWith(
      {
        authUserId: "user_1",
        userWorkosId: "user_1",
        workspaceId: "goat_ws_new",
        name: "New Organization",
      },
      { workos, db },
    );
  });

  it("authorizes workspace switches through the actor's memberships", async () => {
    const service = createWorkspaceControlService({
      db: dbWithWorkspace(),
      workos: workos as never,
    });
    await expect(service.switch(member, "goat_ws_current")).resolves.toEqual({
      workspaceId: "goat_ws_current",
      organizationId: "org_current",
      brainId: "brain_general",
    });
    await expect(service.switch(member, "goat_ws_foreign")).rejects.toMatchObject({ status: 404 });
  });
});

function dbWithWorkspace() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [workspace]),
        })),
      })),
    })),
  };
}

function workspaceMembers() {
  return [
    {
      member: { role: "admin" },
      user: {
        workosUserId: "user_1",
        email: "owner@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
      },
    },
    {
      member: { role: "member" },
      user: {
        workosUserId: "user_2",
        email: "member@example.com",
        firstName: null,
        lastName: null,
        avatarUrl: null,
      },
    },
  ];
}

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv_1",
    email: "teammate@example.com",
    state: "pending",
    expiresAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}
