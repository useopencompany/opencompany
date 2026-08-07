import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkOSClient } from "@/lib/workos-client";
import { GET } from "./route";

vi.mock("@/lib/workos", () => ({
  getAppUrl: vi.fn(() => "https://my.opencompany.chat"),
}));

vi.mock("@/lib/workos-client", () => ({
  getWorkOSClient: vi.fn(),
}));

const getWorkOSClientMock = vi.mocked(getWorkOSClient);

describe("Goat invitation auth route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a pending invitation to sign-up with the token and prefilled email", async () => {
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
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/signup");
    expect(location.searchParams.get("invitation_token")).toBe("invite-token-123");
    expect(location.searchParams.get("email")).toBe("ada@example.com");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("still forwards the token to sign-up when the invitation can't be resolved", async () => {
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

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/signup");
    expect(location.searchParams.get("invitation_token")).toBe("invalid-token");
    expect(location.searchParams.has("email")).toBe(false);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[goat] Could not resolve the workspace invitation before sign-up",
    );
  });

  it("falls back to ordinary sign-in when no invitation token is present", async () => {
    const response = await GET(new NextRequest("https://my.opencompany.chat/auth/invite"));

    expect(response.headers.get("location")).toBe("https://my.opencompany.chat/signin");
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
  });
});
