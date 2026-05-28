import { getDb } from "@opencompany/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentWorkspace } from "@/lib/auth";
import { getWorkOSClient } from "@/lib/workos";
import { inviteWorkspaceMember, updateWorkspaceName } from "./actions";

vi.mock("@opencompany/db/client", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  AUTHENTICATION_REQUIRED_MESSAGE: "Your session expired. Sign in again to continue.",
  currentWorkspace: vi.fn(),
}));

vi.mock("@/lib/workos", () => ({
  getWorkOSClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const getDbMock = vi.mocked(getDb);
const currentWorkspaceMock = vi.mocked(currentWorkspace);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);

describe("updateWorkspaceName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const updateOrganization = vi.fn().mockResolvedValue({ id: "org_123" });
    getWorkOSClientMock.mockReturnValue({
      organizations: { updateOrganization },
    } as never);
    currentWorkspaceMock.mockResolvedValue({
      workspace: {
        id: "wks_123",
        workosOrganizationId: "org_123",
        name: "Old workspace",
      },
    } as never);

    const result = await updateWorkspaceName("  New workspace  ");

    expect(result).toEqual({ ok: true, name: "New workspace" });
    expect(updateOrganization).toHaveBeenCalledWith({
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

describe("inviteWorkspaceMember", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid email addresses without checking auth", async () => {
    const result = await inviteWorkspaceMember("not-an-email");

    expect(result).toEqual({
      ok: false,
      error: "Enter a valid email address.",
    });
    expect(currentWorkspaceMock).not.toHaveBeenCalled();
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
  });

  it("requires an admin workspace context", async () => {
    const error = new Error("Only workspace admins can perform this action.");
    currentWorkspaceMock.mockRejectedValue(error);

    await expect(inviteWorkspaceMember("member@example.com")).rejects.toThrow(
      "Only workspace admins can perform this action.",
    );

    expect(currentWorkspaceMock).toHaveBeenCalledWith({ requireAdmin: true });
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
  });

  it("blocks invitations when the workspace is not linked to WorkOS", async () => {
    currentWorkspaceMock.mockResolvedValue({
      authUser: { id: "user_123" },
      workspace: { id: "wks_123", workosOrganizationId: null },
    } as never);

    const result = await inviteWorkspaceMember("member@example.com");

    expect(result).toEqual({
      ok: false,
      error: "Workspace is not linked to an organization.",
    });
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
  });

  it("sends a member invitation through WorkOS", async () => {
    const sendInvitation = vi.fn().mockResolvedValue({ id: "inv_123" });
    getWorkOSClientMock.mockReturnValue({
      userManagement: { sendInvitation },
    } as never);
    currentWorkspaceMock.mockResolvedValue({
      authUser: { id: "user_123" },
      workspace: { id: "wks_123", workosOrganizationId: "org_123" },
    } as never);

    const result = await inviteWorkspaceMember("  Member@Example.com ");

    expect(result).toEqual({ ok: true, email: "member@example.com" });
    expect(currentWorkspaceMock).toHaveBeenCalledWith({ requireAdmin: true });
    expect(sendInvitation).toHaveBeenCalledWith({
      email: "member@example.com",
      organizationId: "org_123",
      roleSlug: "member",
      inviterUserId: "user_123",
    });
  });

  it("returns a friendly error when WorkOS rejects a duplicate invitation", async () => {
    const sendInvitation = vi.fn().mockRejectedValue(new Error("Resource already exists"));
    getWorkOSClientMock.mockReturnValue({
      userManagement: { sendInvitation },
    } as never);
    currentWorkspaceMock.mockResolvedValue({
      authUser: { id: "user_123" },
      workspace: { id: "wks_123", workosOrganizationId: "org_123" },
    } as never);

    const result = await inviteWorkspaceMember("member@example.com");

    expect(result).toEqual({
      ok: false,
      error: "That email has already been invited or belongs to a workspace member.",
    });
  });
});
