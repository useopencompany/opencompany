import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkOSClient } from "@/lib/workos-client";
import { GET } from "./route";

vi.mock("@workos-inc/authkit-nextjs", () => ({
  getSignInUrl: vi.fn(),
}));

vi.mock("@/lib/workos", () => ({
  getGoatWorkOSRedirectUri: vi.fn(() => "https://my.opencompany.chat/auth/callback"),
}));

vi.mock("@/lib/workos-client", () => ({
  getWorkOSClient: vi.fn(),
}));

const getSignInUrlMock = vi.mocked(getSignInUrl);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);

describe("Goat invitation auth route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSignInUrlMock.mockResolvedValue(
      "https://signin.opencompany.cloud/authorize?state=sealed-state",
    );
  });

  it("targets AuthKit at the organization carried by a pending invitation", async () => {
    const findInvitationByToken = vi.fn(async () => ({
      state: "pending",
      organizationId: "org_invited",
      email: "ada@example.com",
    }));
    getWorkOSClientMock.mockReturnValue({
      userManagement: { findInvitationByToken },
    } as never);

    const response = await GET(
      new NextRequest("https://my.opencompany.chat/auth/invite?invitation_token=invite-token-123"),
    );

    expect(findInvitationByToken).toHaveBeenCalledWith("invite-token-123");
    expect(getSignInUrlMock).toHaveBeenCalledWith({
      redirectUri: "https://my.opencompany.chat/auth/callback",
      organizationId: "org_invited",
      loginHint: "ada@example.com",
    });
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://signin.opencompany.cloud");
    expect(location.searchParams.get("state")).toBe("sealed-state");
    expect(location.searchParams.get("invitation_token")).toBe("invite-token-123");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("lets AuthKit handle an unresolvable invitation without trusting a workspace selector", async () => {
    const findInvitationByToken = vi.fn(async () => {
      throw new Error("Invitation not found");
    });
    getWorkOSClientMock.mockReturnValue({
      userManagement: { findInvitationByToken },
    } as never);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await GET(
      new NextRequest("https://my.opencompany.chat/auth/invite?invitation_token=invalid-token"),
    );

    expect(getSignInUrlMock).toHaveBeenCalledWith({
      redirectUri: "https://my.opencompany.chat/auth/callback",
    });
    expect(
      new URL(response.headers.get("location") ?? "").searchParams.get("invitation_token"),
    ).toBe("invalid-token");
    expect(consoleWarn).toHaveBeenCalledWith(
      "[goat] Could not resolve the workspace invitation before sign-in",
    );
  });

  it("falls back to ordinary sign-in when no invitation token is present", async () => {
    const response = await GET(new NextRequest("https://my.opencompany.chat/auth/invite"));

    expect(response.headers.get("location")).toBe("https://my.opencompany.chat/auth/sign-in");
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
    expect(getSignInUrlMock).not.toHaveBeenCalled();
  });
});
