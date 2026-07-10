import { describe, expect, it, vi } from "vitest";
import { syncGoatUser } from "@/lib/auth";
import { GET } from "./route";

vi.mock("@workos-inc/authkit-nextjs", () => ({
  handleAuth: vi.fn((config) => config),
}));

vi.mock("@/lib/auth", () => ({
  syncGoatUser: vi.fn(),
}));

vi.mock("@/lib/workos", () => ({
  getGoatAppUrl: vi.fn(() => "https://my.opencompany.chat"),
}));

const syncGoatUserMock = vi.mocked(syncGoatUser);

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

  it("syncs the Goat user on successful authentication", async () => {
    const user = {
      id: "user_123",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
    };

    await authConfig().onSuccess?.({ user: user as never });

    expect(syncGoatUserMock).toHaveBeenCalledWith(user);
  });
});
