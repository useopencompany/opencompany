import { AuthenticationException } from "@workos-inc/node";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeAuthentication } from "@/lib/auth";
import { consumeOAuthStateCookie, setOrganizationSelection } from "@/lib/auth-methods";
import { getWorkOSClient } from "@/lib/workos-client";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  completeAuthentication: vi.fn(),
}));

vi.mock("@/lib/auth-methods", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-methods")>();
  return {
    ...actual,
    consumeOAuthStateCookie: vi.fn(),
    setOrganizationSelection: vi.fn(),
  };
});

vi.mock("@/lib/workos", () => ({
  getAppUrl: vi.fn(() => "https://my.opencompany.chat"),
}));

vi.mock("@/lib/workos-client", () => ({
  getWorkOSClient: vi.fn(),
}));

const completeAuthenticationMock = vi.mocked(completeAuthentication);
const consumeOAuthStateCookieMock = vi.mocked(consumeOAuthStateCookie);
const setOrganizationSelectionMock = vi.mocked(setOrganizationSelection);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);

function callbackRequest(search: string) {
  return new NextRequest(`https://my.opencompany.chat/auth/callback${search}`, {
    headers: { "user-agent": "vitest", "x-forwarded-for": "203.0.113.5" },
  });
}

describe("Goat Google OAuth callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exchanges the code, completes the session, and returns to the requested path", async () => {
    consumeOAuthStateCookieMock.mockResolvedValue({
      state: "state-123",
      invitationToken: "invite-token-123",
      returnPathname: "/brain",
    });
    const authenticateWithCode = vi.fn(async () => ({
      user: { id: "user_123", email: "ada@example.com" },
      organizationId: "org_invited",
      authenticationMethod: "GoogleOAuth",
    }));
    getWorkOSClientMock.mockReturnValue({
      userManagement: { authenticateWithCode },
    } as never);

    const response = await GET(callbackRequest("?code=auth-code&state=state-123"));

    expect(authenticateWithCode).toHaveBeenCalledWith({
      clientId: expect.any(String),
      code: "auth-code",
      invitationToken: "invite-token-123",
      ipAddress: "203.0.113.5",
      userAgent: "vitest",
    });
    expect(completeAuthenticationMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org_invited" }),
      expect.anything(),
    );
    expect(response.headers.get("location")).toBe("https://my.opencompany.chat/brain");
  });

  it("ignores a returnPathname that would redirect off our own origin", async () => {
    consumeOAuthStateCookieMock.mockResolvedValue({
      state: "state-123",
      returnPathname: "https://evil.example.com",
    });
    const authenticateWithCode = vi.fn(async () => ({
      user: { id: "user_123", email: "ada@example.com" },
      authenticationMethod: "GoogleOAuth",
    }));
    getWorkOSClientMock.mockReturnValue({
      userManagement: { authenticateWithCode },
    } as never);

    const response = await GET(callbackRequest("?code=auth-code&state=state-123"));

    expect(response.headers.get("location")).toBe("https://my.opencompany.chat/");
  });

  it("rejects a callback whose state does not match the stored cookie", async () => {
    consumeOAuthStateCookieMock.mockResolvedValue({ state: "expected-state" });

    const response = await GET(callbackRequest("?code=auth-code&state=wrong-state"));

    expect(getWorkOSClientMock).not.toHaveBeenCalled();
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/signin");
    expect(location.searchParams.get("error")).toBe("oauth_state");
  });

  it("redirects to sign-in with an error when the code exchange fails", async () => {
    consumeOAuthStateCookieMock.mockResolvedValue({ state: "state-123" });
    const authenticateWithCode = vi.fn(async () => {
      throw new Error("invalid_grant");
    });
    getWorkOSClientMock.mockReturnValue({
      userManagement: { authenticateWithCode },
    } as never);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(callbackRequest("?code=auth-code&state=state-123"));

    expect(completeAuthenticationMock).not.toHaveBeenCalled();
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("oauth_failed");
    expect(consoleError).toHaveBeenCalled();
  });

  it("continues with organization selection when WorkOS requires it", async () => {
    consumeOAuthStateCookieMock.mockResolvedValue({
      state: "state-123",
      returnPathname: "/brain",
    });
    const authenticateWithCode = vi.fn(async () => {
      throw new AuthenticationException(
        400,
        {
          code: "organization_selection_required",
          pending_authentication_token: "pending-token",
          organizations: [
            { id: "org_one", name: "One" },
            { id: "org_two", name: "Two" },
          ],
        },
        "request-123",
      );
    });
    getWorkOSClientMock.mockReturnValue({
      userManagement: { authenticateWithCode },
    } as never);

    const response = await GET(callbackRequest("?code=auth-code&state=state-123"));

    expect(setOrganizationSelectionMock).toHaveBeenCalledWith({
      pendingAuthenticationToken: "pending-token",
      organizations: [
        { id: "org_one", name: "One" },
        { id: "org_two", name: "Two" },
      ],
      returnPathname: "/brain",
    });
    expect(completeAuthenticationMock).not.toHaveBeenCalled();
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/signin");
    expect(location.search).toBe("");
  });

  it("does not allow a callback return path to redirect off-site", async () => {
    consumeOAuthStateCookieMock.mockResolvedValue({
      state: "state-123",
      returnPathname: "https://attacker.example/steal",
    });
    getWorkOSClientMock.mockReturnValue({
      userManagement: {
        authenticateWithCode: vi.fn(async () => ({
          user: { id: "user_123", email: "ada@example.com" },
          authenticationMethod: "GoogleOAuth",
        })),
      },
    } as never);

    const response = await GET(callbackRequest("?code=auth-code&state=state-123"));

    expect(response.headers.get("location")).toBe("https://my.opencompany.chat/");
  });
});
