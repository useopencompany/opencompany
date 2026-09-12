import { createTestPGlite } from "@opencompany/db/test-pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeAction, MAX_EXPANDED_ACTION_RESULT_CHARS } from "./execute";
import { projectActionCatalog } from "./policy";
import { resolveSessionHistoryActions } from "./session-history";
import { createSessionHistoryStore } from "./session-history-store";

const actor = { userWorkosId: "owner", workspaceId: "workspace", chatSessionId: "current" };
const range = { from: "2026-09-01T00:00:00Z", until: "2026-09-08T00:00:00Z" };
let db: Awaited<ReturnType<typeof createTestPGlite>>;
let store: ReturnType<typeof createSessionHistoryStore>;
const context = {
  ...actor,
  signal: new AbortController().signal,
  currentDate: new Date("2026-09-08T00:00:00Z"),
  userTimezone: "Europe/Berlin",
};

beforeAll(async () => {
  db = await createTestPGlite();
  await db.exec(`CREATE SCHEMA goat;
    CREATE TABLE goat.users (workos_user_id text PRIMARY KEY, past_session_access_enabled boolean DEFAULT false);
    CREATE TABLE goat.workspace_members (user_workos_id text, workspace_id text);
    CREATE TABLE goat.chat_sessions (id text PRIMARY KEY, user_workos_id text, kind text DEFAULT 'chat', title text DEFAULT 'Past work', engine text DEFAULT 'codex', closed_at timestamptz);
    CREATE TABLE goat.codex_chat_sessions (chat_session_id text, user_workos_id text, workspace_id text);
    CREATE TABLE goat.chat_session_shares (chat_session_id text);
    CREATE TABLE goat.chat_messages (id text PRIMARY KEY, session_id text, role text DEFAULT 'assistant', content text, debug_trace jsonb, created_at timestamptz DEFAULT '2026-09-04T12:00:00Z', updated_at timestamptz DEFAULT '2026-09-04T12:00:00Z');`);
  store = createSessionHistoryStore(drizzle(db));
}, 20000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec(`TRUNCATE goat.users, goat.workspace_members, goat.chat_sessions, goat.codex_chat_sessions, goat.chat_session_shares, goat.chat_messages;
    INSERT INTO goat.users VALUES ('owner', true), ('other', true);
    INSERT INTO goat.workspace_members VALUES ('owner','workspace'),('other','workspace'),('owner','elsewhere');
    INSERT INTO goat.chat_sessions (id,user_workos_id,kind) VALUES ('current','owner','chat'),('past','owner','chat'),('other','other','chat'),('cross','owner','chat'),('task','owner','task'),('legacy','owner','chat'),('shared','owner','chat'),('archived','owner','chat');
    INSERT INTO goat.codex_chat_sessions SELECT id,user_workos_id,CASE WHEN id='cross' THEN 'elsewhere' ELSE 'workspace' END FROM goat.chat_sessions WHERE id <> 'legacy';
    INSERT INTO goat.chat_session_shares VALUES ('shared');
    UPDATE goat.chat_sessions SET closed_at = now() WHERE id = 'archived';
    INSERT INTO goat.chat_messages (id,session_id,content,debug_trace) SELECT id || '_message',id,'Repeated skill correction', '{"toolCalls":[{"toolName":"secret-tool","input":"hidden input"}],"uiMessageParts":[{"type":"reasoning","text":"hidden reasoning"}],"toolResults":["hidden result"]}' FROM goat.chat_sessions;`);
});

describe("past session history", () => {
  it("finds only owned workspace chats, includes archives, and paginates activity ties", async () => {
    const first = await store.find(actor, { ...range, limit: 1 });
    expect(first.sessions.map((s) => s.sessionId)).toEqual(["past"]);
    const next = await store.find(actor, { ...range, limit: 1, cursor: first.nextCursor });
    expect(next.sessions.map((s) => s.sessionId)).toEqual(["archived"]);
    expect(next.nextCursor).toBeNull();
    expect(next.sessions[0]?.archived).toBe(true);
  });
  it("matches activity in the requested interval with inclusive start and exclusive end", async () => {
    await db.exec(`UPDATE goat.chat_messages SET created_at='2026-08-01' WHERE session_id='past';
      INSERT INTO goat.chat_messages (id,session_id,content,created_at) VALUES ('start','past','found','2026-09-01'),('end','archived','excluded','2026-09-08');`);
    const result = await store.find(actor, { ...range, query: "found" });
    expect(result.sessions.map((s) => s.sessionId)).toEqual(["past"]);
    expect((await store.find(actor, { ...range, query: "excluded" })).sessions).toEqual([]);
  });
  it("searches literal case-insensitive phrases, not wildcard patterns or hidden payloads", async () => {
    await db.query("UPDATE goat.chat_messages SET content=$1 WHERE session_id='past'", [
      "100%_done\\skill",
    ]);
    expect(
      (await store.find(actor, { ...range, query: "100%_DONE\\skill" })).sessions,
    ).toHaveLength(1);
    expect((await store.find(actor, { ...range, query: "%" })).sessions).toHaveLength(1);
    expect((await store.find(actor, { ...range, query: "hidden" })).sessions).toHaveLength(0);
  });
  it("round-trips a huge Unicode message through cursors without gaps or duplicated characters", async () => {
    const content = "a😀\n".repeat(6000);
    await db.query("UPDATE goat.chat_messages SET content=$1 WHERE session_id='past'", [content]);
    let cursor: string | undefined;
    let collected = "";
    let pages = 0;
    do {
      const result = await store.read(actor, {
        ...range,
        sessions: [{ sessionId: "past", ...(cursor ? { cursor } : {}) }],
      });
      const session = result.sessions[0]!;
      for (const m of session.messages) collected += m.text;
      cursor = session.nextCursor ?? undefined;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(collected).toBe(content);
  });
  it("paginates many empty messages and keeps same-timestamp message order", async () => {
    await db.exec(`DELETE FROM goat.chat_messages WHERE session_id='past';
      INSERT INTO goat.chat_messages (id,session_id,content) SELECT 'msg_'||lpad(n::text,3,'0'),'past','' FROM generate_series(1,65) n;`);
    let cursor: string | undefined;
    const ids: unknown[] = [];
    do {
      const result = await store.read(actor, {
        ...range,
        sessions: [{ sessionId: "past", ...(cursor ? { cursor } : {}) }],
      });
      ids.push(...result.sessions[0]!.messages.map((m) => m.messageId));
      cursor = result.sessions[0]!.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(65);
    expect(new Set(ids).size).toBe(65);
    expect(ids).toEqual([...ids].sort());
  });
  it("rejects changed messages and cursors reused for another session, range or actor", async () => {
    await db.query("UPDATE goat.chat_messages SET content=$1 WHERE session_id='past'", [
      "x".repeat(12000),
    ]);
    const first = await store.read(actor, { ...range, sessions: [{ sessionId: "past" }] });
    const cursor = first.sessions[0]!.nextCursor;
    await expect(
      store.read(actor, { ...range, sessions: [{ sessionId: "archived", cursor }] }),
    ).rejects.toThrow("Cursor does not match");
    await expect(
      store.read(actor, {
        ...range,
        from: "2026-09-02T00:00:00Z",
        sessions: [{ sessionId: "past", cursor }],
      }),
    ).rejects.toThrow("Cursor does not match");
    await db.exec("UPDATE goat.chat_messages SET updated_at=now() WHERE session_id='past'");
    await expect(
      store.read(actor, { ...range, sessions: [{ sessionId: "past", cursor }] }),
    ).rejects.toThrow("changed");
  });
  it("returns indistinguishable unavailable results for forbidden and unknown sessions", async () => {
    const result = await store.read(actor, {
      ...range,
      sessions: ["other", "cross", "task", "legacy", "missing"].map((sessionId) => ({ sessionId })),
    });
    for (const s of result.sessions)
      expect(s).toMatchObject({ error: "not_available", messages: [], nextCursor: null });
    const shared = await store.read(actor, { ...range, sessions: [{ sessionId: "shared" }] });
    expect(shared.sessions[0]).toMatchObject({ error: "not_available" });
  });
  it("rechecks flag, membership, destination sharing and task status even for an already resolved action", async () => {
    const catalog = await resolveSessionHistoryActions(actor, store);
    expect(catalog?.actions).toHaveLength(2);
    const action = catalog!.actions[0]!;
    for (const mutation of [
      "UPDATE goat.users SET past_session_access_enabled=false WHERE workos_user_id='owner'",
      "DELETE FROM goat.workspace_members WHERE user_workos_id='owner'",
      "INSERT INTO goat.chat_session_shares VALUES ('current')",
      "UPDATE goat.chat_sessions SET kind='task' WHERE id='current'",
    ]) {
      await db.exec("BEGIN");
      await db.exec(mutation);
      expect(await resolveSessionHistoryActions(actor, store)).toBeNull();
      await expect(action.execute(range, context)).rejects.toThrow("disabled or unavailable");
      expect((await store.find(actor, range)).sessions).toEqual([]);
      await db.exec("ROLLBACK");
    }
    await expect(action.execute(range, { ...context, userWorkosId: "other" })).rejects.toThrow(
      "disabled or unavailable",
    );
    expect(
      projectActionCatalog({ providers: [catalog!.source], actions: catalog!.actions }, "headless")
        .actions,
    ).toEqual([]);
  });
  it("excludes private payloads and stays below the executor cap for a maximally escaped batch", async () => {
    const content = "\u0001".repeat(5000);
    await db.exec(`INSERT INTO goat.chat_sessions(id,user_workos_id) SELECT 'batch_'||n,'owner' FROM generate_series(1,20)n;
      INSERT INTO goat.codex_chat_sessions SELECT id,user_workos_id,'workspace' FROM goat.chat_sessions WHERE id LIKE 'batch_%';`);
    for (let n = 1; n <= 20; n++)
      await db.query("INSERT INTO goat.chat_messages(id,session_id,content) VALUES($1,$2,$3)", [
        "batch_msg_" + n,
        "batch_" + n,
        content,
      ]);
    const catalog = await resolveSessionHistoryActions(actor, store);
    const result = await executeAction({
      catalog: { providers: [catalog!.source], actions: catalog!.actions },
      actionId: "session_history.read_sessions",
      params: {
        ...range,
        sessions: Array.from({ length: 20 }, (_, i) => i + 1).map((n) => ({
          sessionId: "batch_" + n,
        })),
      },
      ...context,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.result).length).toBeLessThan(MAX_EXPANDED_ACTION_RESULT_CHARS);
    expect(result.result).toHaveProperty("sessions");
    const read = JSON.stringify(
      await store.read(actor, { ...range, sessions: [{ sessionId: "past" }] }),
    );
    expect(read).not.toContain("hidden");
    expect(read).not.toContain("secret-tool");
    expect(read).toContain("toolCallCount");
  });
  it("validates unbounded ranges, extra fields, malformed cursors, and duplicate batches", async () => {
    await expect(store.find(actor, { ...range, limit: 51 })).rejects.toThrow();
    await expect(
      store.find(actor, { ...range, query: "x", userWorkosId: "other" }),
    ).rejects.toThrow();
    await expect(store.find(actor, { ...range, from: "2020-01-01T00:00:00Z" })).rejects.toThrow();
    await expect(store.find(actor, { ...range, cursor: "bad" })).rejects.toThrow();
    await expect(
      store.read(actor, { ...range, sessions: [{ sessionId: "past" }, { sessionId: "past" }] }),
    ).rejects.toThrow();
  });
});
