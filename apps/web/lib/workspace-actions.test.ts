import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serverApiErrorMessage } from "@/lib/server-api-client";
import { activateGoatWorkspace } from "@/lib/workspace-session";
import {
  createGoatWorkspaceAction,
  getGoatWorkspaceSettingsAction,
  inviteToGoatWorkspaceAction,
  removeGoatWorkspaceMemberAction,
  revokeGoatWorkspaceInvitationAction,
  switchGoatWorkspaceAction,
  updateGoatWorkspaceNameAction,
} from "./workspace-actions";

const mocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  getSettings: vi.fn(),
  invite: vi.fn(),
  removeMember: vi.fn(),
  rename: vi.fn(),
  revokeInvitation: vi.fn(),
  switchWorkspace: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000123"),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("next/navigation", () => ({
  unstable_rethrow(error: unknown) {
    if (error instanceof Error && "digest" in error) throw error;
  },
}));

vi.mock("@/lib/server-api-client", () => ({
  serverApiClient: vi.fn(async () => ({
    v1: {
      workspace: {
        $get: mocks.getSettings,
        $patch: mocks.rename,
        invitations: {
          $post: mocks.invite,
          ":invitationId": { $delete: mocks.revokeInvitation },
        },
        members: { ":userId": { $delete: mocks.removeMember } },
      },
      workspaces: {
        $post: mocks.createWorkspace,
        ":workspaceId": { switch: { $post: mocks.switchWorkspace } },
      },
    },
  })),
  serverApiErrorMessage: vi.fn(async (_response: Response, fallback: string) => fallback),
}));

vi.mock("@/lib/workspace-session", () => ({
  activateGoatWorkspace: vi.fn(),
  GOAT_ACTIVE_BRAIN_COOKIE: "goat-active-brain",
}));

const activateGoatWorkspaceMock = vi.mocked(activateGoatWorkspace);
const revalidatePathMock = vi.mocked(revalidatePath);
const serverApiErrorMessageMock = vi.mocked(serverApiErrorMessage);

const activation = {
  workspaceId: "goat_ws_new",
  organizationId: "org_new",
  brainId: "brain_general",
};

describe("createGoatWorkspaceAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createWorkspace.mockResolvedValue(Response.json({ data: activation }));
    activateGoatWorkspaceMock.mockResolvedValue(undefined);
  });

  it("validates the organization name before calling the API", async () => {
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
    expect(mocks.createWorkspace).not.toHaveBeenCalled();
  });

  it("creates through the canonical API before activating the WorkOS session", async () => {
    await expect(createGoatWorkspaceAction("  Analytical Co  ")).resolves.toEqual({
      ok: true,
      workspaceId: "goat_ws_new",
    });
    expect(mocks.createWorkspace).toHaveBeenCalledWith({
      json: {
        workspaceId: "goat_ws_00000000-0000-4000-8000-000000000123",
        name: "Analytical Co",
      },
    });
    expect(activateGoatWorkspaceMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_new",
      workosOrganizationId: "org_new",
      brainId: "brain_general",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });

  it("preserves API errors without activating a workspace", async () => {
    mocks.createWorkspace.mockResolvedValueOnce(Response.json({}, { status: 409 }));
    serverApiErrorMessageMock.mockResolvedValueOnce("Hobby includes one workspace.");
    await expect(createGoatWorkspaceAction("Another workspace")).resolves.toEqual({
      ok: false,
      error: "Hobby includes one workspace.",
    });
    expect(activateGoatWorkspaceMock).not.toHaveBeenCalled();
  });

  it("keeps a durable workspace when session activation fails", async () => {
    activateGoatWorkspaceMock.mockRejectedValue(new Error("session refresh unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createGoatWorkspaceAction("Analytical Co")).resolves.toEqual({
      ok: false,
      error:
        "The organization was created, but could not be activated. Please try switching to it.",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/", "layout");
    consoleError.mockRestore();
  });
});

describe("switchGoatWorkspaceAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.switchWorkspace.mockResolvedValue(Response.json({ data: activation }));
    activateGoatWorkspaceMock.mockResolvedValue(undefined);
  });

  it("resolves access in the API before activating the WorkOS session", async () => {
    await expect(switchGoatWorkspaceAction("goat_ws_new")).resolves.toEqual({ ok: true });
    expect(mocks.switchWorkspace).toHaveBeenCalledWith({
      param: { workspaceId: "goat_ws_new" },
    });
    expect(activateGoatWorkspaceMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_new",
      workosOrganizationId: "org_new",
      brainId: "brain_general",
    });
  });

  it("rejects an inaccessible workspace without touching the session", async () => {
    mocks.switchWorkspace.mockResolvedValueOnce(Response.json({}, { status: 404 }));
    await expect(switchGoatWorkspaceAction("goat_ws_other")).resolves.toEqual({
      ok: false,
      error: "You do not have access to that workspace.",
    });
    expect(activateGoatWorkspaceMock).not.toHaveBeenCalled();
  });

  it("returns a stable error for an ordinary AuthKit failure", async () => {
    activateGoatWorkspaceMock.mockRejectedValue(new Error("session refresh unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(switchGoatWorkspaceAction("goat_ws_new")).resolves.toEqual({
      ok: false,
      error: "Could not switch organizations. Please try again.",
    });
    expect(revalidatePathMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("preserves AuthKit redirects for organization-specific authentication", async () => {
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;https://authkit.example.test/authorize;307;",
    });
    activateGoatWorkspaceMock.mockRejectedValue(redirectError);
    await expect(switchGoatWorkspaceAction("goat_ws_new")).rejects.toBe(redirectError);
  });
});

describe("workspace settings actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue(
      Response.json({
        data: {
          workspace: { id: "goat_ws_current", name: "Current Organization" },
          role: "admin",
          plan: "pro",
          memberCap: 10,
          members: [
            {
              id: "user_123",
              email: "owner@example.com",
              name: "Owner",
              avatarUrl: null,
              role: "admin",
            },
          ],
          invitations: [],
        },
      }),
    );
    mocks.invite.mockResolvedValue(Response.json({ data: { completed: true } }));
    mocks.revokeInvitation.mockResolvedValue(Response.json({ data: { completed: true } }));
    mocks.removeMember.mockResolvedValue(Response.json({ data: { completed: true } }));
    mocks.rename.mockResolvedValue(
      Response.json({ data: { workspace: { id: "goat_ws_current", name: "Renamed" } } }),
    );
  });

  it("maps member DTO ids to the existing presentation model", async () => {
    await expect(getGoatWorkspaceSettingsAction()).resolves.toMatchObject({
      members: [{ userWorkosId: "user_123", email: "owner@example.com" }],
    });
  });

  it("forwards membership and rename commands to /v1", async () => {
    await expect(inviteToGoatWorkspaceAction(" TEAMMATE@EXAMPLE.COM ")).resolves.toEqual({
      ok: true,
    });
    expect(mocks.invite).toHaveBeenCalledWith({ json: { email: "teammate@example.com" } });

    await revokeGoatWorkspaceInvitationAction("inv_123");
    expect(mocks.revokeInvitation).toHaveBeenCalledWith({ param: { invitationId: "inv_123" } });

    await removeGoatWorkspaceMemberAction("user_456");
    expect(mocks.removeMember).toHaveBeenCalledWith({ param: { userId: "user_456" } });

    await updateGoatWorkspaceNameAction("  Renamed  ");
    expect(mocks.rename).toHaveBeenCalledWith({ json: { name: "Renamed" } });
  });
});
