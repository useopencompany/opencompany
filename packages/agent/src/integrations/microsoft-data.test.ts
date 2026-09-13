import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { loadMicrosoftIntegration } from "./microsoft-data";

// Runs the real query builder against a proxy driver so the test pins the SQL
// the loader emits without needing a database.
function captureQuery(rows: unknown[][] = []) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    return { rows };
  });
  return { db, queries };
}

describe("Microsoft account selection", () => {
  it("selects the most recently connected account rather than the oldest", async () => {
    const { db, queries } = captureQuery();

    await loadMicrosoftIntegration({ provider: "outlook", userWorkosId: "user_1", db });

    const [query] = queries;
    // last_synced_at moves on connect and reconnect but not on a permission edit.
    // Ordering by created_at would leave a reconnected older account inactive,
    // and ordering by updated_at would let a mode change take over the plugin.
    // `nulls last` matches activePluginAccount on the settings side, which ranks
    // an account without a timestamp as the oldest; plain `desc` would rank it
    // first in Postgres and split the two selections again.
    expect(query?.sql).toContain(
      'order by "goat"."integrations"."last_synced_at" desc nulls last, ' +
        '"goat"."integrations"."id" desc',
    );
    expect(query?.sql).not.toContain("created_at");
    expect(query?.sql).not.toContain("updated_at");
    expect(query?.params).toEqual(["user_1", "outlook", "disconnected", 1]);
  });

  it("ignores disconnected accounts and other users' accounts", async () => {
    const { db, queries } = captureQuery();

    await loadMicrosoftIntegration({
      provider: "outlook-calendar",
      userWorkosId: "user_1",
      db,
    });

    const [query] = queries;
    expect(query?.sql).toContain('"goat"."integrations"."user_workos_id" = $1');
    expect(query?.sql).toContain('"goat"."integrations"."workspace_id" is null');
    expect(query?.sql).toContain('"goat"."integrations"."status" <> $3');
    expect(query?.params).toEqual(["user_1", "outlook-calendar", "disconnected", 1]);
  });
});
