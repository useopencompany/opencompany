import {
  createWorkspaceForUser,
  listAccessibleBrains,
  listWorkspacesForUser,
  newWorkspaceId,
} from "@opencompany/db/workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { provisionWorkspace, WorkspaceProvisioningError } from "./provisioning";
import type { WorkOSClientLike } from "./workos";

vi.mock("@opencompany/db/workspaces", () => ({
  createWorkspaceForUser: vi.fn(),
  DEFAULT_BRAIN_SLUG: "general",
  listAccessibleBrains: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  newWorkspaceId: vi.fn(),
}));

const createWorkspaceForUserMock = vi.mocked(createWorkspaceForUser);
const listAccessibleBrainsMock = vi.mocked(listAccessibleBrains);
const listWorkspacesForUserMock = vi.mocked(listWorkspacesForUser);
const newWorkspaceIdMock = vi.mocked(newWorkspaceId);

const createOrganization = vi.fn();
const createOrganizationMembership = vi.fn();
const deleteOrganization = vi.fn();
const listOrganizationMemberships = vi.fn();

const workos = {
  organizations: { createOrganization, deleteOrganization },
  userManagement: { createOrganizationMembership, listOrganizationMemberships },
} as unknown as WorkOSClientLike;
const db = {};

describe("provisionWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    newWorkspaceIdMock.mockReturnValue("goat_ws_new");
    createOrganization.mockResolvedValue({ id: "org_new", name: "Analytical Co" });
    createOrganizationMembership.mockResolvedValue({});
    deleteOrganization.mockResolvedValue(undefined);
    listOrganizationMemberships.mockResolvedValue({ data: [] });
    listWorkspacesForUserMock.mockResolvedValue([]);
    listAccessibleBrainsMock.mockResolvedValue([]);
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
      provisionWorkspace(
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
    expect(createWorkspaceForUserMock).toHaveBeenCalledWith(
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

  it("replays a completed workspace by its caller-provided id", async () => {
    listWorkspacesForUserMock.mockResolvedValue([
      {
        workspace: {
          id: "goat_ws_replay",
          name: "Analytical Co",
          workosOrganizationId: "org_existing",
        },
        role: "admin",
      },
    ] as never);
    listAccessibleBrainsMock.mockResolvedValue([{ id: "brain_general", slug: "general" }] as never);

    await expect(
      provisionWorkspace(
        {
          authUserId: "user_123",
          userWorkosId: "user_123",
          workspaceId: "goat_ws_replay",
          name: "Analytical Co",
        },
        { workos, db },
      ),
    ).resolves.toMatchObject({
      workspace: { id: "goat_ws_replay", workosOrganizationId: "org_existing" },
      brain: { id: "brain_general" },
    });
    expect(createOrganization).not.toHaveBeenCalled();
    expect(createWorkspaceForUserMock).not.toHaveBeenCalled();
  });

  it("does not duplicate an existing active WorkOS membership", async () => {
    listOrganizationMemberships.mockResolvedValueOnce({
      data: [{ id: "om_existing", status: "active", role: { slug: "admin" } }],
    });

    await provisionWorkspace(
      {
        authUserId: "user_123",
        userWorkosId: "user_123",
        name: "Analytical Co",
      },
      { workos, db },
    );

    expect(createOrganizationMembership).not.toHaveBeenCalled();
  });

  it("compensates the external organization when local persistence fails", async () => {
    const persistenceError = new Error("database unavailable");
    createWorkspaceForUserMock.mockRejectedValue(persistenceError);

    const result = provisionWorkspace(
      {
        authUserId: "user_123",
        userWorkosId: "user_123",
        name: "Analytical Co",
      },
      { workos, db },
    );

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
      provisionWorkspace(
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
      "[opencompany] Failed to clean up workspace organization",
      expect.objectContaining({
        workspaceId: "goat_ws_new",
        workosOrganizationId: "org_new",
      }),
    );
  });
});
