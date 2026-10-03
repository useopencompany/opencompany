import { createHmac } from "node:crypto";
import { sentryAccessToken } from "@opencompany/agent/integrations/sentry";
import type { Actor } from "@opencompany/core";
import { loadIntegrationCredential } from "@opencompany/db/integrations";
import { bindSentryConnection, getSentryConnection } from "@opencompany/db/sentry";
import { snapshotSentryTestSchema } from "@opencompany/db/test-sentry-schema";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createSentryService } from "./sentry";

let restore: Awaited<ReturnType<typeof snapshotSentryTestSchema>>;
beforeAll(async () => {
  restore = await snapshotSentryTestSchema();
}, 30_000);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const installationId = "a8e5d37a-696c-4c54-adb5-b3f28d64c7de";
const admin = {
  userId: "admin_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: [],
  authenticationMethod: "session",
} as unknown as Actor;
async function fixture() {
  vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("SENTRY_APP_CLIENT_ID", "fixture-client");
  vi.stubEnv("SENTRY_APP_CLIENT_SECRET", "fixture-secret");
  vi.stubEnv("SENTRY_APP_SLUG", "fixture-integration");
  const database = await restore();
  const db = drizzle(database);
  await database.exec(
    "INSERT INTO goat.users VALUES ('admin_1',now()); INSERT INTO goat.workspaces VALUES ('workspace_1'),('workspace_2'); INSERT INTO goat.workspace_members VALUES ('workspace_1','admin_1');",
  );
  const service = createSentryService(db);
  const bind = (workspaceId = "workspace_1", expiresAt = new Date("2099-01-01T00:00:00Z")) =>
    bindSentryConnection({
      workspaceId,
      userWorkosId: admin.userId,
      installationId,
      organizationId: "123",
      organizationSlug: "acme",
      region: "eu",
      token: "fixture-access",
      refreshToken: "fixture-refresh",
      expiresAt,
      db,
    });
  return { database, db, service, bind };
}
it("binds to an authenticated admin, stores encrypted credentials, and verifies only after project setup", async () => {
  const f = await fixture();
  try {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        if (
          String(url).endsWith("/authorizations/") &&
          JSON.parse(String(init.body)).code === "fixture-grant"
        )
          return Response.json({
            token: "fixture-access",
            refreshToken: "fixture-refresh",
            expiresAt: "2099-01-01T00:00:00Z",
          });
        if (url.host === "de.sentry.io" && url.pathname.endsWith("organizations/"))
          return Response.json([{ id: "123", slug: "acme" }]);
        if (url.pathname.endsWith("projects/acme/1/"))
          return Response.json({
            id: "1",
            slug: "web",
            name: "Web",
            organization: { slug: "acme" },
          });
        if (
          url.host === "sentry.io" &&
          init.method === "PUT" &&
          JSON.parse(String(init.body)).status === "installed"
        )
          return Response.json({ status: "installed" });
        return new Response(null, { status: 400 });
      }),
    );
    const connected = await f.service.connect(admin, {
      installationId,
      code: "fixture-grant",
      region: "eu",
    });
    expect(connected.connection).toMatchObject({
      organizationSlug: "acme",
      region: "eu",
      verifiedAt: null,
      status: "sync_failed",
    });
    const saved = await f.service.settings(admin, {
      projectIds: ["1"],
      cooldownMinutes: 30,
      dailyCap: 25,
      capabilityModes: {},
    });
    expect(saved.connection).toMatchObject({ selectedProjectIds: ["1"], status: "connected" });
    expect(saved.connection?.verifiedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    const stored = (
      await f.database.query<{ encrypted_payload: unknown }>(
        "SELECT encrypted_payload FROM goat.integration_credentials",
      )
    ).rows[0]!;
    expect(JSON.stringify(stored)).not.toContain("fixture-access");
    await expect(
      loadIntegrationCredential({
        userWorkosId: admin.userId,
        integrationId: saved.connection!.integrationId,
        provider: "sentry",
        kind: "oauth_token",
        db: f.db,
      }),
    ).resolves.toMatchObject({ payload: { access_token: "fixture-access" } });
  } finally {
    await f.database.close();
  }
});
it("rejects a second workspace claiming an installation and rejects members changing any shared settings", async () => {
  const f = await fixture();
  try {
    await f.bind();
    await expect(f.bind("workspace_2")).rejects.toThrow("another workspace");
    const member = { ...admin, role: "member" } as Actor;
    await expect(f.service.connect(member, {})).rejects.toThrow("Only workspace admins");
    await expect(f.service.settings(member, {})).rejects.toThrow("Only workspace admins");
    await expect(f.service.disconnect(member)).rejects.toThrow("Only workspace admins");
    await expect(f.service.projects(member, true)).rejects.toThrow("Only workspace admins");
  } finally {
    await f.database.close();
  }
});
it("coalesces expired token refresh races using the recommended JWT grant and preserves encrypted rotations", async () => {
  const f = await fixture();
  try {
    const connection = await f.bind("workspace_1", new Date("2000-01-01T00:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.grant_type !== "urn:sentry:params:oauth:grant-type:jwt-bearer")
          return new Response(null, { status: 400 });
        const jwt = String((init.headers as Record<string, string>).Authorization).slice(7);
        const parts = jwt.split(".");
        if (
          parts[2] !==
          createHmac("sha256", "fixture-secret")
            .update(`${parts[0]}.${parts[1]}`)
            .digest("base64url")
        )
          return new Response(null, { status: 401 });
        return Response.json({
          token: "rotated-access",
          refreshToken: "rotated-refresh",
          expiresAt: "2099-01-01T00:00:00Z",
        });
      }),
    );
    await expect(
      Promise.all(Array.from({ length: 5 }, () => sentryAccessToken(connection, { db: f.db }))),
    ).resolves.toEqual(Array(5).fill("rotated-access"));
    expect(fetch).toHaveBeenCalledOnce();
    await expect(
      loadIntegrationCredential({
        userWorkosId: admin.userId,
        integrationId: connection.integrationId,
        provider: "sentry",
        kind: "oauth_token",
        db: f.db,
      }),
    ).resolves.toMatchObject({
      payload: { access_token: "rotated-access", refresh_token: "rotated-refresh" },
    });
  } finally {
    await f.database.close();
  }
});
it("marks rejected expired credentials as requiring reauthorization", async () => {
  const f = await fixture();
  try {
    const connection = await f.bind("workspace_1", new Date("2000-01-01T00:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await expect(sentryAccessToken(connection, { db: f.db })).rejects.toThrow("Reconnect");
    expect(await getSentryConnection("workspace_1", f.db)).toMatchObject({
      status: "needs_reauth",
    });
  } finally {
    await f.database.close();
  }
});
it("durably acknowledges receipts, deduplicates retries, rejects signatures and strips installation grants", async () => {
  const f = await fixture();
  try {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Webhooks must not perform enrichment");
      }),
    );
    const payload = {
      action: "created",
      installation: { uuid: installationId },
      data: { installation: { code: "secret-grant", organization: { slug: "acme" } } },
    };
    const raw = JSON.stringify(payload);
    const signature = createHmac("sha256", "fixture-secret").update(raw).digest("hex");
    function request(sig = signature, requestId = "delivery-a") {
      return new Request("https://app.example/webhooks/sentry", {
        method: "POST",
        body: raw,
        headers: {
          "sentry-hook-signature": sig,
          "sentry-hook-resource": "installation",
          "sentry-hook-timestamp": "1791028800",
          "request-id": requestId,
        },
      });
    }
    expect((await f.service.webhook(request("0".repeat(64)))).status).toBe(401);
    expect((await f.service.webhook(request())).status).toBe(202);
    expect((await f.service.webhook(request(signature, "retry-with-new-request-id"))).status).toBe(
      202,
    );
    const receipts = (
      await f.database.query<{ payload: unknown }>(
        "SELECT payload FROM goat.sentry_webhook_receipts",
      )
    ).rows;
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts)).not.toContain("secret-grant");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await f.database.close();
  }
});

it("rejects signed malformed JSON without acknowledging it", async () => {
  const f = await fixture();
  try {
    const raw = "{invalid";
    const signature = createHmac("sha256", "fixture-secret").update(raw).digest("hex");
    expect(
      (
        await f.service.webhook(
          new Request("https://app.example/webhooks/sentry", {
            method: "POST",
            body: raw,
            headers: { "sentry-hook-signature": signature },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await f.database.query("SELECT * FROM goat.sentry_webhook_receipts")).rows,
    ).toHaveLength(0);
  } finally {
    await f.database.close();
  }
});
it("allows replacing a disconnected organization while preserving installation ownership", async () => {
  const f = await fixture();
  try {
    await f.bind();
    await f.service.disconnect(admin);
    await bindSentryConnection({
      workspaceId: admin.workspaceId,
      userWorkosId: admin.userId,
      installationId: "c80a69d8-963e-4f62-b907-8a8e23e6fd21",
      organizationId: "456",
      organizationSlug: "other",
      region: "us",
      token: "fixture-other",
      refreshToken: "fixture-refresh",
      expiresAt: new Date("2099-01-01"),
      db: f.db,
    });
    expect(await getSentryConnection(admin.workspaceId, f.db)).toMatchObject({
      organizationSlug: "other",
      selectedProjectIds: [],
    });
    await expect(f.bind("workspace_2")).rejects.toThrow("another workspace");
  } finally {
    await f.database.close();
  }
});
it("lists only eligible shared alert workflows and validates Sentry's array field format", async () => {
  const f = await fixture();
  try {
    const connection = await f.bind();
    await f.database.exec(
      "UPDATE goat.integrations SET status='connected'; UPDATE goat.sentry_connections SET verified_at=now(), selected_project_ids='[\"1\"]'",
    );
    const trigger = {
      id: "alert_1",
      type: "event",
      event: "issue_alert.triggered",
      provider: "sentry",
      integrationId: connection.integrationId,
      filters: { project: { id: "1", name: "Web" } },
      prompt: "Investigate",
      harnessSpec: {},
      userWorkosId: admin.userId,
      activatedAt: "2026-10-01T00:00:00Z",
    };
    await f.db.execute(
      sql`INSERT INTO goat.workflows(id,workspace_id,slug,name,trigger,status,automation_triggers) VALUES ('workflow_1','workspace_1','alert','Investigate','event','active',${JSON.stringify([trigger])}::jsonb)`,
    );
    function actionRequest(body: unknown, options = false) {
      const raw = options ? "" : JSON.stringify(body);
      return new Request(
        `https://app.example/integrations/sentry/alert-action${options ? `/options?installationId=${installationId}` : ""}`,
        {
          method: options ? "GET" : "POST",
          ...(options ? {} : { body: raw }),
          headers: {
            "sentry-app-signature": createHmac("sha256", "fixture-secret")
              .update(raw)
              .digest("hex"),
          },
        },
      );
    }
    const options = await f.service.alertAction(actionRequest(null, true));
    expect(await options.json()).toEqual([
      {
        label: "Investigate",
        value: JSON.stringify({ workflowId: "workflow_1", triggerId: "alert_1" }),
      },
    ]);
    const valid = {
      installationId,
      fields: [
        {
          name: "destination",
          value: JSON.stringify({ workflowId: "workflow_1", triggerId: "alert_1" }),
        },
      ],
    };
    expect((await f.service.alertAction(actionRequest(valid))).status).toBe(200);
    expect(
      (
        await f.service.alertAction(
          actionRequest({
            installationId,
            fields: [
              {
                name: "destination",
                value: JSON.stringify({ workflowId: "foreign", triggerId: "alert_1" }),
              },
            ],
          }),
        )
      ).status,
    ).toBe(400);
    await f.database.exec("UPDATE goat.workflows SET scope='personal'");
    expect((await f.service.alertAction(actionRequest(valid))).status).toBe(400);
    expect(await (await f.service.alertAction(actionRequest(null, true))).json()).toEqual([]);
  } finally {
    await f.database.close();
  }
});

it("rejects installation UUID case variants before consuming a grant in another workspace", async () => {
  const f = await fixture();
  try {
    await f.bind();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("A foreign binding must not consume the grant");
      }),
    );
    await expect(
      f.service.connect(
        { ...admin, workspaceId: "workspace_2" },
        { installationId: installationId.toUpperCase(), code: "fixture-grant", region: "eu" },
      ),
    ).rejects.toThrow("another workspace");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await f.database.close();
  }
});
