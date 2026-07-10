import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureGoatWorkspaceOrganization } from "@/lib/workos-organizations";

const mocks = vi.hoisted(() => {
  const workos = {
    organizations: {
      getOrganizationByExternalId: vi.fn(),
      createOrganization: vi.fn(),
      deleteOrganization: vi.fn(),
    },
    userManagement: {
      listOrganizationMemberships: vi.fn(),
      createOrganizationMembership: vi.fn(),
      updateOrganizationMembership: vi.fn(),
    },
  };
  return {
    workos,
    listGoatWorkspaceMembers: vi.fn(),
    setGoatWorkspaceOrganizationId: vi.fn(),
  };
});

vi.mock("@/lib/workos-client", () => ({
  getWorkOSClient: () => mocks.workos,
}));

vi.mock("@opencompany/db/goat-workspaces", () => ({
  listGoatWorkspaceMembers: mocks.listGoatWorkspaceMembers,
  setGoatWorkspaceOrganizationId: mocks.setGoatWorkspaceOrganizationId,
}));

describe("ensureGoatWorkspaceOrganization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listGoatWorkspaceMembers.mockResolvedValue([workspaceMember("user_1", "admin")]);
    mocks.workos.userManagement.listOrganizationMemberships.mockResolvedValue({ data: [] });
    mocks.workos.userManagement.createOrganizationMembership.mockResolvedValue({});
    mocks.workos.userManagement.updateOrganizationMembership.mockResolvedValue({});
  });

  it("creates a WorkOS organization with the Goat workspace id as externalId", async () => {
    mocks.workos.organizations.getOrganizationByExternalId.mockRejectedValueOnce({ status: 404 });
    mocks.workos.organizations.createOrganization.mockResolvedValueOnce({ id: "org_new" });

    await expect(ensureGoatWorkspaceOrganization(workspace())).resolves.toBe("org_new");

    expect(mocks.workos.organizations.createOrganization).toHaveBeenCalledWith(
      {
        name: "Ada's Workspace",
        externalId: "goat_ws_1",
        metadata: {
          goat_workspace_id: "goat_ws_1",
        },
      },
      { idempotencyKey: "goat_ws_1" },
    );
    expect(mocks.workos.userManagement.createOrganizationMembership).toHaveBeenCalledWith({
      organizationId: "org_new",
      userId: "user_1",
      roleSlug: "admin",
    });
    expect(mocks.setGoatWorkspaceOrganizationId).toHaveBeenCalledWith({
      workspaceId: "goat_ws_1",
      workosOrganizationId: "org_new",
    });
  });

  it("links an existing WorkOS organization found by externalId", async () => {
    mocks.workos.organizations.getOrganizationByExternalId.mockResolvedValueOnce({
      id: "org_existing",
    });
    mocks.workos.userManagement.listOrganizationMemberships.mockResolvedValueOnce({
      data: [
        {
          id: "om_1",
          status: "active",
          role: { slug: "member" },
        },
      ],
    });

    await expect(ensureGoatWorkspaceOrganization(workspace())).resolves.toBe("org_existing");

    expect(mocks.workos.organizations.createOrganization).not.toHaveBeenCalled();
    expect(mocks.workos.userManagement.updateOrganizationMembership).toHaveBeenCalledWith("om_1", {
      roleSlug: "admin",
    });
    expect(mocks.setGoatWorkspaceOrganizationId).toHaveBeenCalledWith({
      workspaceId: "goat_ws_1",
      workosOrganizationId: "org_existing",
    });
  });
});

function workspace() {
  return {
    id: "goat_ws_1",
    name: "Ada's Workspace",
    workosOrganizationId: null,
    createdByWorkosId: "user_1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function workspaceMember(userWorkosId: string, role: "admin" | "member") {
  return {
    member: {
      id: `wsm_${userWorkosId}`,
      role,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    user: {
      workosUserId: userWorkosId,
      email: `${userWorkosId}@example.com`,
      firstName: null,
      lastName: null,
      avatarUrl: null,
      timezone: "UTC",
      localCodexBetaEnabled: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  };
}
