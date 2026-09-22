import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PRO_STRIPE_PRODUCT_KEY } from "./billing-constants";
import { snapshotPGliteSchema } from "./test-schema-snapshot";
import { countOwnedHobbyWorkspaces, findOwnedHobbyWorkspace } from "./workspaces";

describe("owned Hobby workspaces", () => {
  let db: ReturnType<typeof drizzle>;
  let restoreDatabase: () => Promise<PGlite>;

  beforeAll(async () => {
    restoreDatabase = await snapshotPGliteSchema(async (database) => {
      await database.exec(`
        CREATE SCHEMA goat;
        CREATE TABLE goat.workspaces (
          id text PRIMARY KEY, name text NOT NULL, created_by_workos_id text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE goat.workspace_billing (
          workspace_id text PRIMARY KEY REFERENCES goat.workspaces(id) ON DELETE CASCADE,
          plan text NOT NULL DEFAULT 'hobby', stripe_product_key text
        );
      `);
    });
  });

  beforeEach(async () => {
    db = drizzle(await restoreDatabase());
  });

  async function addWorkspace(
    id: string,
    creator: string,
    billing?: { plan: string; stripeProductKey: string | null },
  ) {
    await db.execute(
      `INSERT INTO goat.workspaces (id, name, created_by_workos_id) VALUES ('${id}', '${id}', '${creator}')`,
    );
    if (!billing) return;
    await db.execute(
      `INSERT INTO goat.workspace_billing (workspace_id, plan, stripe_product_key)
       VALUES ('${id}', '${billing.plan}', ${billing.stripeProductKey === null ? "NULL" : `'${billing.stripeProductKey}'`})`,
    );
  }

  it("counts only the non-Pro workspaces the user created", async () => {
    // No billing row at all is the state a freshly provisioned workspace is in
    // between creation and its first billing write, and it still counts.
    await addWorkspace("ws_no_billing", "user_1");
    await addWorkspace("ws_hobby", "user_1", { plan: "hobby", stripeProductKey: null });
    await addWorkspace("ws_pro", "user_1", {
      plan: "pro",
      stripeProductKey: PRO_STRIPE_PRODUCT_KEY,
    });
    // A "pro" plan without the paid product key is not a paid subscription.
    await addWorkspace("ws_pro_unpaid", "user_1", { plan: "pro", stripeProductKey: null });
    await addWorkspace("ws_other_owner", "user_2", { plan: "hobby", stripeProductKey: null });

    await expect(countOwnedHobbyWorkspaces("user_1", { db })).resolves.toBe(3);
    await expect(countOwnedHobbyWorkspaces("user_2", { db })).resolves.toBe(1);
    await expect(countOwnedHobbyWorkspaces("user_unknown", { db })).resolves.toBe(0);
  });

  it("agrees with the single-workspace lookup on what it counts", async () => {
    await addWorkspace("ws_pro", "user_1", {
      plan: "pro",
      stripeProductKey: PRO_STRIPE_PRODUCT_KEY,
    });

    await expect(countOwnedHobbyWorkspaces("user_1", { db })).resolves.toBe(0);
    await expect(findOwnedHobbyWorkspace("user_1", { db })).resolves.toBeNull();

    await addWorkspace("ws_hobby", "user_1", { plan: "hobby", stripeProductKey: null });

    await expect(countOwnedHobbyWorkspaces("user_1", { db })).resolves.toBe(1);
    await expect(findOwnedHobbyWorkspace("user_1", { db })).resolves.toMatchObject({
      id: "ws_hobby",
    });
  });
});
