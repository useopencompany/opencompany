import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { claimActionInvocation, recordActionSourceDiscovery } from "./action-governance";

it("atomically claims both the invocation id and write key while counting one action", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE SCHEMA goat;
      CREATE TABLE goat.action_turns (
        id text PRIMARY KEY, session_id text, turn_id text, user_workos_id text,
        workspace_id text, policy text, action_call_count integer DEFAULT 0,
        invocation_ids jsonb DEFAULT '[]', listed_source_ids jsonb DEFAULT '[]',
        quoted_total_usd_micros bigint DEFAULT 0, admitted_invocation_ids jsonb DEFAULT '[]',
        capability_quotes jsonb DEFAULT '{}', approval_records jsonb DEFAULT '{}',
        async_runs_started integer DEFAULT 0, async_invocation_ids jsonb DEFAULT '[]',
        expires_at timestamptz, created_at timestamptz, updated_at timestamptz,
        UNIQUE(session_id, turn_id)
      );
    `);
    const db = drizzle(database);
    const turn = {
      sessionId: "session_1",
      turnId: "turn_1",
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      policy: "foregroundInteractive" as const,
    };
    await recordActionSourceDiscovery({ turn, sourceId: "calendar", db });
    const claim = (invocationId: string, deduplicationKey?: string) =>
      claimActionInvocation({
        turn,
        sourceId: "calendar",
        invocationId,
        ...(deduplicationKey ? { deduplicationKey } : {}),
        maxCalls: 16,
        db,
      });
    const results = await Promise.all([claim("call_1", "write:one"), claim("call_2", "write:one")]);
    expect(results.filter((result) => result.ok && !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.duplicate)).toHaveLength(1);
    const winner = results[0]?.ok && !results[0].duplicate ? "call_1" : "call_2";
    expect(await claim(winner, "write:different")).toMatchObject({ ok: true, duplicate: true });
    expect(await claim("call_3", "write:two")).toEqual({
      ok: true,
      duplicate: false,
      callCount: 2,
    });
    expect(await claim("read_1")).toEqual({ ok: true, duplicate: false, callCount: 3 });
    expect(await claim("read_2")).toEqual({ ok: true, duplicate: false, callCount: 4 });
    expect(await claim("read_1")).toEqual({ ok: true, duplicate: true, callCount: 4 });
    const { rows } = await database.query<{ action_call_count: number }>(
      "SELECT action_call_count FROM goat.action_turns",
    );
    expect(rows).toEqual([{ action_call_count: 4 }]);
  } finally {
    await database.close();
  }
});
