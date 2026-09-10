import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "@opencompany/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBotService } from "./bots";
import { createUserSettingsService } from "./user-settings";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "admin",
  permissions: ["chat:read", "chat:write"],
  authenticationMethod: "session",
};
const bot = { id: "bot_1", name: "Research", description: "Research customer needs." };
describe("persistent bot storage", () => {
  let database: PGlite;
  let service: ReturnType<typeof createBotService>;
  beforeEach(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.users (
        workos_user_id text PRIMARY KEY,
        bots_enabled boolean NOT NULL DEFAULT false,
        timezone text NOT NULL DEFAULT 'UTC',
        task_spawning_enabled boolean NOT NULL DEFAULT false,
        task_view_mode text NOT NULL DEFAULT 'board',
        task_time_range text NOT NULL DEFAULT '7d',
        auto_model_routing_enabled boolean NOT NULL DEFAULT false,
        review_inbox_enabled boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text);
      CREATE TABLE goat.chat_sessions (id text PRIMARY KEY, user_workos_id text, title text, model text, engine text, bot_name text, bot_description text, closed_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE goat.codex_chat_sessions (id text PRIMARY KEY, user_workos_id text, chat_session_id text UNIQUE REFERENCES goat.chat_sessions(id), workspace_id text, engine text, model text, status text);
      INSERT INTO goat.users VALUES ('user_1', true), ('user_2', true), ('disabled', false);
      INSERT INTO goat.workspace_members VALUES ('workspace_1', 'user_1'), ('workspace_2', 'user_1'), ('workspace_1', 'user_2'), ('workspace_1', 'disabled');
    `);
    service = createBotService({ db: drizzle(database), defaultModel: "moonshotai/kimi-k3" });
  });
  afterEach(async () => {
    await database.close();
  });
  it("creates one persistent conversation and idle runtime across retries", async () => {
    expect(await service.create(actor, bot)).toEqual(bot);
    expect(await service.create(actor, bot)).toEqual(bot);
    expect((await database.query("SELECT * FROM goat.codex_chat_sessions")).rows).toMatchObject([
      {
        chat_session_id: bot.id,
        workspace_id: actor.workspaceId,
        status: "idle",
        engine: "opencompany",
      },
    ]);
    expect(await service.list(actor)).toEqual([bot]);
    await expect(service.create(actor, { ...bot, name: "Different" })).rejects.toMatchObject({
      status: 409,
    });
  });
  it("enables bot access through Preferences and preserves bots across disabling and re-enabling", async () => {
    await database.exec(
      "UPDATE goat.users SET bots_enabled = false WHERE workos_user_id = 'user_1'",
    );
    const settings = createUserSettingsService({ db: drizzle(database) });
    await expect(service.list(actor)).rejects.toMatchObject({ status: 404 });

    expect(await settings.updatePreferences(actor, { botsEnabled: true })).toMatchObject({
      botsEnabled: true,
      taskSpawningEnabled: false,
    });
    await service.create(actor, bot);
    expect(await service.list(actor)).toEqual([bot]);

    expect(await settings.updatePreferences(actor, { botsEnabled: false })).toMatchObject({
      botsEnabled: false,
    });
    await expect(service.list(actor)).rejects.toMatchObject({ status: 404 });
    await expect(service.authorizeConversation(actor, bot.id)).rejects.toMatchObject({
      status: 404,
    });

    await settings.updatePreferences(actor, { botsEnabled: true });
    expect(await service.list(actor)).toEqual([bot]);
    expect(
      (
        await database.query(
          "SELECT bots_enabled FROM goat.users WHERE workos_user_id = 'disabled'",
        )
      ).rows,
    ).toEqual([{ bots_enabled: false }]);
  });

  it("checks feature flag, membership, permission, ownership and workspace", async () => {
    await service.create(actor, bot);
    for (const other of [
      { ...actor, userId: "user_2" },
      { ...actor, workspaceId: "workspace_2" },
    ]) {
      expect(await service.list(other)).toEqual([]);
      await expect(service.get(other, bot.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.update(other, bot.id, bot)).rejects.toMatchObject({ status: 404 });
    }
    await expect(service.create({ ...actor, userId: "disabled" }, bot)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.list({ ...actor, workspaceId: "unknown" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.create({ ...actor, permissions: ["chat:read"] }, bot),
    ).rejects.toMatchObject({ status: 403 });
    await database.exec(
      "UPDATE goat.users SET bots_enabled = false WHERE workos_user_id = 'user_1'",
    );
    await expect(service.authorizeConversation(actor, bot.id)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("edits identity on the same conversation and excludes archived bots", async () => {
    await service.create(actor, bot);
    const updated = {
      ...bot,
      name: "Customer research",
      description: "Find founders to interview.",
    };
    expect(await service.update(actor, bot.id, updated)).toEqual(updated);
    expect((await database.query("SELECT title FROM goat.chat_sessions")).rows).toEqual([
      { title: updated.name },
    ]);
    await database.exec("UPDATE goat.chat_sessions SET closed_at = now()");
    expect(await service.list(actor)).toEqual([]);
    await expect(service.get(actor, bot.id)).rejects.toMatchObject({ status: 404 });
  });
});
