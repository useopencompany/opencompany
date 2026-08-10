import { getDb } from "@opencompany/db/client";
import { drizzle } from "drizzle-orm/neon-http";
import { describe, expect, it, vi } from "vitest";
import { createImportedGoatSkill, updateGoatSkill } from "@/lib/skills";

vi.mock("@opencompany/db/client", () => ({ getDb: vi.fn() }));

// Fakes the drizzle-orm/neon-http transport (the exact pattern chat-sharing.test.ts uses for
// this same "goat" schema): drizzle compiles to raw SQL + params, and this intercepts calls by
// statement verb rather than mocking drizzle's query-builder API, which stays valid across
// schema/query changes instead of needing to mirror every chained builder call.
function fakeGoatDbClient(responses: {
  select?: unknown[][][];
  insert?: unknown[][][];
  update?: unknown[][][];
}) {
  let selectCalls = 0;
  let insertCalls = 0;
  let updateCalls = 0;
  const query = vi.fn(async (statement: string, _params: unknown[]) => {
    const sql = statement.trim().toLowerCase();
    if (sql.startsWith("insert")) {
      const rows = responses.insert?.[insertCalls] ?? [];
      insertCalls += 1;
      return { rows };
    }
    if (sql.startsWith("update")) {
      const rows = responses.update?.[updateCalls] ?? [];
      updateCalls += 1;
      return { rows };
    }
    const rows = responses.select?.[selectCalls] ?? [];
    selectCalls += 1;
    return { rows };
  });
  return Object.assign(query, {
    transaction: vi.fn(async (queries: Promise<unknown>[]) => Promise.all(queries)),
  });
}

const SOURCE = { type: "github" as const, url: "https://github.com/o/r", ref: "main", path: "" };

describe("createImportedGoatSkill", () => {
  it("reuses the existing row when the same source was already imported, without inserting", async () => {
    const client = fakeGoatDbClient({ select: [[["existing-skill"]]] });
    const db = drizzle(client as never) as never;

    const result = await createImportedGoatSkill({
      workspaceId: "workspace_1",
      createdByWorkosId: "user_1",
      name: "My Skill",
      description: "Does things.",
      instructions: "Do the thing.",
      source: SOURCE,
      resolvedCommit: "a".repeat(40),
      integrity: "sha256:abc",
      db,
    });

    expect(result).toEqual({ ok: true, slug: "existing-skill" });
    expect(
      client.mock.calls.some(([statement]) => /^insert/i.test((statement as string).trim())),
    ).toBe(false);
  });

  it("imports a fresh source as an active row with source columns set", async () => {
    // First select: dedup check (no match). Second select: uniqueGoatSkillSlug's collision scan
    // (no existing slugs).
    const client = fakeGoatDbClient({ select: [[], []], insert: [[]] });
    const db = drizzle(client as never) as never;

    const result = await createImportedGoatSkill({
      workspaceId: "workspace_1",
      createdByWorkosId: "user_1",
      name: "My Skill",
      description: "Does things.",
      instructions: "Do the thing.",
      source: SOURCE,
      resolvedCommit: "a".repeat(40),
      integrity: "sha256:abc",
      db,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe("my-skill");
    const insertCall = client.mock.calls.find(([statement]) =>
      /^insert/i.test((statement as string).trim()),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall?.[1] as unknown[];
    expect(params).toContain("active");
    expect(params).toContain(SOURCE.url);
  });

  it("rejects a name over the length limit before touching the database", async () => {
    const client = fakeGoatDbClient({});
    const db = drizzle(client as never) as never;

    const result = await createImportedGoatSkill({
      workspaceId: "workspace_1",
      createdByWorkosId: "user_1",
      name: "x".repeat(65),
      description: "",
      instructions: "Do the thing.",
      source: SOURCE,
      resolvedCommit: "a".repeat(40),
      integrity: "sha256:abc",
      db,
    });

    expect(result).toEqual({ ok: false, message: expect.stringContaining("64 characters") });
    expect(client).not.toHaveBeenCalled();
  });
});

describe("updateGoatSkill read-only enforcement", () => {
  it("rejects editing an imported skill and never issues an update statement", async () => {
    const client = fakeGoatDbClient({ select: [[["github", "https://github.com/o/r"]]] });
    vi.mocked(getDb).mockReturnValue(drizzle(client as never) as never);

    const result = await updateGoatSkill({
      workspaceId: "workspace_1",
      slug: "my-skill",
      name: "My Skill",
      description: "Does things.",
      instructions: "Changed.",
      status: "active",
    });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("imported from https://github.com/o/r"),
    });
    expect(
      client.mock.calls.some(([statement]) => /^update/i.test((statement as string).trim())),
    ).toBe(false);
  });

  it("still allows editing a hand-authored skill", async () => {
    const client = fakeGoatDbClient({
      select: [[[null, null]]],
      update: [[["my-skill"]]],
    });
    vi.mocked(getDb).mockReturnValue(drizzle(client as never) as never);

    const result = await updateGoatSkill({
      workspaceId: "workspace_1",
      slug: "my-skill",
      name: "My Skill",
      description: "Does things.",
      instructions: "Changed.",
      status: "active",
    });

    expect(result).toEqual({ ok: true, slug: "my-skill" });
  });
});
