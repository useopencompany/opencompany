import { getDb } from "@opencompany/db/client";
import { captureException } from "@opencompany/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentWorkspace, refreshIntoWorkspaceOrganization } from "@/lib/auth";
import { getWorkOSClient } from "@/lib/workos";
import { createWorkspace, switchWorkspace, updateWorkspaceName } from "./actions";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  AUTHENTICATION_REQUIRED_MESSAGE: "Your session expired. Sign in again to continue.",
  currentWorkspace: vi.fn(),
  refreshIntoWorkspaceOrganization: vi.fn(),
}));

vi.mock("@/lib/workos", () => ({
  getWorkOSClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);
const currentWorkspaceMock = vi.mocked(currentWorkspace);
const refreshIntoWorkspaceOrganizationMock = vi.mocked(refreshIntoWorkspaceOrganization);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);
const captureExceptionMock = vi.mocked(captureException);

describe("updateWorkspaceName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWorkOSClientMock.mockReturnValue({
      organizations: {
        createOrganization: vi.fn().mockResolvedValue({ id: "org_new", name: "New Company" }),
        deleteOrganization: vi.fn().mockResolvedValue(undefined),
        updateOrganization: vi.fn().mockResolvedValue({ id: "org_123" }),
      },
      userManagement: {
        createOrganizationMembership: vi.fn().mockResolvedValue({ id: "om_123" }),
      },
    } as never);
  });

  it("rejects empty names without touching the database", async () => {
    const result = await updateWorkspaceName("   ");

    expect(result).toEqual({ ok: false, error: "Name cannot be empty." });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("updates only the current workspace", async () => {
    const where = vi.fn();
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));

    getDbMock.mockReturnValue({ update } as never);
    currentWorkspaceMock.mockResolvedValue({
      workspace: {
        id: "wks_123",
        workosOrganizationId: "org_123",
        name: "Old workspace",
      },
    } as never);

    const result = await updateWorkspaceName("  New workspace  ");

    expect(result).toEqual({ ok: true, name: "New workspace" });
    expect(getWorkOSClientMock().organizations.updateOrganization).toHaveBeenCalledWith({
      organization: "org_123",
      name: "New workspace",
    });
    expect(update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({
      name: "New workspace",
      updatedAt: expect.any(Date),
    });
    expect(where).toHaveBeenCalledOnce();
  });

  it("returns an auth error without updating WorkOS when the session is missing", async () => {
    currentWorkspaceMock.mockResolvedValue(null);

    const result = await updateWorkspaceName("New workspace");

    expect(result).toEqual({
      ok: false,
      error: "Your session expired. Sign in again to continue.",
    });
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
    expect(getDbMock).not.toHaveBeenCalled();
  });
});

describe("createWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWorkOSClientMock.mockReturnValue({
      organizations: {
        createOrganization: vi.fn().mockResolvedValue({ id: "org_new", name: "New Company" }),
        deleteOrganization: vi.fn().mockResolvedValue(undefined),
        updateOrganization: vi.fn(),
      },
      userManagement: {
        createOrganizationMembership: vi.fn().mockResolvedValue({ id: "om_123" }),
      },
    } as never);
    currentWorkspaceMock.mockResolvedValue({
      authUser: { id: "user_123" },
      user: { id: "usr_123" },
      workspace: {
        id: "wks_current",
        workosOrganizationId: "org_current",
        name: "Current",
      },
    } as never);
  });

  it("rejects empty names without touching WorkOS or the database", async () => {
    const result = await createWorkspace("   ");

    expect(result).toEqual({ ok: false, error: "Name cannot be empty." });
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("rejects overlong names without touching WorkOS or the database", async () => {
    const result = await createWorkspace("x".repeat(81));

    expect(result).toEqual({ ok: false, error: "Name is too long (max 80 chars)." });
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("returns an auth error without creating anything when the session is missing", async () => {
    currentWorkspaceMock.mockResolvedValue(null);

    const result = await createWorkspace("New Company");

    expect(result).toEqual({
      ok: false,
      error: "Your session expired. Sign in again to continue.",
    });
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("creates a WorkOS organization, local workspace, admin membership, and refreshes into it", async () => {
    const createdWorkspace = {
      id: "wks_new",
      workosOrganizationId: "org_new",
      name: "New Company",
      createdByUserId: "usr_123",
    };
    const workspaceInsertQuery = { query: "workspace-insert" };
    const membershipInsertQuery = { query: "membership-insert" };
    const userUpdateQuery = { query: "user-update" };
    const batch = vi.fn().mockResolvedValue([[createdWorkspace], undefined, undefined]);
    const returning = vi.fn(() => workspaceInsertQuery);
    const workspaceValues = vi.fn(() => ({ returning }));
    const membershipValues = vi.fn(() => membershipInsertQuery);
    const insert = vi
      .fn()
      .mockReturnValueOnce({ values: workspaceValues })
      .mockReturnValueOnce({ values: membershipValues });
    const where = vi.fn(() => userUpdateQuery);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    getDbMock.mockReturnValue({ insert, update, batch } as never);

    const result = await createWorkspace("  New Company  ");

    expect(result).toEqual({ ok: true, workspaceId: "wks_new" });
    expect(getWorkOSClientMock().organizations.createOrganization).toHaveBeenCalledWith(
      { name: "New Company" },
      { idempotencyKey: expect.stringMatching(/^wks_/) },
    );
    expect(getWorkOSClientMock().userManagement.createOrganizationMembership).toHaveBeenCalledWith({
      organizationId: "org_new",
      userId: "user_123",
      roleSlug: "admin",
    });
    expect(workspaceValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workosOrganizationId: "org_new",
        name: "New Company",
        createdByUserId: "usr_123",
        id: expect.stringMatching(/^wks_/),
      }),
    );
    expect(membershipValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: expect.stringMatching(/^wks_/),
        userId: "usr_123",
        role: "admin",
      }),
    );
    expect(set).toHaveBeenCalledWith({
      companySurfaceEnabled: true,
      updatedAt: expect.any(Date),
    });
    expect(batch).toHaveBeenCalledWith([
      workspaceInsertQuery,
      membershipInsertQuery,
      userUpdateQuery,
    ]);
    expect(refreshIntoWorkspaceOrganizationMock).toHaveBeenCalledWith(createdWorkspace);
  });

  it("cleans up the WorkOS organization and returns stable copy when local persistence fails", async () => {
    const persistenceError = new Error("workspace_memberships_workspace_user_idx violation");
    const workspaceInsertQuery = { query: "workspace-insert" };
    const membershipInsertQuery = { query: "membership-insert" };
    const userUpdateQuery = { query: "user-update" };
    const batch = vi.fn().mockRejectedValue(persistenceError);
    const returning = vi.fn(() => workspaceInsertQuery);
    const workspaceValues = vi.fn(() => ({ returning }));
    const membershipValues = vi.fn(() => membershipInsertQuery);
    const insert = vi
      .fn()
      .mockReturnValueOnce({ values: workspaceValues })
      .mockReturnValueOnce({ values: membershipValues });
    const where = vi.fn(() => userUpdateQuery);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    getDbMock.mockReturnValue({ insert, update, batch } as never);

    const result = await createWorkspace("New Company");

    expect(result).toEqual({
      ok: false,
      error: "Could not create workspace. Please try again.",
    });
    expect(getWorkOSClientMock().organizations.deleteOrganization).toHaveBeenCalledWith("org_new");
    expect(captureExceptionMock).toHaveBeenCalledWith(
      persistenceError,
      expect.objectContaining({
        event: "opencompany.workspace_create_failed",
        user_id: "usr_123",
        workos_organization_id: "org_new",
        local_workspace_persisted: false,
      }),
    );
    expect(refreshIntoWorkspaceOrganizationMock).not.toHaveBeenCalled();
  });

  it("captures cleanup failures without exposing internal errors to the browser", async () => {
    const persistenceError = new Error("database connection failed");
    const cleanupError = new Error("workos cleanup failed");
    vi.mocked(getWorkOSClientMock().organizations.deleteOrganization).mockRejectedValue(
      cleanupError,
    );
    const batch = vi.fn().mockRejectedValue(persistenceError);
    const returning = vi.fn(() => ({ query: "workspace-insert" }));
    const workspaceValues = vi.fn(() => ({ returning }));
    const membershipValues = vi.fn(() => ({ query: "membership-insert" }));
    const insert = vi
      .fn()
      .mockReturnValueOnce({ values: workspaceValues })
      .mockReturnValueOnce({ values: membershipValues });
    const where = vi.fn(() => ({ query: "user-update" }));
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    getDbMock.mockReturnValue({ insert, update, batch } as never);

    const result = await createWorkspace("New Company");

    expect(result).toEqual({
      ok: false,
      error: "Could not create workspace. Please try again.",
    });
    expect(captureExceptionMock).toHaveBeenCalledWith(
      cleanupError,
      expect.objectContaining({
        event: "opencompany.workspace_create_workos_cleanup_failed",
        workos_organization_id: "org_new",
      }),
    );
  });
});

describe("switchWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentWorkspaceMock.mockResolvedValue({
      user: { id: "usr_123" },
      workspace: {
        id: "wks_current",
        workosOrganizationId: "org_current",
        name: "Current",
      },
    } as never);
  });

  function mockWorkspaceLookup(rows: unknown[]) {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    const select = vi.fn(() => ({ from }));
    getDbMock.mockReturnValue({ select } as never);
  }

  it("switches only to a workspace the current user belongs to", async () => {
    const workspace = {
      id: "wks_next",
      workosOrganizationId: "org_next",
      name: "Next",
    };
    mockWorkspaceLookup([{ workspace }]);

    const result = await switchWorkspace("wks_next");

    expect(result).toEqual({ ok: true, workspaceId: "wks_next" });
    expect(refreshIntoWorkspaceOrganizationMock).toHaveBeenCalledWith(workspace);
  });

  it("rejects switching to a workspace without membership", async () => {
    mockWorkspaceLookup([]);

    const result = await switchWorkspace("wks_other");

    expect(result).toEqual({
      ok: false,
      error: "You do not have access to that workspace.",
    });
    expect(refreshIntoWorkspaceOrganizationMock).not.toHaveBeenCalled();
  });

  it("rejects switching to a workspace without a WorkOS organization", async () => {
    mockWorkspaceLookup([
      {
        workspace: {
          id: "wks_legacy",
          workosOrganizationId: null,
          name: "Legacy",
        },
      },
    ]);

    const result = await switchWorkspace("wks_legacy");

    expect(result).toEqual({
      ok: false,
      error: "Workspace is not linked to an organization.",
    });
    expect(refreshIntoWorkspaceOrganizationMock).not.toHaveBeenCalled();
  });
});
