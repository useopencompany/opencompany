import { describe, expect, it, vi } from "vitest";
import { adoptWorkOSOrganizationMemberships, syncGoatUser } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@workos-inc/authkit-nextjs", () => ({
  handleAuth: vi.fn((config) => config),
}));

vi.mock("@/lib/auth", () => ({
  adoptWorkOSOrganizationMemberships: vi.fn(),
  syncGoatUser: vi.fn(),
}));

vi.mock("@/lib/workos", () => ({
  getGoatAppUrl: vi.fn(() => "https://my.opencompany.chat"),
}));

const syncGoatUserMock = vi.mocked(syncGoatUser);
const adoptWorkOSOrganizationMembershipsMock = vi.mocked(adoptWorkOSOrganizationMemberships);

function authConfig() {
  const config = GET as unknown as {
    baseURL?: string;
    returnPathname?: string;
    onSuccess?: (input: { user: never }) => Promise<void>;
  };
  if (!config.onSuccess) throw new Error("Auth callback onSuccess was not registered.");
  return config;
}

describe("Goat auth callback", () => {
  it("pins AuthKit callback redirects to the Goat app origin", () => {
    expect(authConfig().baseURL).toBe("https://my.opencompany.chat");
    expect(authConfig().returnPathname).toBe("/");
  });

  it("syncs the user and accepted workspace memberships on every authentication", async () => {
    const user = {
      id: "user_123",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
    };

    await authConfig().onSuccess?.({ user: user as never });

    expect(syncGoatUserMock).toHaveBeenCalledWith(user);
    expect(adoptWorkOSOrganizationMembershipsMock).toHaveBeenCalledWith(user);
    expect(syncGoatUserMock.mock.invocationCallOrder[0]).toBeLessThan(
      adoptWorkOSOrganizationMembershipsMock.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });
});
