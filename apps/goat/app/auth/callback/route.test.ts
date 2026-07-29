import { describe, expect, it, vi } from "vitest";
import {
  activateGoatWorkspaceForOrganization,
  adoptWorkOSOrganizationMemberships,
  syncGoatUser,
} from "@/lib/auth";
import { GET } from "./route";

vi.mock("@workos-inc/authkit-nextjs", () => ({
  handleAuth: vi.fn((config) => config),
}));

vi.mock("@/lib/auth", () => ({
  activateGoatWorkspaceForOrganization: vi.fn(),
  adoptWorkOSOrganizationMemberships: vi.fn(),
  syncGoatUser: vi.fn(),
}));

vi.mock("@/lib/workos", () => ({
  getGoatAppUrl: vi.fn(() => "https://my.opencompany.chat"),
}));

const syncGoatUserMock = vi.mocked(syncGoatUser);
const adoptWorkOSOrganizationMembershipsMock = vi.mocked(adoptWorkOSOrganizationMemberships);
const activateGoatWorkspaceForOrganizationMock = vi.mocked(activateGoatWorkspaceForOrganization);

function authConfig() {
  const config = GET as unknown as {
    baseURL?: string;
    returnPathname?: string;
    onSuccess?: (input: { user: never; organizationId?: string }) => Promise<void>;
  };
  if (!config.onSuccess) throw new Error("Auth callback onSuccess was not registered.");
  return config;
}

describe("Goat auth callback", () => {
  it("pins AuthKit callback redirects to the Goat app origin", () => {
    expect(authConfig().baseURL).toBe("https://my.opencompany.chat");
    expect(authConfig().returnPathname).toBe("/");
  });

  it("syncs memberships and activates the workspace selected by AuthKit", async () => {
    const user = {
      id: "user_123",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
    };

    await authConfig().onSuccess?.({
      user: user as never,
      organizationId: "org_invited",
    });

    expect(syncGoatUserMock).toHaveBeenCalledWith(user);
    expect(adoptWorkOSOrganizationMembershipsMock).toHaveBeenCalledWith(user);
    expect(activateGoatWorkspaceForOrganizationMock).toHaveBeenCalledWith({
      userWorkosId: user.id,
      organizationId: "org_invited",
    });
    expect(syncGoatUserMock.mock.invocationCallOrder[0]).toBeLessThan(
      adoptWorkOSOrganizationMembershipsMock.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(adoptWorkOSOrganizationMembershipsMock.mock.invocationCallOrder[0]).toBeLessThan(
      activateGoatWorkspaceForOrganizationMock.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it("does not block authentication when local workspace activation fails", async () => {
    const error = new Error("Database unavailable");
    activateGoatWorkspaceForOrganizationMock.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      authConfig().onSuccess?.({
        user: { id: "user_123" } as never,
        organizationId: "org_invited",
      }),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "[goat] Failed to activate the authenticated workspace",
      error,
    );
  });
});
