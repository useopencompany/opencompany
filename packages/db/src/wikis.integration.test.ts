// Access control for the wiki entity, against embedded Postgres (PGlite)
// running the real migration. This module decides who can reach which wiki, so
// the interesting cases are the negative ones: a non-member of a restricted
// wiki, a wiki in another workspace, and removing someone's access again.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPGlite } from "./test-pglite";
import {
  createWiki,
  listWikiMemberIds,
  listWikisForUser,
  replaceWikiMembers,
  requireIngestionWikiId,
  resolveWikiForUser,
  updateWikiAccess,
  updateWikiSettings,
  WikiAccessError,
} from "./wikis";

const MIGRATIONS = [
  "0195_goat_wiki.sql",
  "0220_goat_wiki_folders.sql",
  "0269_wiki_first_class_entity.sql",
  "0273_default_wiki_company.sql",
];

const WS = "ws-acl";
const OTHER_WS = "ws-acl-other";
const FOUNDER = "user_founder";
const COFOUNDER = "user_cofounder";
const EMPLOYEE = "user_employee";

let pglite: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  pglite = await createTestPGlite({ extensions: { pg_trgm } });
  await pglite.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
  await pglite.exec("CREATE SCHEMA goat;");
  await pglite.exec("CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);");
  await pglite.exec(`
    CREATE TABLE goat.workspaces (id text PRIMARY KEY, created_by_workos_id text);
    CREATE TABLE goat.workspace_members (workspace_id text, user_workos_id text, role text);
  `);
  // Not under test here; 0269 threads wiki_id through them.
  await pglite.exec(`
    CREATE TABLE goat.wiki_sources (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE goat.wiki_source_items (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE goat.wiki_ingest_jobs (id text PRIMARY KEY, workspace_id text NOT NULL);
    CREATE TABLE goat.wiki_source_event_claims (id text PRIMARY KEY, workspace_id text NOT NULL);
  `);
  await pglite.exec(`
    INSERT INTO goat.users (workos_user_id)
    VALUES ('${FOUNDER}'), ('${COFOUNDER}'), ('${EMPLOYEE}');
    INSERT INTO goat.workspaces (id, created_by_workos_id)
    VALUES ('${WS}', '${FOUNDER}'), ('${OTHER_WS}', '${FOUNDER}');
    INSERT INTO goat.workspace_members (workspace_id, user_workos_id, role) VALUES
      ('${WS}', '${FOUNDER}', 'admin'),
      ('${WS}', '${COFOUNDER}', 'member'),
      ('${WS}', '${EMPLOYEE}', 'member'),
      ('${OTHER_WS}', '${FOUNDER}', 'admin');
  `);
  for (const migration of MIGRATIONS) {
    const sql = await readFile(
      path.join(__dirname, "..", "..", "..", "drizzle", migration),
      "utf8",
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      await pglite.exec(statement);
    }
  }
  db = drizzle(pglite);
});

beforeEach(async () => {
  await pglite.exec("DELETE FROM goat.wiki_members; DELETE FROM goat.wikis WHERE NOT is_default;");
});

const forUser = (userWorkosId: string, wikiId?: string) =>
  resolveWikiForUser({ userWorkosId, workspaceId: WS, ...(wikiId ? { wikiId } : {}) }, { db });

async function restrictedWiki(name = "C-level") {
  return createWiki(
    { workspaceId: WS, name, access: "restricted", createdByWorkosId: FOUNDER },
    { db },
  );
}

describe("createWiki", () => {
  it("derives a slug and suffixes a collision rather than failing", async () => {
    const first = await createWiki(
      { workspaceId: WS, name: "C-level", access: "workspace", createdByWorkosId: FOUNDER },
      { db },
    );
    const second = await createWiki(
      { workspaceId: WS, name: "C-Level", access: "workspace", createdByWorkosId: FOUNDER },
      { db },
    );
    expect(first.slug).toBe("c-level");
    expect(second.slug).toBe("c-level-2");
  });

  it("suffixes a slug reserved by a static /wiki route", async () => {
    // `/wiki/sources` and `/wiki/import` are pages of their own, so Next would resolve them before
    // ever reaching a wiki holding that slug. Suffixing keeps the name the reader typed.
    const sources = await createWiki(
      { workspaceId: WS, name: "Sources", access: "workspace", createdByWorkosId: FOUNDER },
      { db },
    );
    const importing = await createWiki(
      { workspaceId: WS, name: "Import", access: "workspace", createdByWorkosId: FOUNDER },
      { db },
    );
    expect(sources.name).toBe("Sources");
    expect(sources.slug).toBe("sources-2");
    expect(importing.slug).toBe("import-2");
  });

  it("stores markdown instructions and makes the creator a member of a restricted wiki", async () => {
    const wiki = await createWiki(
      {
        workspaceId: WS,
        name: "Board",
        access: "restricted",
        instructions: "One page per board topic.",
        createdByWorkosId: FOUNDER,
      },
      { db },
    );
    expect(wiki.instructions).toBe("One page per board topic.");
    // Otherwise the founder would lock themselves out on creation.
    expect(await listWikiMemberIds(wiki.id, { db })).toEqual([FOUNDER]);
  });

  it("rejects a blank name and oversized instructions", async () => {
    await expect(
      createWiki(
        { workspaceId: WS, name: "   ", access: "workspace", createdByWorkosId: FOUNDER },
        { db },
      ),
    ).rejects.toBeInstanceOf(WikiAccessError);
    await expect(
      createWiki(
        {
          workspaceId: WS,
          name: "Huge",
          access: "workspace",
          instructions: "x".repeat(20_001),
          createdByWorkosId: FOUNDER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(WikiAccessError);
  });
});

describe("resolveWikiForUser", () => {
  it("resolves the default wiki when no selector is given", async () => {
    const resolved = await forUser(EMPLOYEE);
    expect(resolved?.isDefault).toBe(true);
    expect(resolved?.slug).toBe("company");
  });

  it("is reachable by an ordinary member of a workspace with no paid plan", async () => {
    // The fixture workspace has no workspace_billing row. The wiki is the
    // default knowledge surface, not a plan-gated feature: carrying Brain's
    // paid-plan clause here would lock every non-creator member out.
    expect(EMPLOYEE).not.toBe(FOUNDER);
    const resolved = await forUser(EMPLOYEE);
    expect(resolved).not.toBeNull();

    const shared = await createWiki(
      { workspaceId: WS, name: "Handbook", access: "workspace", createdByWorkosId: FOUNDER },
      { db },
    );
    expect((await forUser(EMPLOYEE, shared.id))?.id).toBe(shared.id);
  });

  it("resolves an explicit id and slug", async () => {
    const wiki = await createWiki(
      { workspaceId: WS, name: "Handbook", access: "workspace", createdByWorkosId: FOUNDER },
      { db },
    );
    expect((await forUser(EMPLOYEE, wiki.id))?.id).toBe(wiki.id);
    await expect(
      resolveWikiForUser({ userWorkosId: EMPLOYEE, workspaceId: WS, wikiSlug: "handbook" }, { db }),
    ).resolves.toMatchObject({ id: wiki.id });
  });

  it("hides a restricted wiki from a non-member and shows it to an invitee", async () => {
    const wiki = await restrictedWiki();
    await replaceWikiMembers(
      { wikiId: wiki.id, userWorkosIds: [FOUNDER, COFOUNDER], addedByWorkosId: FOUNDER },
      { db },
    );

    expect((await forUser(FOUNDER, wiki.id))?.id).toBe(wiki.id);
    expect((await forUser(COFOUNDER, wiki.id))?.id).toBe(wiki.id);
    // Null, not an error: a distinguishable "exists but forbidden" would leak
    // that the wiki exists at all.
    expect(await forUser(EMPLOYEE, wiki.id)).toBeNull();
  });

  it("never resolves a wiki that belongs to another workspace", async () => {
    const otherWiki = await createWiki(
      { workspaceId: OTHER_WS, name: "Theirs", access: "workspace", createdByWorkosId: FOUNDER },
      { db },
    );
    expect(await forUser(FOUNDER, otherWiki.id)).toBeNull();
  });

  it("hides a workspace-access wiki from someone outside the workspace", async () => {
    const wiki = await createWiki(
      { workspaceId: WS, name: "Open", access: "workspace", createdByWorkosId: FOUNDER },
      { db },
    );
    // `workspace` access means every member of *that* workspace, not everyone.
    await expect(
      resolveWikiForUser(
        { userWorkosId: "user_outsider", workspaceId: WS, wikiId: wiki.id },
        { db },
      ),
    ).resolves.toBeNull();
  });
});

describe("listWikisForUser", () => {
  it("returns the default wiki first and omits restricted wikis the user cannot reach", async () => {
    const shared = await createWiki(
      { workspaceId: WS, name: "Handbook", access: "workspace", createdByWorkosId: FOUNDER },
      { db },
    );
    const restricted = await restrictedWiki();

    const founderWikis = await listWikisForUser({ userWorkosId: FOUNDER, workspaceId: WS }, { db });
    expect(founderWikis[0]?.isDefault).toBe(true);
    expect(founderWikis.map((wiki) => wiki.id)).toContain(restricted.id);

    const employeeWikis = await listWikisForUser(
      { userWorkosId: EMPLOYEE, workspaceId: WS },
      { db },
    );
    expect(employeeWikis.map((wiki) => wiki.id)).toContain(shared.id);
    expect(employeeWikis.map((wiki) => wiki.id)).not.toContain(restricted.id);
  });
});

describe("replaceWikiMembers", () => {
  it("makes the member list exactly the desired set, revoking access that was removed", async () => {
    const wiki = await restrictedWiki();
    await replaceWikiMembers(
      { wikiId: wiki.id, userWorkosIds: [FOUNDER, COFOUNDER, EMPLOYEE], addedByWorkosId: FOUNDER },
      { db },
    );
    expect((await listWikiMemberIds(wiki.id, { db })).toSorted()).toEqual(
      [COFOUNDER, EMPLOYEE, FOUNDER].toSorted(),
    );

    // Un-sharing has to actually revoke: this is the only path that removes a
    // member, so a silent no-op here would leave access behind forever.
    await replaceWikiMembers(
      { wikiId: wiki.id, userWorkosIds: [FOUNDER, COFOUNDER], addedByWorkosId: FOUNDER },
      { db },
    );
    expect((await listWikiMemberIds(wiki.id, { db })).toSorted()).toEqual(
      [COFOUNDER, FOUNDER].toSorted(),
    );
    expect(await forUser(EMPLOYEE, wiki.id)).toBeNull();
  });

  it("is idempotent and clears the list when the desired set is empty", async () => {
    const wiki = await restrictedWiki();
    for (let run = 0; run < 2; run += 1) {
      await replaceWikiMembers(
        { wikiId: wiki.id, userWorkosIds: [FOUNDER, FOUNDER], addedByWorkosId: FOUNDER },
        { db },
      );
      expect(await listWikiMemberIds(wiki.id, { db })).toEqual([FOUNDER]);
    }
    await replaceWikiMembers(
      { wikiId: wiki.id, userWorkosIds: [], addedByWorkosId: FOUNDER },
      { db },
    );
    expect(await listWikiMemberIds(wiki.id, { db })).toEqual([]);
  });

  it("leaves another wiki's members untouched", async () => {
    const mine = await restrictedWiki("Mine");
    const theirs = await restrictedWiki("Theirs");
    await replaceWikiMembers(
      { wikiId: theirs.id, userWorkosIds: [FOUNDER, COFOUNDER], addedByWorkosId: FOUNDER },
      { db },
    );
    await replaceWikiMembers(
      { wikiId: mine.id, userWorkosIds: [FOUNDER], addedByWorkosId: FOUNDER },
      { db },
    );
    expect((await listWikiMemberIds(theirs.id, { db })).toSorted()).toEqual(
      [COFOUNDER, FOUNDER].toSorted(),
    );
  });
});

describe("updateWikiAccess", () => {
  it("keeps the acting user reachable when a wiki becomes restricted", async () => {
    const wiki = await createWiki(
      { workspaceId: WS, name: "Handbook", access: "workspace", createdByWorkosId: FOUNDER },
      { db },
    );
    await updateWikiAccess(
      { wikiId: wiki.id, access: "restricted", actingUserWorkosId: COFOUNDER },
      { db },
    );
    expect(await listWikiMemberIds(wiki.id, { db })).toEqual([COFOUNDER]);
    expect((await forUser(COFOUNDER, wiki.id))?.access).toBe("restricted");
    expect(await forUser(EMPLOYEE, wiki.id)).toBeNull();
  });

  it("returns a restricted wiki to the whole workspace", async () => {
    const wiki = await restrictedWiki();
    await updateWikiAccess(
      { wikiId: wiki.id, access: "workspace", actingUserWorkosId: FOUNDER },
      { db },
    );
    expect((await forUser(EMPLOYEE, wiki.id))?.id).toBe(wiki.id);
  });
});

describe("updateWikiSettings", () => {
  it("updates the name and instructions independently", async () => {
    const wiki = await createWiki(
      { workspaceId: WS, name: "Handbook", access: "workspace", createdByWorkosId: FOUNDER },
      { db },
    );
    const renamed = await updateWikiSettings({ wikiId: wiki.id, name: "  Playbook  " }, { db });
    expect(renamed.name).toBe("Playbook");
    // The slug is stable identity and must not follow a rename.
    expect(renamed.slug).toBe(wiki.slug);
    expect(renamed.instructions).toBe("");

    const briefed = await updateWikiSettings(
      { wikiId: wiki.id, instructions: "One page per team." },
      { db },
    );
    expect(briefed.name).toBe("Playbook");
    expect(briefed.instructions).toBe("One page per team.");
  });

  it("rejects a blank name and an unknown wiki", async () => {
    const wiki = await createWiki(
      { workspaceId: WS, name: "Handbook", access: "workspace", createdByWorkosId: FOUNDER },
      { db },
    );
    await expect(
      updateWikiSettings({ wikiId: wiki.id, name: "   " }, { db }),
    ).rejects.toBeInstanceOf(WikiAccessError);
    await expect(
      updateWikiSettings({ wikiId: "goat_wiki_missing", name: "Nope" }, { db }),
    ).rejects.toBeInstanceOf(WikiAccessError);
  });
});

describe("default wiki", () => {
  it("resolves the one default wiki the migration seeded", async () => {
    const resolved = await forUser(FOUNDER);
    expect(resolved?.isDefault).toBe(true);
    expect(await requireIngestionWikiId(WS, db)).toBe(resolved?.id);
  });

  it("fails closed when a workspace has no default wiki", async () => {
    // Ingestion must not write rows that belong to no wiki.
    await expect(requireIngestionWikiId("ws-nonexistent", db)).rejects.toBeInstanceOf(
      WikiAccessError,
    );
  });
});
