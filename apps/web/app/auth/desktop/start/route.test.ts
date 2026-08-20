import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setOAuthStateCookie } from "@/lib/auth-methods";
import { getWorkOSClient } from "@/lib/workos-client";
import { GET } from "./route";

vi.mock("@/lib/auth-methods", () => ({
  setOAuthStateCookie: vi.fn(),
}));

vi.mock("@/lib/workos", () => ({
  getAppUrl: vi.fn(() => "https://my.opencompany.chat"),
  getWorkOSRedirectUri: vi.fn(() => "https://my.opencompany.chat/auth/callback"),
}));

vi.mock("@/lib/workos-client", () => ({
  getWorkOSClient: vi.fn(),
}));

const setOAuthStateCookieMock = vi.mocked(setOAuthStateCookie);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);
const CHALLENGE = "a".repeat(43);

describe("desktop Google auth start route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves the invitation token in the OAuth state cookie", async () => {
    const getAuthorizationUrl = vi.fn(() => "https://api.workos.test/authorize");
    getWorkOSClientMock.mockReturnValue({ userManagement: { getAuthorizationUrl } } as never);

    const response = await GET(
      new NextRequest(
        `https://my.opencompany.chat/auth/desktop/start?challenge=${CHALLENGE}&invitation_token=invite-token-123`,
      ),
    );

    expect(setOAuthStateCookieMock).toHaveBeenCalledWith({
      state: expect.any(String),
      desktopChallenge: CHALLENGE,
      invitationToken: "invite-token-123",
    });
    expect(getAuthorizationUrl).toHaveBeenCalledWith({
      clientId: expect.any(String),
      provider: "GoogleOAuth",
      redirectUri: "https://my.opencompany.chat/auth/callback",
      state: expect.any(String),
    });
    expect(response.headers.get("location")).toBe("https://api.workos.test/authorize");
  });

  it("rejects malformed desktop challenges before starting OAuth", async () => {
    const response = await GET(
      new NextRequest("https://my.opencompany.chat/auth/desktop/start?challenge=invalid"),
    );

    expect(setOAuthStateCookieMock).not.toHaveBeenCalled();
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/signin");
    expect(location.searchParams.get("error")).toBe("desktop_handoff");
  });
});
