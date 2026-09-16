import type { PGlite } from "@electric-sql/pglite";
import type { ChatSqlExecute } from "@opencompany/db/chat-repository";
import { snapshotPGliteSchema } from "@opencompany/db/test-schema-snapshot";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkOsApiAuthenticator } from "./auth";

const pluginSetupRequests = [
  ["GET", "/v1/plugins"],
  ["POST", "/v1/plugins/imports/preview"],
  ["POST", "/v1/plugins/imports"],
] as const;

describe("plugin setup authentication during onboarding", () => {
  let database: PGlite;
  let restoreDatabase: () => Promise<PGlite>;
  let execute: ChatSqlExecute;

  beforeAll(async () => {
    restoreDatabase = await snapshotPGliteSchema(async (database) => {
      await database.exec(`
        CREATE SCHEMA goat;
        CREATE TABLE goat.users (
          workos_user_id text PRIMARY KEY,
          onboarded_at timestamptz
        );
        CREATE TABLE goat.workspaces (
          id text PRIMARY KEY,
          workos_organization_id text
        );
        CREATE TABLE goat.workspace_members (
          workspace_id text REFERENCES goat.workspaces(id),
          user_workos_id text REFERENCES goat.users(workos_user_id),
          role text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO goat.users VALUES ('user_new', NULL), ('user_no_workspace', NULL);
        INSERT INTO goat.workspaces VALUES ('workspace_1', 'org_1'), ('workspace_other', 'org_other');
        INSERT INTO goat.workspace_members (workspace_id, user_workos_id, role)
          VALUES ('workspace_1', 'user_new', 'admin');
      `);
    });
  });

  beforeEach(async () => {
    database = await restoreDatabase();
    execute = async (query) => {
      const compiled = new PgDialect().sqlToQuery(query);
      return database.query(compiled.sql, compiled.params);
    };
  });

  afterEach(async () => {
    await database.close();
  });

  function browserAuthenticator(userId = "user_new", organizationId: string | null = "org_1") {
    return createWorkOsApiAuthenticator(execute, {
      cookieName: "wos-session",
      cookiePassword: "a-secure-cookie-password-with-32-chars",
      workos: {
        userManagement: {
          loadSealedSession: async () => ({
            authenticate: async () => ({
              authenticated: true,
              user: { id: userId },
              organizationId,
              sessionId: "session_1",
            }),
          }),
        },
      } as never,
    });
  }

  function browserRequest(method: string, path: string, workspaceId = "workspace_1") {
    return new Request(`https://api.example.test${path}`, {
      method,
      headers: { Cookie: `wos-session=sealed-session; goat-active-workspace=${workspaceId}` },
    });
  }

  it.each(pluginSetupRequests)("allows %s %s before onboarding completes", async (method, path) => {
    await expect(browserAuthenticator()(browserRequest(method, path))).resolves.toMatchObject({
      actor: {
        userId: "user_new",
        workspaceId: "workspace_1",
        role: "admin",
        authenticationMethod: "session",
        permissions: expect.arrayContaining(["skill:read", "skill:write"]),
      },
    });
    expect((await database.query("SELECT onboarded_at FROM goat.users")).rows).toEqual([
      { onboarded_at: null },
      { onboarded_at: null },
    ]);
  });

  it.each(pluginSetupRequests)(
    "still requires workspace membership for %s %s",
    async (method, path) => {
      await expect(
        browserAuthenticator("user_no_workspace")(browserRequest(method, path)),
      ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    },
  );

  it("does not grant access to the workspace named in an unauthorized cookie", async () => {
    await expect(
      browserAuthenticator(
        "user_new",
        null,
      )(browserRequest("POST", "/v1/plugins/imports", "workspace_other")),
    ).resolves.toMatchObject({ actor: { workspaceId: "workspace_1" } });
  });

  it("allows plugin setup for members as well as admins", async () => {
    await database.exec("UPDATE goat.workspace_members SET role = 'member'");
    await expect(
      browserAuthenticator()(browserRequest("POST", "/v1/plugins/imports")),
    ).resolves.toMatchObject({ actor: { role: "member" } });
  });

  it.each([
    ["GET", "/v1/conversations"],
    ["POST", "/v1/conversations"],
    ["GET", "/v1/tasks"],
    ["GET", "/v1/plugins/linear"],
    ["POST", "/v1/plugins/linear/archive"],
    ["POST", "/v1/plugins/linear/mcp/approve"],
    ["POST", "/v1/plugins/custom"],
    ["DELETE", "/v1/plugins"],
    ["GET", "/v1/plugins/imports"],
    ["POST", "/v1/plugins/imports/preview/other"],
  ])("keeps completed onboarding required for %s %s", async (method, path) => {
    await expect(browserAuthenticator()(browserRequest(method, path))).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
  });

  it.each(["client_connect", "client_mobile"])(
    "does not extend the onboarding exception to %s bearer tokens",
    async (clientId) => {
      const authenticate = createWorkOsApiAuthenticator(execute, {
        audience: "api_resource",
        authKitDomain: "https://example.authkit.app",
        mobileClientId: "client_mobile",
        verifyJwt: vi.fn(async () => ({
          payload: { sub: "user_new", org_id: "org_1", sid: "session_1", client_id: clientId },
          protectedHeader: { alg: "RS256" },
        })) as never,
      });
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const token = `${encode({ alg: "RS256" })}.${encode({ client_id: clientId })}.signature`;
      for (const [method, path] of pluginSetupRequests) {
        await expect(
          authenticate(
            new Request(`https://api.example.test${path}`, {
              method,
              headers: { Authorization: `Bearer ${token}` },
            }),
          ),
        ).rejects.toMatchObject({ status: 403, code: "forbidden" });
      }
    },
  );

  it("rejects unauthenticated plugin setup", async () => {
    await expect(
      browserAuthenticator()(
        new Request("https://api.example.test/v1/plugins/imports", { method: "POST" }),
      ),
    ).rejects.toMatchObject({ status: 401, code: "authentication_required" });
  });

  it("allows ordinary product routes after onboarding completes", async () => {
    await database.exec(
      "UPDATE goat.users SET onboarded_at = now() WHERE workos_user_id = 'user_new'",
    );
    await expect(
      browserAuthenticator()(browserRequest("GET", "/v1/conversations")),
    ).resolves.toMatchObject({
      actor: { userId: "user_new", workspaceId: "workspace_1" },
    });
  });
});
