import type { SQL } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkOsApiAuthenticator, createWorkOsApiIdentityVerifier } from "./auth";

describe("API authentication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["", "   "])(
    "uses the default WorkOS session cookie when WORKOS_COOKIE_NAME is %j",
    async (cookieName) => {
      vi.stubEnv("WORKOS_COOKIE_NAME", cookieName);
      const loadSealedSession = vi.fn(async () => ({
        authenticate: async () => ({
          authenticated: true,
          user: { id: "user_1" },
          organizationId: "org_1",
          sessionId: "session_1",
        }),
      }));
      const identify = createWorkOsApiIdentityVerifier({
        cookiePassword: "a-secure-cookie-password-with-32-chars",
        workos: { userManagement: { loadSealedSession } } as never,
      });

      await expect(
        identify(
          new Request("https://api.example.test/v1/identity", {
            headers: { Cookie: "wos-session=sealed-session" },
          }),
        ),
      ).resolves.toMatchObject({
        userId: "user_1",
        organizationId: "org_1",
        method: "session",
      });
      expect(loadSealedSession).toHaveBeenCalledWith({
        sessionData: "sealed-session",
        cookiePassword: "a-secure-cookie-password-with-32-chars",
      });
    },
  );

  it("accepts the encoded browser session and preferences used by identity sync", async () => {
    const loadSealedSession = vi.fn(async () => ({
      authenticate: async () => ({
        authenticated: true,
        user: { id: "user_1" },
        organizationId: "org_1",
        sessionId: "session_1",
      }),
    }));
    const identify = createWorkOsApiIdentityVerifier({
      cookiePassword: "a-secure-cookie-password-with-32-chars",
      workos: { userManagement: { loadSealedSession } } as never,
    });

    await expect(
      identify(
        new Request("https://api.example.test/v1/identity/sync", {
          method: "POST",
          headers: {
            Cookie:
              "wos-session=fresh%2Fsession%3D%3D; goat-active-workspace=workspace_1; goat-active-brain=brain_1",
            Origin: "https://my.opencompany.chat",
          },
        }),
      ),
    ).resolves.toMatchObject({
      userId: "user_1",
      organizationId: "org_1",
      activeWorkspaceId: "workspace_1",
      activeBrainId: "brain_1",
      method: "session",
    });
    expect(loadSealedSession).toHaveBeenCalledWith({
      sessionData: "fresh/session==",
      cookiePassword: "a-secure-cookie-password-with-32-chars",
    });
  });

  it("accepts a verified pre-organization bearer identity for onboarding and identity sync", async () => {
    const identify = createWorkOsApiIdentityVerifier({
      audience: "api_resource",
      authKitDomain: "https://example.authkit.app",
      verifyJwt: vi.fn(async () => ({
        payload: { sub: "user_1", sid: "session_1" },
        protectedHeader: { alg: "RS256" },
      })) as never,
    });

    await expect(
      identify(
        new Request("https://api.example.test/v1/identity/sync", {
          headers: {
            Authorization: "Bearer token",
            Cookie: "goat-active-workspace=workspace_1; goat-active-brain=brain_1",
          },
        }),
      ),
    ).resolves.toMatchObject({
      userId: "user_1",
      organizationId: null,
      activeWorkspaceId: "workspace_1",
      activeBrainId: "brain_1",
    });
  });

  it("verifies bearer claims and resolves the local actor by WorkOS organization", async () => {
    const execute = vi.fn(async (_query: SQL) => ({
      rows: [
        {
          workspaceId: "workspace_1",
          role: "admin",
          taskSpawningEnabled: true,
          wikiEnabled: true,
        },
      ],
    }));
    const authenticate = createWorkOsApiAuthenticator(execute, {
      audience: "api_resource",
      authKitDomain: "https://example.authkit.app",
      verifyJwt: vi.fn(async () => ({
        payload: { sub: "user_1", org_id: "org_1", sid: "session_1" },
        protectedHeader: { alg: "RS256" },
      })) as never,
    });

    await expect(
      authenticate(
        new Request("https://api.example.test/v1/conversations", {
          headers: { Authorization: "Bearer token" },
        }),
      ),
    ).resolves.toMatchObject({
      actor: {
        userId: "user_1",
        workspaceId: "workspace_1",
        role: "admin",
        authenticationMethod: "oauth",
        sessionId: "session_1",
        permissions: [
          "chat:read",
          "chat:write",
          "task:read",
          "task:write",
          "brain:read",
          "skill:read",
          "brain:write",
          "skill:write",
          "wiki:read",
          "wiki:write",
          "workflow:read",
          "workflow:write",
          "schedule:read",
          "schedule:write",
        ],
      },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects pre-organization bearer identities on ordinary product routes", async () => {
    const execute = vi.fn();
    const authenticate = createWorkOsApiAuthenticator(execute, {
      audience: "api_resource",
      authKitDomain: "https://example.authkit.app",
      verifyJwt: vi.fn(async () => ({
        payload: { sub: "user_1", sid: "session_1" },
        protectedHeader: { alg: "RS256" },
      })) as never,
    });

    await expect(
      authenticate(
        new Request("https://api.example.test/v1/conversations", {
          headers: { Authorization: "Bearer token" },
        }),
      ),
    ).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
      message: "Invalid bearer token claims.",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("withholds Workflow and schedule permissions while Tasks & Workflows is disabled", async () => {
    const execute = vi.fn(async (_query: SQL) => ({
      rows: [
        {
          workspaceId: "workspace_1",
          role: "member",
          taskSpawningEnabled: false,
          wikiEnabled: false,
        },
      ],
    }));
    const authenticate = createWorkOsApiAuthenticator(execute, {
      audience: "api_resource",
      authKitDomain: "https://example.authkit.app",
      verifyJwt: vi.fn(async () => ({
        payload: { sub: "user_1", org_id: "org_1" },
        protectedHeader: { alg: "RS256" },
      })) as never,
    });

    const result = await authenticate(
      new Request("https://api.example.test/v1/workflows", {
        headers: { Authorization: "Bearer token" },
      }),
    );

    expect(result.actor.permissions).toEqual([
      "chat:read",
      "chat:write",
      "task:read",
      "task:write",
      "brain:read",
      "skill:read",
    ]);
  });

  it("refreshes an expired sealed browser session and returns the rotated cookie", async () => {
    vi.stubEnv("WORKOS_COOKIE_DOMAIN", "   ");
    const execute = vi.fn(async () => ({
      rows: [
        {
          workspaceId: "workspace_1",
          role: "member",
          taskSpawningEnabled: true,
          wikiEnabled: false,
        },
      ],
    }));
    const authenticate = createWorkOsApiAuthenticator(execute, {
      cookieName: "wos-session",
      cookiePassword: "a-secure-cookie-password-with-32-chars",
      cookieDomain: "   ",
      workos: {
        userManagement: {
          loadSealedSession: async () => ({
            authenticate: async () => ({ authenticated: false, reason: "invalid_jwt" }),
            refresh: async () => ({
              authenticated: true,
              user: { id: "user_1" },
              organizationId: "org_1",
              sessionId: "session_2",
              sealedSession: "rotated-session",
            }),
          }),
        },
      } as never,
    });

    const result = await authenticate(
      new Request("https://api.example.test/v1/conversations", {
        headers: { Cookie: "wos-session=expired-session" },
      }),
    );
    expect(result.actor).toMatchObject({
      userId: "user_1",
      workspaceId: "workspace_1",
      authenticationMethod: "session",
      sessionId: "session_2",
    });
    expect(result.refreshedSessionCookie).toContain("wos-session=rotated-session");
    expect(result.refreshedSessionCookie).toContain("HttpOnly");
    expect(result.refreshedSessionCookie).not.toContain("Domain=");
  });
});
