import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { executeWorkspaceSkillToolForActor } from "@opencompany/agent/skills";
import {
  ACTION_HOST_TOOL_CONTRACT_VERSION,
  createExternalEngineGatewayTicket,
} from "@opencompany/agent-runtime";
import type { PooledDb } from "@opencompany/db/pool";
import { createTestPGlite } from "@opencompany/db/test-pglite";
import { drizzle } from "drizzle-orm/pglite";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAcpToolsMcpRoute } from "./acp-tools-mcp";
import type { RunnerEnv } from "./env";

const database = vi.hoisted(() => ({ db: undefined as PooledDb | undefined }));
vi.mock("./db", () => ({
  getDb: () => {
    if (!database.db) throw new Error("Test database is not initialized.");
    return database.db;
  },
}));
// Keep the real HTTP driver's transaction behavior, without production credentials or requests.
vi.mock("@opencompany/db/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opencompany/db/client")>();
  return {
    ...original,
    getDb: () => original.createDb("postgresql://test:test@localhost/test"),
  };
});

const actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["skill:read", "skill:write"],
  authenticationMethod: "service" as const,
};
const env = { internalToken: "test-runner-secret" } as RunnerEnv;
const capability = {
  codexChatSessionId: "session_1",
  codexChatTurnId: "run_1",
  attemptId: "attempt_1",
  leaseId: "lease_1",
};

describe("external engine Skill persistence through the MCP route", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await createTestPGlite();
    await pg.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.workspaces (id text PRIMARY KEY);
      CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text, role text);
      INSERT INTO goat.workspace_members VALUES ('workspace_1', 'user_1', 'admin');
      INSERT INTO goat.workspaces (id) VALUES ('workspace_1');
    `);
    for (const migration of [
      "0226_goat_immutable_skill_bundles.sql",
      "0232_workspace_authored_skills.sql",
      "0263_personal_company_skills.sql",
    ]) {
      const source = await readFile(
        new URL(`../../../drizzle/${migration}`, import.meta.url),
        "utf8",
      );
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await pg.exec(statement);
      }
    }
    database.db = drizzle(pg) as unknown as PooledDb;
  });

  beforeEach(async () => {
    await pg.exec("DELETE FROM goat.skill_installations; DELETE FROM goat.skill_bundles;");
  });

  afterAll(async () => {
    database.db = undefined;
    await pg.close();
  });

  it.each(["codex", "claude_code"] as const)(
    "%s creates and edits saved Skills using the runner database and rejects stale edits",
    async (engine) => {
      const initial = await executeWorkspaceSkillToolForActor({
        actor,
        tool: "create_workspace_skill",
        args: {
          name: "my-skill",
          description: "Original description.",
          instructions: "Original steps.",
        },
        idempotencyKey: "seed",
        db: database.db!,
      });
      const originalBundleId = (initial as { bundleId: string }).bundleId;
      const app = Fastify();
      registerAcpToolsMcpRoute(app, env, {
        authorize: async () => ({
          ...actor,
          actorId: actor.userId,
          workspaceName: "Test workspace",
          workspaceSlug: "test-workspace",
          skillToolsEnabled: true,
          legacyBrainEnabled: false,
          conversationId: "conversation_1",
          sandboxId: "sandbox_1",
          engine,
          brainRef: null,
          userMessageId: "message_user_1",
          assistantMessageId: "message_assistant_1",
          hostToolContractVersion: ACTION_HOST_TOOL_CONTRACT_VERSION,
        }),
      });
      const client = new Client({ name: "skill-persistence-test", version: "1" });
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP address.");
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${address.port}/internal/goat/acp-tools`),
          {
            requestInit: {
              headers: {
                "x-opencompany-tool-ticket": createExternalEngineGatewayTicket({
                  ...capability,
                  secret: env.internalToken,
                }).ticket,
              },
            },
          },
        );
        await client.connect(transport as Parameters<typeof client.connect>[0]);
        const edit = await client.callTool({
          name: "edit_workspace_skill",
          arguments: {
            name: "my-skill",
            description: "Revised description.",
            instructions: "Revised steps.",
            expectedBundleId: originalBundleId,
          },
        });
        expect(edit.isError, JSON.stringify(edit.content)).not.toBe(true);
        const read = await client.callTool({
          name: "workspace_skills",
          arguments: { command: "read", name: "my-skill" },
        });
        const readContent = read.content as Array<{ type: string; text: string }>;
        const savedSkill = JSON.parse(readContent[0]!.text);
        expect(savedSkill).toMatchObject({
          instructions: "Revised steps.\n",
          description: "Revised description.",
        });
        expect(savedSkill.bundleId).not.toBe(originalBundleId);
        const stale = await client.callTool({
          name: "edit_workspace_skill",
          arguments: {
            name: "my-skill",
            description: "Stale revision.",
            instructions: "Must not overwrite the saved revision.",
            expectedBundleId: originalBundleId,
          },
        });
        expect(stale.isError).toBe(true);
        expect(JSON.stringify(stale.content)).toContain("changed since you opened it");
        const renamed = await client.callTool({
          name: "edit_workspace_skill",
          arguments: {
            name: savedSkill.id,
            newName: "renamed-skill",
            expectedBundleId: savedSkill.bundleId,
          },
        });
        expect(renamed.isError, JSON.stringify(renamed.content)).not.toBe(true);
        expect(JSON.parse((renamed.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
          id: savedSkill.id,
          name: "renamed-skill",
          command: "/renamed-skill",
        });
        const renamedRead = await client.callTool({
          name: "workspace_skills",
          arguments: { command: "read", name: "renamed-skill" },
        });
        expect(JSON.parse((renamedRead.content as Array<{ text: string }>)[0]!.text)).toMatchObject(
          {
            id: savedSkill.id,
            name: "renamed-skill",
            instructions: "Revised steps.\n",
            description: "Revised description.",
          },
        );
        const created = await client.callTool({
          name: "create_workspace_skill",
          arguments: {
            name: "new-skill",
            description: "New description.",
            instructions: "New steps.",
          },
        });
        expect(created.isError, JSON.stringify(created.content)).not.toBe(true);
        const saved = await pg.query<{ body: string }>(
          "SELECT body FROM goat.skill_bundles ORDER BY body",
        );
        expect(saved.rows.map(({ body }) => body)).toEqual([
          "New steps.\n",
          "Original steps.\n",
          "Revised steps.\n",
          "Revised steps.\n",
        ]);
      } finally {
        await client.close();
        await app.close();
      }
    },
  );
});
