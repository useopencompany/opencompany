import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeGoatAuthentication } from "@/lib/auth";
import {
  requestMagicCode,
  restartAuthentication,
  selectOrganization,
  startGoogleAuth,
  verifyMagicCode,
} from "@/lib/auth-actions";
import {
  clearGoatOrganizationSelection,
  organizationSelectionFromError,
  readPendingGoatOrganizationSelection,
  setGoatOAuthStateCookie,
  setGoatOrganizationSelection,
} from "@/lib/auth-methods";
import { getGoatAppUrl, getGoatWorkOSRedirectUri } from "@/lib/workos";
import { getWorkOSClient } from "@/lib/workos-client";

vi.mock("@/lib/auth", () => ({
  completeGoatAuthentication: vi.fn(),
}));

vi.mock("@/lib/auth-methods", () => ({
  clearGoatOrganizationSelection: vi.fn(),
  organizationSelectionFromError: vi.fn(() => null),
  readPendingGoatOrganizationSelection: vi.fn(),
  safeGoatReturnPathname: vi.fn((value) =>
    typeof value === "string" && value.startsWith("/") ? value : "/",
  ),
  setGoatOAuthStateCookie: vi.fn(),
  setGoatOrganizationSelection: vi.fn(),
}));

vi.mock("@/lib/workos", () => ({
  getGoatAppUrl: vi.fn(() => "https://my.opencompany.chat"),
  getGoatWorkOSRedirectUri: vi.fn(() => "https://my.opencompany.chat/auth/callback"),
}));

vi.mock("@/lib/workos-client", () => ({
  getWorkOSClient: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

const completeGoatAuthenticationMock = vi.mocked(completeGoatAuthentication);
const clearGoatOrganizationSelectionMock = vi.mocked(clearGoatOrganizationSelection);
const organizationSelectionFromErrorMock = vi.mocked(organizationSelectionFromError);
const readPendingGoatOrganizationSelectionMock = vi.mocked(readPendingGoatOrganizationSelection);
const setGoatOAuthStateCookieMock = vi.mocked(setGoatOAuthStateCookie);
const setGoatOrganizationSelectionMock = vi.mocked(setGoatOrganizationSelection);
const getGoatAppUrlMock = vi.mocked(getGoatAppUrl);
const getGoatWorkOSRedirectUriMock = vi.mocked(getGoatWorkOSRedirectUri);
const getWorkOSClientMock = vi.mocked(getWorkOSClient);
const headersMock = vi.mocked(headers);
const redirectMock = vi.mocked(redirect);

function stubHeaders(values: Record<string, string>) {
  headersMock.mockResolvedValue({
    get: (name: string) => values[name] ?? null,
  } as never);
}

describe("startGoogleAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    organizationSelectionFromErrorMock.mockReturnValue(null);
    getGoatWorkOSRedirectUriMock.mockReturnValue("https://my.opencompany.chat/auth/callback");
  });

  it("stores a CSRF state cookie and redirects to WorkOS's GoogleOAuth authorization URL", async () => {
    const getAuthorizationUrl = vi.fn(
      () => "https://api.workos.com/authorize?provider=GoogleOAuth",
    );
    getWorkOSClientMock.mockReturnValue({
      userManagement: { getAuthorizationUrl },
    } as never);
    const formData = new FormData();
    formData.set("invitationToken", "invite-token-123");

    await startGoogleAuth(formData);

    expect(setGoatOAuthStateCookieMock).toHaveBeenCalledTimes(1);
    const [storedPayload] = setGoatOAuthStateCookieMock.mock.calls[0] ?? [];
    expect(storedPayload).toBeDefined();
    expect(storedPayload?.invitationToken).toBe("invite-token-123");
    expect(storedPayload?.returnPathname).toBe("/");
    expect(typeof storedPayload?.state).toBe("string");

    expect(getAuthorizationUrl).toHaveBeenCalledWith({
      clientId: expect.any(String),
      provider: "GoogleOAuth",
      redirectUri: "https://my.opencompany.chat/auth/callback",
      state: storedPayload?.state,
    });
    expect(redirectMock).toHaveBeenCalledWith(
      "https://api.workos.com/authorize?provider=GoogleOAuth",
    );
  });

  it("normalizes an off-origin returnPathname before storing it", async () => {
    getWorkOSClientMock.mockReturnValue({
      userManagement: { getAuthorizationUrl: vi.fn(() => "https://api.workos.com/authorize") },
    } as never);
    const formData = new FormData();
    formData.set("returnPathname", "https://evil.example.com");

    await startGoogleAuth(formData);

    const [storedPayload] = setGoatOAuthStateCookieMock.mock.calls[0] ?? [];
    expect(storedPayload?.returnPathname).toBe("/");
  });
});

describe("requestMagicCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    organizationSelectionFromErrorMock.mockReturnValue(null);
  });

  it("sends a magic code for a normalized email", async () => {
    const createMagicAuth = vi.fn(async () => ({}));
    getWorkOSClientMock.mockReturnValue({
      userManagement: { createMagicAuth },
    } as never);

    const result = await requestMagicCode({ email: " Ada@Example.com " });

    expect(createMagicAuth).toHaveBeenCalledWith({
      email: "ada@example.com",
      invitationToken: undefined,
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns a friendly error without throwing when WorkOS rejects the request", async () => {
    const createMagicAuth = vi.fn(async () => {
      throw new Error("rate limited");
    });
    getWorkOSClientMock.mockReturnValue({
      userManagement: { createMagicAuth },
    } as never);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requestMagicCode({ email: "ada@example.com" });

    expect(result.ok).toBe(false);
    expect(consoleError).toHaveBeenCalled();
  });

  it("rejects an empty email before calling WorkOS", async () => {
    const result = await requestMagicCode({ email: "   " });

    expect(result).toEqual({ ok: false, error: "Enter your email address." });
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
  });
});

describe("verifyMagicCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    organizationSelectionFromErrorMock.mockReturnValue(null);
    getGoatAppUrlMock.mockReturnValue("https://my.opencompany.chat");
    stubHeaders({ "x-forwarded-for": "203.0.113.5, 10.0.0.1", "user-agent": "vitest" });
  });

  it("completes the session and redirects home on a valid code", async () => {
    const authResponse = {
      user: { id: "user_123" },
      authenticationMethod: "MagicAuth",
    };
    const authenticateWithMagicAuth = vi.fn(async () => authResponse);
    getWorkOSClientMock.mockReturnValue({
      userManagement: { authenticateWithMagicAuth },
    } as never);

    await verifyMagicCode({
      email: "Ada@Example.com",
      code: " 123456 ",
      invitationToken: "invite-1",
    });

    expect(authenticateWithMagicAuth).toHaveBeenCalledWith({
      clientId: expect.any(String),
      email: "ada@example.com",
      code: "123456",
      invitationToken: "invite-1",
      ipAddress: "203.0.113.5",
      userAgent: "vitest",
    });
    expect(completeGoatAuthenticationMock).toHaveBeenCalledWith(
      authResponse,
      "https://my.opencompany.chat",
    );
    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("returns a friendly error without redirecting when the code is invalid", async () => {
    const authenticateWithMagicAuth = vi.fn(async () => {
      throw new Error("code_not_found");
    });
    getWorkOSClientMock.mockReturnValue({
      userManagement: { authenticateWithMagicAuth },
    } as never);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await verifyMagicCode({ email: "ada@example.com", code: "000000" });

    expect(result.ok).toBe(false);
    expect(completeGoatAuthenticationMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it("continues with organization selection when WorkOS requires it", async () => {
    const error = new Error("organization selection required");
    const selection = {
      pendingAuthenticationToken: "pending-token",
      organizations: [
        { id: "org_one", name: "One" },
        { id: "org_two", name: "Two" },
      ],
    };
    organizationSelectionFromErrorMock.mockReturnValue(selection);
    const authenticateWithMagicAuth = vi.fn(async () => {
      throw error;
    });
    getWorkOSClientMock.mockReturnValue({
      userManagement: { authenticateWithMagicAuth },
    } as never);

    const result = await verifyMagicCode({ email: "ada@example.com", code: "123456" });

    expect(organizationSelectionFromErrorMock).toHaveBeenCalledWith(error);
    expect(setGoatOrganizationSelectionMock).toHaveBeenCalledWith(selection);
    expect(redirectMock).toHaveBeenCalledWith("/signin");
    expect(completeGoatAuthenticationMock).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("rejects an empty code before calling WorkOS", async () => {
    const result = await verifyMagicCode({ email: "ada@example.com", code: "  " });

    expect(result).toEqual({ ok: false, error: "Enter the code from your email." });
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
  });
});

describe("selectOrganization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    organizationSelectionFromErrorMock.mockReturnValue(null);
    getGoatAppUrlMock.mockReturnValue("https://my.opencompany.chat");
    stubHeaders({ "x-forwarded-for": "203.0.113.5", "user-agent": "vitest" });
  });

  it("exchanges the pending challenge and completes the session", async () => {
    readPendingGoatOrganizationSelectionMock.mockResolvedValue({
      pendingAuthenticationToken: "pending-token",
      organizations: [
        { id: "org_one", name: "One" },
        { id: "org_two", name: "Two" },
      ],
      returnPathname: "/brain",
    });
    const authResponse = {
      user: { id: "user_123" },
      organizationId: "org_two",
      authenticationMethod: "MagicAuth",
    };
    const authenticateWithOrganizationSelection = vi.fn(async () => authResponse);
    getWorkOSClientMock.mockReturnValue({
      userManagement: { authenticateWithOrganizationSelection },
    } as never);

    await selectOrganization({ organizationId: "org_two" });

    expect(authenticateWithOrganizationSelection).toHaveBeenCalledWith({
      clientId: expect.any(String),
      organizationId: "org_two",
      pendingAuthenticationToken: "pending-token",
      ipAddress: "203.0.113.5",
      userAgent: "vitest",
    });
    expect(clearGoatOrganizationSelectionMock).toHaveBeenCalledOnce();
    expect(completeGoatAuthenticationMock).toHaveBeenCalledWith(
      authResponse,
      "https://my.opencompany.chat",
    );
    expect(redirectMock).toHaveBeenCalledWith("/brain");
  });

  it("rejects an organization that was not in the WorkOS challenge", async () => {
    readPendingGoatOrganizationSelectionMock.mockResolvedValue({
      pendingAuthenticationToken: "pending-token",
      organizations: [{ id: "org_one", name: "One" }],
      returnPathname: "/",
    });

    const result = await selectOrganization({ organizationId: "org_other" });

    expect(result).toEqual({ ok: false, error: "Choose one of the available workspaces." });
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
  });

  it("returns an expired-session error when no pending challenge exists", async () => {
    readPendingGoatOrganizationSelectionMock.mockResolvedValue(null);

    const result = await selectOrganization({ organizationId: "org_one" });

    expect(result).toEqual({ ok: false, error: "Your sign-in session expired. Start again." });
    expect(getWorkOSClientMock).not.toHaveBeenCalled();
  });
});

describe("restartAuthentication", () => {
  it("clears the pending challenge before returning to sign-in", async () => {
    vi.clearAllMocks();

    await restartAuthentication();

    expect(clearGoatOrganizationSelectionMock).toHaveBeenCalledOnce();
    expect(redirectMock).toHaveBeenCalledWith("/signin");
  });
});
