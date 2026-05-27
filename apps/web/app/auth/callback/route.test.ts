import { captureServerEvent } from "@opencompany/analytics/server";
import { captureException } from "@opencompany/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  provisionDefaultOrganization,
  refreshIntoWorkspaceOrganization,
  syncUserAndWorkspace,
} from "@/lib/auth";
import { dispatchSignupWelcomeEmailRequested } from "@/lib/email/events";
import { GET } from "./route";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
}));

vi.mock("@workos-inc/authkit-nextjs", () => ({
  handleAuth: vi.fn((config) => config),
}));

vi.mock("@/lib/auth", () => ({
  provisionDefaultOrganization: vi.fn(),
  refreshIntoWorkspaceOrganization: vi.fn(),
  syncUserAndWorkspace: vi.fn(),
}));

vi.mock("@/lib/email/events", () => ({
  dispatchSignupWelcomeEmailRequested: vi.fn(),
}));

const captureServerEventMock = vi.mocked(captureServerEvent);
const captureExceptionMock = vi.mocked(captureException);
const dispatchSignupWelcomeEmailRequestedMock = vi.mocked(dispatchSignupWelcomeEmailRequested);
const provisionDefaultOrganizationMock = vi.mocked(provisionDefaultOrganization);
const refreshIntoWorkspaceOrganizationMock = vi.mocked(refreshIntoWorkspaceOrganization);
const syncUserAndWorkspaceMock = vi.mocked(syncUserAndWorkspace);

const authUser = {
  id: "user_123",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
};

const context = {
  authUser,
  user: {
    id: "usr_123",
    workosUserId: "user_123",
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
  },
  workspace: {
    id: "wks_123",
    workosOrganizationId: "org_123",
  },
  role: "admin",
  isNewUser: true,
};

function authOnSuccess() {
  const config = GET as unknown as { onSuccess?: (input: unknown) => Promise<void> };
  if (!config?.onSuccess) throw new Error("Auth callback onSuccess was not registered.");
  return config.onSuccess;
}

describe("auth callback welcome email dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captureServerEventMock.mockResolvedValue(undefined);
    dispatchSignupWelcomeEmailRequestedMock.mockResolvedValue({ ids: ["evt_123"] } as never);
    refreshIntoWorkspaceOrganizationMock.mockResolvedValue(undefined);
    syncUserAndWorkspaceMock.mockResolvedValue(context as never);
    provisionDefaultOrganizationMock.mockResolvedValue(context as never);
  });

  it("dispatches the signup welcome email event for new users", async () => {
    await authOnSuccess()({ user: authUser, organizationId: "org_123" } as never);

    expect(captureServerEventMock).toHaveBeenCalledWith("signup_completed", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
    });
    expect(dispatchSignupWelcomeEmailRequestedMock).toHaveBeenCalledWith({
      userId: "usr_123",
      workspaceId: "wks_123",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("does not dispatch the welcome email for existing users", async () => {
    syncUserAndWorkspaceMock.mockResolvedValue({ ...context, isNewUser: false } as never);

    await authOnSuccess()({ user: authUser, organizationId: "org_123" } as never);

    expect(dispatchSignupWelcomeEmailRequestedMock).not.toHaveBeenCalled();
  });

  it("captures welcome dispatch failures without failing auth", async () => {
    const error = new Error("Inngest failed");
    dispatchSignupWelcomeEmailRequestedMock.mockRejectedValue(error);

    await expect(
      authOnSuccess()({ user: authUser, organizationId: "org_123" } as never),
    ).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      event: "opencompany.signup_welcome_email_dispatch_failed",
      user_id: "usr_123",
      workspace_id: "wks_123",
    });
  });
});
