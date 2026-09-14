import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  create: vi.fn(),
  connect: vi.fn(),
  kill: vi.fn(),
  member: vi.fn(),
  validate: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: () => mocks.db }));
vi.mock("./sandbox", () => ({ killSandbox: mocks.kill, managedSandboxMetadata: () => ({}) }));
vi.mock("e2b", () => ({ Sandbox: { create: mocks.create, connect: mocks.connect } }));
vi.mock("@opencompany/db/workspaces", () => ({ getWorkspaceRole: mocks.member }));
vi.mock("./doppler-api", () => ({ validateDopplerToken: mocks.validate }));

import {
  cancelDopplerAuth,
  parseDopplerLogin,
  pollDopplerAuthFlow,
  startDopplerAuthFlow,
} from "./doppler-auth";

const actor = { workspaceId: "w1", requestedByWorkosId: "alice" };
let pg: PGlite;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  mocks.member.mockResolvedValue("admin");
  mocks.validate.mockResolvedValue("Alice");
  mocks.kill.mockResolvedValue(undefined);
  pg = new PGlite();
  mocks.db = drizzle(pg);
  await pg.exec(
    `CREATE SCHEMA goat; CREATE TABLE goat.workspaces(id text primary key); CREATE TABLE goat.users(workos_user_id text primary key); CREATE TABLE goat.workspace_members(workspace_id text, user_workos_id text, role text); CREATE TABLE goat.plugin_ownership_rollout(id text primary key, personal_enabled boolean); CREATE TABLE goat.plugins(id text, name text, owner_user_id text, workspace_id text, status text, source_url text, source_path text, source_ref text); INSERT INTO goat.workspaces VALUES ('w1'),('w2'); INSERT INTO goat.users VALUES ('alice'),('bob'); INSERT INTO goat.workspace_members VALUES ('w1','alice','admin'),('w1','bob','member'); INSERT INTO goat.plugin_ownership_rollout VALUES ('personal_plugins',true); INSERT INTO goat.plugins VALUES ('p1','doppler','alice','w1','enabled','https://github.com/useopencompany/plugins','doppler','891c084c347ff69288635b651e545c9bfd47b212');`,
  );
  await pg.exec(
    await readFile(new URL("../../../drizzle/0281_doppler_cli_auth.sql", import.meta.url), "utf8"),
  );
});
afterEach(async () => {
  await pg?.close();
  vi.unstubAllEnvs();
});
async function pending(id = "flow1", user = "alice") {
  await pg.query(
    `INSERT INTO goat.doppler_auth_flows (id,workspace_id,requested_by_workos_id,sandbox_id,status,expires_at) VALUES ($1,'w1',$2,'sandbox1','link_ready',now()+interval '5 minutes')`,
    [id, user],
  );
}
function sandbox() {
  return {
    sandboxId: "sandbox1",
    files: { write: vi.fn() },
    commands: {
      run: vi.fn(async (cmd: string) => ({
        stdout: cmd.includes("configure get token")
          ? "dp.ct.test_token"
          : cmd.includes("login.exit")
            ? "0"
            : "",
        exitCode: 0,
      })),
    },
  };
}
it("accepts only the actual Doppler sign-in origin", () => {
  const log =
    "Complete authorization at https://dashboard.doppler.com/workplace/auth/cli\nYour auth code is:\n\u001b[32mtest_code_123\u001b[0m\nWaiting...";
  expect(parseDopplerLogin(log)?.userCode).toBe("test_code_123");
  expect(
    parseDopplerLogin(log.replace("dashboard.doppler.com", "dashboard.doppler.com.evil.test")),
  ).toBeNull();
});
it("does not expose or complete another user's flow", async () => {
  await pending();
  expect(
    await pollDopplerAuthFlow({ ...actor, requestedByWorkosId: "bob", flowId: "flow1" }),
  ).toBeNull();
  expect(mocks.connect).not.toHaveBeenCalled();
});
it("persists only encrypted credentials after validating identity", async () => {
  await pending();
  mocks.connect.mockResolvedValue(sandbox());
  expect((await pollDopplerAuthFlow({ ...actor, flowId: "flow1" }))?.status).toBe("completed");
  const rows = (await pg.query("SELECT * FROM goat.doppler_connections")).rows;
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("dp.ct.test_token");
  expect(rows[0]).toMatchObject({
    owner_user_id: "alice",
    account_name: "Alice",
    status: "connected",
  });
});
it("does not restore credentials when disconnect races completion", async () => {
  await pending();
  mocks.connect.mockResolvedValue(sandbox());
  mocks.validate.mockImplementation(async () => {
    await cancelDopplerAuth({ ...actor, disconnect: true });
    return "Alice";
  });
  expect((await pollDopplerAuthFlow({ ...actor, flowId: "flow1" }))?.status).toBe("failed");
  expect(
    (await pg.query("SELECT status,encrypted_auth_bundle FROM goat.doppler_connections")).rows[0],
  ).toMatchObject({ status: "disconnected", encrypted_auth_bundle: null });
});
it("cancels while the sandbox is being provisioned", async () => {
  mocks.create.mockImplementation(async () => {
    await cancelDopplerAuth({ ...actor, disconnect: false });
    return sandbox();
  });
  await expect(
    startDopplerAuthFlow({
      ...actor,
      env: {
        codexE2bTemplates: { small: "small", standard: "standard", large: "large" },
        sandboxNamespace: "test",
      } as never,
    }),
  ).rejects.toThrow("could not start");
  expect(mocks.kill).toHaveBeenCalledWith("sandbox1");
  expect((await pg.query("SELECT * FROM goat.doppler_connections")).rows).toHaveLength(0);
});
it("expires pending flows without contacting the sandbox", async () => {
  await pending();
  await pg.exec("UPDATE goat.doppler_auth_flows SET expires_at=now()-interval '1 second'");
  expect((await pollDopplerAuthFlow({ ...actor, flowId: "flow1" }))?.status).toBe("expired");
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.kill).toHaveBeenCalledWith("sandbox1");
});
