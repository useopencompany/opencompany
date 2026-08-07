import { createWorkspaceForUser, newWorkspaceId } from "@opencompany/db/workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkOSClient } from "@/lib/workos-client";
import { provisionWorkspace, WorkspaceProvisioningError } from "./workspace-provisioning";

vi.mock("@opencompany/db/workspaces", () => ({
  createWorkspaceForUser: vi.fn(),
  newWorkspaceId: vi.fn(),
}));

vi.mock("@/lib/workos-client", () => ({
  getWorkOSClient: vi.fn(),
}));

const createWorkspaceForUserMock = vi.mocked(createWorkspaceForUser);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);
const newWorkspaceIdMock = vi.mocked(newWorkspaceId);

const createOrganization = vi.fn();
const createOrganizationMembership = vi.fn();
const deleteOrganization = vi.fn();

describe("provisionWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    newWorkspaceIdMock.mockReturnValue("goat_ws_new");
    createOrganization.mockResolvedValue({ id: "org_new", name: "Analytical Co" });
    createOrganizationMembership.mockResolvedValue({});
    deleteOrganization.mockResolvedValue(undefined);
    getWorkOSClientMock.mockReturnValue({
      organizations: { createOrganization, deleteOrganization },
      userManagement: { createOrganizationMembership },
    } as never);
    createWorkspaceForUserMock.mockResolvedValue({
      workspace: {
        id: "goat_ws_new",
        name: "Analytical Co",
        workosOrganizationId: "org_new",
      },
      brain: { id: "brain_general" },
    } as never);
  });

  it("provisions the WorkOS organization before the complete local workspace", async () => {
    await expect(
      provisionWorkspace({
        authUserId: "user_123",
        userWorkosId: "user_123",
        name: "Analytical Co",
        slug: "analytical-co",
      }),
    ).resolves.toMatchObject({
      workspace: {
        id: "goat_ws_new",
        workosOrganizationId: "org_new",
      },
      brain: { id: "brain_general" },
    });

    expect(createOrganization).toHaveBeenCalledWith(
      {
        name: "Analytical Co",
        externalId: "goat_ws_new",
        metadata: { goat_workspace_id: "goat_ws_new" },
      },
      { idempotencyKey: "goat_ws_new" },
    );
    expect(createOrganizationMembership).toHaveBeenCalledWith({
      organizationId: "org_new",
      userId: "user_123",
      roleSlug: "admin",
    });
    expect(createWorkspaceForUserMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_new",
      workosOrganizationId: "org_new",
      userWorkosId: "user_123",
      name: "Analytical Co",
      slug: "analytical-co",
    });
    expect(deleteOrganization).not.toHaveBeenCalled();
  });

  it("compensates the external organization when local persistence fails", async () => {
    const persistenceError = new Error("database unavailable");
    createWorkspaceForUserMock.mockRejectedValue(persistenceError);

    const result = provisionWorkspace({
      authUserId: "user_123",
      userWorkosId: "user_123",
      name: "Analytical Co",
    });

    await expect(result).rejects.toMatchObject({
      name: "WorkspaceProvisioningError",
      workspaceId: "goat_ws_new",
      workosOrganizationId: "org_new",
      localWorkspacePersisted: false,
      cause: persistenceError,
    } satisfies Partial<WorkspaceProvisioningError>);
    expect(deleteOrganization).toHaveBeenCalledWith("org_new");
  });

  it("keeps the original provisioning failure when cleanup also fails", async () => {
    const membershipError = new Error("membership unavailable");
    createOrganizationMembership.mockRejectedValue(membershipError);
    deleteOrganization.mockRejectedValue(new Error("cleanup unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      provisionWorkspace({
        authUserId: "user_123",
        userWorkosId: "user_123",
        name: "Analytical Co",
      }),
    ).rejects.toMatchObject({
      cause: membershipError,
      workosOrganizationId: "org_new",
      localWorkspacePersisted: false,
    });

    expect(consoleError).toHaveBeenCalledWith(
      "[goat] Failed to clean up workspace organization",
      expect.objectContaining({
        workspaceId: "goat_ws_new",
        workosOrganizationId: "org_new",
      }),
    );
  });
});
