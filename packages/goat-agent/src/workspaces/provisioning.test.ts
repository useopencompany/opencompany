import { createGoatWorkspaceForUser, newGoatWorkspaceId } from "@opencompany/db/goat-workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoatWorkspaceProvisioningError, provisionGoatWorkspace } from "./provisioning";
import type { WorkOSClientLike } from "./workos";

vi.mock("@opencompany/db/goat-workspaces", () => ({
  createGoatWorkspaceForUser: vi.fn(),
  newGoatWorkspaceId: vi.fn(),
}));

const createGoatWorkspaceForUserMock = vi.mocked(createGoatWorkspaceForUser);
const newGoatWorkspaceIdMock = vi.mocked(newGoatWorkspaceId);

const createOrganization = vi.fn();
const createOrganizationMembership = vi.fn();
const deleteOrganization = vi.fn();

const workos = {
  organizations: { createOrganization, deleteOrganization },
  userManagement: { createOrganizationMembership },
} as unknown as WorkOSClientLike;
const db = {};

describe("provisionGoatWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    newGoatWorkspaceIdMock.mockReturnValue("goat_ws_new");
    createOrganization.mockResolvedValue({ id: "org_new", name: "Analytical Co" });
    createOrganizationMembership.mockResolvedValue({});
    deleteOrganization.mockResolvedValue(undefined);
    createGoatWorkspaceForUserMock.mockResolvedValue({
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
      provisionGoatWorkspace(
        {
          authUserId: "user_123",
          userWorkosId: "user_123",
          name: "Analytical Co",
          slug: "analytical-co",
        },
        { workos, db },
      ),
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
    expect(createGoatWorkspaceForUserMock).toHaveBeenCalledWith(
      {
        workspaceId: "goat_ws_new",
        workosOrganizationId: "org_new",
        userWorkosId: "user_123",
        name: "Analytical Co",
        slug: "analytical-co",
      },
      { db },
    );
    expect(deleteOrganization).not.toHaveBeenCalled();
  });

  it("compensates the external organization when local persistence fails", async () => {
    const persistenceError = new Error("database unavailable");
    createGoatWorkspaceForUserMock.mockRejectedValue(persistenceError);

    const result = provisionGoatWorkspace(
      {
        authUserId: "user_123",
        userWorkosId: "user_123",
        name: "Analytical Co",
      },
      { workos, db },
    );

    await expect(result).rejects.toMatchObject({
      name: "GoatWorkspaceProvisioningError",
      workspaceId: "goat_ws_new",
      workosOrganizationId: "org_new",
      localWorkspacePersisted: false,
      cause: persistenceError,
    } satisfies Partial<GoatWorkspaceProvisioningError>);
    expect(deleteOrganization).toHaveBeenCalledWith("org_new");
  });

  it("keeps the original provisioning failure when cleanup also fails", async () => {
    const membershipError = new Error("membership unavailable");
    createOrganizationMembership.mockRejectedValue(membershipError);
    deleteOrganization.mockRejectedValue(new Error("cleanup unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      provisionGoatWorkspace(
        {
          authUserId: "user_123",
          userWorkosId: "user_123",
          name: "Analytical Co",
        },
        { workos, db },
      ),
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
