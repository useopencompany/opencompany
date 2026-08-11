import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createWorkOsApiAuthenticator } from "./auth";

describe("API authentication", () => {
  it("verifies bearer claims and resolves the local actor by WorkOS organization", async () => {
    const execute = vi.fn(async (_query: SQL) => ({
      rows: [{ workspaceId: "workspace_1", role: "admin" }],
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
        permissions: ["chat:read", "chat:write", "task:read", "task:write"],
      },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("refreshes an expired sealed browser session and returns the rotated cookie", async () => {
    const execute = vi.fn(async () => ({
      rows: [{ workspaceId: "workspace_1", role: "member" }],
    }));
    const authenticate = createWorkOsApiAuthenticator(execute, {
      cookieName: "wos-session",
      cookiePassword: "a-secure-cookie-password-with-32-chars",
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
  });
});
